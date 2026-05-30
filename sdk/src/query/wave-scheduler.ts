/**
 * Wave-scheduler adapter (ADR 0014, D1 step 1). Calls the shipped `conflictGraph`
 * verb in-process and projects its `ConflictGraphResult` into the shape the
 * parallel runner consumes: the ordered concurrency waves plus the per-phase
 * footprints + edges (for logging / skip-dependents reasoning). No CLI round-trip.
 */
import { conflictGraph } from './conflict-graph.js';
import type { ConflictGraphResult, PhaseFootprint, ConflictEdge } from './conflict-graph.js';

export interface WaveSchedule {
  /** Concurrency waves, in execution order (parallel within, sequential across). */
  waves: string[][];
  /** Per-phase `files_modified` union (canonical phase tokens). */
  footprints: PhaseFootprint[];
  /** The classified overlap edges (soft/hard). */
  edges: ConflictEdge[];
}

/**
 * Schedule `phaseNumbers` into concurrency waves via `conflictGraph`. Throws the
 * verb's own validation error when fewer than two phases are supplied.
 *
 * `conflictGraph` is a `QueryHandler` — its first argument is the raw phase-token
 * argv and it returns a `{ data }` envelope. The wave tokens it emits are the
 * NORMALIZED phase names (`normalizePhaseName`), e.g. `'1'` → `'01'`; callers
 * that key roadmap metadata by the raw number must reconcile via the same
 * normalization (see `parallel-runner.ts`).
 */
export async function scheduleWavesForPhases(
  phaseNumbers: string[],
  projectDir: string,
  workstream?: string,
): Promise<WaveSchedule> {
  const { data } = await conflictGraph(phaseNumbers, projectDir, workstream);
  const result = data as ConflictGraphResult;
  return { waves: result.schedule.waves, footprints: result.phases, edges: result.edges };
}
