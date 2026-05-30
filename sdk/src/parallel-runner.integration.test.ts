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
});
