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
import { scheduleWavesForPhases } from './query/wave-scheduler.js';
import { planningPaths } from './query/helpers.js';

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

  it('keeps ROADMAP.md / STATE.md uncorrupted across a concurrent wave (D2)', async () => {
    const dir = await setupRepo();
    dirs.push(dir);
    const git = gitIn(dir);
    const gsd = new GSD({ projectDir: dir });
    vi.spyOn(gsd as any, 'runPhaseWithRollbackRetry').mockImplementation(async (phase: any) => {
      // A phase "promotes" a STATE.md update the orchestrator serializes. (Only
      // phase 1 mutates git so the two concurrent wave members don't collide on
      // the shared repo index — real phase-agents work in isolated branches.)
      if (phase.number === '1') {
        await writeFile(join(dir, '.planning', 'STATE.md'), 'status: ready\nphase-1\n');
        await git(['add', '-A']);
        await git(['commit', '-q', '--no-verify', '-m', 'p1']);
      }
      return { result: greenResult(phase.number), halted: false };
    });
    vi.spyOn(gsd, 'createTools').mockReturnValue({
      roadmapAnalyze: vi.fn().mockResolvedValue(twoPhaseRoadmap()),
    } as never);

    const res = await gsd.runParallel(['1', '2'], { openPullRequests: false });
    // No merge conflict markers ever land in the ledgers.
    const { stdout: state } = await git(['show', 'HEAD:.planning/STATE.md']);
    expect(state).not.toMatch(/^<{7}|^={7}|^>{7}/m);
    expect(res.success).toBe(true);
  });

  it('fails closed when a phase mutates an orchestrator-owned ledger mid-wave (D2 tripwire)', async () => {
    const dir = await setupRepo();
    dirs.push(dir);
    const git = gitIn(dir);
    const gsd = new GSD({ projectDir: dir });
    // One phase-agent corrupts ROADMAP.md with conflict markers and promotes it
    // onto protected — the wave-scoped sole-writer invariant is violated. The
    // tripwire must catch it after the wave settles and fail closed. (Only phase
    // 1 mutates git so the two concurrent wave members don't collide on the
    // shared repo index — real phase-agents work in isolated integration
    // branches; the corrupted protected ledger is what the tripwire inspects.)
    vi.spyOn(gsd as any, 'runPhaseWithRollbackRetry').mockImplementation(async (phase: any) => {
      if (phase.number === '1') {
        await writeFile(
          join(dir, '.planning', 'ROADMAP.md'),
          '<<<<<<< HEAD\n### Phase 1: A\n=======\n### Phase 1: A bad\n>>>>>>> theirs\n',
        );
        await git(['add', '-A']);
        await git(['commit', '-q', '--no-verify', '-m', 'corrupt 1']);
      }
      return { result: greenResult(phase.number), halted: false };
    });
    vi.spyOn(gsd, 'createTools').mockReturnValue({
      roadmapAnalyze: vi.fn().mockResolvedValue(twoPhaseRoadmap()),
    } as never);

    await expect(gsd.runParallel(['1', '2'], { openPullRequests: false })).rejects.toThrow(
      /D2 violation.*ROADMAP\.md/,
    );
  });

  it('skips only the depends_on closure of a failed phase; unrelated phases proceed (D4)', async () => {
    const dir = await setupRepo();
    dirs.push(dir);
    const git = gitIn(dir);
    // Three phases: 1 (fails), 2 (depends on 1 → skipped), 3 (independent → runs).
    await mkdir(join(dir, '.planning', 'phases', '03-c'), { recursive: true });
    const plan = (ph: string, f: string) =>
      `---\nphase: ${ph}\nfiles_modified:\n  - ${f}\n---\n<objective>O</objective>\n<tasks><task type="auto"><name>T</name></task></tasks>\n`;
    await writeFile(join(dir, '.planning', 'phases', '03-c', '03-PLAN.md'), plan('03-c', 'src/c.ts'));
    // ROADMAP declares phase 2 depends on phase 1.
    await writeFile(
      join(dir, '.planning', 'ROADMAP.md'),
      '### Phase 1: A\n### Phase 2: B\n**Depends on:** Phase 1\n### Phase 3: C\n',
    );
    await git(['add', '-A']);
    await git(['commit', '-q', '--no-verify', '-m', 'roadmap deps']);

    const gsd = new GSD({ projectDir: dir });
    const ran: string[] = [];
    vi.spyOn(gsd as any, 'runPhaseWithRollbackRetry').mockImplementation(async (phase: any) => {
      ran.push(phase.number);
      if (phase.number === '1') {
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
      roadmapAnalyze: vi.fn().mockResolvedValue({
        phases: [
          { number: '1', disk_status: 'pending', roadmap_complete: false, phase_name: 'A' },
          { number: '2', disk_status: 'pending', roadmap_complete: false, phase_name: 'B' },
          { number: '3', disk_status: 'pending', roadmap_complete: false, phase_name: 'C' },
        ],
      }),
    } as never);

    const res = await gsd.runParallel(['1', '2', '3'], { openPullRequests: false });
    // Phase 1 ran and failed; phase 2 (depends on 1) was SKIPPED, never ran;
    // phase 3 (independent) ran and promoted.
    expect(ran).toContain('1');
    expect(ran).not.toContain('2');
    expect(ran).toContain('3');
    const p2 = res.phases.find((p) => p.phaseNumber === '2')!;
    expect(p2.skippedReason).toMatch(/depends_on.*\b1\b/);
    expect(p2.promoted).toBe(false);
    const p3 = res.phases.find((p) => p.phaseNumber === '3')!;
    expect(p3.promoted).toBe(true);
    expect(res.success).toBe(false);
  });

  it('a failed phase leaves no integration branch after the wave (Tier-1 reuse)', async () => {
    const dir = await setupRepo();
    dirs.push(dir);
    const git = gitIn(dir);
    const gsd = new GSD({ projectDir: dir });
    // Do NOT stub runPhaseWithRollbackRetry — exercise the REAL driver so its
    // existing Tier-1 rollback path fires. Stub the inner runPhase to settle
    // non-green WITH a rollback context the real driver acts on via rollbackTier1.
    const { createPhaseCheckpoint, ensureCheckpointGitignore, integrationBranchFor } = await import(
      './query/phase-checkpoint.js'
    );
    await ensureCheckpointGitignore(dir);
    const cp = await createPhaseCheckpoint({ projectDir: dir, phaseNumber: '1', protectedBranch: 'main' });
    await git(['checkout', '-B', integrationBranchFor('1'), cp.lastGoodSha]);
    await writeFile(join(dir, 'work.txt'), 'w\n');
    await git(['add', '-A']);
    await git(['commit', '-q', '--no-verify', '-m', 'int work']);
    await git(['checkout', 'main']);

    vi.spyOn(gsd as any, 'runPhase').mockResolvedValue({
      phaseNumber: '1',
      phaseName: 'A',
      steps: [{ step: PhaseStepType.Execute, success: false, durationMs: 1 }],
      success: false,
      totalCostUsd: 0,
      totalDurationMs: 1,
      rollbackContext: {
        phaseNumber: '1',
        protectedBranch: 'main',
        lastGoodSha: cp.lastGoodSha,
        snapshotDir: cp.snapshotDir,
        integrationBranch: integrationBranchFor('1'),
      },
    });
    vi.spyOn(gsd, 'createTools').mockReturnValue({
      roadmapAnalyze: vi.fn().mockResolvedValue(twoPhaseRoadmap()),
    } as never);

    const res = await gsd.runParallel(['1', '2'], { openPullRequests: false });
    // Tier-1 fired (reused, not reimplemented): integration branch deleted,
    // protected still at LAST_GOOD.
    await expect(
      git(['rev-parse', '--verify', `refs/heads/${integrationBranchFor('1')}`]),
    ).rejects.toThrow();
    expect((await git(['rev-parse', 'main'])).stdout.trim()).toBe(cp.lastGoodSha);
    expect(res.phases.find((p) => p.phaseNumber === '1')!.promoted).toBe(false);
  });
});

describe('GSD.runParallel — schedule-validity guards + fail-closed wave loop (FIX 1/2/3)', () => {
  // FIX 1a — CROSS-WAVE backward edge → REJECT (not hang). Phase 2 hard-conflicts
  // phase 1 (→ separate waves) AND declares `Depends on: Phase 1`. With input
  // order ['2','1'], conflict-graph places phase 2 in wave 0 and phase 1 in wave 1,
  // so the dependent (phase 2) is scheduled BEFORE its predecessor (phase 1). The
  // pre-seeded `settled` await on phase 1's promise can never resolve (wave 1 can't
  // start until wave 0 finishes) → permanent hang without the up-front guard.
  it('rejects (does not hang) when a depends_on predecessor is scheduled in a later wave', async () => {
    const dir = await setupRepo();
    dirs.push(dir);
    const git = gitIn(dir);
    // Phase 2 hard-conflicts phase 1 on src/a.ts → forced into separate waves.
    await writeFile(
      join(dir, '.planning', 'phases', '02-b', '02-PLAN.md'),
      `---\nphase: 02-b\nfiles_modified:\n  - src/a.ts\n---\n<objective>O</objective>\n<tasks><task type="auto"><name>T</name></task></tasks>\n`,
    );
    // ROADMAP: phase 2 depends_on phase 1.
    await writeFile(
      join(dir, '.planning', 'ROADMAP.md'),
      '### Phase 1: A\n### Phase 2: B\n**Depends on:** Phase 1\n',
    );
    await git(['add', '-A']);
    await git(['commit', '-q', '--no-verify', '-m', 'cross-wave dep']);

    // Assert the schedule inversion actually holds: phase 2 (dependent) in an
    // earlier wave than phase 1 (predecessor) under input order ['2','1'].
    const sched = await scheduleWavesForPhases(['2', '1'], dir);
    const waveOf = (t: string) => sched.waves.findIndex((w) => w.includes(t));
    expect(waveOf('02')).toBeLessThan(waveOf('01'));

    const gsd = new GSD({ projectDir: dir });
    vi.spyOn(gsd as any, 'runPhaseWithRollbackRetry').mockImplementation(
      async (phase: any) => ({ result: greenResult(phase.number), halted: false }),
    );
    vi.spyOn(gsd, 'createTools').mockReturnValue({
      roadmapAnalyze: vi.fn().mockResolvedValue(twoPhaseRoadmap()),
    } as never);

    await expect(
      gsd.runParallel(['2', '1'], { openPullRequests: false }),
    ).rejects.toThrow(/later wave|contradicts the dependency order/);
  }, 8000);

  // FIX 1b — depends_on CYCLE → REJECT. Phases 1 and 2 have DISJOINT files (same
  // wave); ROADMAP declares 1 depends_on 2 AND 2 depends_on 1. The pre-seeded
  // settled-promise await is mutual → permanent hang without the cycle guard.
  it('rejects (does not hang) on a depends_on cycle among scheduled phases', async () => {
    const dir = await setupRepo();
    dirs.push(dir);
    const git = gitIn(dir);
    // Disjoint files (a.ts vs b.ts) → same wave. Mutual depends_on.
    await writeFile(
      join(dir, '.planning', 'ROADMAP.md'),
      '### Phase 1: A\n**Depends on:** Phase 2\n### Phase 2: B\n**Depends on:** Phase 1\n',
    );
    await git(['add', '-A']);
    await git(['commit', '-q', '--no-verify', '-m', 'cycle']);

    const gsd = new GSD({ projectDir: dir });
    vi.spyOn(gsd as any, 'runPhaseWithRollbackRetry').mockImplementation(
      async (phase: any) => ({ result: greenResult(phase.number), halted: false }),
    );
    vi.spyOn(gsd, 'createTools').mockReturnValue({
      roadmapAnalyze: vi.fn().mockResolvedValue(twoPhaseRoadmap()),
    } as never);

    await expect(
      gsd.runParallel(['1', '2'], { openPullRequests: false }),
    ).rejects.toThrow(/cycle/);
  }, 8000);

  // FIX 2 — THROW path → run COMPLETES (continue-independents + tripwire still
  // runs). The driver THROWS for phase 1 and returns green for phase 2. Today the
  // unguarded member body rejects the wave's Promise.all → the run rejects, the
  // sibling is aborted, and assertLedgersClean never runs. After the fix the run
  // RESOLVES: the throwing phase is a non-promoted outcome, the sibling ran.
  it('completes the run when a phase throws (continue-independents, tripwire reachable)', async () => {
    const dir = await setupRepo();
    dirs.push(dir);
    const gsd = new GSD({ projectDir: dir });
    const ran: string[] = [];
    vi.spyOn(gsd as any, 'runPhaseWithRollbackRetry').mockImplementation(
      async (phase: any) => {
        ran.push(phase.number);
        if (phase.number === '1') throw new Error('boom in phase 1');
        return { result: greenResult(phase.number), halted: false };
      },
    );
    vi.spyOn(gsd, 'createTools').mockReturnValue({
      roadmapAnalyze: vi.fn().mockResolvedValue(twoPhaseRoadmap()),
    } as never);

    const res = await gsd.runParallel(['1', '2'], { openPullRequests: false });
    expect(res.success).toBe(false);
    const p1 = res.phases.find((p) => p.phaseNumber === '1')!;
    expect(p1.promoted).toBe(false);
    expect(p1.result.success).toBe(false);
    // The sibling ran (was not aborted by phase 1's throw).
    expect(ran).toContain('2');
    const p2 = res.phases.find((p) => p.phaseNumber === '2')!;
    expect(p2.promoted).toBe(true);
  }, 8000);

  // FIX 3 — WORKSTREAM D2 tripwire FIRES. Under a workstream run the ledgers live
  // at .planning/workstreams/<ws>/{ROADMAP,STATE}.md. assertLedgersClean hardcodes
  // the ROOT paths → reads an absent path → catch{continue} → SILENT PASS today.
  // A phase corrupts the WORKSTREAM-scoped ROADMAP and promotes it; the tripwire
  // must fire after the wave settles.
  it('fires the D2 tripwire under a workstream when a phase corrupts the workstream ROADMAP', async () => {
    const dir = await setupRepo();
    dirs.push(dir);
    const git = gitIn(dir);
    const ws = 'streamx';
    // Materialize the workstream-scoped planning tree per planningPaths.
    const wsPaths = planningPaths(dir, ws);
    await mkdir(join(wsPaths.phases, '01-a'), { recursive: true });
    await mkdir(join(wsPaths.phases, '02-b'), { recursive: true });
    const plan = (ph: string, f: string) =>
      `---\nphase: ${ph}\nfiles_modified:\n  - ${f}\n---\n<objective>O</objective>\n<tasks><task type="auto"><name>T</name></task></tasks>\n`;
    await writeFile(join(wsPaths.phases, '01-a', '01-PLAN.md'), plan('01-a', 'src/a.ts'));
    await writeFile(join(wsPaths.phases, '02-b', '02-PLAN.md'), plan('02-b', 'src/b.ts'));
    await writeFile(wsPaths.state, 'status: ready\n');
    await writeFile(wsPaths.roadmap, '### Phase 1: A\n### Phase 2: B\n');
    await git(['add', '-A']);
    await git(['commit', '-q', '--no-verify', '-m', 'workstream base']);

    const gsd = new GSD({ projectDir: dir, workstream: ws });
    // Project-relative form of the workstream ROADMAP for the git mutation.
    const wsRoadmapRel = relativeUnder(dir, wsPaths.roadmap);
    vi.spyOn(gsd as any, 'runPhaseWithRollbackRetry').mockImplementation(async (phase: any) => {
      if (phase.number === '1') {
        await writeFile(
          wsPaths.roadmap,
          '<<<<<<< HEAD\n### Phase 1: A\n=======\n### Phase 1: A bad\n>>>>>>> theirs\n',
        );
        await git(['add', '-A']);
        await git(['commit', '-q', '--no-verify', '-m', `corrupt ws roadmap ${wsRoadmapRel}`]);
      }
      return { result: greenResult(phase.number), halted: false };
    });
    vi.spyOn(gsd, 'createTools').mockReturnValue({
      roadmapAnalyze: vi.fn().mockResolvedValue(twoPhaseRoadmap()),
    } as never);

    await expect(
      gsd.runParallel(['1', '2'], { openPullRequests: false }),
    ).rejects.toThrow(/D2 violation.*ROADMAP/);
  }, 8000);
});

/** Project-relative POSIX path of `abs` under `root` (for `git show <ref>:<rel>`). */
function relativeUnder(root: string, abs: string): string {
  return abs.slice(root.length).replace(/^[/\\]+/, '').replace(/\\/g, '/');
}
