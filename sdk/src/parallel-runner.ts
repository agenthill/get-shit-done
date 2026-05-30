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
import { Semaphore, resolveConcurrencyCap } from './execution-engine.js';

/** The orchestration surface the GSD class supplies to the wave loop. */
export interface ParallelDriverContext {
  projectDir: string;
  workstream?: string;
  parallelization: boolean;
  /** Resolve a phase's roadmap metadata by wave token (reconciles normalization). */
  resolvePhase: (waveToken: string) => Promise<RoadmapPhaseInfo>;
  /** The EXISTING per-phase rollback/retry driver (GSD.runPhaseWithRollbackRetry). */
  runPhase: (phase: RoadmapPhaseInfo) => Promise<{ result: PhaseRunnerResult; halted: boolean }>;
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

  const waves: WaveResult[] = [];
  const allOutcomes: PhaseParallelOutcome[] = [];
  let success = true;

  for (let waveIndex = 0; waveIndex < schedule.waves.length; waveIndex++) {
    const members = schedule.waves[waveIndex]!;
    const outcomes = await Promise.all(
      members.map((waveToken) =>
        semaphore.run(async (): Promise<PhaseParallelOutcome> => {
          const phase = await ctx.resolvePhase(waveToken);
          const { result, halted } = await ctx.runPhase(phase);
          const promoted = result.success && !halted;
          return { phaseNumber: phase.number, result, promoted };
        }),
      ),
    );
    waves.push({ waveIndex, phases: outcomes });
    allOutcomes.push(...outcomes);
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
