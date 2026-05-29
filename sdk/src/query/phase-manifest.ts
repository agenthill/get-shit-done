/**
 * Phase manifest writer (ADR 0013 option 4, chunk 1).
 *
 * Append-only ledger of phase PROMOTIONS at `.planning/.phase-manifest.json`.
 * Each entry records what a phase promoted onto the protected branch: the
 * checkpoint base tag + sha it forked off, the head it promoted, and every
 * commit in `base_sha..head_sha`. Rollback (chunk 2) reads this to know exactly
 * which commits a phase contributed; `depends_on` (empty for now) is where
 * chunk 3's cross-phase dependency edges land.
 *
 * NO CLOCK in the writer: `promotedAt` is passed in by the caller (the
 * orchestrator stamps `new Date().toISOString()` at the promote call site in
 * index.ts / phase-runner.ts). This keeps the writer deterministic and testable.
 *
 * Single-writer: only the orchestrator promotes, so the read-modify-write of the
 * manifest is never concurrent with another writer.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const execFileAsync = promisify(execFile);

export interface PhaseManifestEntry {
  base_tag: string;
  base_sha: string;
  head_sha: string;
  /** Commits in base_sha..head_sha (oldest-first), this phase's contribution. */
  commits: string[];
  /** ISO-8601 promotion timestamp, stamped by the caller. */
  promoted_at: string;
  /** Cross-phase dependency edges (chunk 3). Empty for now. */
  depends_on: string[];
}

/** The on-disk manifest shape: phaseNumber → entry. */
export type PhaseManifest = Record<string, PhaseManifestEntry>;

export interface RecordPhasePromotionInput {
  projectDir: string;
  phaseNumber: string;
  baseTag: string;
  baseSha: string;
  headSha: string;
  /** ISO-8601 timestamp; the caller stamps it (no clock in the writer). */
  promotedAt: string;
}

/** `.planning/.phase-manifest.json` for a project. */
export function phaseManifestPath(projectDir: string): string {
  return join(projectDir, '.planning', '.phase-manifest.json');
}

/**
 * Record a phase promotion. Computes `commits = git rev-list base_sha..head_sha`
 * (reversed to oldest-first for readability), reads the existing manifest,
 * upserts the phase entry, and writes the manifest back. Returns the entry it
 * wrote.
 */
export async function recordPhasePromotion(
  input: RecordPhasePromotionInput,
): Promise<PhaseManifestEntry> {
  const { projectDir, phaseNumber, baseTag, baseSha, headSha, promotedAt } = input;
  const git = (args: string[]) => execFileAsync('git', args, { cwd: projectDir });

  // Commits this phase contributed: base_sha (exclusive)..head_sha (inclusive).
  // rev-list is newest-first; reverse to oldest-first so the manifest reads in
  // application order.
  let commits: string[] = [];
  try {
    const { stdout } = await git(['rev-list', `${baseSha}..${headSha}`]);
    commits = stdout
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0)
      .reverse();
  } catch {
    // base_sha..head_sha unresolvable (e.g. headSha === baseSha after an empty
    // promote) → no commits attributed to the phase.
    commits = [];
  }

  const entry: PhaseManifestEntry = {
    base_tag: baseTag,
    base_sha: baseSha,
    head_sha: headSha,
    commits,
    promoted_at: promotedAt,
    depends_on: [],
  };

  const manifest = await readPhaseManifest(projectDir);
  manifest[String(phaseNumber)] = entry;

  const path = phaseManifestPath(projectDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);

  return entry;
}

/**
 * Read the phase manifest. Returns `{}` when absent or malformed — a manifest
 * is a derived ledger, never a source of truth, so a missing/corrupt file is
 * treated as empty rather than fatal.
 */
export async function readPhaseManifest(projectDir: string): Promise<PhaseManifest> {
  const path = phaseManifestPath(projectDir);
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as PhaseManifest;
    }
    return {};
  } catch {
    return {};
  }
}
