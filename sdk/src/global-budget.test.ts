import { describe, it, expect } from 'vitest';
import { getGlobalBudget, resetGlobalBudgetForTest } from './global-budget.js';

describe('global agent budget (ADR 0014 D5)', () => {
  it('returns the same singleton semaphore across calls', () => {
    resetGlobalBudgetForTest();
    const a = getGlobalBudget();
    const b = getGlobalBudget();
    expect(a).toBe(b);
  });
  it('caps in-flight to its permit count', async () => {
    resetGlobalBudgetForTest(2);
    const sem = getGlobalBudget();
    let inFlight = 0;
    let maxInFlight = 0;
    const task = () => sem.run(async () => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    });
    await Promise.all([task(), task(), task(), task()]);
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });
});
