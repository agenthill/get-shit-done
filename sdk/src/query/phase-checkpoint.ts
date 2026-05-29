/**
 * Phase checkpoint primitive (ADR 0013 option 4 — autonomous cross-phase +
 * rollback, chunk 1: the per-phase lifecycle spine).
 *
 * Before a phase executes under the isolated git engine, the orchestrator
 * records LAST_GOOD — the protected branch HEAD — so the phase is recoverable
 * to a known-good point regardless of what the phase does on its integration
 * branch. The checkpoint is:
 *
 *  - LAST_GOOD sha (protected HEAD at checkpoint time);
 *  - an annotated git tag `gsd/phase-<N>-base` pinned at LAST_GOOD (net-new tag
 *    convention; the repo has 0 tags). The tag message carries the phase number
 *    and the sha so the checkpoint is self-describing from `git tag -n`/`git
 *    cat-file`;
 *  - a byte-for-byte snapshot of the planning docs (STATE.md, ROADMAP.md,
 *    REQUIREMENTS.md — only those that exist) into
 *    `.planning/.checkpoints/phase-<N>/`. Rollback (chunk 2) restores from here.
 *
 * Pure SDK/git ops via execFile, mirroring the git-helper style in
 * execution-engine.ts / build-execution-engine.ts. No clock/randomness of our
 * own. Single-writer: only the orchestrator calls this; executors never do.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, copyFile, readFile, writeFile, access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

/** Planning docs snapshotted into the checkpoint (only those that exist). */
const CHECKPOINT_DOCS = ['STATE.md', 'ROADMAP.md', 'REQUIREMENTS.md'] as const;

export interface PhaseCheckpoint {
  /** Protected branch HEAD sha at checkpoint time (the recoverable point). */
  lastGoodSha: string;
  /** Annotated tag pinned at lastGoodSha. */
  baseTag: string;
  /** Directory the planning-doc byte-snapshots were copied into. */
  snapshotDir: string;
}

export interface CreatePhaseCheckpointInput {
  projectDir: string;
  /** Phase number as it appears on the roadmap (e.g. "1", "02", "5.1"). */
  phaseNumber: string;
  /** Protected branch the phase forks off and ultimately promotes to. */
  protectedBranch: string;
}

/** `gsd/phase-<N>-base` — the checkpoint tag pinned at LAST_GOOD. */
export function baseTagFor(phaseNumber: string): string {
  return `gsd/phase-${sanitizePhase(phaseNumber)}-base`;
}

/** `gsd/phase-<N>-done` — applied by the orchestrator on promote-on-green. */
export function doneTagFor(phaseNumber: string): string {
  return `gsd/phase-${sanitizePhase(phaseNumber)}-done`;
}

/** `gsd-phase-<N>-int` — the orchestrator-owned per-phase integration branch. */
export function integrationBranchFor(phaseNumber: string): string {
  return `gsd-phase-${sanitizePhase(phaseNumber)}-int`;
}

/** `.planning/.checkpoints/phase-<N>` — the per-phase snapshot directory. */
export function checkpointDirFor(projectDir: string, phaseNumber: string): string {
  return join(projectDir, '.planning', '.checkpoints', `phase-${sanitizePhase(phaseNumber)}`);
}

/**
 * Record LAST_GOOD, tag it, and byte-snapshot the planning docs. Returns the
 * recoverable point + the artifacts the orchestrator and rollback rely on.
 */
export async function createPhaseCheckpoint(
  input: CreatePhaseCheckpointInput,
): Promise<PhaseCheckpoint> {
  const { projectDir, phaseNumber, protectedBranch } = input;
  const git = (args: string[]) => execFileAsync('git', args, { cwd: projectDir });

  // LAST_GOOD = the protected branch HEAD (NOT the working-tree HEAD, which may
  // already be on an integration branch from a prior phase in the same run).
  const lastGoodSha = (await git(['rev-parse', protectedBranch])).stdout.trim();

  // Annotated tag at LAST_GOOD. Force (-f) so a re-run of the same phase (resume
  // / retry) re-pins rather than failing on an existing tag. The message is the
  // self-describing checkpoint record.
  const baseTag = baseTagFor(phaseNumber);
  await git([
    'tag',
    '-f',
    '-a',
    baseTag,
    '-m',
    `gsd phase ${phaseNumber} checkpoint base @ ${lastGoodSha}`,
    lastGoodSha,
  ]);

  // Byte-snapshot the planning docs that exist into the checkpoint dir.
  const snapshotDir = checkpointDirFor(projectDir, phaseNumber);
  await mkdir(snapshotDir, { recursive: true });
  const planningDir = join(projectDir, '.planning');
  for (const doc of CHECKPOINT_DOCS) {
    const src = join(planningDir, doc);
    if (await pathExists(src)) {
      await copyFile(src, join(snapshotDir, doc));
    }
  }

  return { lastGoodSha, baseTag, snapshotDir };
}

/**
 * Ensure `.planning/.checkpoints/` and `.planning/.rollback-quarantine/` are
 * git-ignored at the repo root, so the merge guard suite's `git add -A` /
 * `git checkout` ops can never stage or clobber checkpoint snapshots. Idempotent
 * (appends only the entries that are not already present, byte-exact lines).
 *
 * The repo-root `.gitignore` is the SDK package's parent — the SDK ships as
 * `<root>/sdk`, but the engine operates on the consumer's `projectDir`, so the
 * ignore lives in the consumer repo root (`projectDir/.gitignore`).
 */
export async function ensureCheckpointGitignore(projectDir: string): Promise<void> {
  const entries = ['.planning/.checkpoints/', '.planning/.rollback-quarantine/'];
  const gitignorePath = join(projectDir, '.gitignore');

  let existing = '';
  try {
    existing = await readFile(gitignorePath, 'utf-8');
  } catch {
    // No .gitignore yet — we will create it with just our entries.
  }

  const present = new Set(existing.split(/\r?\n/).map(l => l.trim()));
  const missing = entries.filter(e => !present.has(e));
  if (missing.length === 0) return;

  const needsLeadingNewline = existing.length > 0 && !existing.endsWith('\n');
  const block =
    (needsLeadingNewline ? '\n' : '') +
    (existing.length > 0 ? '\n# GSD phase checkpoints / rollback quarantine (ADR 0013)\n' : '# GSD phase checkpoints / rollback quarantine (ADR 0013)\n') +
    missing.map(e => `${e}\n`).join('');
  await writeFile(gitignorePath, existing + block);
}

function sanitizePhase(phaseNumber: string): string {
  return String(phaseNumber).replace(/[^A-Za-z0-9._-]/g, '-');
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}
