/**
 * conflict-graph — schedule N phases for concurrent execution from `files_modified`.
 *
 * Issue #13, gap 1 (the mechanically-specified core). Reads each named phase's
 * PLAN.md `files_modified` frontmatter (unioned across every PLAN.md the phase
 * owns, root and nested `plans/`), builds the file-overlap adjacency between
 * phases, classifies each overlap, and partitions the phases into concurrency
 * waves.
 *
 * Conflict classification:
 *   - SOFT  — the overlap is *only* on known shared-write hotspots
 *     (`ROADMAP.md`, `STATE.md`, `register-all.ts`). These are trivial-merge
 *     append points; phases that overlap only here may still run concurrently.
 *   - HARD  — the overlap touches any non-hotspot file. The two phases must be
 *     serialized into different waves.
 *
 * Conservative default: a phase with empty/missing `files_modified` (or whose
 * directory cannot be found) is treated as HARD-conflicting with *every* other
 * phase, so it lands in its own wave rather than racing against work whose file
 * footprint we cannot see.
 *
 * Scope note: this verb only *computes* the schedule. The parallel orchestrator
 * command and the async-dispatch-contract relaxation (issue #13, gap 2) are
 * deferred pending design — this PR does not change any workflow's synchronous
 * dispatch rules.
 *
 * SDK-only — no gsd-tools.cjs mirror (like `requirements.extract-from-plans`).
 */

import { readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { GSDError, ErrorClassification } from '../errors.js';
import { extractFrontmatter } from './frontmatter.js';
import { scanPhasePlans } from './plan-scan.js';
import {
  normalizePhaseName,
  comparePhaseNum,
  phaseTokenMatches,
  planningPaths,
} from './helpers.js';
import type { QueryHandler } from './utils.js';

/**
 * Known shared-write hotspots, matched by basename. Overlaps confined to these
 * files are trivial-merge append points, not real serialization constraints.
 *
 * `ROADMAP.md` / `STATE.md` are GSD's per-project shared ledgers (see
 * `planningPaths`). `register-all.ts` is the canonical verb/feature registry
 * append point that independent features routinely co-touch (issue #13).
 */
export const SHARED_WRITE_HOTSPOTS: ReadonlySet<string> = new Set([
  'ROADMAP.md',
  'STATE.md',
  'register-all.ts',
]);

function isHotspot(file: string): boolean {
  return SHARED_WRITE_HOTSPOTS.has(basename(file));
}

export interface ConflictEdge {
  /** The two phase tokens this edge connects (input order preserved). */
  phases: [string, string];
  /** The files both phases declare in `files_modified`. */
  files: string[];
  /** `soft` when every shared file is a hotspot; `hard` otherwise. */
  classification: 'soft' | 'hard';
}

export interface PhaseFootprint {
  /** Normalized phase token as resolved from the input argument. */
  phase: string;
  /** Union of `files_modified` across every PLAN.md the phase owns. */
  files_modified: string[];
  /** False when the phase directory could not be located. */
  found: boolean;
}

export interface ConflictGraphResult {
  phases: PhaseFootprint[];
  edges: ConflictEdge[];
  schedule: { waves: string[][] };
}

/** Resolve `.planning/phases/<dir>` for a phase token, or null. */
async function resolvePhaseDir(
  phase: string,
  projectDir: string,
  workstream?: string,
): Promise<string | null> {
  const phasesDir = planningPaths(projectDir, workstream).phases;
  const normalized = normalizePhaseName(phase);
  try {
    const entries = await readdir(phasesDir, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => comparePhaseNum(a, b));
    const match = dirs.find((d) => phaseTokenMatches(d, normalized));
    return match ? join(phasesDir, match) : null;
  } catch {
    return null;
  }
}

/**
 * Union `files_modified` across every PLAN.md a phase owns — both root-level
 * plans and nested `plans/PLAN-N*.md` (a phase may carry several plans).
 */
async function collectPhaseFiles(phaseDir: string): Promise<string[]> {
  const scan = scanPhasePlans(phaseDir);
  const files = new Set<string>();

  for (const planFile of scan.planFiles) {
    // Nested plans live under `<phaseDir>/plans/`; root plans directly in the dir.
    const candidates = [join(phaseDir, planFile), join(phaseDir, 'plans', planFile)];
    let content: string | null = null;
    for (const candidate of candidates) {
      try {
        content = await readFile(candidate, 'utf-8');
        break;
      } catch {
        /* try the next candidate location */
      }
    }
    if (content === null) continue;

    const fm = extractFrontmatter(content) as Record<string, unknown>;
    const list = fm.files_modified;
    if (Array.isArray(list)) {
      for (const f of list) {
        const s = String(f).trim();
        if (s) files.add(s);
      }
    }
  }

  return [...files].sort();
}

/**
 * Classify the overlap between two phases.
 *
 * Disjoint footprints produce no edge (returns null). When either phase has an
 * empty footprint (no visible `files_modified`), the pair is conservatively
 * HARD with an empty file list. Otherwise the edge lists the shared files and
 * is SOFT only when every shared file is a hotspot.
 */
function classifyPair(a: PhaseFootprint, b: PhaseFootprint): ConflictEdge | null {
  const aEmpty = a.files_modified.length === 0;
  const bEmpty = b.files_modified.length === 0;

  if (aEmpty || bEmpty) {
    return { phases: [a.phase, b.phase], files: [], classification: 'hard' };
  }

  const bSet = new Set(b.files_modified);
  const shared = a.files_modified.filter((f) => bSet.has(f));
  if (shared.length === 0) return null;

  const classification = shared.every(isHotspot) ? 'soft' : 'hard';
  return { phases: [a.phase, b.phase], files: shared.sort(), classification };
}

/**
 * Partition phases into waves via greedy graph coloring on the HARD-conflict
 * subgraph. A phase joins the earliest wave that holds no phase it HARD-
 * conflicts with; soft edges never block co-scheduling. Input order is the
 * deterministic tie-break.
 */
function scheduleWaves(phases: PhaseFootprint[], edges: ConflictEdge[]): string[][] {
  const hardAdj = new Map<string, Set<string>>();
  for (const p of phases) hardAdj.set(p.phase, new Set());
  for (const e of edges) {
    if (e.classification !== 'hard') continue;
    hardAdj.get(e.phases[0])?.add(e.phases[1]);
    hardAdj.get(e.phases[1])?.add(e.phases[0]);
  }

  const waves: string[][] = [];
  for (const p of phases) {
    const conflictsWith = hardAdj.get(p.phase) ?? new Set<string>();
    let placed = false;
    for (const wave of waves) {
      if (!wave.some((member) => conflictsWith.has(member))) {
        wave.push(p.phase);
        placed = true;
        break;
      }
    }
    if (!placed) waves.push([p.phase]);
  }

  return waves;
}

/**
 * conflict-graph — `gsd-sdk query conflict-graph <phase...>`
 *
 * Args: two or more phase tokens (e.g. `43 44 45`).
 */
export const conflictGraph: QueryHandler = async (args, projectDir, workstream) => {
  const phaseArgs = args.filter((a) => !a.startsWith('-'));
  if (phaseArgs.length < 2) {
    throw new GSDError(
      'conflict-graph requires at least two phases',
      ErrorClassification.Validation,
    );
  }

  const phases: PhaseFootprint[] = [];
  const seen = new Set<string>();
  for (const arg of phaseArgs) {
    const token = normalizePhaseName(arg);
    if (seen.has(token)) continue;
    seen.add(token);

    const phaseDir = await resolvePhaseDir(arg, projectDir, workstream);
    if (!phaseDir) {
      phases.push({ phase: token, files_modified: [], found: false });
      continue;
    }
    const filesModified = await collectPhaseFiles(phaseDir);
    phases.push({ phase: token, files_modified: filesModified, found: true });
  }

  const edges: ConflictEdge[] = [];
  for (let i = 0; i < phases.length; i++) {
    for (let j = i + 1; j < phases.length; j++) {
      const edge = classifyPair(phases[i], phases[j]);
      if (edge) edges.push(edge);
    }
  }

  const waves = scheduleWaves(phases, edges);

  const result: ConflictGraphResult = { phases, edges, schedule: { waves } };
  return { data: result };
};
