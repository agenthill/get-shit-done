/**
 * Autonomous crash-resume HALT — FALSIFIER (ADR 0013 option 4, chunk 4).
 *
 * The locked invariant: the autonomous driver NEVER auto-advances after a Tier-2
 * cascade. The clean path enforces this (maybeCascadeTier2 → halted → the loop
 * breaks with success=false). This test falsifies the CRASH-RESUME path: a
 * process that crashed mid-Tier-2 unwind and is restarted must FINISH the unwind
 * AND then halt — it must NOT fall through into the next phase.
 *
 * Scenario (reuses the rollback-resume crash setup: phases 1+2 promoted, phase 2
 * depends_on 1 touching shared.ts):
 *   1. CRASH: drive rollbackTier2 with `journal:true` + a fault that throws right
 *      after the quarantine step persists, leaving ROLLBACK.json with an
 *      INCOMPLETE per-step journal (git_done/quarantine_done true; roadmap_done/
 *      requirements_done/state_done false). The phase-2 revert IS on protected and
 *      the phase-2 checkpoint snapshot IS present, so resume can finish steps 3-5.
 *   2. RESTART: drive GSD.run. The top-of-loop resume finishes the unwind, then
 *      the driver HALTS for a human.
 *
 * ASSERT: GSD.run returns success=false (halted); the phase executor (runPhase)
 * was NEVER invoked (the loop did not advance); ROLLBACK.json ends {tier:2,
 * status:'halted'} with the phase-2 journal all-done; ROADMAP phase 2 `[ ]`,
 * phase 1 still `[x]`, STATE restored from the snapshot.
 *
 * LC_ALL=C on the one log parse so the assertion is locale-stable.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GSD } from './index.js';
import {
  createPhaseCheckpoint,
  ensureCheckpointGitignore,
} from './query/phase-checkpoint.js';
import { recordPhasePromotion } from './query/phase-manifest.js';
import type { PhaseManifest } from './query/phase-manifest.js';
import { rollbackTier2 } from './query/rollback-engine.js';
import { readRollbackLedger } from './query/rollback-ledger.js';
import { GitMergeSerializer } from './execution-engine.js';
import type { RoadmapAnalysis } from './types.js';

const execFileAsync = promisify(execFile);
const gitIn = (dir: string) => (args: string[]) => execFileAsync('git', args, { cwd: dir });

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
  const dir = await mkdtemp(join(tmpdir(), 'gsd-resume-halt-'));
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

/**
 * Crash mid-Tier-2 to leave an INCOMPLETE per-step journal on disk: drive
 * rollbackTier2(journal:true) with a fault that throws right after the quarantine
 * step persists (steps 1-2 done, 3-5 not). The phase-2 revert IS on protected and
 * the snapshot IS present, so a subsequent resume can finish steps 3-5.
 */
async function crashMidTier2(dir: string, manifest: PhaseManifest): Promise<void> {
  const git = gitIn(dir);
  const serializer = new GitMergeSerializer(dir, 'main', async () => 0);
  const protectedTipBeforeRevert = (await git(['rev-parse', 'main'])).stdout.trim();
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
}

// Phase 3 is the only incomplete phase the (would-be) loop could advance into.
function phase3Info(): RoadmapAnalysis {
  return { phases: [{ number: '3', disk_status: 'planned', roadmap_complete: false, phase_name: 'Ship' }] };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Autonomous crash-resume HALT — never auto-advance after a resumed Tier-2', () => {
  it('finishes the interrupted unwind, then HALTS (success=false) without running any phase', async () => {
    const { dir, manifest } = await setupTwoPromotedPhases();
    try {
      // ── Arrange the crashed-mid-Tier-2 state: incomplete journal on disk ──
      await crashMidTier2(dir, manifest);

      // Precondition sanity: the journal IS incomplete (steps 3-5 not done) and
      // ROADMAP phase 2 is still `[x]` (the crash hit before step 3).
      const midLedger = await readRollbackLedger(dir);
      expect(midLedger?.steps?.['2']).toEqual({
        git_done: true,
        quarantine_done: true,
        roadmap_done: false,
        requirements_done: false,
        state_done: false,
      });
      const roadmapMid = await readFile(join(dir, '.planning', 'ROADMAP.md'), 'utf-8');
      expect(roadmapMid).toMatch(/- \[x\] Phase 2: Build/);
      expect(await revertCommitCount(dir, 'main')).toBe(1);

      // ── Act: restart the autonomous driver ──
      const gsd = new GSD({ projectDir: dir });
      vi.spyOn(gsd, 'createTools').mockReturnValue({
        roadmapAnalyze: vi.fn().mockResolvedValue(phase3Info()),
      } as never);
      // Spy on the phase executor: if the loop advanced, this WOULD fire. The
      // resume-halt invariant requires it NEVER does.
      const runPhaseSpy = vi.spyOn(gsd, 'runPhase').mockImplementation((async () => {
        throw new Error('runPhase must NOT be invoked after a resumed Tier-2 unwind');
      }) as never);

      const result = await gsd.run('ship it');

      // ── Assert: halted (success=false), and the loop NEVER advanced ──
      expect(result.success).toBe(false);
      expect(runPhaseSpy).not.toHaveBeenCalled();
      expect(result.phases).toEqual([]);

      // ── Assert: the unwind COMPLETED on resume ──
      // No double-revert (still exactly one revert commit).
      expect(await revertCommitCount(dir, 'main')).toBe(1);

      // Journal all-done; ledger settled to {tier:2, status:'halted'}.
      const doneLedger = await readRollbackLedger(dir);
      expect(doneLedger?.steps?.['2']).toEqual({
        git_done: true,
        quarantine_done: true,
        roadmap_done: true,
        requirements_done: true,
        state_done: true,
      });
      expect(doneLedger?.tier).toBe(2);
      expect(doneLedger?.status).toBe('halted');

      // ROADMAP: phase 2 now unchecked, phase 1 still complete.
      const roadmapAfter = await readFile(join(dir, '.planning', 'ROADMAP.md'), 'utf-8');
      expect(roadmapAfter).toMatch(/- \[ \] Phase 2: Build/);
      expect(roadmapAfter).toMatch(/- \[x\] Phase 1: Foundation/);

      // STATE restored from the phase-2 checkpoint snapshot.
      const snapState = await readFile(join(dir, '.planning', '.checkpoints', 'phase-2', 'STATE.md'), 'utf-8');
      const liveState = await readFile(join(dir, '.planning', 'STATE.md'), 'utf-8');
      expect(liveState).toBe(snapState);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
