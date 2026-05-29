/**
 * Tier-1 rollback engine — integration test against a real temp git repo
 * (ADR 0013 option 4, chunk 2 step 6).
 *
 * Falsifies the clean-rollback property: a phase that FAILED (never promoted)
 * is torn down to a state where
 *   - protected is provably still at LAST_GOOD (no failed work landed),
 *   - the integration branch + base tag are gone,
 *   - the per-plan worktree branches are reaped via `branch -D` (NOT merged —
 *     asserted by the ABSENCE of any merge commit for the phase on protected),
 *   - STATE.md / ROADMAP.md / REQUIREMENTS.md are restored from the checkpoint
 *     snapshot (disk_status reverted to planned/pending).
 */

import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  createPhaseCheckpoint,
  ensureCheckpointGitignore,
  integrationBranchFor,
  baseTagFor,
} from './phase-checkpoint.js';
import { branchNameFor } from '../execution-engine.js';
import { rollbackTier1 } from './rollback-engine.js';

const execFileAsync = promisify(execFile);

function gitIn(dir: string) {
  return (args: string[]) => execFileAsync('git', args, { cwd: dir });
}

async function initRepo(): Promise<{ dir: string; baseSha: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'gsd-rb-repo-'));
  const git = gitIn(dir);
  await git(['init', '-q', '-b', 'main']);
  await git(['config', 'user.email', 't@t.t']);
  await git(['config', 'user.name', 'T']);
  await git(['config', 'commit.gpgsign', 'false']);
  // Seed the planning docs in their PLANNED state (this is what the checkpoint
  // snapshots and what rollback must restore to).
  await mkdir(join(dir, '.planning'), { recursive: true });
  await writeFile(join(dir, '.planning', 'STATE.md'), 'status: ready_to_plan\nphase: 1 planned\n');
  await writeFile(join(dir, '.planning', 'ROADMAP.md'), '- [ ] Phase 1: Thing\n');
  await writeFile(join(dir, '.planning', 'REQUIREMENTS.md'), '- [ ] **REQ-01** thing\n');
  await writeFile(join(dir, 'base.txt'), 'base\n');
  // Git-ignore the checkpoint snapshot dir in the base commit (production flow
  // does this in beginPhaseIntegration) so `git add -A` never stages the
  // snapshot and `git checkout` never clobbers it — and so LAST_GOOD == baseSha.
  await ensureCheckpointGitignore(dir);
  await git(['add', '-A']);
  await git(['commit', '-q', '--no-verify', '-m', 'base']);
  const baseSha = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  return { dir, baseSha };
}

/** Stage the failed-phase state the spine would leave: integration branch with
 * a commit, base tag, a per-plan worktree branch with a commit, and DIRTIED
 * planning docs (as a phaseComplete-on-the-working-copy would write). */
async function stageFailedPhase(
  dir: string,
  baseSha: string,
  phaseNumber: string,
): Promise<{ snapshotDir: string }> {
  const git = gitIn(dir);

  // 1. Checkpoint at LAST_GOOD (snapshots the PLANNED docs + writes base tag).
  const checkpoint = await createPhaseCheckpoint({
    projectDir: dir,
    phaseNumber,
    protectedBranch: 'main',
  });
  expect(checkpoint.lastGoodSha).toBe(baseSha);

  // 2. Integration branch forked off LAST_GOOD with a commit (the failed work
  //    that accumulated but never promoted).
  const intBranch = integrationBranchFor(phaseNumber);
  await git(['checkout', '-q', '-B', intBranch, baseSha]);
  await writeFile(join(dir, 'phase-work.txt'), 'failed work\n');
  await git(['add', '-A']);
  await git(['commit', '-q', '--no-verify', '-m', 'phase-1 integration work']);

  // 3. A per-plan worktree on `worktree-agent-<phase>-<id>` with its own commit.
  const planBranch = branchNameFor(Number(phaseNumber), '01');
  const wtDir = join(dir, '.wt', `wt-${phaseNumber}-01`);
  await mkdir(join(dir, '.wt'), { recursive: true });
  await git(['worktree', 'add', '-q', '-b', planBranch, wtDir, baseSha]);
  await writeFile(join(wtDir, 'plan-01.txt'), 'plan 1 work\n');
  await gitIn(wtDir)(['add', '-A']);
  await gitIn(wtDir)(['commit', '-q', '--no-verify', '-m', 'plan-01 work']);

  // 4. Dirty the working-copy planning docs as a (rolled-back) completion would
  //    have — proves rollback restores them to the snapshot. Done while HEAD is
  //    NOT main; the restore is a working-copy overwrite, no commit on main.
  await git(['checkout', '-q', 'main']);
  await writeFile(join(dir, '.planning', 'STATE.md'), 'status: phase_complete\nphase: 1 COMPLETE\n');
  await writeFile(join(dir, '.planning', 'ROADMAP.md'), '- [x] Phase 1: Thing (completed 2026-01-01)\n');
  await writeFile(join(dir, '.planning', 'REQUIREMENTS.md'), '- [x] **REQ-01** thing\n');
  // Leave HEAD on the integration branch (the spine leaves the failed phase's
  // tree there); rollback must check out protected itself.
  await git(['checkout', '-q', intBranch]);

  return { snapshotDir: checkpoint.snapshotDir };
}

/** Commit subjects reachable from a ref (newest-first). */
async function logSubjects(dir: string, ref: string): Promise<string[]> {
  const { stdout } = await gitIn(dir)(['log', '--format=%s', ref]);
  return stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

async function refExists(dir: string, ref: string): Promise<boolean> {
  try {
    await gitIn(dir)(['rev-parse', '--verify', `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

describe('rollbackTier1 — clean rollback of a failed (never-promoted) phase', () => {
  it('leaves protected at LAST_GOOD, deletes the integration branch + base tag, reaps per-plan branches via branch -D (no merge), and restores planning docs', async () => {
    const { dir, baseSha } = await initRepo();
    try {
      const phaseNumber = '1';
      const { snapshotDir } = await stageFailedPhase(dir, baseSha, phaseNumber);

      const intBranch = integrationBranchFor(phaseNumber);
      const planBranch = branchNameFor(Number(phaseNumber), '01');
      // Pre-conditions: the failed-phase artifacts all exist.
      expect(await refExists(dir, intBranch)).toBe(true);
      expect(await refExists(dir, planBranch)).toBe(true);
      expect(await refExists(dir, baseTagFor(phaseNumber))).toBe(true);

      const result = await rollbackTier1({
        projectDir: dir,
        phaseNumber,
        protectedBranch: 'main',
        lastGoodSha: baseSha,
        snapshotDir,
        integrationBranch: intBranch,
      });

      // ── Protected provably unchanged ──
      expect(result.protectedSha).toBe(baseSha);
      const mainSha = (await gitIn(dir)(['rev-parse', 'main'])).stdout.trim();
      expect(mainSha).toBe(baseSha);

      // ── Integration branch + base tag gone ──
      expect(result.integrationBranchDeleted).toBe(true);
      expect(result.baseTagDeleted).toBe(true);
      expect(await refExists(dir, intBranch)).toBe(false);
      expect(await refExists(dir, baseTagFor(phaseNumber))).toBe(false);

      // ── Per-plan branch reaped via branch -D ──
      expect(result.reapedBranches).toContain(planBranch);
      expect(await refExists(dir, planBranch)).toBe(false);

      // ── No merge happened: protected's history is exactly the base commit, and
      //    NONE of the failed work's subjects appear on protected ──
      const mainSubjects = await logSubjects(dir, 'main');
      expect(mainSubjects).toEqual(['base']);
      expect(mainSubjects).not.toContain('phase-1 integration work');
      expect(mainSubjects).not.toContain('plan-01 work');
      // And there is no merge commit on protected (branch -D, never a merge).
      const mergeCommits = (await gitIn(dir)(['rev-list', '--merges', 'main'])).stdout.trim();
      expect(mergeCommits).toBe('');

      // ── Planning docs restored to the PLANNED snapshot ──
      expect(result.restoredDocs.sort()).toEqual(['REQUIREMENTS.md', 'ROADMAP.md', 'STATE.md']);
      const state = await readFile(join(dir, '.planning', 'STATE.md'), 'utf-8');
      const roadmap = await readFile(join(dir, '.planning', 'ROADMAP.md'), 'utf-8');
      const req = await readFile(join(dir, '.planning', 'REQUIREMENTS.md'), 'utf-8');
      expect(state).toContain('ready_to_plan');
      expect(state).not.toContain('COMPLETE');
      expect(roadmap).toContain('- [ ] Phase 1: Thing');
      expect(roadmap).not.toContain('[x]');
      expect(req).toContain('- [ ] **REQ-01**');
      expect(req).not.toContain('[x]');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('throws (fail-closed) when protected has MOVED off LAST_GOOD', async () => {
    const { dir, baseSha } = await initRepo();
    try {
      const phaseNumber = '1';
      const { snapshotDir } = await stageFailedPhase(dir, baseSha, phaseNumber);

      // Simulate the corruption the assert guards against: protected advanced.
      await gitIn(dir)(['checkout', '-q', 'main']);
      await writeFile(join(dir, 'leaked.txt'), 'leaked\n');
      await gitIn(dir)(['add', '-A']);
      await gitIn(dir)(['commit', '-q', '--no-verify', '-m', 'leaked work onto protected']);
      // Back to the integration branch so rollback's checkout path is realistic.
      await gitIn(dir)(['checkout', '-q', integrationBranchFor(phaseNumber)]);

      await expect(
        rollbackTier1({
          projectDir: dir,
          phaseNumber,
          protectedBranch: 'main',
          lastGoodSha: baseSha,
          snapshotDir,
          integrationBranch: integrationBranchFor(phaseNumber),
        }),
      ).rejects.toThrow(/invariant violated/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
