/**
 * Execution-engine collaborator unit tests (ADR 0013, SDK surface).
 *
 * Focused regression coverage for the single-writer Mutex (invariant 2): a
 * throwing exclusive section must not break serialization or wedge the lock.
 */

import { describe, it, expect } from 'vitest';
import { Mutex } from './execution-engine.js';

describe('Mutex.runExclusive — single-writer ordering (invariant 2)', () => {
  it('runs sections serially even when a prior section throws, and never wedges', async () => {
    const mutex = new Mutex();
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];

    const section = (label: string, ms: number, shouldThrow: boolean) =>
      mutex
        .runExclusive(async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          order.push(`${label}:enter`);
          await new Promise(r => setTimeout(r, ms));
          active--;
          order.push(`${label}:exit`);
          if (shouldThrow) throw new Error(`${label} boom`);
          return label;
        })
        // Swallow the expected rejection at the call site so the test asserts on
        // ordering, not on the throw itself.
        .catch(err => `rejected:${(err as Error).message}`);

    // Fire three sections concurrently; the first one throws.
    const [r1, r2, r3] = await Promise.all([
      section('A', 30, true), // throws
      section('B', 5, false),
      section('C', 5, false),
    ]);

    // The throwing section never let a subsequent section run concurrently.
    expect(maxActive).toBe(1);
    // Strict serialization: each section fully entered+exited before the next.
    expect(order).toEqual([
      'A:enter',
      'A:exit',
      'B:enter',
      'B:exit',
      'C:enter',
      'C:exit',
    ]);
    // A rejected (its own rejection surfaced to its own caller, not re-thrown
    // into B/C), and B/C still ran to completion — the lock did not wedge.
    expect(r1).toBe('rejected:A boom');
    expect(r2).toBe('B');
    expect(r3).toBe('C');

    // The mutex remains usable after the throw (no wedge).
    const after = await mutex.runExclusive(async () => 'after');
    expect(after).toBe('after');
  });

  it('a rejected section does not propagate its rejection to the next caller', async () => {
    const mutex = new Mutex();
    const p1 = mutex.runExclusive(async () => {
      throw new Error('first fails');
    });
    const p2 = mutex.runExclusive(async () => 'second ok');

    await expect(p1).rejects.toThrow('first fails');
    // p2 must resolve normally — the prior rejection is swallowed for ordering
    // only and must never become p2's outcome (the `.then(fn, fn)` bug).
    await expect(p2).resolves.toBe('second ok');
  });
});
