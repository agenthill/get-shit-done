/**
 * Tier-2 cascade revert engine — FALSIFIER against a real temp git repo
 * (ADR 0013 option 4, chunk 3, Task B3 + measure-of-success TEST 1 Tier-2 leg).
 *
 * Scenario: a 3-phase repo. Phases 1 + 2 PROMOTE onto protected. Phase 3
 * depends_on phase 2 and FAILS with a break attributable to a phase-2 file. The
 * classifier returns revert-confident with cascade set [2] (NOT phase 1 — it is
 * independent), and the cascade:
 *   - lands phase 2's `revert(phase-2): autonomous unwind` commit ON protected
 *     (history-preserving — protected is NOT reset),
 *   - does NOT revert the independent phase 1 (no over-cascade),
 *   - leaves phase 1's kept work in the tree (not stranded; guard suite passes),
 *   - quarantines (MOVES, not deletes) phase 2's SUMMARY,
 *   - flips ROADMAP phase 2 back to `[ ]`,
 *   - restores STATE.md from the phase-2 checkpoint snapshot.
 *
 * Conflict-injection variant: phase 2's revert conflicts with a kept later
 * change → the tree is left CLEAN (no half-revert) and the cascade HALTs.
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
import { classifyCascade } from './tier2-cascade-classifier.js';
import { cascadeRollbackTier2 } from './rollback-engine.js';
import { writeRollbackLedger, readRollbackLedger } from './rollback-ledger.js';

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
async function logSubjects(dir: string, ref: string): Promise<string[]> {
  const { stdout } = await gitIn(dir)(['log', '--format=%s', ref]);
  return stdout.split('\n').map(l => l.trim()).filter(Boolean);
}
async function isClean(dir: string): Promise<boolean> {
  const { stdout } = await gitIn(dir)(['status', '--porcelain']);
  return stdout.trim() === '';
}

/**
 * Build a repo where phases 1 + 2 are promoted onto protected via the real spine
 * primitives (checkpoint + integration branch + promote + manifest). ROADMAP
 * marks both phases complete; each phase dir holds a SUMMARY. Returns the dir,
 * the manifest, and protected HEAD.
 */
async function setupTwoPromotedPhases(): Promise<{ dir: string; manifest: PhaseManifest }> {
  const dir = await mkdtemp(join(tmpdir(), 'gsd-t2-'));
  const git = gitIn(dir);
  await git(['init', '-q', '-b', 'main']);
  await git(['config', 'user.email', 't@t.t']);
  await git(['config', 'user.name', 'T']);
  await git(['config', 'commit.gpgsign', 'false']);

  await mkdir(join(dir, '.planning', 'phases', '01-foundation'), { recursive: true });
  await mkdir(join(dir, '.planning', 'phases', '02-build'), { recursive: true });
  // STATE/ROADMAP/REQUIREMENTS in their FINAL (both-complete) state on protected.
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
  // Phase summaries live on disk in the phase dirs. They are NOT part of the
  // reverted source commits below (the revert only touches indep.ts/shared.ts),
  // so the quarantine step is what MOVES phase 2's summary out — exercising it
  // distinctly from the source revert.
  await writeFile(join(dir, '.planning', 'phases', '01-foundation', '01-SUMMARY.md'), '# phase 1 done\n');
  await writeFile(join(dir, '.planning', 'phases', '02-build', '02-SUMMARY.md'), '# phase 2 done\n');
  await ensureCheckpointGitignore(dir);
  await git(['add', '-A']);
  await git(['commit', '-q', '--no-verify', '-m', 'base']);

  const manifest: PhaseManifest = {};

  // ── Promote phase 1 (independent, touches indep.ts) ──
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

  // ── Promote phase 2 (depends_on 1, touches shared.ts) ──
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
  // The manifest is gitignored (ensureCheckpointGitignore), so it is never swept
  // into a phase commit and the protected working tree is clean for Tier-2.

  return { dir, manifest };
}

describe('Tier-2 cascade — attributable predecessor reverted, independent phase untouched', () => {
  it('reverts ONLY the attributable depends_on-linked phase 2, preserves phase 1, quarantines + uncompletes, restores STATE', async () => {
    const { dir, manifest } = await setupTwoPromotedPhases();
    try {
      const git = gitIn(dir);
      const serializer = new GitMergeSerializer(dir, 'main', async () => 0);

      // Phase 3 (failing) depends_on 2; the break is in shared.ts (a phase-2 file).
      const cls = await classifyCascade({
        projectDir: dir,
        failingPhase: '3',
        // Pretend phase 3 declared `depends_on: 2` (it never promoted, so the
        // closure walk needs its edges supplied via a transient manifest entry).
        manifest: { ...manifest, '3': { ...manifest['2']!, depends_on: ['2'], commits: [] } },
        implicatedFiles: ['shared.ts'],
      });
      expect(cls.verdict).toBe('revert-confident');
      expect(cls.cascadeSet).toEqual(['2']); // NOT [2,1] — phase 1 is independent.

      const protectedBeforeAll = (await git(['rev-parse', 'main'])).stdout.trim();

      const casc = await cascadeRollbackTier2({
        projectDir: dir,
        protectedBranch: 'main',
        cascadeSet: cls.cascadeSet,
        manifest,
        serializer,
      });

      expect(casc.status).toBe('reverted');
      expect(casc.revertedPhases).toEqual(['2']);

      // ── History-preserving: a revert commit landed on protected (NOT a reset) ──
      const subjects = await logSubjects(dir, 'main');
      expect(subjects).toContain('revert(phase-2): autonomous unwind');
      // protected ADVANCED (revert commit added), it was not rewound to before.
      const protectedAfter = (await git(['rev-parse', 'main'])).stdout.trim();
      expect(protectedAfter).not.toBe(protectedBeforeAll);
      // The original phase-2 work commit is STILL in history (revert, not erased).
      expect(subjects).toContain('phase 2 work');

      // ── Phase 2's content is gone from the tree; phase 1's is NOT stranded ──
      expect(await pathExists(join(dir, 'shared.ts'))).toBe(false);
      expect(await pathExists(join(dir, 'indep.ts'))).toBe(true); // kept phase preserved
      // No independent phase reverted.
      expect(subjects).not.toContain('revert(phase-1): autonomous unwind');

      // ── Quarantine: phase 2's SUMMARY MOVED (not deleted) ──
      expect(casc.perPhase[0]!.quarantined).toContain('02-SUMMARY.md');
      expect(await pathExists(join(dir, '.planning', 'phases', '02-build', '02-SUMMARY.md'))).toBe(false);
      expect(await pathExists(join(dir, '.planning', '.rollback-quarantine', 'phase-2', '02-SUMMARY.md'))).toBe(true);
      // Phase 1's summary untouched.
      expect(await pathExists(join(dir, '.planning', 'phases', '01-foundation', '01-SUMMARY.md'))).toBe(true);

      // ── ROADMAP: phase 2 unchecked, phase 1 still complete ──
      const roadmap = await readFile(join(dir, '.planning', 'ROADMAP.md'), 'utf-8');
      expect(roadmap).toMatch(/- \[ \] Phase 2: Build/);
      expect(roadmap).toMatch(/- \[x\] Phase 1: Foundation/);

      // ── REQUIREMENTS: REQ-02 flipped to pending, REQ-01 untouched ──
      expect(casc.perPhase[0]!.requirementsMarkedIncomplete).toContain('REQ-02');
      const req = await readFile(join(dir, '.planning', 'REQUIREMENTS.md'), 'utf-8');
      expect(req).toMatch(/- \[ \] \*\*REQ-02\*\*/);
      expect(req).toMatch(/- \[x\] \*\*REQ-01\*\*/);

      // ── STATE restored from the phase-2 checkpoint snapshot ──
      // The phase-2 checkpoint snapshotted STATE at phase-1-complete (before
      // phase 2 promoted), so the restored body must NOT say "2 COMPLETE".
      const snapState = await readFile(join(dir, '.planning', '.checkpoints', 'phase-2', 'STATE.md'), 'utf-8');
      const liveState = await readFile(join(dir, '.planning', 'STATE.md'), 'utf-8');
      expect(liveState).toBe(snapState);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('GROUP-A falsifier: a reverted phase that ADDED >5 files actually REMOVES all of them (the forward-merge guard must NOT undo the revert)', async () => {
    // Reproduces-then-kills bulk-delete-guard-undoes-tier2-revert: phase 2 adds
    // 7 files (> the bulk-delete threshold of 5). Pre-fix, rollbackTier2 ran the
    // FORWARD-MERGE guard suite over the revert delta — its bulk-delete branch
    // (>5 deletions) RESTORED all 7 files from baseTip (which still has them),
    // silently NEUTRALIZING the revert while the ledger/ROADMAP claimed reverted.
    // Post-fix: the guard is not run over a revert delta, so all 7 files are
    // actually GONE.
    const dir = await mkdtemp(join(tmpdir(), 'gsd-t2a-'));
    try {
      const git = gitIn(dir);
      await git(['init', '-q', '-b', 'main']);
      await git(['config', 'user.email', 't@t.t']);
      await git(['config', 'user.name', 'T']);
      await git(['config', 'commit.gpgsign', 'false']);

      await mkdir(join(dir, '.planning', 'phases', '02-build'), { recursive: true });
      await writeFile(
        join(dir, '.planning', 'ROADMAP.md'),
        [
          '## Milestone v1',
          '',
          '### Phase 2: Build',
          '**Requirements:** REQ-02',
          '**Depends on:** None',
          '',
          '- [x] Phase 2: Build (completed 2026-01-02)',
          '',
        ].join('\n'),
      );
      await writeFile(join(dir, '.planning', 'REQUIREMENTS.md'), '- [x] **REQ-02** build\n');
      await writeFile(join(dir, '.planning', 'STATE.md'), 'status: phase_complete\nphase: 2 COMPLETE\n');
      await writeFile(join(dir, '.planning', 'phases', '02-build', '02-SUMMARY.md'), '# phase 2 done\n');
      await ensureCheckpointGitignore(dir);
      await git(['add', '-A']);
      await git(['commit', '-q', '--no-verify', '-m', 'base']);

      const manifest: PhaseManifest = {};
      // Promote phase 2 adding feat1..feat7 (7 files > bulk-delete threshold 5).
      const cp2 = await createPhaseCheckpoint({ projectDir: dir, phaseNumber: '2', protectedBranch: 'main' });
      await git(['checkout', '-q', '-B', 'gsd-phase-2-int', cp2.lastGoodSha]);
      const featFiles = ['feat1.ts', 'feat2.ts', 'feat3.ts', 'feat4.ts', 'feat5.ts', 'feat6.ts', 'feat7.ts'];
      for (const f of featFiles) await writeFile(join(dir, f), `export const ${f.replace('.ts', '')} = 1;\n`);
      await git(['add', '-A']);
      await git(['commit', '-q', '--no-verify', '-m', 'phase 2 work']);
      await git(['checkout', '-q', 'main']);
      await git(['merge', '--no-ff', '--no-edit', 'gsd-phase-2-int']);
      const head2 = (await git(['rev-parse', 'HEAD'])).stdout.trim();
      manifest['2'] = await recordPhasePromotion({
        projectDir: dir, phaseNumber: '2', baseTag: cp2.baseTag, baseSha: cp2.lastGoodSha,
        headSha: head2, promotedAt: '2026-01-02T00:01:00.000Z', dependsOn: [],
      });

      // All 7 files exist on protected before the revert.
      for (const f of featFiles) expect(await pathExists(join(dir, f))).toBe(true);

      const serializer = new GitMergeSerializer(dir, 'main', async () => 0);
      const casc = await cascadeRollbackTier2({
        projectDir: dir, protectedBranch: 'main', cascadeSet: ['2'], manifest, serializer,
      });

      expect(casc.status).toBe('reverted');
      expect(casc.revertedPhases).toEqual(['2']);
      const subjects = await logSubjects(dir, 'main');
      expect(subjects).toContain('revert(phase-2): autonomous unwind');

      // THE LOAD-BEARING ASSERTION: every added file is ACTUALLY GONE from
      // protected — the revert is real, not neutralized by a bulk-delete restore.
      for (const f of featFiles) {
        expect(await pathExists(join(dir, f)), `${f} must be removed by the revert`).toBe(false);
      }
      // And no guard "restore N file(s)" commit re-added them.
      expect(subjects).not.toContain('guard: restore 7 file(s) (bulk-delete/state/resurrection guard)');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('GROUP-A falsifier: a reverted phase that DELETED a pre-existing file RESTORES it and it STAYS restored (resurrection guard must not strip it)', async () => {
    // Reproduces-then-kills resurrection-guard-strips-reverted-restore: phase 2
    // DELETES a pre-existing file `legacy.ts`. Reverting phase 2 re-ADDS legacy.ts.
    // Pre-fix, the forward-merge guard's resurrection branch saw legacy.ts as an
    // addition over a baseTip whose history shows a prior deletion → `git rm`'d
    // it, STRIPPING the revert's restore. Post-fix: the guard is not run, so
    // legacy.ts stays restored.
    const dir = await mkdtemp(join(tmpdir(), 'gsd-t2d-'));
    try {
      const git = gitIn(dir);
      await git(['init', '-q', '-b', 'main']);
      await git(['config', 'user.email', 't@t.t']);
      await git(['config', 'user.name', 'T']);
      await git(['config', 'commit.gpgsign', 'false']);

      await mkdir(join(dir, '.planning', 'phases', '02-build'), { recursive: true });
      await writeFile(
        join(dir, '.planning', 'ROADMAP.md'),
        ['## Milestone v1', '', '### Phase 2: Build', '**Requirements:** REQ-02', '**Depends on:** None', '', '- [x] Phase 2: Build (completed 2026-01-02)', ''].join('\n'),
      );
      await writeFile(join(dir, '.planning', 'REQUIREMENTS.md'), '- [x] **REQ-02** build\n');
      await writeFile(join(dir, '.planning', 'STATE.md'), 'status: phase_complete\nphase: 2 COMPLETE\n');
      await writeFile(join(dir, '.planning', 'phases', '02-build', '02-SUMMARY.md'), '# phase 2 done\n');
      // Pre-existing file that phase 2 will delete.
      await writeFile(join(dir, 'legacy.ts'), 'export const legacy = true;\n');
      await ensureCheckpointGitignore(dir);
      await git(['add', '-A']);
      await git(['commit', '-q', '--no-verify', '-m', 'base']);

      const manifest: PhaseManifest = {};
      const cp2 = await createPhaseCheckpoint({ projectDir: dir, phaseNumber: '2', protectedBranch: 'main' });
      await git(['checkout', '-q', '-B', 'gsd-phase-2-int', cp2.lastGoodSha]);
      await git(['rm', '-q', 'legacy.ts']); // phase 2 DELETES the pre-existing file
      await writeFile(join(dir, 'newthing.ts'), 'export const n = 1;\n');
      await git(['add', '-A']);
      await git(['commit', '-q', '--no-verify', '-m', 'phase 2 work']);
      await git(['checkout', '-q', 'main']);
      await git(['merge', '--no-ff', '--no-edit', 'gsd-phase-2-int']);
      const head2 = (await git(['rev-parse', 'HEAD'])).stdout.trim();
      manifest['2'] = await recordPhasePromotion({
        projectDir: dir, phaseNumber: '2', baseTag: cp2.baseTag, baseSha: cp2.lastGoodSha,
        headSha: head2, promotedAt: '2026-01-02T00:01:00.000Z', dependsOn: [],
      });

      // After phase 2 promoted, legacy.ts is gone, newthing.ts present.
      expect(await pathExists(join(dir, 'legacy.ts'))).toBe(false);
      expect(await pathExists(join(dir, 'newthing.ts'))).toBe(true);

      const serializer = new GitMergeSerializer(dir, 'main', async () => 0);
      const casc = await cascadeRollbackTier2({
        projectDir: dir, protectedBranch: 'main', cascadeSet: ['2'], manifest, serializer,
      });
      expect(casc.status).toBe('reverted');

      // THE LOAD-BEARING ASSERTION: the revert restored legacy.ts and it STAYS —
      // the resurrection guard did not strip it back out.
      expect(await pathExists(join(dir, 'legacy.ts')), 'legacy.ts must be restored by the revert and stay').toBe(true);
      expect(await readFile(join(dir, 'legacy.ts'), 'utf-8')).toContain('legacy = true');
      // And phase 2's added file is gone.
      expect(await pathExists(join(dir, 'newthing.ts'))).toBe(false);
      // (The .planning/*.md docs are restored on the working tree by the
      // quarantine/ROADMAP/REQ/STATE steps and are intentionally left uncommitted
      // there — so the tree is NOT asserted clean after a full successful unwind.)
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('GROUP-B falsifier: a manifest commit that is an invalid/nonexistent sha → HALTED with a CLEAN tree (commitParents throw routed, no dirty half-revert)', async () => {
    // Reproduces-then-kills commitparents-throw-leaves-dirty-tree: the manifest's
    // `commits` carries a bogus sha. Pre-fix, commitParents() ran OUTSIDE the try
    // and threw → the exception escaped uncaught and (if a prior iteration staged
    // a --no-commit revert) left a dirty half-reverted tree. Post-fix: the throw
    // is routed through the conflict→clean+halt path → status:'halted', clean tree.
    const { dir, manifest } = await setupTwoPromotedPhases();
    try {
      const git = gitIn(dir);
      const serializer = new GitMergeSerializer(dir, 'main', async () => 0);
      const protectedBefore = (await git(['rev-parse', 'main'])).stdout.trim();

      // Corrupt phase 2's manifest commits: prepend a real commit (so an earlier
      // iteration stages a --no-commit revert) then a bogus sha (so commitParents
      // throws on the NEXT iteration with a dirty index already staged).
      const realCommit = manifest['2']!.commits[manifest['2']!.commits.length - 1]!;
      const bogus = '0123456789abcdef0123456789abcdef01234567';
      const corruptManifest: PhaseManifest = {
        ...manifest,
        '2': { ...manifest['2']!, commits: [realCommit, bogus] }, // reversed → bogus reverted "first"
      };

      const casc = await cascadeRollbackTier2({
        projectDir: dir, protectedBranch: 'main', cascadeSet: ['2'], manifest: corruptManifest, serializer,
      });

      // HALTED (not thrown) with a CLEAN tree and protected unchanged.
      expect(casc.status).toBe('halted');
      expect(await isClean(dir)).toBe(true);
      expect((await git(['rev-parse', 'main'])).stdout.trim()).toBe(protectedBefore);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('CONFLICT variant: a revert conflicting with a kept later change leaves a CLEAN tree + halts (no half-revert)', async () => {
    const { dir, manifest } = await setupTwoPromotedPhases();
    try {
      const git = gitIn(dir);
      const serializer = new GitMergeSerializer(dir, 'main', async () => 0);

      // Inject a conflict: a LATER commit on protected modifies shared.ts (the
      // file phase 2 created). Reverting phase 2 now tries to delete a file that
      // a kept later commit changed → conflict.
      await writeFile(join(dir, 'shared.ts'), 'export const built = true; // kept-later edit\n');
      await git(['add', '-A']);
      await git(['commit', '-q', '--no-verify', '-m', 'kept later edit on shared.ts']);
      const protectedBeforeRevert = (await git(['rev-parse', 'main'])).stdout.trim();

      const casc = await cascadeRollbackTier2({
        projectDir: dir,
        protectedBranch: 'main',
        cascadeSet: ['2'],
        manifest,
        serializer,
      });

      // ── HALTED with a clean tree ──
      expect(casc.status).toBe('halted');
      expect(casc.revertedPhases).toEqual([]); // nothing reverted
      expect(await isClean(dir)).toBe(true);
      // No revert commit landed; protected is unchanged (no half-revert).
      const protectedAfter = (await git(['rev-parse', 'main'])).stdout.trim();
      expect(protectedAfter).toBe(protectedBeforeRevert);
      const subjects = await logSubjects(dir, 'main');
      expect(subjects).not.toContain('revert(phase-2): autonomous unwind');

      // ── Caller persists the halted Tier-2 ledger ──
      await writeRollbackLedger(dir, {
        failed_phase: '3',
        attempt_count: 1,
        failure_context: [{ attempt: 1, signal: 'gate', detail: 'gate failed' }],
        status: 'halted',
        tier: 2,
        cascade_set: ['2'],
      });
      const ledger = await readRollbackLedger(dir);
      expect(ledger?.status).toBe('halted');
      expect(ledger?.tier).toBe(2);
      expect(ledger?.cascade_set).toEqual(['2']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('HALTS clean when a reverted phase\'s checkpoint STATE snapshot is missing', async () => {
    const { dir, manifest } = await setupTwoPromotedPhases();
    try {
      const git = gitIn(dir);
      const serializer = new GitMergeSerializer(dir, 'main', async () => 0);

      // Remove the phase-2 checkpoint STATE snapshot to force the step-5 HALT.
      await rm(join(dir, '.planning', '.checkpoints', 'phase-2'), { recursive: true, force: true });
      const protectedBefore = (await git(['rev-parse', 'main'])).stdout.trim();

      const casc = await cascadeRollbackTier2({
        projectDir: dir,
        protectedBranch: 'main',
        cascadeSet: ['2'],
        manifest,
        serializer,
      });

      expect(casc.status).toBe('halted');
      expect(casc.haltReason).toMatch(/STATE\.md snapshot missing/i);
      // The revert commit DID land (steps 1-4 ran) and the cascade halts at
      // step 5 rather than producing an inconsistent STATE. The phase is NOT
      // counted as fully reverted (it halted), and crucially STATE.md was NOT
      // overwritten with a missing/empty snapshot — it keeps its pre-restore
      // content for a human to inspect.
      expect(casc.revertedPhases).toEqual([]);
      expect((await git(['rev-parse', 'main'])).stdout.trim()).not.toBe(protectedBefore);
      const liveState = await readFile(join(dir, '.planning', 'STATE.md'), 'utf-8');
      expect(liveState).toContain('2 COMPLETE'); // unchanged (no inconsistent restore)
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
