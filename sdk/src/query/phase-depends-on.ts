/**
 * Phase-level `depends_on` parsing + transitive closure with a PHASE-TIER cycle
 * check (ADR 0013 option 4, chunk 3 — autonomous cross-phase + rollback).
 *
 * The ROADMAP renders a phase's cross-phase dependencies as a free-text
 * `**Depends on:** Phase 2` / `**Depends on:** Phase 1, Phase 3` line; the
 * roadmap parser (roadmap.ts) already surfaces that raw string. This module
 * turns it into a canonical list of phase numbers and computes the transitive
 * `depends_on` closure the Tier-2 cascade classifier needs.
 *
 * PHASE-TIER cycle check — distinct from the PLAN-TIER cycle detection
 * (invariant 8, which runs upstream in phase.cjs over a phase's per-plan
 * `depends_on` DAG). This one guards the PHASE graph: if the manifest's
 * phase-level `depends_on` edges form a cycle, the closure walk reports it so
 * the classifier treats the failure as cannot-classify (HALT) rather than
 * cascading on a corrupt graph.
 *
 * Pure functions, no I/O. The caller (phase-runner promote / the classifier)
 * supplies the already-read manifest + the raw roadmap depends_on string.
 */

import { readFile } from 'node:fs/promises';
import type { PhaseManifest } from './phase-manifest.js';
import { planningPaths, escapeRegex } from './helpers.js';
import { extractCurrentMilestone } from './roadmap.js';

/**
 * Canonicalize a phase identifier for `depends_on` matching: strip surrounding
 * whitespace, drop a leading `Phase` word, strip leading zeros on the integer
 * part while PRESERVING a decimal suffix ("02.1" → "2.1", "Phase 03" → "3").
 * Returns '' for anything that is not a phase number token.
 */
export function canonicalizePhaseId(raw: string): string {
  const trimmed = String(raw).trim().replace(/^phase\s+/i, '').trim();
  // Accept integer, letter-suffixed (12A), or decimal (5.1) phase tokens — the
  // same shape the roadmap parser's heading regex accepts.
  const m = trimmed.match(/^(\d+)([A-Za-z])?(?:\.(\d+))?$/);
  if (!m) return '';
  const intPart = String(parseInt(m[1]!, 10)); // strips leading zeros
  const letter = m[2] ? m[2].toUpperCase() : '';
  const decimal = m[3] !== undefined ? `.${m[3]}` : '';
  return `${intPart}${letter}${decimal}`;
}

/**
 * Parse a ROADMAP `**Depends on:**` value into a deduped, canonicalized list of
 * phase numbers. Tolerates the in-the-wild renderings:
 *   - "Phase 2"
 *   - "Phase 1, Phase 3"
 *   - "1, 2"
 *   - "Phase 2 and Phase 4"
 *   - "" / "None" / "TBD" / null → []
 *
 * Splits on commas, `and`, slashes, and the `Phase` keyword, then canonicalizes
 * each token. Non-phase tokens (e.g. "None", "TBD") canonicalize to '' and are
 * dropped, so a free-text "to be planned" never produces a spurious edge.
 */
export function parsePhaseDependsOn(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const out = new Set<string>();
  // Split on separators AND on the `Phase` keyword so "Phase 1 Phase 3" (no
  // comma) still yields two tokens. `and`/`&` join multiple deps in prose.
  for (const token of raw.split(/\s*(?:,|;|\/|\band\b|&|\bphase\b)\s*/i)) {
    const id = canonicalizePhaseId(token);
    if (id) out.add(id);
  }
  return [...out];
}

/**
 * Read a phase's `**Depends on:**` value from the current-milestone ROADMAP and
 * return it as a canonicalized list of phase numbers. Returns `[]` when ROADMAP
 * is absent, the phase has no section, or the phase declares no dependencies.
 *
 * Mirrors the roadmap parser's section-scan (roadmap.ts:777-796): find the
 * `### Phase N:` header, slice to the next phase header, and read the
 * `**Depends on:**` line inside that body — so a phase's own dependency line is
 * never confused with a sibling's. The orchestrator calls this at promote time
 * to populate the manifest's `depends_on`.
 */
export async function readPhaseDependsOn(
  projectDir: string,
  phaseNumber: string,
  workstream?: string,
): Promise<string[]> {
  const roadmapPath = planningPaths(projectDir, workstream).roadmap;
  let rawContent: string;
  try {
    rawContent = await readFile(roadmapPath, 'utf-8');
  } catch {
    return [];
  }

  const content = await extractCurrentMilestone(rawContent, projectDir, workstream);

  // Find this phase's header, padding-tolerant on the phase number, then slice
  // to the next phase header (any depth). escapeRegex keeps a decimal phase's
  // `.` literal.
  const headerRe = new RegExp(
    `#{2,4}\\s*Phase\\s+0*${escapeRegex(phaseNumber.replace(/^0+/, ''))}\\s*:`,
    'i',
  );
  const headerMatch = content.match(headerRe);
  if (!headerMatch || headerMatch.index === undefined) return [];

  const sectionStart = headerMatch.index;
  const rest = content.slice(sectionStart + headerMatch[0].length);
  const nextHeader = rest.match(/\n#{2,4}\s+Phase\s+\d/i);
  const sectionEnd =
    nextHeader && nextHeader.index !== undefined
      ? sectionStart + headerMatch[0].length + nextHeader.index
      : content.length;
  const section = content.slice(sectionStart, sectionEnd);

  const dependsMatch = section.match(/\*\*Depends on(?::\*\*|\*\*:)\s*([^\n]+)/i);
  return parsePhaseDependsOn(dependsMatch ? dependsMatch[1]!.trim() : null);
}

/**
 * Result of a transitive-closure walk over the manifest's phase-level
 * `depends_on` edges.
 */
export interface PhaseClosure {
  /**
   * The transitive `depends_on` closure of the start phase (canonicalized,
   * EXCLUDING the start phase itself). Empty when the start phase has no
   * dependencies or is absent from the manifest.
   */
  closure: string[];
  /**
   * True when a cycle was detected in the phase `depends_on` graph reachable
   * from the start phase. When true, `closure` is not trustworthy and the
   * caller MUST treat the situation as cannot-classify (HALT).
   */
  hasCycle: boolean;
}

/**
 * Compute the transitive `depends_on` closure of `startPhase` over the manifest,
 * detecting cycles in the phase graph (PHASE-TIER cycle check).
 *
 * Manifest entries store each phase's already-parsed `depends_on` (populated at
 * promote time, chunk 3). We walk those edges with iterative DFS + a recursion
 * stack so a back-edge (a phase reachable from itself) sets `hasCycle`. Edges
 * pointing at phases ABSENT from the manifest are simply not traversed (an
 * unpromoted dependency contributes nothing to the cascade set), which is not a
 * cycle.
 *
 * Keys are canonicalized on both sides so a manifest keyed "5.1" matches a
 * `depends_on` edge written "Phase 05.1".
 */
export function transitiveDependsOnClosure(
  manifest: PhaseManifest,
  startPhase: string,
): PhaseClosure {
  // Build a canonical adjacency map from the manifest once.
  const adj = new Map<string, string[]>();
  for (const [key, entry] of Object.entries(manifest)) {
    const from = canonicalizePhaseId(key) || key;
    const edges = (entry.depends_on ?? [])
      .map(d => canonicalizePhaseId(d))
      .filter(Boolean);
    adj.set(from, edges);
  }

  const start = canonicalizePhaseId(startPhase) || startPhase;
  const closure = new Set<string>();
  let hasCycle = false;

  // Iterative DFS with an explicit recursion-stack (onStack) for back-edge
  // detection. Colors: not-present = WHITE, onStack = GRAY, done = BLACK.
  const onStack = new Set<string>();
  const done = new Set<string>();
  // Each frame: the node + an iterator index into its edges.
  const stack: Array<{ node: string; edges: string[]; i: number }> = [];

  const pushFrame = (node: string) => {
    onStack.add(node);
    stack.push({ node, edges: adj.get(node) ?? [], i: 0 });
  };
  pushFrame(start);

  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    if (frame.i >= frame.edges.length) {
      onStack.delete(frame.node);
      done.add(frame.node);
      stack.pop();
      continue;
    }
    const next = frame.edges[frame.i++]!;
    if (next === start) {
      // Back-edge to the start phase — a cycle through the failing phase.
      hasCycle = true;
      continue;
    }
    if (onStack.has(next)) {
      // Back-edge to an ancestor on the current path — a cycle.
      hasCycle = true;
      continue;
    }
    // A dependency edge: it belongs to the closure regardless of whether the
    // target is itself in the manifest (the caller intersects with promoted
    // phases later). Only traverse INTO it when the manifest knows it.
    closure.add(next);
    if (done.has(next)) continue;
    if (adj.has(next)) pushFrame(next);
  }

  return { closure: [...closure], hasCycle };
}
