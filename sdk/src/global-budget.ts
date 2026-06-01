/**
 * ADR 0014 D5 — ONE process-wide agent budget shared across phase + plan
 * dispatch. Both the per-plan DAG (phase-runner.runPlanDag) and the cross-phase
 * wave loop (parallel-runner) acquire from this single Semaphore so N phases × M
 * plans cannot oversubscribe CPU/API. The total is min(16, cores-2)
 * (resolveConcurrencyCap with parallelization enabled). parallel-runner ALSO
 * applies a max_concurrent_phases sub-cap on top of this global budget.
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
