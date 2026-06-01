/**
 * GSD.runParallel — FAILURE-PATH isolation FALSIFIER (ADR 0014 D4, Design B).
 *
 * The four BLOCKING concurrency defects (#22 adversarial review): under intra-
 * wave fan-out cap>=2, the FAILURE segment of the per-phase driver
 * GSD.runPhaseWithRollbackRetry ran entirely against the SHARED projectDir,
 * unserialized, concurrently with a sibling's promote:
 *
 *   1 (CRITICAL) concurrent rollbackTier1 `git checkout protected` collides on
 *               `.git/index.lock` with a sibling's promote;
 *   2 (CRITICAL) rollbackTier1 asserts `git rev-parse protected === lastGoodSha`,
 *               which a sibling's LEGITIMATE promote falsifies → a false-positive
 *               "non-green phase appears to have moved protected" fail-closed HALT;
 *   3 (HIGH)    concurrent `.planning/ROLLBACK.json` writes clobber each other and
 *               corrupt the shared Tier-2 crash-resume journal;
 *   4 (HIGH)    unserialized maybeCascadeTier2 against shared protected can leave
 *               protected half-reverted.
 *
 * This test drives the REAL driver (runPhaseWithRollbackRetry is NOT stubbed —
 * only the inner runPhase boundary is stubbed to control per-phase green/fail,
 * the proven pattern from the existing "Tier-1 reuse" test). One genuinely-
 * FAILING phase runs concurrently with a PROMOTING phase against a real temp git
 * repo at cap>=2.
 *
 * BEFORE the fix it fails: the failing phase's real rollbackTier1 asserts
 * protected === its pre-promote LAST_GOOD, which the promoting sibling already
 * advanced → throws the "invariant violated" HALT (assertion B), and writes the
 * shared `.planning/ROLLBACK.json` (assertion C). AFTER the fix the failing phase
 * takes the Design B isolated-discard path: it deletes only its OWN integration
 * branch, makes no protected checkout / LAST_GOOD assert, and records to a
 * per-phase-scoped ledger.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GSD } from './index.js';
import { PhaseStepType } from './types.js';
import type { PhaseRunnerResult, RoadmapAnalysis } from './types.js';
import {
  createPhaseCheckpoint,
  ensureCheckpointGitignore,
  integrationBranchFor,
  checkpointDirFor,
} from './query/phase-checkpoint.js';

const execFileAsync = promisify(execFile);
const gitIn = (dir: string) => (args: string[]) => execFileAsync('git', args, { cwd: dir });

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Three hard-disjoint phases (each touches its own file → conflict-graph puts all
 * three in one wave). Phase 1 will PROMOTE (advances protected); phases 2 and 3
 * will FAIL concurrently.
 */
async function setupRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gsd-par-fail-'));
  const git = gitIn(dir);
  await git(['init', '-q', '-b', 'main']);
  await git(['config', 'user.email', 't@t.t']);
  await git(['config', 'user.name', 'T']);
  await git(['config', 'commit.gpgsign', 'false']);
  const plan = (ph: string, f: string) =>
    `---\nphase: ${ph}\nfiles_modified:\n  - ${f}\n---\n<objective>O</objective>\n<tasks><task type="auto"><name>T</name></task></tasks>\n`;
  for (const [phaseDir, num, file] of [
    ['01-a', '01-a', 'src/a.ts'],
    ['02-b', '02-b', 'src/b.ts'],
    ['03-c', '03-c', 'src/c.ts'],
  ] as const) {
    await mkdir(join(dir, '.planning', 'phases', phaseDir), { recursive: true });
    await writeFile(join(dir, '.planning', 'phases', phaseDir, `${num.slice(0, 2)}-PLAN.md`), plan(num, file));
  }
  await writeFile(join(dir, '.planning', 'STATE.md'), 'status: ready\n');
  await writeFile(join(dir, '.planning', 'ROADMAP.md'), '### Phase 1: A\n### Phase 2: B\n### Phase 3: C\n');
  await ensureCheckpointGitignore(dir);
  await git(['add', '-A']);
  await git(['commit', '-q', '--no-verify', '-m', 'base']);
  return dir;
}

function threePhaseRoadmap(): RoadmapAnalysis {
  return {
    phases: [
      { number: '1', disk_status: 'pending', roadmap_complete: false, phase_name: 'A' },
      { number: '2', disk_status: 'pending', roadmap_complete: false, phase_name: 'B' },
      { number: '3', disk_status: 'pending', roadmap_complete: false, phase_name: 'C' },
    ],
  } as RoadmapAnalysis;
}

let dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
  dirs = [];
  vi.restoreAllMocks();
});

describe('GSD.runParallel — failure path isolated from a concurrent promote (Design B)', () => {
  it('a failing wave member does not collide / false-positive-HALT / clobber the shared ledger when a sibling promotes', async () => {
    const dir = await setupRepo();
    dirs.push(dir);
    const git = gitIn(dir);
    const gsd = new GSD({ projectDir: dir });

    // The protected sha BEFORE any promote — the LAST_GOOD the failing phases'
    // rollbackContext pins. Phase 1's promote advances protected PAST this, which
    // is exactly what the pre-fix rollbackTier1 invariant assert mis-reads as
    // "a non-green phase moved protected".
    const lastGood = (await git(['rev-parse', 'main'])).stdout.trim();

    // Phase 1's integration branch with a real commit beyond LAST_GOOD so the
    // orchestrator's promoteLocal performs a real `merge --no-ff` that ADVANCES
    // protected (a vacuous branch would no-op the merge and not move protected).
    await createPhaseCheckpoint({ projectDir: dir, phaseNumber: '1', protectedBranch: 'main' });
    await git(['checkout', '-B', integrationBranchFor('1'), lastGood]);
    await writeFile(join(dir, 'src', 'a.ts'), 'phase1\n').catch(async () => {
      await mkdir(join(dir, 'src'), { recursive: true });
      await writeFile(join(dir, 'src', 'a.ts'), 'phase1\n');
    });
    await git(['add', '-A']);
    await git(['commit', '-q', '--no-verify', '-m', 'phase 1 int work']);
    await git(['checkout', 'main']);

    // Drive the REAL runPhaseWithRollbackRetry. Stub only the inner runPhase:
    //   - phase 1 → green (orchestrator promoteLocal advances protected);
    //   - phases 2 & 3 → non-green WITH a rollbackContext pinned at the pre-promote
    //     LAST_GOOD. A small delay lets phase 1 promote FIRST so the pre-fix Tier-1
    //     assert deterministically sees protected already advanced.
    vi.spyOn(gsd as any, 'runPhase').mockImplementation(async (...args: any[]) => {
      const phaseNumber = args[0] as string;
      if (phaseNumber === '1') {
        return {
          phaseNumber: '1',
          phaseName: 'A',
          steps: [{ step: PhaseStepType.Execute, success: true, durationMs: 1 }],
          success: true,
          totalCostUsd: 0,
          totalDurationMs: 1,
        } as PhaseRunnerResult;
      }
      // Failing phases settle after a beat so the sibling promote lands first.
      await new Promise((r) => setTimeout(r, 60));
      return {
        phaseNumber,
        phaseName: phaseNumber,
        steps: [{ step: PhaseStepType.Execute, success: false, durationMs: 1 }],
        success: false,
        totalCostUsd: 0,
        totalDurationMs: 1,
        rollbackContext: {
          phaseNumber,
          protectedBranch: 'main',
          lastGoodSha: lastGood,
          snapshotDir: checkpointDirFor(dir, phaseNumber),
          integrationBranch: integrationBranchFor(phaseNumber),
        },
      } as PhaseRunnerResult;
    });
    vi.spyOn(gsd, 'createTools').mockReturnValue({
      roadmapAnalyze: vi.fn().mockResolvedValue(threePhaseRoadmap()),
    } as never);

    const res = await gsd.runParallel(['1', '2', '3'], { openPullRequests: false });

    const p1 = res.phases.find((p) => p.phaseNumber === '1')!;
    const p2 = res.phases.find((p) => p.phaseNumber === '2')!;
    const p3 = res.phases.find((p) => p.phaseNumber === '3')!;

    // Phase 1 legitimately promoted; protected advanced past LAST_GOOD.
    expect(p1.promoted).toBe(true);
    const protectedNow = (await git(['rev-parse', 'main'])).stdout.trim();
    expect(protectedNow).not.toBe(lastGood);
    // Phases 2 & 3 are non-promoted (they failed) — that is correct.
    expect(p2.promoted).toBe(false);
    expect(p3.promoted).toBe(false);

    // (B) NO false-positive HALT: a failing member must NOT carry a Tier-1
    // "invariant violated / non-green phase moved protected" error. The pre-fix
    // rollbackTier1 throws exactly that string against the advanced protected.
    const failNotes = [p2, p3]
      .map((p) => `${p.skippedReason ?? ''} ${p.errorReason ?? ''} ${p.result.steps.map((s) => s.error ?? '').join(' ')}`)
      .join(' ');
    expect(failNotes).not.toMatch(/invariant violated/i);
    expect(failNotes).not.toMatch(/non-green phase appears to have moved protected/i);

    // (A) NO shared-tree corruption: protected is the phase-1 promote tip, the
    // working tree is clean, and no stale index.lock survives.
    const { stdout: status } = await git(['status', '--porcelain']);
    expect(status.trim()).toBe('');
    expect(await exists(join(dir, '.git', 'index.lock'))).toBe(false);

    // (C) The shared `.planning/ROLLBACK.json` is NOT written by parallel failure
    // handling (Design B routes the per-phase failure ledger to a per-phase path),
    // so the Tier-2 crash-resume journal stays untouched/uncorrupted. Each failing
    // phase has its OWN per-phase ledger naming only itself.
    expect(await exists(join(dir, '.planning', 'ROLLBACK.json'))).toBe(false);
    for (const num of ['2', '3']) {
      const perPhase = join(checkpointDirFor(dir, num), 'ROLLBACK.json');
      expect(await exists(perPhase)).toBe(true);
      const ledger = JSON.parse(await readFile(perPhase, 'utf-8'));
      expect(ledger.failed_phase).toBe(num);
    }

    // The failing phases' own integration branches were discarded (isolated
    // cleanup), and phase 1's promote was NOT undone.
    await expect(
      git(['rev-parse', '--verify', `refs/heads/${integrationBranchFor('2')}`]),
    ).rejects.toThrow();
    await expect(
      git(['rev-parse', '--verify', `refs/heads/${integrationBranchFor('3')}`]),
    ).rejects.toThrow();

    expect(res.success).toBe(false); // overall run had failures (phases 2 & 3)
  }, 30000);
});
