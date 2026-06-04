/**
 * GSD.runParallel — per-phase worktree isolation FALSIFIER (ADR 0014, #13 gap 2,
 * Chunk C PR-1).
 *
 * The concurrency-safety defect: under intra-wave fan-out (cap >= 2) two
 * concurrent wave members both drive `runPhaseWithRollbackRetry` against the
 * SHARED `projectDir` working tree / index / HEAD — their per-phase `git checkout
 * -B <int>` / merge / checkpoint races clobber HEAD and collide on `index.lock`.
 *
 * The fix threads a per-phase WORKTREE dir through the driver: each wave member
 * runs segment (a) — checkpoint / begin / execute / verify — in its OWN linked
 * worktree (forked off the wave base SHA, on the phase's integration branch),
 * never the shared projectDir. The worktree is removed after the phase settles
 * (success, fail, or skip).
 *
 * These tests assert at the SEAM (a real temp git repo, the per-phase driver
 * stubbed at the unit boundary — the proven pattern from
 * parallel-runner.integration.test.ts): each concurrent phase's driver call
 * receives a DISTINCT worktree path (never the shared projectDir), and a worktree
 * is created and then removed per phase.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GSD } from './index.js';
import { PhaseStepType } from './types.js';
import type { PhaseRunnerResult, RoadmapAnalysis } from './types.js';

const execFileAsync = promisify(execFile);
const gitIn = (dir: string) => (args: string[]) => execFileAsync('git', args, { cwd: dir });

async function setupRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gsd-par-wt-'));
  const git = gitIn(dir);
  await git(['init', '-q', '-b', 'main']);
  await git(['config', 'user.email', 't@t.t']);
  await git(['config', 'user.name', 'T']);
  await git(['config', 'commit.gpgsign', 'false']);
  await mkdir(join(dir, '.planning', 'phases', '01-a'), { recursive: true });
  await mkdir(join(dir, '.planning', 'phases', '02-b'), { recursive: true });
  const plan = (ph: string, f: string) =>
    `---\nphase: ${ph}\nfiles_modified:\n  - ${f}\n---\n<objective>O</objective>\n<tasks><task type="auto"><name>T</name></task></tasks>\n`;
  await writeFile(join(dir, '.planning', 'phases', '01-a', '01-PLAN.md'), plan('01-a', 'src/a.ts'));
  await writeFile(join(dir, '.planning', 'phases', '02-b', '02-PLAN.md'), plan('02-b', 'src/b.ts'));
  await writeFile(join(dir, '.planning', 'STATE.md'), 'status: ready\n');
  await writeFile(join(dir, '.planning', 'ROADMAP.md'), '### Phase 1: A\n### Phase 2: B\n');
  // ADR 0014 D5 opt-in: phase_level:true is required by the runParallel gate.
  await writeFile(
    join(dir, '.planning', 'config.json'),
    JSON.stringify({ parallelization: { enabled: true, phase_level: true } }),
  );
  await git(['add', '-A']);
  await git(['commit', '-q', '--no-verify', '-m', 'base']);
  return dir;
}

function greenResult(phaseNumber: string): PhaseRunnerResult {
  return {
    phaseNumber,
    phaseName: `P${phaseNumber}`,
    steps: [{ step: PhaseStepType.Execute, success: true, durationMs: 1 }],
    success: true,
    totalCostUsd: 0,
    totalDurationMs: 1,
  };
}

function twoPhaseRoadmap(): RoadmapAnalysis {
  return {
    phases: [
      { number: '1', disk_status: 'pending', roadmap_complete: false, phase_name: 'A' },
      { number: '2', disk_status: 'pending', roadmap_complete: false, phase_name: 'B' },
    ],
  };
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

let dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
  dirs = [];
  vi.restoreAllMocks();
});

describe('GSD.runParallel — per-phase worktree isolation (Chunk C PR-1)', () => {
  it('drives each concurrent phase in a DISTINCT worktree (never the shared projectDir), created then removed', async () => {
    const dir = await setupRepo();
    dirs.push(dir);
    const gsd = new GSD({ projectDir: dir });

    // Capture the phaseDir the driver receives per phase + whether the dir
    // existed AT call time. The driver is stubbed at the unit boundary so we
    // exercise the wave loop's worktree threading, not the executor.
    const seen = new Map<string, { phaseDir: string | undefined; existedAtCall: boolean }>();
    const runSpy = vi
      .spyOn(gsd as any, 'runPhaseWithRollbackRetry')
      .mockImplementation(async (...args: any[]) => {
        const phase = args[0];
        const phaseDir: string | undefined = args[3];
        seen.set(phase.number, {
          phaseDir,
          existedAtCall: phaseDir ? await exists(phaseDir) : false,
        });
        return { result: greenResult(phase.number), halted: false };
      });
    vi.spyOn(gsd, 'createTools').mockReturnValue({
      roadmapAnalyze: vi.fn().mockResolvedValue(twoPhaseRoadmap()),
    } as never);

    const res = await gsd.runParallel(['1', '2'], { openPullRequests: false });
    expect(res.success).toBe(true);
    expect(runSpy).toHaveBeenCalledTimes(2);

    const p1 = seen.get('1')!;
    const p2 = seen.get('2')!;
    // Each phase ran in a real per-phase worktree, NOT the shared projectDir.
    expect(p1.phaseDir).toBeTruthy();
    expect(p2.phaseDir).toBeTruthy();
    expect(p1.phaseDir).not.toBe(dir);
    expect(p2.phaseDir).not.toBe(dir);
    // The two concurrent members got DISTINCT worktrees (no shared tree/index).
    expect(p1.phaseDir).not.toBe(p2.phaseDir);
    // The worktree existed while the driver ran.
    expect(p1.existedAtCall).toBe(true);
    expect(p2.existedAtCall).toBe(true);
    // Each worktree is removed after the phase settles — none survive the wave.
    expect(await exists(p1.phaseDir!)).toBe(false);
    expect(await exists(p2.phaseDir!)).toBe(false);
    const { stdout: wts } = await gitIn(dir)(['worktree', 'list', '--porcelain']);
    expect(wts).not.toContain(p1.phaseDir!);
    expect(wts).not.toContain(p2.phaseDir!);
  }, 15000);

  it('removes a phase worktree even when the phase fails (cleanup in the settle path)', async () => {
    const dir = await setupRepo();
    dirs.push(dir);
    const gsd = new GSD({ projectDir: dir });

    let failedPhaseDir: string | undefined;
    vi.spyOn(gsd as any, 'runPhaseWithRollbackRetry').mockImplementation(async (...args: any[]) => {
      const phase = args[0];
      const phaseDir: string | undefined = args[3];
      if (phase.number === '1') {
        failedPhaseDir = phaseDir;
        return {
          result: {
            ...greenResult('1'),
            success: false,
            steps: [{ step: PhaseStepType.Execute, success: false, durationMs: 1 }],
          },
          halted: true,
        };
      }
      return { result: greenResult(phase.number), halted: false };
    });
    vi.spyOn(gsd, 'createTools').mockReturnValue({
      roadmapAnalyze: vi.fn().mockResolvedValue(twoPhaseRoadmap()),
    } as never);

    const res = await gsd.runParallel(['1', '2'], { openPullRequests: false });
    expect(res.success).toBe(false);
    expect(failedPhaseDir).toBeTruthy();
    // The failing phase's worktree was removed despite the failure.
    expect(await exists(failedPhaseDir!)).toBe(false);
    const { stdout: wts } = await gitIn(dir)(['worktree', 'list', '--porcelain']);
    expect(wts).not.toContain(failedPhaseDir!);
  }, 15000);
});
