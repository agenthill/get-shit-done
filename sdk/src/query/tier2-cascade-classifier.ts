/**
 * Tier-2 cascade TRISTATE classifier (ADR 0013 option 4, chunk 3, Task B2).
 *
 * The hard case: a LATER phase N fails, and the failure implicates an
 * ALREADY-PROMOTED earlier phase. The resolved user decision is
 * ATTRIBUTABLE-ONLY, else HALT — cascade-revert a promoted predecessor ONLY
 * when the failure is (1) file-attributable to that predecessor AND (2) the
 * predecessor is in the failing phase's transitive `depends_on` closure. On ANY
 * ambiguity → HALT with a clean tree.
 *
 * This module returns one of three verdicts, modelled on the
 * diff-touches-shipped-paths.cjs #2983 tristate (where the load-bearing rule is:
 * an INABILITY to decide must NEVER masquerade as a clean negative — there the
 * classifier-error exit 2 must be distinguishable from the legitimate
 * no-shipped-paths exit 1, or the workflow silently skips a real failure):
 *
 *   - `revert-confident`     (≈ exit 0): a promoted predecessor is BOTH
 *                            depends_on-linked AND file-attributable → cascade
 *                            the closure ∩ promoted ∩ attributable set.
 *   - `no-cascade-confident` (≈ exit 1): no promoted predecessor is both linked
 *                            AND attributable → proceed with phase-N Tier-1 +
 *                            informed retry (no Tier-2).
 *   - `cannot-classify`      (≈ exit 2): corrupt/missing manifest, cyclic phase
 *                            graph, OR attribution ambiguous → HALT clean. This
 *                            verdict must NEVER be silently downgraded to
 *                            no-cascade — that is the #2983 footgun.
 *
 * Pure logic + git reads (diff-tree per predecessor commit). No mutation.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PhaseManifest } from './phase-manifest.js';
import {
  canonicalizePhaseId,
  transitiveDependsOnClosure,
} from './phase-depends-on.js';

const execFileAsync = promisify(execFile);

export type CascadeVerdict =
  | 'revert-confident'
  | 'no-cascade-confident'
  | 'cannot-classify';

export interface ClassifyCascadeInput {
  projectDir: string;
  /** The failing phase number (canonicalized internally). */
  failingPhase: string;
  /** The phase manifest (read by the caller; may be `{}` if absent/corrupt). */
  manifest: PhaseManifest;
  /**
   * Repo-relative paths the failure implicates (the broken files the failing
   * phase's gate/verify pointed at). Empty → nothing to attribute → no-cascade.
   * The caller derives these from the failure detail.
   */
  implicatedFiles: string[];
  /**
   * True when the caller could not reliably determine the implicated files
   * (e.g. a gate failure with no parseable file list) but the failure is
   * GENUINE. Forces cannot-classify so an ambiguous failure never silently
   * resolves to no-cascade. Default false.
   */
  implicatedFilesUncertain?: boolean;
}

export interface ClassifyCascadeResult {
  verdict: CascadeVerdict;
  /**
   * For `revert-confident`: the cascade set — promoted predecessors in the
   * failing phase's transitive depends_on closure that are file-attributable to
   * the failure, ordered in REVERSE promotion order (newest-promoted first), the
   * order rollbackTier2 must revert them in. Empty for the other verdicts.
   */
  cascadeSet: string[];
  /** Human-readable reason, primarily for the ledger + diagnostics. */
  reason: string;
}

/** True when a manifest entry looks structurally valid (defensive vs corruption). */
function isValidEntry(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const entry = e as Record<string, unknown>;
  return (
    typeof entry.head_sha === 'string' &&
    typeof entry.base_sha === 'string' &&
    Array.isArray(entry.commits) &&
    Array.isArray(entry.depends_on)
  );
}

/**
 * Touched paths of a single commit: `git diff-tree --no-commit-id --name-only -r
 * <commit>`. Throws on git failure so the caller can map it to cannot-classify
 * (a commit we cannot diff is an attribution we cannot make).
 */
async function commitTouchedPaths(projectDir: string, commit: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    'git',
    ['diff-tree', '--no-commit-id', '--name-only', '-r', commit],
    { cwd: projectDir },
  );
  return stdout
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);
}

/**
 * Classify whether a failing phase's failure should cascade-revert a promoted
 * predecessor. ATTRIBUTABLE-ONLY, else HALT.
 *
 * Decision order (each ambiguity is cannot-classify, never no-cascade):
 *   1. Corrupt/missing manifest (the failing phase is absent, or any entry is
 *      structurally invalid) → cannot-classify.
 *   2. Cyclic phase depends_on graph (transitiveDependsOnClosure.hasCycle) →
 *      cannot-classify.
 *   3. Implicated files uncertain → cannot-classify.
 *   4. closure ∩ promoted: the depends_on-linked promoted predecessors. Empty →
 *      no-cascade-confident (the failure has no promoted predecessor to blame).
 *   5. For each linked promoted predecessor, intersect the failure's implicated
 *      files with the UNION of that predecessor's commits' touched paths
 *      (diff-tree). A git failure diffing any candidate's commit →
 *      cannot-classify.
 *   6. attributable set non-empty → revert-confident (cascade set, reverse
 *      promotion order). Empty → no-cascade-confident.
 */
export async function classifyCascade(
  input: ClassifyCascadeInput,
): Promise<ClassifyCascadeResult> {
  const { projectDir, failingPhase, manifest, implicatedFiles } = input;

  // ── 1. Corrupt / missing manifest ──
  if (!manifest || typeof manifest !== 'object') {
    return { verdict: 'cannot-classify', cascadeSet: [], reason: 'manifest missing or not an object' };
  }
  const entries = Object.entries(manifest);
  for (const [key, e] of entries) {
    if (!isValidEntry(e)) {
      return {
        verdict: 'cannot-classify',
        cascadeSet: [],
        reason: `manifest entry for phase ${key} is structurally invalid`,
      };
    }
  }

  // ── 2. PHASE-TIER cycle check ──
  const { closure, hasCycle } = transitiveDependsOnClosure(manifest, failingPhase);
  if (hasCycle) {
    return {
      verdict: 'cannot-classify',
      cascadeSet: [],
      reason: 'cyclic phase depends_on graph — cannot scope a cascade set',
    };
  }

  // ── 3. Implicated-file uncertainty ──
  if (input.implicatedFilesUncertain) {
    return {
      verdict: 'cannot-classify',
      cascadeSet: [],
      reason: 'failure implicated-files could not be determined — refusing to guess',
    };
  }

  // ── 4. closure ∩ promoted predecessors ──
  // A phase is "promoted" iff it has a manifest entry. Canonicalize for matching.
  const promoted = new Set(entries.map(([k]) => canonicalizePhaseId(k) || k));
  const failing = canonicalizePhaseId(failingPhase) || failingPhase;
  const linkedPromoted = closure
    .map(p => canonicalizePhaseId(p) || p)
    .filter(p => p !== failing && promoted.has(p));

  if (linkedPromoted.length === 0) {
    return {
      verdict: 'no-cascade-confident',
      cascadeSet: [],
      reason: 'no promoted predecessor in the failing phase\'s depends_on closure',
    };
  }

  // ── 5. File attribution per linked promoted predecessor ──
  const implicated = new Set(implicatedFiles.map(f => f.replace(/\\/g, '/')));
  // No implicated files at all → nothing to attribute → no-cascade (NOT
  // cannot-classify: an EMPTY implicated set is a confident negative, the way
  // diff-touches-shipped-paths exit-1 is a confident "no shipped paths"; only an
  // UNCERTAIN set (step 3) is cannot-classify).
  if (implicated.size === 0) {
    return {
      verdict: 'no-cascade-confident',
      cascadeSet: [],
      reason: 'no implicated files — failure not attributable to any predecessor',
    };
  }

  // Map canonical phase → manifest key so we can pull its commits.
  const keyByCanonical = new Map<string, string>();
  for (const [k] of entries) keyByCanonical.set(canonicalizePhaseId(k) || k, k);

  const attributable: string[] = [];
  for (const phase of linkedPromoted) {
    const key = keyByCanonical.get(phase)!;
    const commits = (manifest[key]!.commits ?? []) as string[];
    let touchesImplicated = false;
    for (const commit of commits) {
      let paths: string[];
      try {
        paths = await commitTouchedPaths(projectDir, commit);
      } catch (err) {
        // Cannot diff a predecessor's commit → cannot make the attribution
        // call. Fail to cannot-classify rather than silently dropping the
        // candidate (the #2983 rule).
        return {
          verdict: 'cannot-classify',
          cascadeSet: [],
          reason: `cannot diff commit ${commit} of phase ${phase}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      if (paths.some(p => implicated.has(p.replace(/\\/g, '/')))) {
        touchesImplicated = true;
        break;
      }
    }
    if (touchesImplicated) attributable.push(phase);
  }

  if (attributable.length === 0) {
    return {
      verdict: 'no-cascade-confident',
      cascadeSet: [],
      reason: 'depends_on-linked predecessor(s) exist but none is file-attributable to the failure',
    };
  }

  // ── 6. revert-confident: order the cascade set in REVERSE promotion order ──
  // (newest-promoted first) — the order rollbackTier2 reverts them in, so a
  // later phase's revert lands before the earlier phase it sat on top of.
  const promotedAtByPhase = new Map<string, string>();
  for (const [k, e] of entries) {
    promotedAtByPhase.set(canonicalizePhaseId(k) || k, e.promoted_at);
  }
  const cascadeSet = [...attributable].sort((a, b) => {
    const ta = promotedAtByPhase.get(a) ?? '';
    const tb = promotedAtByPhase.get(b) ?? '';
    // Reverse chronological; ties broken by phase number descending for stability.
    if (ta !== tb) return tb.localeCompare(ta);
    return Number.parseFloat(b) - Number.parseFloat(a);
  });

  return {
    verdict: 'revert-confident',
    cascadeSet,
    reason: `cascade ${cascadeSet.length} attributable depends_on-linked predecessor(s): ${cascadeSet.join(', ')}`,
  };
}
