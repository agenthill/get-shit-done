/**
 * Plan DAG — pure dependency-graph logic for per-plan parallel execution.
 *
 * The SDK execute engine runs a true `depends_on` DAG rather than coarse wave
 * barriers (ADR 0013). This module is the deterministic, I/O-free core:
 *
 *  - reduce the plan set to incomplete plans, keeping `has_summary` plans as
 *    already-satisfied predecessors (their work is already integrated);
 *  - prune each plan's `depends_on` to its incomplete predecessors;
 *  - add a *serialization edge* between any two incomplete plans that share a
 *    `files_modified` entry and are not already `depends_on`-ordered, so they
 *    never run concurrently (preservation invariant 9);
 *  - compute the topological level of each plan over the reduced edge set, used
 *    only to fire synthetic WaveStart/WaveComplete events at level boundaries
 *    (event-stream cardinality stays byte-compatible);
 *  - emit a topological integration order for the single-writer merge phase.
 *
 * Cycle detection itself runs upstream in `phase.cjs` (invariant 8); this module
 * assumes an acyclic edge set and is defensive only against missing references.
 */

import type { PlanInfo } from './types.js';

/** A plan node with its resolved direct predecessors (deps + serialization peers). */
export interface DagNode {
  id: string;
  /** The original plan info (carries files_modified, wave, etc.). */
  plan: PlanInfo;
  /**
   * Direct predecessors among *incomplete* plans. Pruned `depends_on` edges plus
   * serialization edges for file overlaps. A plan starts the instant every
   * predecessor here has settled — no whole-wave barrier.
   */
  predecessors: string[];
  /**
   * Topological level (1-based) over the reduced edge set. Roots are level 1.
   * Used for synthetic wave event boundaries, not for gating.
   */
  level: number;
}

export interface PlanDag {
  /** Incomplete plans in topological order (integration order). */
  nodes: DagNode[];
  /** Lookup by plan id. */
  byId: Map<string, DagNode>;
  /** Highest level present (0 when the DAG is empty). */
  maxLevel: number;
}

/**
 * Build the reduced execution DAG over the incomplete plans.
 *
 * `allPlans` is the full plan set from `phase-plan-index`. Plans with
 * `has_summary === true` are excluded from execution but treated as satisfied
 * predecessors: an edge into a completed plan is simply dropped (its commits are
 * already on the protected branch), so a dependent of a skipped plan needs no
 * rebase for that edge.
 */
export function buildPlanDag(allPlans: PlanInfo[]): PlanDag {
  const completed = new Set<string>();
  const incomplete: PlanInfo[] = [];
  for (const p of allPlans) {
    if (p.has_summary) completed.add(p.id);
    else incomplete.push(p);
  }
  const incompleteIds = new Set(incomplete.map(p => p.id));

  // ── Direct predecessors from depends_on, pruned to incomplete plans ──
  // A dependency on a completed plan is a satisfied external dep → dropped.
  // A dependency on an unknown id (not in this phase) is ignored defensively;
  // phase.cjs already surfaces unresolved references as warnings.
  const predSets = new Map<string, Set<string>>();
  for (const p of incomplete) {
    const preds = new Set<string>();
    for (const dep of p.depends_on ?? []) {
      if (incompleteIds.has(dep)) preds.add(dep);
      // completed.has(dep) → satisfied, drop. unknown → drop.
    }
    predSets.set(p.id, preds);
  }

  // ── Serialization edges for files_modified overlap (invariant 9) ──
  // Between any two incomplete plans sharing a modified file and not already
  // depends_on-ordered (in either direction), add one ordering edge. Direction
  // is stable: earlier-in-list → later-in-list, so the result is deterministic
  // and acyclic (it only ever points forward in the input order).
  for (let i = 0; i < incomplete.length; i++) {
    for (let j = i + 1; j < incomplete.length; j++) {
      const a = incomplete[i];
      const b = incomplete[j];
      if (!sharesFile(a, b)) continue;
      // Already ordered by a real dependency edge (transitively-direct check is
      // unnecessary: a direct edge in either direction already serializes them).
      if (reachable(predSets, b.id, a.id) || reachable(predSets, a.id, b.id)) {
        continue;
      }
      // Add a→b serialization edge (a precedes b: b waits on a).
      predSets.get(b.id)!.add(a.id);
    }
  }

  // ── Topological level assignment (Kahn longest-path) ──
  // level(node) = 1 + max(level(predecessors)); roots → 1.
  const successors = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  for (const p of incomplete) {
    inDegree.set(p.id, predSets.get(p.id)!.size);
    if (!successors.has(p.id)) successors.set(p.id, []);
  }
  for (const p of incomplete) {
    for (const pred of predSets.get(p.id)!) {
      successors.get(pred)!.push(p.id);
    }
  }

  const level = new Map<string, number>();
  // Preserve input order within a level so wave planIds match declaration order.
  const queue: string[] = incomplete.filter(p => inDegree.get(p.id) === 0).map(p => p.id);
  for (const id of queue) level.set(id, 1);
  const topoOrder: string[] = [];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    topoOrder.push(cur);
    const curLevel = level.get(cur)!;
    for (const succ of successors.get(cur)!) {
      const succLevel = Math.max(level.get(succ) ?? 1, curLevel + 1);
      level.set(succ, succLevel);
      const remaining = inDegree.get(succ)! - 1;
      inDegree.set(succ, remaining);
      if (remaining === 0) queue.push(succ);
    }
  }

  // Defensive: any plan not reached (would imply a cycle the upstream pass missed)
  // is appended at level 1 so it still executes rather than silently vanishing.
  for (const p of incomplete) {
    if (!level.has(p.id)) {
      level.set(p.id, 1);
      topoOrder.push(p.id);
    }
  }

  const byId = new Map<string, DagNode>();
  for (const p of incomplete) {
    byId.set(p.id, {
      id: p.id,
      plan: p,
      predecessors: [...predSets.get(p.id)!],
      level: level.get(p.id)!,
    });
  }

  // nodes ordered by topological order (integration order). Within ties, input order.
  const orderIndex = new Map<string, number>();
  topoOrder.forEach((id, idx) => orderIndex.set(id, idx));
  const nodes = incomplete
    .map(p => byId.get(p.id)!)
    .sort((a, b) => (orderIndex.get(a.id)! - orderIndex.get(b.id)!));

  const maxLevel = nodes.reduce((m, n) => Math.max(m, n.level), 0);

  return { nodes, byId, maxLevel };
}

/** True when plans a and b declare at least one shared files_modified entry. */
function sharesFile(a: PlanInfo, b: PlanInfo): boolean {
  const fa = a.files_modified ?? [];
  if (fa.length === 0) return false;
  const set = new Set(fa);
  for (const f of b.files_modified ?? []) {
    if (set.has(f)) return true;
  }
  return false;
}

/**
 * True when `from` can reach `to` by following predecessor edges (i.e. `to` is a
 * transitive predecessor of `from`). Used to detect existing ordering before
 * adding a serialization edge.
 */
function reachable(predSets: Map<string, Set<string>>, from: string, to: string): boolean {
  if (from === to) return true;
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const pred of predSets.get(cur) ?? []) {
      if (pred === to) return true;
      if (!seen.has(pred)) {
        seen.add(pred);
        stack.push(pred);
      }
    }
  }
  return false;
}

/** Plan ids grouped by topological level (1-based), in input order within a level. */
export function levelGroups(dag: PlanDag): Map<number, string[]> {
  const groups = new Map<number, string[]>();
  for (const node of dag.nodes) {
    const g = groups.get(node.level) ?? [];
    g.push(node.id);
    groups.set(node.level, g);
  }
  return groups;
}
