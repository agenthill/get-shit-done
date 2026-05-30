/**
 * Parallel multi-phase wave executor (ADR 0014). Lifts the proven per-plan
 * engine up one level to phases: schedule N phases into concurrency waves via
 * `conflict-graph`, then per wave fan out one phase-agent per member through the
 * EXISTING per-phase rollback/retry driver (checkpoint + Tier-1/Tier-2 +
 * promote-on-green), advancing to wave N+1 only after wave N settles.
 *
 * The runner is a free function the GSD class binds its private driver into, so
 * it can reuse runPhaseWithRollbackRetry / maybeCascadeTier2 without exposing
 * them. PR-per-phase promotion (D6), per-phase base SHA (D3), and skip-dependents
 * (D4) are layered in by later tasks.
 *
 * Token reconciliation: `conflict-graph` emits NORMALIZED phase tokens in its
 * waves (`normalizePhaseName`, e.g. `'1'` → `'01'`). The roadmap metadata the
 * caller resolves is keyed by the raw phase number. The runner hands each wave
 * token to `ctx.resolvePhase`, which reconciles the two and returns the
 * `RoadmapPhaseInfo`; outcomes report that phase's canonical `.number`, not the
 * normalized wave token.
 */
import type {
  ParallelRunnerOptions,
  ParallelRunnerResult,
  WaveResult,
  PhaseParallelOutcome,
  PhaseRunnerResult,
  RoadmapPhaseInfo,
} from './types.js';
import { scheduleWavesForPhases } from './query/wave-scheduler.js';
import { Semaphore, Mutex, resolveConcurrencyCap } from './execution-engine.js';
import { canonicalizePhaseId } from './query/phase-depends-on.js';

/** The orchestration surface the GSD class supplies to the wave loop. */
export interface ParallelDriverContext {
  projectDir: string;
  workstream?: string;
  parallelization: boolean;
  /** Resolve a phase's roadmap metadata by wave token (reconciles normalization). */
  resolvePhase: (waveToken: string) => Promise<RoadmapPhaseInfo>;
  /** The EXISTING per-phase rollback/retry driver (GSD.runPhaseWithRollbackRetry). */
  runPhase: (phase: RoadmapPhaseInfo) => Promise<{ result: PhaseRunnerResult; halted: boolean }>;
  /**
   * Open + admin-merge the phase's PR after a green local promote (D6). Returns
   * the PR url. Absent → no PR step (local-only / openPullRequests:false).
   */
  promotePhasePr?: (phase: RoadmapPhaseInfo, result: PhaseRunnerResult) => Promise<string>;
  /**
   * Called once at the START of each wave (D3): re-checks-out the protected
   * branch so this wave's phases build their engines off the protected HEAD AS
   * IT STANDS after the prior wave's promotes — each phase captures its OWN base
   * SHA at wave-member start, not a stale global LAST_GOOD left by an earlier
   * wave parking the working tree on an integration branch.
   */
  onWaveStart?: (waveIndex: number) => Promise<void>;
  /**
   * Called after a wave settles (D2 tripwire): verifies the orchestrator-owned
   * ledgers (ROADMAP.md / STATE.md) carry no conflict markers on protected — the
   * orchestrator is the sole writer of those files at wave scope. The
   * GitMergeSerializer guard already restores them on a per-plan merge; this is
   * the regression assertion that the single-writer invariant held end-to-end
   * under concurrency. Throws (fails closed) on a detected violation.
   */
  assertLedgersClean?: () => Promise<void>;
  /**
   * Resolve a phase's direct `depends_on` (ROADMAP edges, canonical phase tokens)
   * — used to skip the closure of a failed predecessor (D4). Absent → no
   * skip-dependents (every phase runs; D4 reduces to continue-independents).
   */
  resolveDependsOn?: (phaseNumber: string) => Promise<string[]>;
}

/**
 * Drive the wave loop. Within a wave, phases run concurrently capped by a shared
 * Semaphore; across waves they run sequentially (a wave barrier). A wave member
 * that fails does NOT abort its siblings — they finish and settle (D4
 * continue-independents; skip-dependents is layered in by B3).
 */
export async function runParallelWaves(
  phaseNumbers: string[],
  _options: ParallelRunnerOptions | undefined,
  ctx: ParallelDriverContext,
): Promise<ParallelRunnerResult> {
  const startTime = Date.now();
  const schedule = await scheduleWavesForPhases(phaseNumbers, ctx.projectDir, ctx.workstream);

  // One nested global Semaphore caps in-flight phase-agents (D5 lifts it to a
  // process-wide singleton in chunk C).
  const cap = resolveConcurrencyCap(ctx.parallelization);
  const semaphore = new Semaphore(cap);
  // Serialize PR auto-merges in wave order — preserves the single-writer (D2)
  // property: ordered promotes onto protected, never concurrent.
  const promoteMutex = new Mutex();

  const waves: WaveResult[] = [];
  const allOutcomes: PhaseParallelOutcome[] = [];
  let success = true;

  // ── D4 skip-dependents bookkeeping ────────────────────────────────────────
  // `failed` accumulates the canonical ids of phases that did NOT promote (a
  // genuine failure OR a skip — a skipped phase is itself a failed predecessor
  // for ITS dependents, so multi-hop chains propagate). `settled` holds one
  // deferred per scheduled phase: a dependent awaits its predecessors' settlement
  // before deciding to run or skip, so a same-wave dependent (conflict-graph
  // schedules by files only, not depends_on) still observes its predecessor's
  // outcome rather than racing it.
  const failed = new Set<string>();
  const settled = new Map<string, { promise: Promise<void>; resolve: () => void }>();
  // Map each scheduled phase (canonical) → its wave index, for the schedule-vs-
  // dependency-order validation below.
  const tokenToWaveIndex = new Map<string, number>();
  for (let wi = 0; wi < schedule.waves.length; wi++) {
    for (const token of schedule.waves[wi]!) {
      const id = canonicalizePhaseId(token) || token;
      tokenToWaveIndex.set(id, wi);
      if (!settled.has(id)) {
        let resolve!: () => void;
        const promise = new Promise<void>((r) => { resolve = r; });
        settled.set(id, { promise, resolve });
      }
    }
  }
  const markSettled = (id: string) => settled.get(id)?.resolve();

  // ── FIX 1: up-front schedule-validity pass (BEFORE any phase runs) ──────────
  // The runner pre-seeds one settled-promise per scheduled phase and a member
  // awaits its in-run predecessors' settlement. Two schedules make that await
  // un-resolvable → permanent hang: (a) a predecessor scheduled in a LATER wave
  // than its dependent (the file-conflict schedule contradicts the dependency
  // order — the awaited promise only resolves in a wave that can't start until
  // this one finishes), and (b) a depends_on CYCLE (mutual await). Both abort the
  // whole run LOUDLY here, outside the per-member try/catch of FIX 2, so an
  // invalid schedule never silently deadlocks. Resolve every scheduled phase's
  // DIRECT in-run depends_on ONCE; the member fn reuses this map.
  const inRunDeps = new Map<string, string[]>();
  for (const token of tokenToWaveIndex.keys()) {
    const raw = ctx.resolveDependsOn ? await ctx.resolveDependsOn(token) : [];
    const deps = raw
      .map((d) => canonicalizePhaseId(d) || d)
      .filter((d) => tokenToWaveIndex.has(d)); // in-run, scheduled phases only
    inRunDeps.set(token, deps);
  }

  // CYCLE guard: a back-edge in the in-run direct-depends_on graph ⇒ mutual await.
  const cycle = findDependsOnCycle(inRunDeps);
  if (cycle) {
    throw new Error(
      `parallel run aborted: depends_on cycle among phases ${cycle.join(' -> ')} — unschedulable`,
    );
  }

  // CROSS-WAVE guard: a dependency scheduled in a LATER wave than its dependent.
  for (const [member, deps] of inRunDeps) {
    const memberWave = tokenToWaveIndex.get(member)!;
    for (const dep of deps) {
      const depWave = tokenToWaveIndex.get(dep)!;
      if (depWave > memberWave) {
        throw new Error(
          `parallel run aborted: phase ${member} depends_on ${dep} but ${dep} is scheduled in a later wave (${depWave}) than ${member} (${memberWave}) — the file-conflict schedule contradicts the dependency order`,
        );
      }
    }
  }

  for (let waveIndex = 0; waveIndex < schedule.waves.length; waveIndex++) {
    const members = schedule.waves[waveIndex]!;
    // D3: re-seed the per-phase base SHA at the wave boundary so this wave's
    // phases fork off protected as the prior wave's promotes left it.
    if (ctx.onWaveStart) await ctx.onWaveStart(waveIndex);
    const outcomes = await Promise.all(
      members.map(async (waveToken): Promise<PhaseParallelOutcome> => {
        const memberId = canonicalizePhaseId(waveToken) || waveToken;
        const memberWave = tokenToWaveIndex.get(memberId) ?? waveIndex;

        // D4: this phase's direct in-run depends_on, precomputed up front (FIX 1)
        // and reused here instead of re-resolving per member. Await any in-run
        // predecessor's settlement BEFORE acquiring a semaphore slot — so a
        // dependent never holds a permit while blocking on a predecessor that
        // also needs one (which would deadlock under a small cap).
        const deps = inRunDeps.get(memberId) ?? [];
        // FIX 1: the up-front pass guaranteed no dep is scheduled in a LATER wave,
        // so only deps in the SAME or an EARLIER wave remain. Earlier-wave deps are
        // already settled (waves run sequentially); same-wave deps are awaited so a
        // same-wave dependent (conflict-graph schedules by files only, not
        // depends_on) observes its predecessor's outcome rather than racing it.
        await Promise.all(
          deps
            .filter((d) => tokenToWaveIndex.get(d)! <= memberWave && settled.has(d))
            .map((d) => settled.get(d)!.promise),
        );
        const blocking = deps.filter((d) => failed.has(d));
        if (blocking.length > 0) {
          const skippedReason = `skipped: depends_on failed phase(s) ${blocking.join(', ')}`;
          failed.add(memberId); // a skipped phase blocks its own dependents in turn
          markSettled(memberId);
          const phaseInfo = await ctx.resolvePhase(waveToken).catch(() => undefined);
          const phaseNumber = phaseInfo?.number ?? waveToken;
          const result: PhaseRunnerResult = {
            phaseNumber,
            phaseName: phaseInfo?.phase_name ?? phaseNumber,
            steps: [],
            success: false,
            totalCostUsd: 0,
            totalDurationMs: 0,
          };
          return { phaseNumber, result, promoted: false, skippedReason };
        }

        return semaphore.run(async (): Promise<PhaseParallelOutcome> => {
          // FIX 2: a thrown/rejected resolvePhase or runPhase must NOT reject the
          // wave's Promise.all — that would abort concurrent siblings, record no
          // outcome, and make the post-wave assertLedgersClean unreachable. Catch
          // it, emit a non-promoted outcome (continue-independents), and ALWAYS
          // markSettled in finally so no dependent hangs. (FIX 1's up-front
          // schedule-validity errors are raised OUTSIDE this body and still abort
          // the whole run.)
          try {
            const phase = await ctx.resolvePhase(waveToken);
            const { result, halted } = await ctx.runPhase(phase);
            const promoted = result.success && !halted;
            if (!promoted) failed.add(memberId);
            let prUrl: string | undefined;
            if (promoted && ctx.promotePhasePr) {
              prUrl = await promoteMutex.runExclusive(() => ctx.promotePhasePr!(phase, result));
            }
            return { phaseNumber: phase.number, result, promoted, ...(prUrl && { prUrl }) };
          } catch (err) {
            failed.add(memberId);
            const errorReason = err instanceof Error ? err.message : String(err);
            const phaseInfo = await ctx.resolvePhase(waveToken).catch(() => undefined);
            const phaseNumber = phaseInfo?.number ?? memberId;
            const result: PhaseRunnerResult = {
              phaseNumber,
              phaseName: phaseInfo?.phase_name ?? phaseNumber,
              steps: [],
              success: false,
              totalCostUsd: 0,
              totalDurationMs: 0,
            };
            return { phaseNumber, result, promoted: false, errorReason };
          } finally {
            markSettled(memberId);
          }
        });
      }),
    );
    waves.push({ waveIndex, phases: outcomes });
    allOutcomes.push(...outcomes);
    // D2 tripwire: after the wave settles, assert no wave member's promote left a
    // conflict marker in an orchestrator-owned ledger. Fails closed.
    if (ctx.assertLedgersClean) await ctx.assertLedgersClean();
    if (outcomes.some((o) => !o.promoted)) success = false;
  }

  const totalCostUsd = allOutcomes.reduce((s, o) => s + o.result.totalCostUsd, 0);
  return {
    success,
    waves,
    phases: allOutcomes,
    totalCostUsd,
    totalDurationMs: Date.now() - startTime,
  };
}

/**
 * Detect a cycle in the in-run direct-`depends_on` graph (FIX 1). Keys are the
 * scheduled (canonical) phase ids; values are their in-run direct deps. Returns
 * the nodes on the first back-edge cycle found (for the error message), or `null`
 * when the graph is acyclic. DFS with a WHITE/GRAY/BLACK recursion-stack — the
 * phase-tier cycle check `transitiveDependsOnClosure` operates on a
 * `PhaseManifest`, not this in-run adjacency map, so a small local walk fits.
 */
function findDependsOnCycle(adj: Map<string, string[]>): string[] | null {
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const path: string[] = [];

  const visit = (node: string): string[] | null => {
    color.set(node, GRAY);
    path.push(node);
    for (const next of adj.get(node) ?? []) {
      if (!adj.has(next)) continue; // edge to an out-of-run phase — not a cycle
      const c = color.get(next);
      if (c === GRAY) {
        // Back-edge: slice the current path from `next` to close the cycle.
        const from = path.indexOf(next);
        return [...path.slice(from), next];
      }
      if (c === undefined) {
        const found = visit(next);
        if (found) return found;
      }
    }
    path.pop();
    color.set(node, BLACK);
    return null;
  };

  for (const node of adj.keys()) {
    if (color.get(node) === undefined) {
      const found = visit(node);
      if (found) return found;
    }
  }
  return null;
}
