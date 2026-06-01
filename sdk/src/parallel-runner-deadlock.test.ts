/**
 * ADR 0014 D5 — global-budget self-deadlock falsifier (BLOCKER 1).
 *
 * Drives `runParallelWaves` with a `ctx.runPhase` that performs the REAL
 * plan-level budget acquire (`getGlobalBudget().run(...)`) — the exact call
 * `phase-runner.runPlanDag` makes per plan. The wave scheduler is mocked so the
 * test owns the wave shape (no temp repo needed); everything else is the real
 * runner.
 *
 * Pre-fix, the wave loop held ONE global permit for the whole phase body
 * (`phaseSubCap.run(() => globalBudget.run(fn))`). With globalCap=2 and a
 * 2-phase wave, both phase bodies took the only two permits, then each phase's
 * plan acquire blocked forever waiting for a permit none would release →
 * hold-and-wait deadlock. The per-test timeout turns that hang into a FAILURE.
 *
 * Post-fix, the global budget bounds LEAF (plan) dispatch only; phases are
 * bounded solely by the phase sub-cap, so no phase holds a permit while its plan
 * contends for one → the wave completes.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { WaveSchedule } from './query/wave-scheduler.js';

const schedule = vi.hoisted(() => ({ value: { waves: [] as string[][] } as WaveSchedule }));
vi.mock('./query/wave-scheduler.js', () => ({
  scheduleWavesForPhases: vi.fn(async () => schedule.value),
}));

import { runParallelWaves } from './parallel-runner.js';
import { getGlobalBudget, resetGlobalBudgetForTest } from './global-budget.js';
import type { RoadmapPhaseInfo, PhaseRunnerResult } from './types.js';

function phaseInfo(token: string): RoadmapPhaseInfo {
  return { number: token, phase_name: token, disk_status: 'pending', roadmap_complete: false };
}
function greenResult(token: string): PhaseRunnerResult {
  return { phaseNumber: token, phaseName: token, steps: [], success: true, totalCostUsd: 0, totalDurationMs: 1 };
}

beforeEach(() => {
  resetGlobalBudgetForTest();
  vi.clearAllMocks();
});

describe('ADR 0014 D5 — global-budget self-deadlock (BLOCKER 1)', () => {
  it('a 2-phase wave (each running ≥1 plan) COMPLETES with globalCap=2 / subCap=3', async () => {
    // The exact repro: globalCap=2, max_concurrent_phases=3, 2 disjoint phases in
    // ONE wave, each running 1 plan via the REAL plan-level budget acquire.
    resetGlobalBudgetForTest(2);
    schedule.value = { waves: [['1', '2']] };

    let plansRun = 0;
    const ctx = {
      projectDir: '/tmp/par-deadlock-unused',
      maxConcurrentPhases: 3,
      resolvePhase: async (t: string) => phaseInfo(t),
      // runPhase mirrors phase-runner.runPlanDag: re-acquire the SAME global
      // budget singleton per plan, INSIDE the phase body, then run the plan.
      runPhase: async (phase: RoadmapPhaseInfo) => {
        const budget = getGlobalBudget();
        const result = await budget.run(async () => {
          plansRun++;
          await new Promise((r) => setTimeout(r, 10));
          return greenResult(phase.number);
        });
        return { result, halted: false };
      },
    };

    const res = await runParallelWaves(['1', '2'], undefined, ctx);

    expect(res.waves).toHaveLength(1);
    expect(res.phases.map((p) => p.phaseNumber).sort()).toEqual(['1', '2']);
    expect(res.phases.every((p) => p.promoted)).toBe(true);
    expect(plansRun).toBe(2);
  }, 5000);

  it('default max_concurrent_phases=3 + globalCap=2 + a multi-plan-per-phase wave completes', async () => {
    // Default sub-cap (3) with the global cap below it (2) and TWO plans per
    // phase — exercises plan-level contention across concurrent phases.
    resetGlobalBudgetForTest(2);
    schedule.value = { waves: [['10', '11', '12']] };

    let maxPlansInFlight = 0;
    let plansInFlight = 0;
    const ctx = {
      projectDir: '/tmp/par-deadlock-unused',
      maxConcurrentPhases: 3,
      resolvePhase: async (t: string) => phaseInfo(t),
      runPhase: async (phase: RoadmapPhaseInfo) => {
        const budget = getGlobalBudget();
        // Two plans per phase, each acquiring the shared budget (like a 2-plan DAG).
        const runPlan = () =>
          budget.run(async () => {
            plansInFlight++;
            maxPlansInFlight = Math.max(maxPlansInFlight, plansInFlight);
            await new Promise((r) => setTimeout(r, 10));
            plansInFlight--;
          });
        await Promise.all([runPlan(), runPlan()]);
        return { result: greenResult(phase.number), halted: false };
      },
    };

    const res = await runParallelWaves(['10', '11', '12'], undefined, ctx);

    expect(res.phases.every((p) => p.promoted)).toBe(true);
    // The global budget remains an OBSERVABLE bound on concurrent leaf dispatch
    // (D5 oversubscription prevention): never more than 2 plans run at once.
    expect(maxPlansInFlight).toBeLessThanOrEqual(2);
  }, 5000);
});
