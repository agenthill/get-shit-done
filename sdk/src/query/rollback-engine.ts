/**
 * Tier-1 rollback engine (ADR 0013 option 4, chunk 2 — autonomous cross-phase
 * + rollback).
 *
 * Tier-1 = a CLEAN rollback of a phase that FAILED its gate/verify and was
 * therefore NEVER promoted onto the protected branch. Because the per-phase
 * integration spine (chunk 1) is atomic — protected moves ONLY on a green
 * promote — the protected branch is provably still at LAST_GOOD when this runs.
 * Tier-1's job is to make the WHOLE working state consistent with that: tear
 * down the failed phase's integration branch + checkpoint tag, discard its
 * per-plan worktrees WITHOUT merging them anywhere, and restore the planning
 * docs from the byte-snapshot the checkpoint took.
 *
 * Tier-2 (reverting an ALREADY-PROMOTED earlier phase via the manifest) is
 * chunk 3 and is NOT implemented here.
 *
 * The load-bearing safety distinction (vs the wave-cleanup path): reaping a
 * failed phase's worktrees must DELETE the branches (`git branch -D`), never
 * merge them. `executeWorktreeWaveCleanupPlan` (bin/lib/worktree-safety.cjs)
 * merges a worktree's branch onto HEAD — using it here would land the failed
 * work on protected, the exact corruption the integration spine exists to
 * prevent. So this engine force-removes the worktrees and force-deletes the
 * branches directly.
 *
 * Single-writer: only the orchestrator drives rollback, sequentially, between
 * phases — never concurrent with the per-plan merge mutex.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import { GSDError, ErrorClassification } from '../errors.js';
import { branchNameFor } from '../execution-engine.js';
import { baseTagFor } from './phase-checkpoint.js';

const execFileAsync = promisify(execFile);

/** Planning docs the checkpoint snapshotted; restored byte-for-byte on rollback. */
const CHECKPOINT_DOCS = ['STATE.md', 'ROADMAP.md', 'REQUIREMENTS.md'] as const;

export interface RollbackTier1Input {
  projectDir: string;
  /** Phase number as it appears on the roadmap (e.g. "1", "02", "5.1"). */
  phaseNumber: string;
  /** The branch the phase was supposed to promote onto (still at LAST_GOOD). */
  protectedBranch: string;
  /** Protected HEAD at checkpoint time — the recoverable point we assert against. */
  lastGoodSha: string;
  /** Checkpoint snapshot dir (`.planning/.checkpoints/phase-<N>/`) to restore from. */
  snapshotDir: string;
  /** The orchestrator-owned per-phase integration branch (`gsd-phase-<N>-int`). */
  integrationBranch: string;
}

export interface RollbackTier1Result {
  /** Protected HEAD after rollback — asserted to equal lastGoodSha. */
  protectedSha: string;
  /** True if the integration branch was present and deleted. */
  integrationBranchDeleted: boolean;
  /** True if the `gsd/phase-<N>-base` tag was present and deleted. */
  baseTagDeleted: boolean;
  /** Per-plan worktree branches reaped (force-removed + branch -D), oldest-first. */
  reapedBranches: string[];
  /** Planning docs restored from the snapshot (subset of CHECKPOINT_DOCS that existed). */
  restoredDocs: string[];
}

/**
 * Roll back a phase that FAILED and was NEVER promoted, leaving a clean tree
 * with protected provably still at LAST_GOOD.
 *
 * Sequence (each step fail-tolerant where the post-condition is what matters;
 * the final assert is the hard gate):
 *   1. `git checkout <protectedBranch>` (it is still at LAST_GOOD) then
 *      `git branch -D <integrationBranch>`; delete the `gsd/phase-<N>-base` tag.
 *   2. Reap the phase's per-plan worktrees: `git worktree remove --force` each
 *      worktree whose branch is `worktree-agent-<phase>-*`, then `git branch -D`
 *      the branch. Force-DELETE (never merge) — the failed work is discarded.
 *   3. Restore STATE.md / ROADMAP.md / REQUIREMENTS.md from the checkpoint
 *      byte-snapshot (a non-green phase never committed these to protected, so
 *      this restores the working copy).
 *   4. Assert protected HEAD == LAST_GOOD. If protected moved, THROW — something
 *      promoted work that should never have reached protected (fail-closed).
 */
export async function rollbackTier1(input: RollbackTier1Input): Promise<RollbackTier1Result> {
  const { projectDir, phaseNumber, protectedBranch, lastGoodSha, snapshotDir, integrationBranch } =
    input;
  const git = (args: string[], cwd = projectDir) => execFileAsync('git', args, { cwd });

  // ── 1. Return protected to the foreground, tear down the integration branch + base tag ──
  // Protected is still at LAST_GOOD (the phase never promoted). Check it out so
  // the working tree is on protected before we delete the integration branch
  // (you cannot delete the branch you are on). Plain `checkout` (not -f) is
  // intentional: protected has no failed work, and the per-plan deltas live on
  // the integration branch / worktree branches we are about to discard.
  await git(['checkout', protectedBranch]);

  let integrationBranchDeleted = false;
  if (await branchExists(git, integrationBranch)) {
    // -D (force) deletes regardless of merge status — the integration branch
    // carries the failed phase's commits and is NOT merged into protected.
    await git(['branch', '-D', integrationBranch]);
    integrationBranchDeleted = true;
  }

  let baseTagDeleted = false;
  const baseTag = baseTagFor(phaseNumber);
  if (await tagExists(git, baseTag)) {
    await git(['tag', '-d', baseTag]);
    baseTagDeleted = true;
  }

  // ── 2. Reap the phase's per-plan worktrees (force-remove + branch -D) ──
  // The per-plan branches are `worktree-agent-<phase>-<id>` (branchNameFor). We
  // derive the deterministic prefix (a sanitized planId always follows the
  // trailing dash) and reap every worktree/branch under it. This DELETES the
  // branches — it never merges them, the load-bearing distinction from
  // executeWorktreeWaveCleanupPlan.
  const reapedBranches = await reapPhaseWorktrees(git, projectDir, phaseNumber);

  // ── 3. Restore the planning docs from the checkpoint byte-snapshot ──
  // phaseComplete never committed these to protected on a non-green phase, so
  // restoring the working copy returns disk_status to planned/pending. Only the
  // docs that were snapshotted (i.e. existed at checkpoint time) are restored.
  const restoredDocs: string[] = [];
  for (const doc of CHECKPOINT_DOCS) {
    const src = join(snapshotDir, doc);
    if (await pathExists(src)) {
      await copyFile(src, join(projectDir, '.planning', doc));
      restoredDocs.push(doc);
    }
  }

  // ── 4. Fail-closed assert: protected HEAD must still be LAST_GOOD ──
  const protectedSha = (await git(['rev-parse', protectedBranch])).stdout.trim();
  if (protectedSha !== lastGoodSha) {
    throw new GSDError(
      `Tier-1 rollback invariant violated: protected branch ${protectedBranch} is at ${protectedSha}, ` +
        `expected LAST_GOOD ${lastGoodSha}. A non-green phase appears to have moved protected — ` +
        `refusing to declare a clean rollback.`,
      ErrorClassification.Execution,
    );
  }

  return {
    protectedSha,
    integrationBranchDeleted,
    baseTagDeleted,
    reapedBranches,
    restoredDocs,
  };
}

/**
 * Reap the per-plan worktrees + branches for a phase. For every linked worktree
 * whose checked-out branch is `worktree-agent-<phase>-*`, force-remove the
 * worktree then force-delete the branch. Also force-deletes any matching branch
 * with no live worktree (a worktree that was already cleaned up by the engine's
 * own per-plan cleanup, leaving the branch behind for the integration merge).
 *
 * Force (`worktree remove --force`, `branch -D`) is required: the failed phase's
 * work is being DISCARDED, so these branches are unmerged by design.
 */
async function reapPhaseWorktrees(
  git: (args: string[], cwd?: string) => Promise<{ stdout: string }>,
  projectDir: string,
  phaseNumber: string,
): Promise<string[]> {
  // Deterministic prefix for this phase's per-plan branches. The prefix MUST be
  // derived the SAME way chunk 1 creates the branches, or a decimal phase reaps
  // nothing: phase-runner.ts forks per-plan branches with
  // `phaseTag = Number.parseInt(phaseNumber, 10)` (the `Number.isFinite ? : 0`
  // fallback for a non-numeric phase). A naive `Number("5.1")` here would yield
  // `worktree-agent-5.1-` and MISS the real `worktree-agent-5-*` branches that
  // `parseInt("5.1", 10) === 5` created. Match branch creation exactly.
  const phaseLevel = Number.parseInt(phaseNumber, 10);
  const phaseTag = Number.isFinite(phaseLevel) ? phaseLevel : 0;
  const prefix = branchNameFor(phaseTag, '').replace(/-$/, ''); // worktree-agent-<phaseTag>
  const branchPrefix = `${prefix}-`;

  const reaped: string[] = [];

  // First pass: worktrees whose branch matches the prefix → remove the worktree.
  let porcelain = '';
  try {
    porcelain = (await git(['worktree', 'list', '--porcelain'])).stdout;
  } catch {
    porcelain = '';
  }
  // Parse `git worktree list --porcelain` blocks: each block has a `worktree
  // <path>` line and (for attached worktrees) a `branch refs/heads/<name>` line.
  for (const block of porcelain.replace(/\r\n/g, '\n').split('\n\n')) {
    const lines = block.split('\n');
    const wtLine = lines.find((l) => l.startsWith('worktree '));
    const brLine = lines.find((l) => l.startsWith('branch '));
    if (!wtLine || !brLine) continue;
    const wtPath = wtLine.slice('worktree '.length).trim();
    const branch = brLine.slice('branch refs/heads/'.length).trim();
    if (!branch.startsWith(branchPrefix)) continue;
    // Discard the worktree (force — it has uncommitted/committed failed work).
    try {
      await git(['worktree', 'remove', '--force', wtPath]);
    } catch {
      // best-effort; the branch -D pass below still discards the branch
    }
  }

  // Prune any stale worktree admin metadata left by force-removes.
  try {
    await git(['worktree', 'prune']);
  } catch {
    /* non-fatal */
  }

  // Second pass: force-delete every branch under the prefix (worktree-backed or
  // not — e.g. branches left behind for the integration merge after per-plan
  // cleanup already removed the worktree dir).
  let branchList = '';
  try {
    branchList = (
      await git(['for-each-ref', '--format=%(refname:short)', `refs/heads/${branchPrefix}*`])
    ).stdout;
  } catch {
    branchList = '';
  }
  const branches = branchList
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((b) => b.trim())
    .filter(Boolean)
    .sort();
  for (const branch of branches) {
    try {
      await git(['branch', '-D', branch]);
      reaped.push(branch);
    } catch {
      // A branch still backing a live worktree we failed to remove cannot be
      // deleted; leave it rather than corrupt state. The final protected-HEAD
      // assert is the real safety gate.
    }
  }

  return reaped;
}

async function branchExists(
  git: (args: string[]) => Promise<{ stdout: string }>,
  branch: string,
): Promise<boolean> {
  try {
    await git(['rev-parse', '--verify', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

async function tagExists(
  git: (args: string[]) => Promise<{ stdout: string }>,
  tag: string,
): Promise<boolean> {
  try {
    await git(['rev-parse', '--verify', `refs/tags/${tag}`]);
    return true;
  } catch {
    return false;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}
