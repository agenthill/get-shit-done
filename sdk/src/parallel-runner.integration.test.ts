/**
 * GSD.runParallel — parallel multi-phase wave executor FALSIFIER (ADR 0014).
 *
 * Drives the wave loop against a REAL temp git repo (so conflict-graph reads the
 * on-disk PLAN.md `files_modified` footprints), with the per-phase rollback/retry
 * driver stubbed at the unit boundary so the test exercises the WAVE LOOP — not
 * the executor.
 *
 * Stubbing: `createTools` is replaced wholesale (the proven pattern from
 * autonomous-rollback-retry.integration.test.ts) so the runParallel instance sees
 * the controlled roadmap; `runPhaseWithRollbackRetry` is spied on the instance so
 * the loop's fan-out/settle behavior is what runs.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
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
  const dir = await mkdtemp(join(tmpdir(), 'gsd-par-'));
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

/** The two-phase roadmap the runParallel instance resolves. */
function twoPhaseRoadmap(): RoadmapAnalysis {
  return {
    phases: [
      { number: '1', disk_status: 'pending', roadmap_complete: false, phase_name: 'A' },
      { number: '2', disk_status: 'pending', roadmap_complete: false, phase_name: 'B' },
    ],
  };
}

let dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
  dirs = [];
  vi.restoreAllMocks();
});

describe('GSD.runParallel — happy path wave loop (D1)', () => {
  it('runs two disjoint phases in one wave and both go green', async () => {
    const dir = await setupRepo();
    dirs.push(dir);
    const gsd = new GSD({ projectDir: dir });
    // Stub the per-phase driver so we exercise the wave loop, not the executor.
    const runSpy = vi
      .spyOn(gsd as any, 'runPhaseWithRollbackRetry')
      .mockImplementation(async (phase: any) => ({ result: greenResult(phase.number), halted: false }));
    // Replace createTools wholesale so the runParallel instance resolves the
    // controlled roadmap (the robust pattern — a prototype spy can miss the
    // instance the loop actually uses).
    vi.spyOn(gsd, 'createTools').mockReturnValue({
      roadmapAnalyze: vi.fn().mockResolvedValue(twoPhaseRoadmap()),
    } as never);

    const res = await gsd.runParallel(['1', '2'], { openPullRequests: false });

    expect(res.success).toBe(true);
    expect(res.waves).toHaveLength(1);
    expect(res.waves[0].phases.map((p) => p.phaseNumber).sort()).toEqual(['1', '2']);
    expect(res.phases.every((p) => p.promoted)).toBe(true);
    expect(runSpy).toHaveBeenCalledTimes(2);
  });

  it('opens + admin-merges a PR per green phase, serialized in wave order (D6)', async () => {
    const dir = await setupRepo();
    dirs.push(dir);
    const gsd = new GSD({ projectDir: dir });
    vi.spyOn(gsd as any, 'runPhaseWithRollbackRetry')
      .mockImplementation(async (phase: any) => ({ result: greenResult(phase.number), halted: false }));
    vi.spyOn(gsd, 'createTools').mockReturnValue({
      roadmapAnalyze: vi.fn().mockResolvedValue(twoPhaseRoadmap()),
    } as never);

    const merges: string[] = [];
    const fakeRunners = {
      gh: vi.fn(async (args: string[]) => {
        if (args[0] === 'pr' && args[1] === 'create') {
          return `https://x/pull/${args[args.indexOf('--head') + 1]}\n`;
        }
        if (args[0] === 'pr' && args[1] === 'merge') merges.push(args[2]);
        return '';
      }),
      git: vi.fn(async () => ''),
    };

    const res = await gsd.runParallel(['1', '2'], {
      openPullRequests: true,
      prRunners: fakeRunners,
    });

    expect(res.phases.every((p) => p.prUrl)).toBe(true);
    // One merge per green phase, in wave order (both members of wave 0).
    expect(merges).toHaveLength(2);
  });

  it('captures a fresh base SHA per wave (D3): wave 1 forks off wave 0 promotes', async () => {
    const dir = await setupRepo();
    dirs.push(dir);
    const git = gitIn(dir);
    const base0 = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    const gsd = new GSD({ projectDir: dir });

    const seenHeads: string[] = [];
    const seenBranches: string[] = [];
    // Driver stub: record where the engine would fork off (the working-tree HEAD
    // and its branch at runPhase time), then advance protected (the promote) and
    // leave the working tree parked on a NON-protected integration branch — the
    // state a real per-phase promote leaves behind. Without the D3 wave-start
    // hook re-checking-out protected, wave 1 would fork off this stale branch.
    vi.spyOn(gsd as any, 'runPhaseWithRollbackRetry').mockImplementation(async (phase: any) => {
      seenHeads.push((await git(['rev-parse', 'HEAD'])).stdout.trim());
      seenBranches.push((await git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim());
      // Advance protected (the promote commit).
      await git(['checkout', '-q', 'main']);
      await writeFile(join(dir, `phase-${phase.number}.txt`), 'x\n');
      await git(['add', '-A']);
      await git(['commit', '-q', '--no-verify', '-m', `promote ${phase.number}`]);
      // Park the working tree off protected, as a real promote leaves it.
      await git(['checkout', '-q', '-B', `gsd-int-${phase.number}`]);
      return { result: greenResult(phase.number), halted: false };
    });
    vi.spyOn(gsd, 'createTools').mockReturnValue({
      roadmapAnalyze: vi.fn().mockResolvedValue(twoPhaseRoadmap()),
    } as never);
    // Force two waves: make phase 2 hard-conflict with phase 1.
    await writeFile(
      join(dir, '.planning', 'phases', '02-b', '02-PLAN.md'),
      `---\nphase: 02-b\nfiles_modified:\n  - src/a.ts\n---\n<objective>O</objective>\n<tasks><task type="auto"><name>T</name></task></tasks>\n`,
    );
    await git(['add', '-A']);
    await git(['commit', '-q', '--no-verify', '-m', 'conflict']);
    const mainAfterConflict = (await git(['rev-parse', 'main'])).stdout.trim();

    const res = await gsd.runParallel(['1', '2'], { openPullRequests: false });
    expect(res.waves).toHaveLength(2);
    // Wave 0's phase forked off the (conflict-advanced) protected HEAD, not base0.
    expect(seenHeads[0]).toBe(mainAfterConflict);
    expect(seenHeads[0]).not.toBe(base0);
    // D3: wave 1's phase forked off protected AS IT STANDS AFTER wave 0's promote
    // — the wave-start hook re-checked-out protected, so it did NOT inherit the
    // stale non-protected branch wave 0 parked on.
    expect(seenBranches[1]).toBe('main');
    expect(seenHeads[1]).not.toBe(seenHeads[0]); // protected advanced by wave 0's promote
    expect(seenHeads[1]).not.toBe(mainAfterConflict); // forked off wave 0's promote, not the pre-wave base
  });
});
