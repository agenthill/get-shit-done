/**
 * plan-dag.ts — pure DAG logic. No I/O; deterministic.
 *
 * Covers the preservation-invariant-relevant DAG behaviours (ADR 0013):
 *  - direct depends_on edges are preserved (not collapsed to integer levels);
 *  - has_summary predecessors are dropped as satisfied external deps (inv 10);
 *  - a files_modified overlap adds a serialization edge between unordered
 *    plans (inv 9), but not between already depends_on-ordered plans;
 *  - topological levels are the longest-path levels, used for wave events.
 */

import { describe, it, expect } from 'vitest';
import { buildPlanDag, levelGroups } from './plan-dag.js';
import type { PlanInfo } from './types.js';

function plan(overrides: Partial<PlanInfo> & { id: string }): PlanInfo {
  return {
    wave: 1,
    depends_on: [],
    autonomous: true,
    objective: null,
    files_modified: [],
    task_count: 1,
    has_summary: false,
    ...overrides,
  };
}

describe('buildPlanDag', () => {
  it('keeps independent plans at level 1 with no predecessors', () => {
    const dag = buildPlanDag([plan({ id: 'a' }), plan({ id: 'b' })]);
    expect(dag.byId.get('a')!.predecessors).toEqual([]);
    expect(dag.byId.get('b')!.predecessors).toEqual([]);
    expect(dag.byId.get('a')!.level).toBe(1);
    expect(dag.byId.get('b')!.level).toBe(1);
    expect(dag.maxLevel).toBe(1);
  });

  it('preserves direct depends_on edges as predecessors', () => {
    const dag = buildPlanDag([
      plan({ id: 'a' }),
      plan({ id: 'b', depends_on: ['a'] }),
      plan({ id: 'c', depends_on: ['b'] }),
    ]);
    expect(dag.byId.get('b')!.predecessors).toEqual(['a']);
    expect(dag.byId.get('c')!.predecessors).toEqual(['b']);
    // Longest-path levels along the chain.
    expect(dag.byId.get('a')!.level).toBe(1);
    expect(dag.byId.get('b')!.level).toBe(2);
    expect(dag.byId.get('c')!.level).toBe(3);
  });

  it('does NOT collapse a level-2 plan onto all of level-1 (true DAG, not bucket)', () => {
    // B depends only on A. C is an independent level-1 plan. B must NOT wait on C.
    const dag = buildPlanDag([
      plan({ id: 'a' }),
      plan({ id: 'c' }),
      plan({ id: 'b', depends_on: ['a'] }),
    ]);
    expect(dag.byId.get('b')!.predecessors).toEqual(['a']);
    expect(dag.byId.get('b')!.predecessors).not.toContain('c');
  });

  it('drops has_summary predecessors as satisfied external deps', () => {
    // a is already complete (has_summary). b depends on a → that edge is dropped,
    // so b is a root with no incomplete predecessors.
    const dag = buildPlanDag([
      plan({ id: 'a', has_summary: true }),
      plan({ id: 'b', depends_on: ['a'] }),
    ]);
    expect(dag.nodes.map(n => n.id)).toEqual(['b']);
    expect(dag.byId.get('b')!.predecessors).toEqual([]);
    expect(dag.byId.get('b')!.level).toBe(1);
  });

  it('adds a serialization edge between unordered file-colliding plans (inv 9)', () => {
    const dag = buildPlanDag([
      plan({ id: 'a', files_modified: ['src/api.ts'] }),
      plan({ id: 'b', files_modified: ['src/api.ts'] }),
    ]);
    // a precedes b (stable: earlier in input order), so they never run concurrently.
    expect(dag.byId.get('b')!.predecessors).toEqual(['a']);
    expect(dag.byId.get('a')!.predecessors).toEqual([]);
    expect(dag.byId.get('b')!.level).toBe(2);
  });

  it('does NOT add a serialization edge when plans are already depends_on-ordered', () => {
    const dag = buildPlanDag([
      plan({ id: 'a', files_modified: ['src/api.ts'] }),
      plan({ id: 'b', depends_on: ['a'], files_modified: ['src/api.ts'] }),
    ]);
    // Already ordered by the real dependency edge — no duplicate serialization edge.
    expect(dag.byId.get('b')!.predecessors).toEqual(['a']);
  });

  it('does not serialize plans that touch disjoint files', () => {
    const dag = buildPlanDag([
      plan({ id: 'a', files_modified: ['src/api.ts'] }),
      plan({ id: 'b', files_modified: ['src/ui.tsx'] }),
    ]);
    expect(dag.byId.get('a')!.predecessors).toEqual([]);
    expect(dag.byId.get('b')!.predecessors).toEqual([]);
  });

  it('emits integration order as a valid topological order', () => {
    const dag = buildPlanDag([
      plan({ id: 'c', depends_on: ['b'] }),
      plan({ id: 'a' }),
      plan({ id: 'b', depends_on: ['a'] }),
    ]);
    const order = dag.nodes.map(n => n.id);
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('c'));
  });

  it('groups plan ids by level in input order', () => {
    const dag = buildPlanDag([
      plan({ id: 'a' }),
      plan({ id: 'b' }),
      plan({ id: 'c', depends_on: ['a'] }),
    ]);
    const groups = levelGroups(dag);
    expect(groups.get(1)).toEqual(['a', 'b']);
    expect(groups.get(2)).toEqual(['c']);
  });

  it('worked example: A→B→C chain + independent D, all touching api except D', () => {
    // ADR worked example. A,B,C touch src/api.ts; D touches src/ui.tsx.
    const dag = buildPlanDag([
      plan({ id: 'A', files_modified: ['src/api.ts'] }),
      plan({ id: 'B', depends_on: ['A'], files_modified: ['src/api.ts'] }),
      plan({ id: 'C', depends_on: ['B'], files_modified: ['src/api.ts'] }),
      plan({ id: 'D', files_modified: ['src/ui.tsx'] }),
    ]);
    expect(dag.byId.get('A')!.predecessors).toEqual([]);
    expect(dag.byId.get('B')!.predecessors).toEqual(['A']);
    expect(dag.byId.get('C')!.predecessors).toEqual(['B']);
    expect(dag.byId.get('D')!.predecessors).toEqual([]); // D never blocks on the chain
    expect(dag.byId.get('D')!.level).toBe(1);
    expect(dag.byId.get('C')!.level).toBe(3);
  });
});
