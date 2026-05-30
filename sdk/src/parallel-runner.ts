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

  for (let waveIndex = 0; waveIndex < schedule.waves.length; waveIndex++) {
    const members = schedule.waves[waveIndex]!;
    // D3: re-seed the per-phase base SHA at the wave boundary so this wave's
    // phases fork off protected as the prior wave's promotes left it.
    if (ctx.onWaveStart) await ctx.onWaveStart(waveIndex);
    const outcomes = await Promise.all(
      members.map((waveToken) =>
        semaphore.run(async (): Promise<PhaseParallelOutcome> => {
          const phase = await ctx.resolvePhase(waveToken);
          const { result, halted } = await ctx.runPhase(phase);
          const promoted = result.success && !halted;
          let prUrl: string | undefined;
          if (promoted && ctx.promotePhasePr) {
            prUrl = await promoteMutex.runExclusive(() => ctx.promotePhasePr!(phase, result));
          }
          return { phaseNumber: phase.number, result, promoted, ...(prUrl && { prUrl }) };
        }),
      ),
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
