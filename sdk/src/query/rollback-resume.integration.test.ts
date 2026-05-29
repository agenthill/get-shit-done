/**
 * Tier-2 crash-resume idempotency — FALSIFIER against a real temp git repo
 * (ADR 0013 option 4, chunk 4, measure-of-success TEST 2).
 *
 * The measure: a crash mid-Tier-2 must replay ONLY the remaining steps on
 * restart — never double-revert, never leave an inconsistent STATE — and a
 * SECOND resume must be a no-op.
 *
 * Scenario (reuses the rollback-tier2 setup: phases 1+2 promoted, phase 2
 * depends_on 1 touching shared.ts):
 *   1. CRASH: drive rollbackTier2 with `journal:true` + a fault that throws right
 *      after the quarantine step persists. Assert ROLLBACK.json shows
 *      git_done/quarantine_done true, roadmap_done/requirements_done/state_done
 *      false — and the revert commit IS on protected, the SUMMARY IS quarantined,
 *      but ROADMAP phase 2 is still `[x]` and STATE is unrestored.
 *   2. RESUME: call resumeIncompleteRollback. Assert it replays ONLY the
 *      remaining steps (ROADMAP → `[ ]`, REQ-02 flipped, STATE restored) and does
 *      NOT double-revert: the revert-commit count is unchanged and protected HEAD
 *      equals the post-crash HEAD.
 *   3. SECOND RESUME: call it again → no-op (no new commits, no error, journal
 *      fully done, ledger halted).
 *
 * LC_ALL=C on the one sort so the assertion is locale-stable.
 */

import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile, access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GitMergeSerializer } from '../execution-engine.js';
import {
  createPhaseCheckpoint,
  ensureCheckpointGitignore,
} from './phase-checkpoint.js';
import { recordPhasePromotion } from './phase-manifest.js';
import type { PhaseManifest } from './phase-manifest.js';
import { rollbackTier2, resumeIncompleteRollback } from './rollback-engine.js';
import { readRollbackLedger } from './rollback-ledger.js';

const execFileAsync = promisify(execFile);
const gitIn = (dir: string) => (args: string[]) => execFileAsync('git', args, { cwd: dir });

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}
/** Count of `revert(phase-2): autonomous unwind` commits on a ref (LC_ALL=C). */
async function revertCommitCount(dir: string, ref: string): Promise<number> {
  const { stdout } = await execFileAsync(
    'git',
    ['log', '--format=%s', ref],
    { cwd: dir, env: { ...process.env, LC_ALL: 'C' } },
  );
  return stdout
    .split('\n')
    .map(l => l.trim())
    .filter(s => s === 'revert(phase-2): autonomous unwind').length;
}

/** Phases 1 + 2 promoted onto protected (phase 2 depends_on 1, touches shared.ts). */
async function setupTwoPromotedPhases(): Promise<{ dir: string; manifest: PhaseManifest }> {
  const dir = await mkdtemp(join(tmpdir(), 'gsd-resume-'));
  const git = gitIn(dir);
  await git(['init', '-q', '-b', 'main']);
  await git(['config', 'user.email', 't@t.t']);
  await git(['config', 'user.name', 'T']);
  await git(['config', 'commit.gpgsign', 'false']);

  await mkdir(join(dir, '.planning', 'phases', '01-foundation'), { recursive: true });
  await mkdir(join(dir, '.planning', 'phases', '02-build'), { recursive: true });
  await writeFile(
    join(dir, '.planning', 'ROADMAP.md'),
    [
      '## Milestone v1',
      '',
      '### Phase 1: Foundation',
      '**Goal:** lay it',
      '**Requirements:** REQ-01',
      '**Depends on:** None',
      '**Plans:** 1/1 plans complete',
      '',
      '### Phase 2: Build',
      '**Goal:** build it',
      '**Requirements:** REQ-02',
      '**Depends on:** Phase 1',
      '**Plans:** 1/1 plans complete',
      '',
      '- [x] Phase 1: Foundation (completed 2026-01-01)',
      '- [x] Phase 2: Build (completed 2026-01-02)',
      '',
    ].join('\n'),
  );
  await writeFile(
    join(dir, '.planning', 'REQUIREMENTS.md'),
    '- [x] **REQ-01** foundation\n- [x] **REQ-02** build\n',
  );
  await writeFile(join(dir, '.planning', 'STATE.md'), 'status: phase_complete\nphase: 2 COMPLETE\nTotal plans completed: 2\n');
  await writeFile(join(dir, '.planning', 'phases', '01-foundation', '01-SUMMARY.md'), '# phase 1 done\n');
  await writeFile(join(dir, '.planning', 'phases', '02-build', '02-SUMMARY.md'), '# phase 2 done\n');
  await ensureCheckpointGitignore(dir);
  await git(['add', '-A']);
  await git(['commit', '-q', '--no-verify', '-m', 'base']);

  const manifest: PhaseManifest = {};

  const cp1 = await createPhaseCheckpoint({ projectDir: dir, phaseNumber: '1', protectedBranch: 'main' });
  await git(['checkout', '-q', '-B', 'gsd-phase-1-int', cp1.lastGoodSha]);
  await writeFile(join(dir, 'indep.ts'), 'export const indep = 1;\n');
  await git(['add', '-A']);
  await git(['commit', '-q', '--no-verify', '-m', 'phase 1 work']);
  await git(['checkout', '-q', 'main']);
  await git(['merge', '--no-ff', '--no-edit', 'gsd-phase-1-int']);
  const head1 = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  manifest['1'] = await recordPhasePromotion({
    projectDir: dir, phaseNumber: '1', baseTag: cp1.baseTag, baseSha: cp1.lastGoodSha,
    headSha: head1, promotedAt: '2026-01-01T00:01:00.000Z', dependsOn: [],
  });

  const cp2 = await createPhaseCheckpoint({ projectDir: dir, phaseNumber: '2', protectedBranch: 'main' });
  await git(['checkout', '-q', '-B', 'gsd-phase-2-int', cp2.lastGoodSha]);
  await writeFile(join(dir, 'shared.ts'), 'export const built = true;\n');
  await git(['add', '-A']);
  await git(['commit', '-q', '--no-verify', '-m', 'phase 2 work']);
  await git(['checkout', '-q', 'main']);
  await git(['merge', '--no-ff', '--no-edit', 'gsd-phase-2-int']);
  const head2 = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  manifest['2'] = await recordPhasePromotion({
    projectDir: dir, phaseNumber: '2', baseTag: cp2.baseTag, baseSha: cp2.lastGoodSha,
    headSha: head2, promotedAt: '2026-01-02T00:01:00.000Z', dependsOn: ['1'],
  });

  return { dir, manifest };
}

class CrashAfterStep extends Error {}

describe('Tier-2 crash-resume idempotency (measure-of-success TEST 2)', () => {
  it('crash mid-Tier-2 → resume replays ONLY remaining steps, does NOT double-revert; second resume is a no-op', async () => {
    const { dir, manifest } = await setupTwoPromotedPhases();
    try {
      const git = gitIn(dir);
      const serializer = new GitMergeSerializer(dir, 'main', async () => 0);

      const protectedTipBeforeRevert = (await git(['rev-parse', 'main'])).stdout.trim();

      // ── 1. CRASH: fault throws right AFTER the quarantine step persists ──
      let crashed = false;
      try {
        await rollbackTier2({
          projectDir: dir,
          protectedBranch: 'main',
          protectedTipBeforeRevert,
          phaseNumber: '2',
          manifest,
          serializer,
          journal: true,
          faultAfterStep: (step) => {
            if (step === 'quarantine_done') throw new CrashAfterStep('simulated crash post-quarantine');
          },
        });
      } catch (e) {
        crashed = true;
        expect(e).toBeInstanceOf(CrashAfterStep);
      }
      expect(crashed).toBe(true);

      // Journal reflects steps 1-2 done, 3-5 not.
      const midLedger = await readRollbackLedger(dir);
      expect(midLedger?.steps?.['2']).toEqual({
        git_done: true,
        quarantine_done: true,
        roadmap_done: false,
        requirements_done: false,
        state_done: false,
      });

      // The revert commit DID land; the SUMMARY WAS quarantined; but ROADMAP +
      // STATE are NOT yet rolled back (the crash hit before step 3).
      const headAfterCrash = (await git(['rev-parse', 'main'])).stdout.trim();
      expect(await revertCommitCount(dir, 'main')).toBe(1);
      expect(await pathExists(join(dir, '.planning', '.rollback-quarantine', 'phase-2', '02-SUMMARY.md'))).toBe(true);
      expect(await pathExists(join(dir, '.planning', 'phases', '02-build', '02-SUMMARY.md'))).toBe(false);
      const roadmapMid = await readFile(join(dir, '.planning', 'ROADMAP.md'), 'utf-8');
      expect(roadmapMid).toMatch(/- \[x\] Phase 2: Build/); // NOT yet unchecked
      const stateMid = await readFile(join(dir, '.planning', 'STATE.md'), 'utf-8');
      expect(stateMid).toContain('2 COMPLETE'); // NOT yet restored

      // ── 2. RESUME: replays ONLY the remaining steps, no double-revert ──
      const resume1 = await resumeIncompleteRollback({
        projectDir: dir,
        protectedBranch: 'main',
        serializer,
        manifest,
      });
      expect(resume1.resumed).toBe(true);
      expect(resume1.phase).toBe('2');
      expect(resume1.result?.status).toBe('reverted');

      // No double-revert: still exactly ONE revert commit; HEAD unchanged from
      // the post-crash state (resume mutated only ROADMAP/REQ/STATE on disk).
      expect(await revertCommitCount(dir, 'main')).toBe(1);
      expect((await git(['rev-parse', 'main'])).stdout.trim()).toBe(headAfterCrash);

      // Remaining steps now applied: ROADMAP unchecked, REQ-02 flipped, STATE restored.
      const roadmapAfter = await readFile(join(dir, '.planning', 'ROADMAP.md'), 'utf-8');
      expect(roadmapAfter).toMatch(/- \[ \] Phase 2: Build/);
      expect(roadmapAfter).toMatch(/- \[x\] Phase 1: Foundation/);
      const reqAfter = await readFile(join(dir, '.planning', 'REQUIREMENTS.md'), 'utf-8');
      expect(reqAfter).toMatch(/- \[ \] \*\*REQ-02\*\*/);
      expect(reqAfter).toMatch(/- \[x\] \*\*REQ-01\*\*/);
      const snapState = await readFile(join(dir, '.planning', '.checkpoints', 'phase-2', 'STATE.md'), 'utf-8');
      const liveState = await readFile(join(dir, '.planning', 'STATE.md'), 'utf-8');
      expect(liveState).toBe(snapState);

      // Journal now all-done; ledger halted, tier 2.
      const doneLedger = await readRollbackLedger(dir);
      expect(doneLedger?.steps?.['2']).toEqual({
        git_done: true,
        quarantine_done: true,
        roadmap_done: true,
        requirements_done: true,
        state_done: true,
      });
      expect(doneLedger?.status).toBe('halted');
      expect(doneLedger?.tier).toBe(2);

      // ── 3. SECOND RESUME: a no-op (all flags done) ──
      const headBeforeSecond = (await git(['rev-parse', 'main'])).stdout.trim();
      const resume2 = await resumeIncompleteRollback({
        projectDir: dir,
        protectedBranch: 'main',
        serializer,
        manifest,
      });
      expect(resume2.resumed).toBe(false); // complete journal → no replay
      // No new commits, still one revert, HEAD unchanged.
      expect((await git(['rev-parse', 'main'])).stdout.trim()).toBe(headBeforeSecond);
      expect(await revertCommitCount(dir, 'main')).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
