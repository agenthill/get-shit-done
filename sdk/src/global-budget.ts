/**
 * ADR 0014 D5 — ONE process-wide agent budget bounding total LEAF (plan) agent
 * dispatch. EVERY plan across every concurrent phase acquires from this single
 * Semaphore inside the per-plan DAG (phase-runner.runPlanDag) — so N phases × M
 * plans cannot oversubscribe CPU/API. The total is min(16, cores-2)
 * (resolveConcurrencyCap with parallelization enabled).
 *
 * The cross-phase wave loop (parallel-runner) does NOT take a permit per phase:
 * a phase is an orchestrator, not an agent, so holding a permit for a whole
 * phase body while its plans contend for the same pool would hold-and-wait
 * deadlock (min(max_concurrent_phases, waveSize) ≥ this cap drains the pool with
 * none left for any plan). Instead parallel-runner bounds concurrent PHASES with
 * a separate max_concurrent_phases sub-cap, and this budget bounds the leaves —
 * a real, observable bound on concurrent agent dispatch enforced where the
 * agents actually run.
 */
import { Semaphore, resolveConcurrencyCap } from './execution-engine.js';

let singleton: Semaphore | undefined;

/** The process-wide agent budget (lazily created at the global cap). */
export function getGlobalBudget(): Semaphore {
  if (!singleton) singleton = new Semaphore(resolveConcurrencyCap(true));
  return singleton;
}

/** Test-only: reset (optionally to a fixed permit count). */
export function resetGlobalBudgetForTest(permits?: number): void {
  singleton = permits !== undefined ? new Semaphore(permits) : undefined;
}
