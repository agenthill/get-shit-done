/**
 * Autonomous Tier-2 cascade wiring — FALSIFIER (ADR 0013 option 4, chunk 3 B4).
 *
 * Drives GSD.run's per-phase loop against a REAL temp git repo with two promoted
 * phases, PhaseRunner.run stubbed to emit a controlled non-green result for a
 * failing phase 3. Falsifies the three Tier-2 routing verdicts:
 *
 *   (a) revert-confident: phase 3 depends_on 2, failure attributable to a
 *       phase-2 file → the loop cascade-reverts phase 2 (revert commit on
 *       protected, phase 1 untouched) and HALTs with ROLLBACK.json tier:2.
 *   (b) cannot-classify: a throw with no parseable implicated files → HALT
 *       clean with tier:2, NO cascade (never guess).
 *   (c) no-cascade-confident: NO promoted predecessor in the failing phase's
 *       depends_on closure → fall through to chunk-2's informed retry (Tier-1
 *       only), NO Tier-2 ledger tier.
 *   (d) no-cascade-confident under a sequential Depends on: Phase 2 when the
 *       break is in phase 3's OWN file phase 2 never touched → informed retry
 *       (Tier-1 only), NO Tier-2 ledger (R1 headline behavior).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GSD, extractImplicatedFiles } from './index.js';
import {
  createPhaseCheckpoint,
  ensureCheckpointGitignore,
  integrationBranchFor,
} from './query/phase-checkpoint.js';
import { recordPhasePromotion } from './query/phase-manifest.js';
import type { PhaseManifest } from './query/phase-manifest.js';
import { PhaseStepType } from './types.js';
import type {
  PhaseRunnerResult,
  PhaseRunnerOptions,
  RoadmapAnalysis,
  PhaseRollbackContext,
} from './types.js';

const execFileAsync = promisify(execFile);
const gitIn = (dir: string) => (args: string[]) => execFileAsync('git', args, { cwd: dir });

async function refExists(dir: string, ref: string): Promise<boolean> {
  try {
    await gitIn(dir)(['rev-parse', '--verify', `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}
async function logSubjects(dir: string, ref: string): Promise<string[]> {
  const { stdout } = await gitIn(dir)(['log', '--format=%s', ref]);
  return stdout.split('\n').map(l => l.trim()).filter(Boolean);
}

/**
 * A repo with phases 1 + 2 PROMOTED (phase 2 depends_on 1, touches shared.ts;
 * phase 1 independent, touches indep.ts), and a checkpoint + integration branch
 * staged for the FAILING phase 3 (as the spine leaves a non-green phase).
 * Returns LAST_GOOD + phase 3's rollback context.
 */
async function setupRepoWithPromotedPredecessors(): Promise<{
  dir: string;
  lastGoodSha: string;
  rollbackContext: PhaseRollbackContext;
  manifest: PhaseManifest;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'gsd-ct2-'));
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
      '### Phase 1: Foundation',
      '**Requirements:** REQ-01',
      '**Depends on:** None',
      '',
      '### Phase 2: Build',
      '**Requirements:** REQ-02',
      '**Depends on:** Phase 1',
      '',
      '### Phase 3: Ship',
      '**Requirements:** REQ-03',
      '**Depends on:** Phase 2',
      '',
      '- [x] Phase 1: Foundation (completed 2026-01-01)',
      '- [x] Phase 2: Build (completed 2026-01-02)',
      '- [ ] Phase 3: Ship',
      '',
    ].join('\n'),
  );
  await writeFile(join(dir, '.planning', 'REQUIREMENTS.md'), '- [x] **REQ-01** f\n- [x] **REQ-02** b\n- [ ] **REQ-03** s\n');
  await writeFile(join(dir, '.planning', 'STATE.md'), 'status: phase_complete\nphase: 2 COMPLETE\n');
  await writeFile(join(dir, '.planning', 'phases', '02-build', '02-SUMMARY.md'), '# phase 2 done\n');
  await ensureCheckpointGitignore(dir);
  await git(['add', '-A']);
  await git(['commit', '-q', '--no-verify', '-m', 'base']);

  const manifest: PhaseManifest = {};

  // promote phase 1 (independent)
  const cp1 = await createPhaseCheckpoint({ projectDir: dir, phaseNumber: '1', protectedBranch: 'main' });
  await git(['checkout', '-q', '-B', 'gsd-phase-1-int', cp1.lastGoodSha]);
  await writeFile(join(dir, 'indep.ts'), '1\n');
  await git(['add', '-A']); await git(['commit', '-q', '--no-verify', '-m', 'phase 1 work']);
  await git(['checkout', '-q', 'main']); await git(['merge', '--no-ff', '--no-edit', 'gsd-phase-1-int']);
  const head1 = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  manifest['1'] = await recordPhasePromotion({
    projectDir: dir, phaseNumber: '1', baseTag: cp1.baseTag, baseSha: cp1.lastGoodSha,
    headSha: head1, promotedAt: '2026-01-01T00:01:00.000Z', dependsOn: [],
  });

  // promote phase 2 (depends_on 1, touches shared.ts)
  const cp2 = await createPhaseCheckpoint({ projectDir: dir, phaseNumber: '2', protectedBranch: 'main' });
  await git(['checkout', '-q', '-B', 'gsd-phase-2-int', cp2.lastGoodSha]);
  await writeFile(join(dir, 'shared.ts'), '2\n');
  await git(['add', '-A']); await git(['commit', '-q', '--no-verify', '-m', 'phase 2 work']);
  await git(['checkout', '-q', 'main']); await git(['merge', '--no-ff', '--no-edit', 'gsd-phase-2-int']);
  const head2 = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  manifest['2'] = await recordPhasePromotion({
    projectDir: dir, phaseNumber: '2', baseTag: cp2.baseTag, baseSha: cp2.lastGoodSha,
    headSha: head2, promotedAt: '2026-01-02T00:01:00.000Z', dependsOn: ['1'],
  });

  // Stage phase 3's failed checkpoint + integration branch (spine leftover).
  const lastGoodSha = (await git(['rev-parse', 'main'])).stdout.trim();
  const cp3 = await createPhaseCheckpoint({ projectDir: dir, phaseNumber: '3', protectedBranch: 'main' });
  const int3 = integrationBranchFor('3');
  await git(['checkout', '-q', '-B', int3, lastGoodSha]);
  await writeFile(join(dir, 'phase3.ts'), 'broken\n');
  await git(['add', '-A']); await git(['commit', '-q', '--no-verify', '-m', 'phase 3 failed work']);
  await git(['checkout', '-q', 'main']);

  return {
    dir,
    lastGoodSha,
    manifest,
    rollbackContext: {
      phaseNumber: '3',
      protectedBranch: 'main',
      lastGoodSha,
      snapshotDir: cp3.snapshotDir,
      integrationBranch: int3,
    },
  };
}

function phase3Info(): RoadmapAnalysis {
  return { phases: [{ number: '3', disk_status: 'planned', roadmap_complete: false, phase_name: 'Ship' }] };
}

function failResult(rollbackContext: PhaseRollbackContext, detail: string, signal: 'gate' | 'throw' = 'gate'): PhaseRunnerResult {
  return {
    phaseNumber: '3',
    phaseName: 'Ship',
    steps: signal === 'gate'
      ? [{ step: PhaseStepType.Execute, success: false, durationMs: 1, error: detail }]
      : [],
    success: false,
    totalCostUsd: 0,
    totalDurationMs: 1,
    rollbackContext,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Tier-2 loop wiring — (a) revert-confident cascade', () => {
  it('cascade-reverts the attributable promoted predecessor (phase 2) and HALTs with ROLLBACK.json tier:2', async () => {
    const { dir, manifest, rollbackContext } = await setupRepoWithPromotedPredecessors();
    try {
      const gsd = new GSD({ projectDir: dir });
      vi.spyOn(gsd, 'createTools').mockReturnValue({
        roadmapAnalyze: vi.fn().mockResolvedValue(phase3Info()),
      } as never);
      // Phase 3 fails on the FIRST attempt with a break naming a phase-2 file.
      vi.spyOn(gsd, 'runPhase').mockImplementation((async () => {
        return failResult(rollbackContext, 'gate failed: type error in shared.ts blocks build', 'gate');
      }) as never);

      const result = await gsd.run('ship it');
      expect(result.success).toBe(false);

      // ── Phase 2 cascade-reverted on protected; phase 1 untouched ──
      const subjects = await logSubjects(dir, 'main');
      expect(subjects).toContain('revert(phase-2): autonomous unwind');
      expect(subjects).not.toContain('revert(phase-1): autonomous unwind');

      // ── Phase 3's Tier-1 ran: its integration branch is gone ──
      expect(await refExists(dir, integrationBranchFor('3'))).toBe(false);

      // ── ROLLBACK.json: tier 2, cascade_set [2], halted ──
      const ledger = JSON.parse(await readFile(join(dir, '.planning', 'ROLLBACK.json'), 'utf-8'));
      expect(ledger.tier).toBe(2);
      expect(ledger.cascade_set).toEqual(['2']);
      expect(ledger.status).toBe('halted');
      expect(ledger.failed_phase).toBe('3');

      // ── ROADMAP: phase 2 unchecked, phase 1 still complete ──
      const roadmap = await readFile(join(dir, '.planning', 'ROADMAP.md'), 'utf-8');
      expect(roadmap).toMatch(/- \[ \] Phase 2: Build/);
      expect(roadmap).toMatch(/- \[x\] Phase 1: Foundation/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('Tier-2 loop wiring — (b) cannot-classify HALTs clean', () => {
  it('a checkpointed failure naming no files (with a depends_on-linked promoted predecessor) HALTs clean with tier:2 and NO cascade', async () => {
    const { dir, rollbackContext } = await setupRepoWithPromotedPredecessors();
    try {
      const gsd = new GSD({ projectDir: dir });
      vi.spyOn(gsd, 'createTools').mockReturnValue({
        roadmapAnalyze: vi.fn().mockResolvedValue(phase3Info()),
      } as never);
      // A genuine gate failure whose detail names NO files — phase 3 depends_on
      // 2 (a promoted predecessor), so the inability to attribute must HALT
      // rather than silently retry past phase 2.
      vi.spyOn(gsd, 'runPhase').mockImplementation((async () => {
        return failResult(rollbackContext, 'build failed for unknown reasons; exit code 1', 'gate');
      }) as never);

      const result = await gsd.run('ship it');
      expect(result.success).toBe(false);

      // No cascade revert happened (cannot-classify, not revert-confident).
      const subjects = await logSubjects(dir, 'main');
      expect(subjects).not.toContain('revert(phase-2): autonomous unwind');

      // ROLLBACK.json: tier 2, EMPTY cascade_set, halted.
      const ledger = JSON.parse(await readFile(join(dir, '.planning', 'ROLLBACK.json'), 'utf-8'));
      expect(ledger.tier).toBe(2);
      expect(ledger.cascade_set).toEqual([]);
      expect(ledger.status).toBe('halted');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('Tier-2 loop wiring — (c) no-cascade-confident falls through to informed retry', () => {
  it('a failure with NO promoted predecessor in the closure does Tier-1 only and retries; no Tier-2 ledger', async () => {
    const { dir, lastGoodSha, rollbackContext } = await setupRepoWithPromotedPredecessors();
    try {
      // Make phase 3 depend on NOTHING promoted: with no promoted predecessor in
      // its depends_on closure, the classifier is confidently no-cascade and the
      // driver falls through to the informed-retry loop. (A failure whose
      // implicated files are present-but-unmatchable WHILE a promoted candidate
      // exists is now cannot-classify, not no-cascade — the GROUP-D #2983 fix —
      // so this falls-through case is exercised via the no-candidate path, the
      // genuine confident-negative.)
      const roadmapPath = join(dir, '.planning', 'ROADMAP.md');
      const roadmap = await readFile(roadmapPath, 'utf-8');
      await writeFile(
        roadmapPath,
        roadmap.replace(
          '### Phase 3: Ship\n**Requirements:** REQ-03\n**Depends on:** Phase 2',
          '### Phase 3: Ship\n**Requirements:** REQ-03\n**Depends on:** None',
        ),
      );

      const gsd = new GSD({ projectDir: dir });
      vi.spyOn(gsd, 'createTools').mockReturnValue({
        roadmapAnalyze: vi.fn().mockResolvedValue(phase3Info()),
      } as never);

      const seenPrior: Array<PhaseRunnerOptions['priorFailureContext']> = [];
      let attemptNo = 0;
      vi.spyOn(gsd, 'runPhase').mockImplementation((async (_n: string, opts?: PhaseRunnerOptions) => {
        attemptNo += 1;
        seenPrior.push(opts?.priorFailureContext);
        // Re-stage phase 3's integration branch (the prior attempt's Tier-1 tore
        // it down; the real runPhase would re-create it).
        const git = gitIn(dir);
        await createPhaseCheckpoint({ projectDir: dir, phaseNumber: '3', protectedBranch: 'main' });
        await git(['checkout', '-q', '-B', integrationBranchFor('3'), lastGoodSha]);
        await writeFile(join(dir, 'phase3.ts'), `try ${attemptNo}\n`);
        await git(['add', '-A']); await git(['commit', '-q', '--no-verify', '-m', `phase 3 work ${attemptNo}`]);
        await git(['checkout', '-q', 'main']);
        // Phase 3 declares no promoted dependency → no cascade candidate → the
        // classifier is confidently no-cascade regardless of the implicated file.
        return failResult(rollbackContext, 'gate failed: error in phase3-new-module.ts', 'gate');
      }) as never);

      const result = await gsd.run('ship it');
      expect(result.success).toBe(false);

      // Fell through to informed retry: 5 attempts, prior context injected.
      expect(attemptNo).toBe(5);
      expect(seenPrior[0]).toBeUndefined();
      expect(seenPrior[4]).toBeTruthy();

      // NO cascade revert; phase 2 untouched.
      const subjects = await logSubjects(dir, 'main');
      expect(subjects).not.toContain('revert(phase-2): autonomous unwind');

      // ROLLBACK.json halted at the cap, but Tier-1 (not Tier-2): no tier:2.
      const ledger = JSON.parse(await readFile(join(dir, '.planning', 'ROLLBACK.json'), 'utf-8'));
      expect(ledger.status).toBe('halted');
      expect(ledger.tier).toBeUndefined();
      expect(ledger.attempt_count).toBe(5);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('Tier-2 loop wiring — (d) own-file failure under Depends on: Phase 2 keeps informed-retry', () => {
  it('phase 3 depends_on 2 but breaks in its OWN new file phase 2 never touched → Tier-1 + informed retry, NO tier:2 ledger', async () => {
    // R1 headline behavior restored: phase 3 KEEPS the sequential `Depends on:
    // Phase 2` shape (a promoted candidate exists in the closure), but the break
    // is in phase 3's OWN brand-new file phase 2 never touched. Within the
    // file-overlap heuristic this is a confident no-cascade, so the driver takes
    // the user's CHOSEN DEFAULT: informed-retry (auto-rollback + retry to the
    // cap, then HALT), Tier-1 only — NOT a Tier-2 cascade ledger. (A prior round
    // flipped this to a cannot-classify HALT on attempt 1, defeating the retry.)
    const { dir, lastGoodSha, rollbackContext } = await setupRepoWithPromotedPredecessors();
    try {
      // ROADMAP left UNCHANGED: phase 3 Depends on: Phase 2 (the sequential shape).
      const gsd = new GSD({ projectDir: dir });
      vi.spyOn(gsd, 'createTools').mockReturnValue({
        roadmapAnalyze: vi.fn().mockResolvedValue(phase3Info()),
      } as never);

      const seenPrior: Array<PhaseRunnerOptions['priorFailureContext']> = [];
      let attemptNo = 0;
      vi.spyOn(gsd, 'runPhase').mockImplementation((async (_n: string, opts?: PhaseRunnerOptions) => {
        attemptNo += 1;
        seenPrior.push(opts?.priorFailureContext);
        // Re-stage phase 3's integration branch (the prior attempt's Tier-1 tore
        // it down; the real runPhase would re-create it).
        const git = gitIn(dir);
        await createPhaseCheckpoint({ projectDir: dir, phaseNumber: '3', protectedBranch: 'main' });
        await git(['checkout', '-q', '-B', integrationBranchFor('3'), lastGoodSha]);
        await writeFile(join(dir, 'phase3.ts'), `try ${attemptNo}\n`);
        await git(['add', '-A']); await git(['commit', '-q', '--no-verify', '-m', `phase 3 work ${attemptNo}`]);
        await git(['checkout', '-q', 'main']);
        // Break is in phase 3's OWN new file phase 2 never touched. A promoted
        // predecessor (phase 2) IS a candidate, but it is not file-attributable
        // → no-cascade-confident → informed retry.
        return failResult(rollbackContext, 'gate failed: error in phase3-new-module.ts', 'gate');
      }) as never);

      const result = await gsd.run('ship it');
      expect(result.success).toBe(false);

      // Fell through to informed retry: 5 attempts, prior context injected.
      expect(attemptNo).toBe(5);
      expect(seenPrior[0]).toBeUndefined();
      expect(seenPrior[4]).toBeTruthy();

      // NO cascade revert; phase 2 untouched on protected.
      const subjects = await logSubjects(dir, 'main');
      expect(subjects).not.toContain('revert(phase-2): autonomous unwind');

      // ROLLBACK.json halted at the cap, but Tier-1 (not Tier-2): NO tier:2.
      const ledger = JSON.parse(await readFile(join(dir, '.planning', 'ROLLBACK.json'), 'utf-8'));
      expect(ledger.status).toBe('halted');
      expect(ledger.tier).toBeUndefined();
      expect(ledger.attempt_count).toBe(5);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('extractImplicatedFiles', () => {
  it('pulls path-like tokens out of a freeform failure detail', () => {
    expect(extractImplicatedFiles('type error in shared.ts blocks build')).toContain('shared.ts');
    expect(extractImplicatedFiles('FAIL src/query/foo.test.ts > broke')).toContain('src/query/foo.test.ts');
    expect(extractImplicatedFiles('error at ./lib/bar.js:12')).toContain('lib/bar.js');
  });
  it('returns [] for prose with no file paths', () => {
    expect(extractImplicatedFiles('the build failed for unknown reasons')).toEqual([]);
    expect(extractImplicatedFiles('')).toEqual([]);
  });
});
