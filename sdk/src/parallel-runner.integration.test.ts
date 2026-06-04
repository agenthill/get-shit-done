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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
import { resetGlobalBudgetForTest } from './global-budget.js';

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
// BLOCKER 2: the process-wide getGlobalBudget() singleton is created by the
// FIRST runParallel and otherwise carried across EVERY subsequent test, so a
// prior test's drained/odd permit count leaked into the next and flaked the D2
// tripwire tests ('promise resolved instead of rejecting') under contamination.
// Reset it before EVERY test so each starts from a fresh, full budget.
beforeEach(() => {
  resetGlobalBudgetForTest();
});
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

  // ─── phase_level gate falsifier (item 2, #24) ────────────────────────────
  // FALSIFIER (W): if the gate is absent the call resolves instead of throwing.
  // Verifies resolvePhaseLevelParallelism is wired into GSD.runParallel
  // fail-closed (ADR 0014 D5 opt-in). A repo with no config.json (or one that
  // explicitly sets phase_level:false) must cause runParallel to reject.
  it('rejects when phase_level is false/unset — phase-level parallelism is opt-in (gate falsifier)', async () => {
    const dir = await setupRepo();
    dirs.push(dir);
    // Overwrite the config written by setupRepo: explicitly disable phase_level.
    // This exercises both the false and the "enabled but not phase_level" cases.
    await writeFile(
      join(dir, '.planning', 'config.json'),
      JSON.stringify({ parallelization: { enabled: true, phase_level: false } }),
    );
    const gsd = new GSD({ projectDir: dir });
    vi.spyOn(gsd as any, 'runPhaseWithRollbackRetry').mockImplementation(
      async (phase: any) => ({ result: greenResult(phase.number), halted: false }),
    );
    vi.spyOn(gsd, 'createTools').mockReturnValue({
      roadmapAnalyze: vi.fn().mockResolvedValue(twoPhaseRoadmap()),
    } as never);

    await expect(
      gsd.runParallel(['1', '2'], { openPullRequests: false }),
    ).rejects.toThrow(/runParallel requires parallelization\.phase_level: true/);
  });
});

/** Project-relative POSIX path of `abs` under `root` (for `git show <ref>:<rel>`). */
function relativeUnder(root: string, abs: string): string {
  return abs.slice(root.length).replace(/^[/\\]+/, '').replace(/\\/g, '/');
}

// ─────────────────────────────────────────────────────────────────────────────
// M1 — ADR 0014 measure of success (RELEASE GATE).
//
// One consolidated end-to-end run that exercises all five ADR decisions
// together. It is the genuine FALSIFIER for D1 (real concurrency in a wave), D4
// (failure isolates only the depends_on closure), and D6 (a PR per green phase).
// D2, D3, and the HARD D5 sub-cap binding are NOT falsified inside this fixture
// — its dep-blocking + worktreeOpMutex + fake-PR-promote shape makes those
// assertions tautological here — so each is covered by a DEDICATED falsifier and
// carried here only as a labelled regression/sanity check (see the per-block
// NOTEs). It MUST fail if the command falls back to sequential, mis-schedules
// waves, or mis-isolates a failure.
// ─────────────────────────────────────────────────────────────────────────────

/** A fake gh/git runner pair matching the real pr-merge.ts call shape. */
function fakePrRunners(merges: string[], heads: string[]) {
  return {
    gh: vi.fn(async (a: string[]) => {
      if (a[0] === 'pr' && a[1] === 'create') return `https://x/pull/${a[a.indexOf('--head') + 1]}\n`;
      if (a[0] === 'pr' && a[1] === 'merge') merges.push(a[2]!);
      void heads;
      return '';
    }),
    git: vi.fn(async () => ''),
  };
}

describe('ADR 0014 measure of success (release gate)', () => {
  it('D1+D4+D6 (falsified) + D2/D3/D5 (regression checks): disjoint phases run concurrently in wave 0; a sharer is sequenced later; a failure isolates its depends_on closure; a PR promotes per green phase; ledgers stay clean', async () => {
    const dir = await setupRepo();
    dirs.push(dir);
    const git = gitIn(dir);
    // D5: pin the phase sub-cap to 2 via config.json so the wave-loop budget is
    // observably enforced (a low cap a multi-core global budget would not impose).
    await writeFile(
      join(dir, '.planning', 'config.json'),
      JSON.stringify({ parallelization: { enabled: true, phase_level: true, max_concurrent_phases: 2 } }),
    );
    // Phases: 43,44,45,47 disjoint (would all be wave 0); 46 shares src/a.ts with
    // 43 → forced to a LATER wave; 47 depends_on 43, and 43 is rigged to fail →
    // 47 skipped, 44/45 still promote.
    const plan = (ph: string, f: string) =>
      `---\nphase: ${ph}\nfiles_modified:\n  - ${f}\n---\n<objective>O</objective>\n<tasks><task type="auto"><name>T</name></task></tasks>\n`;
    for (const [d, ph, f] of [
      ['43-x', '43-x', 'src/a.ts'], ['44-y', '44-y', 'src/b.ts'], ['45-z', '45-z', 'src/c.ts'],
      ['46-w', '46-w', 'src/a.ts'], ['47-v', '47-v', 'src/d.ts'],
    ] as const) {
      await mkdir(join(dir, '.planning', 'phases', d), { recursive: true });
      await writeFile(join(dir, '.planning', 'phases', d, `${ph.split('-')[0]}-PLAN.md`), plan(ph, f));
    }
    await writeFile(
      join(dir, '.planning', 'ROADMAP.md'),
      '### Phase 43: X\n### Phase 44: Y\n### Phase 45: Z\n### Phase 46: W\n### Phase 47: V\n**Depends on:** Phase 43\n',
    );
    await git(['add', '-A']);
    await git(['commit', '-q', '--no-verify', '-m', 'fixtures']);

    const gsd = new GSD({ projectDir: dir });
    // Fresh budget so a prior test's permit count cannot leak in; size it ABOVE
    // the sub-cap of 2 so any in-flight bound is proven to come from the phase
    // sub-cap (D5 wiring), not from the global budget itself.
    resetGlobalBudgetForTest(8);

    const merges: string[] = [];
    // D1 concurrency tracker + D3 per-phase base-SHA capture.
    //
    // DETERMINISTIC concurrency barrier (BLOCKER 2): the D1 proof must not depend
    // on a setTimeout overlap winning a jitter race. Wave 0's RUNNABLE set is
    // {43,44,45} (47 is dep-blocked on the failed 43; 46 hard-conflicts 43 → a
    // later wave); the sub-cap is 2, so at most 2 bodies coexist. The barrier
    // holds every arriving body until `barrierTarget` (2) are SIMULTANEOUSLY
    // in-flight, then releases all — so `maxInFlight` reaches 2 reliably, not by
    // luck. A short timeout race is a pure LIVENESS guard (never the success
    // path): if fewer than 2 ever coexist — a genuine concurrency regression —
    // the timeout releases the lone body and maxInFlight stays 1, correctly
    // FAILING the `> 1` assertion below rather than hanging the suite.
    const barrierTarget = 2;
    let arrived = 0;
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((r) => { releaseBarrier = r; });
    const awaitBarrier = async () => {
      arrived++;
      if (arrived >= barrierTarget) releaseBarrier();
      await Promise.race([barrier, new Promise((r) => setTimeout(r, 1000))]);
    };
    let inFlight = 0;
    let maxInFlight = 0;
    const baseShaByPhase = new Map<string, string>();
    vi.spyOn(gsd as any, 'runPhaseWithRollbackRetry').mockImplementation(async (phase: any) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // D3: capture the base SHA each phase forks off at wave-member start.
      baseShaByPhase.set(phase.number, (await git(['rev-parse', 'HEAD'])).stdout.trim());
      await awaitBarrier(); // hold in-flight until the expected count coexist
      inFlight--;
      if (phase.number === '43') {
        return {
          result: {
            phaseNumber: '43', phaseName: 'X',
            steps: [{ step: PhaseStepType.Execute, success: false, durationMs: 1 }],
            success: false, totalCostUsd: 0, totalDurationMs: 1,
          },
          halted: true,
        };
      }
      return { result: greenResult(phase.number), halted: false };
    });
    vi.spyOn(gsd, 'createTools').mockReturnValue({
      roadmapAnalyze: vi.fn().mockResolvedValue({
        phases: ['43', '44', '45', '46', '47'].map((n) => ({
          number: n, disk_status: 'pending', roadmap_complete: false, phase_name: n,
        })),
      }),
    } as never);

    const res = await gsd.runParallel(['43', '44', '45', '46', '47'], {
      openPullRequests: true,
      prRunners: fakePrRunners(merges, []),
    } as never);

    // ── (D1) disjoint phases ran concurrently within a wave; the sharer is a
    // later wave (dependent phases / hard-conflicts sequenced ACROSS waves).
    expect(res.waves.length).toBeGreaterThanOrEqual(2); // would be 1 if sequential-fallback collapsed waves
    const waveOf = (ph: string) => res.waves.findIndex((w) => w.phases.some((p) => p.phaseNumber === ph));
    expect(waveOf('44')).toBe(0);
    expect(waveOf('45')).toBe(0);
    // (D1) the src/a.ts-sharer 46 is provably scheduled to a LATER wave than 43.
    expect(waveOf('46')).toBeGreaterThan(waveOf('43'));
    // (D1) concurrency actually happened — the barrier held two phase bodies
    // SIMULTANEOUSLY in-flight, so this is deterministic (not a timer-overlap
    // race). A sequential-fallback run could never reach 2.
    expect(maxInFlight).toBeGreaterThan(1);

    // ── (D5) NOTE — the HARD sub-cap binding is NOT asserted here. This fixture
    // confounds it two ways: (1) 47 is dep-blocked on the failed 43 and 46 is a
    // later wave, so wave 0's RUNNABLE set is only {43,44,45}; (2) the
    // orchestrator's worktreeOpMutex (index.ts addDetachedWorktreeAt) serializes
    // `git worktree add`, structurally holding overlap at 2 regardless of the
    // sub-cap. Proof: raising max_concurrent_phases to 999 here leaves
    // maxInFlight unchanged at 2 — i.e. `expect(maxInFlight).toBeLessThanOrEqual(2)`
    // would be TAUTOLOGICAL. The genuine, mutation-checked end-to-end sub-cap
    // binding lives in the dedicated D5 falsifier below
    // ('binds the phase sub-cap end-to-end'), which removes both confounders.
    // Here D5 contributes only the (D1) concurrency-occurred signal above.

    // ── (D3) NOTE — per-phase base-SHA capture is a regression/sanity check, not
    // a D3 falsifier: this run promotes via fake PR runners that never advance
    // protected, so wave N+1's captured SHA does not genuinely DIFFER from wave
    // N's. The `^[0-9a-f]{40}$` shape match is always-true on any real repo and
    // the `has('47')` check is a D4 skip-path proxy, not D3. D3's actual binding
    // (wave N+1 forks off wave N's PROMOTED HEAD) is falsified by the dedicated
    // tests: the local-promote D3 test (~line 134) and the multi-wave
    // origin-sync Gap A test (~line 800). Kept here as cheap regression coverage.
    for (const [, sha] of baseShaByPhase) expect(sha).toMatch(/^[0-9a-f]{40}$/);
    // 47 was skipped (never ran) so it captured no base SHA — D4 skip-path proxy.
    expect(baseShaByPhase.has('47')).toBe(false);

    // ── (D4) failure isolation: 43 failed → its depends_on dependent 47 is SKIPPED;
    // independents 44/45 still promote; the failed phase did NOT promote.
    expect(res.phases.find((p) => p.phaseNumber === '43')!.promoted).toBe(false);
    expect(res.phases.find((p) => p.phaseNumber === '44')!.promoted).toBe(true);
    expect(res.phases.find((p) => p.phaseNumber === '45')!.promoted).toBe(true);
    const p47 = res.phases.find((p) => p.phaseNumber === '47')!;
    expect(p47.skippedReason).toMatch(/depends_on.*\b43\b/);
    expect(p47.promoted).toBe(false);

    // ── (D6) a PR auto-merged per green phase (44,45,46 — not 43, not 47).
    expect(merges.length).toBeGreaterThanOrEqual(3);

    // ── (D2) NOTE — sole-writer regression check, NOT the D2 tripwire falsifier:
    // no M1 wave member mutates an orchestrator-owned ledger, so this "no conflict
    // markers on protected" assertion is always-true within this run. The D2
    // tripwire's actual falsifier (a phase corrupts a ledger mid-wave → the run
    // FAILS CLOSED) lives in the dedicated tests: the root-path tripwire (~line
    // 212) and the workstream-scoped tripwire (~line 457). Kept here so a
    // regression that DID let a marker through would still trip the gate.
    const { stdout: roadmap } = await git(['show', 'HEAD:.planning/ROADMAP.md']);
    expect(roadmap).not.toMatch(/^<{7}[\s\S]*?^={7}$[\s\S]*?^>{7}/m);

    // ── overall: the run reports FAILURE (a phase failed) but isolated the blast
    // radius (independents promoted). Sequential-fallback or a non-isolating run
    // would either hang, abort siblings, or report success.
    expect(res.success).toBe(false);
  }, 15000);

  // ── D5 — HARD sub-cap binding, falsified END-TO-END through GSD.runParallel.
  //
  // BLOCKER 3: the M1 block above can NOT bind the sub-cap (its 47-dep-blocked /
  // 46-later-wave / fake-PR shape + worktreeOpMutex hold overlap at 2 regardless
  // of the cap). This dedicated falsifier removes BOTH confounders so the ONLY
  // thing that can bound in-flight phases is `max_concurrent_phases`:
  //   • a CLEAN fixture of FOUR fully-disjoint phases (43,44,45,47 on a,b,c,d) →
  //     one wave, four phases all eligible at once, NO dep-blocking;
  //   • a deterministic barrier that holds each phase body in-flight until the
  //     EXPECTED concurrent count coexist, so the worktreeOpMutex (which only
  //     serializes the `git worktree add` ENTRY, not the body) cannot mask the
  //     steady-state in-flight count.
  // The global budget is sized ABOVE the wave size (8) so the OBSERVED bound is
  // proven to come from the phase sub-cap, not the budget.
  //
  // MUTATION CHECK (verified manually, recorded here): raising
  // max_concurrent_phases from 3 to 999 raises maxInFlight from 3 to 4 (the full
  // disjoint wave) → the `toBe(3)` assertion FAILS. Restoring it to 3 passes.
  // This is the genuine falsifier the M1 `toBeLessThanOrEqual(2)` only pretended
  // to be.
  it('binds the phase sub-cap end-to-end: max_concurrent_phases caps simultaneous in-flight phases (D5)', async () => {
    const dir = await setupRepo();
    dirs.push(dir);
    const git = gitIn(dir);
    const SUB_CAP = 3;
    const WAVE_SIZE = 4;
    await writeFile(
      join(dir, '.planning', 'config.json'),
      JSON.stringify({
        parallelization: { enabled: true, phase_level: true, max_concurrent_phases: SUB_CAP },
      }),
    );
    // Four FULLY DISJOINT phases (distinct files, NO depends_on) → all in wave 0,
    // all eligible at once. Absent the sub-cap, all four would run together.
    const plan = (ph: string, f: string) =>
      `---\nphase: ${ph}\nfiles_modified:\n  - ${f}\n---\n<objective>O</objective>\n<tasks><task type="auto"><name>T</name></task></tasks>\n`;
    for (const [d, ph, f] of [
      ['43-x', '43-x', 'src/a.ts'], ['44-y', '44-y', 'src/b.ts'],
      ['45-z', '45-z', 'src/c.ts'], ['47-v', '47-v', 'src/d.ts'],
    ] as const) {
      await mkdir(join(dir, '.planning', 'phases', d), { recursive: true });
      await writeFile(join(dir, '.planning', 'phases', d, `${ph.split('-')[0]}-PLAN.md`), plan(ph, f));
    }
    await writeFile(
      join(dir, '.planning', 'ROADMAP.md'),
      '### Phase 43: X\n### Phase 44: Y\n### Phase 45: Z\n### Phase 47: V\n',
    );
    await git(['add', '-A']);
    await git(['commit', '-q', '--no-verify', '-m', 'disjoint fixtures']);

    const gsd = new GSD({ projectDir: dir });
    resetGlobalBudgetForTest(8); // ABOVE the wave size → not the binding factor.

    // Barrier holds every body in-flight until `expected` coexist, then releases
    // all. The worktreeOpMutex serializes ENTRY into the body but not the held
    // window, so the steady-state in-flight count reflects the sub-cap alone. The
    // timeout is a pure liveness guard: if the cap admits FEWER than `expected`
    // (a regression), the lone bodies drain on the timeout and maxInFlight lands
    // below `expected`, FAILING the assertion rather than hanging.
    const expected = Math.min(SUB_CAP, WAVE_SIZE);
    let arrived = 0;
    let release!: () => void;
    const barrier = new Promise<void>((r) => { release = r; });
    let inFlight = 0;
    let maxInFlight = 0;
    vi.spyOn(gsd as any, 'runPhaseWithRollbackRetry').mockImplementation(async (phase: any) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      arrived++;
      if (arrived >= expected) release();
      await Promise.race([barrier, new Promise((r) => setTimeout(r, 1500))]);
      inFlight--;
      return { result: greenResult(phase.number), halted: false };
    });
    vi.spyOn(gsd, 'createTools').mockReturnValue({
      roadmapAnalyze: vi.fn().mockResolvedValue({
        phases: ['43', '44', '45', '47'].map((n) => ({
          number: n, disk_status: 'pending', roadmap_complete: false, phase_name: n,
        })),
      }),
    } as never);

    const res = await gsd.runParallel(['43', '44', '45', '47'], { openPullRequests: false });

    // One wave, all four disjoint phases scheduled together.
    expect(res.waves).toHaveLength(1);
    expect(res.waves[0].phases).toHaveLength(WAVE_SIZE);
    // FALSIFIER: in-flight phases are bounded by the sub-cap EXACTLY. Removing or
    // raising the sub-cap lets all 4 coexist → maxInFlight=4 → this FAILS.
    expect(maxInFlight).toBe(SUB_CAP);
    expect(res.phases.every((p) => p.promoted)).toBe(true);
  }, 15000);
});

describe('ADR 0014 hardening — wave-order serialization, transitive skip, Setext-H1 regex (D6/D4/D2)', () => {
  // D6 — promotions serialize in wave order; no two phases' promotes interleave.
  // Each promote (PR admin-merge) is wrapped in the promoteMutex; this test
  // instruments the fake gh runner to detect any overlap of two promotes.
  it('serializes promotes in wave order; no two promotes interleave (D6)', async () => {
    const dir = await setupRepo();
    dirs.push(dir);
    const git = gitIn(dir);
    // Three disjoint phases → one wave, three concurrent members, three promotes.
    const plan = (ph: string, f: string) =>
      `---\nphase: ${ph}\nfiles_modified:\n  - ${f}\n---\n<objective>O</objective>\n<tasks><task type="auto"><name>T</name></task></tasks>\n`;
    await mkdir(join(dir, '.planning', 'phases', '03-c'), { recursive: true });
    await writeFile(join(dir, '.planning', 'phases', '03-c', '03-PLAN.md'), plan('03-c', 'src/c.ts'));
    await git(['add', '-A']);
    await git(['commit', '-q', '--no-verify', '-m', 'three phases']);

    const gsd = new GSD({ projectDir: dir });
    vi.spyOn(gsd as any, 'runPhaseWithRollbackRetry').mockImplementation(
      async (phase: any) => ({ result: greenResult(phase.number), halted: false }),
    );
    vi.spyOn(gsd, 'createTools').mockReturnValue({
      roadmapAnalyze: vi.fn().mockResolvedValue({
        phases: ['1', '2', '3'].map((n) => ({
          number: n, disk_status: 'pending', roadmap_complete: false, phase_name: n,
        })),
      }),
    } as never);

    let promotesInFlight = 0;
    let maxPromotesInFlight = 0;
    const mergeOrder: string[] = [];
    const fakeRunners = {
      gh: vi.fn(async (a: string[]) => {
        if (a[0] === 'pr' && a[1] === 'create') return `https://x/pull/${a[a.indexOf('--head') + 1]}\n`;
        if (a[0] === 'pr' && a[1] === 'merge') {
          // The whole promote (create + merge) runs under the mutex; observe the
          // merge step's overlap window.
          promotesInFlight++;
          maxPromotesInFlight = Math.max(maxPromotesInFlight, promotesInFlight);
          await new Promise((r) => setTimeout(r, 10));
          promotesInFlight--;
          mergeOrder.push(a[2]!);
        }
        return '';
      }),
      git: vi.fn(async () => ''),
    };

    const res = await gsd.runParallel(['1', '2', '3'], {
      openPullRequests: true, prRunners: fakeRunners,
    });
    // All three green and promoted in ONE wave.
    expect(res.waves).toHaveLength(1);
    expect(res.phases.every((p) => p.promoted)).toBe(true);
    // D6: promotes were serialized — never two at once.
    expect(maxPromotesInFlight).toBe(1);
    expect(mergeOrder).toHaveLength(3);
  }, 12000);

  // D4 — multi-hop TRANSITIVE skip: A→B→C (3 fails ⇒ 2 and 1 both skipped).
  // ROADMAP: phase 1 depends_on 2, phase 2 depends_on 3; phase 3 fails. Both the
  // direct (2) and transitive (1) dependents must be skipped.
  it('skips the full transitive depends_on closure of a failed phase (A→B→C, D4)', async () => {
    const dir = await setupRepo();
    dirs.push(dir);
    const git = gitIn(dir);
    const plan = (ph: string, f: string) =>
      `---\nphase: ${ph}\nfiles_modified:\n  - ${f}\n---\n<objective>O</objective>\n<tasks><task type="auto"><name>T</name></task></tasks>\n`;
    await mkdir(join(dir, '.planning', 'phases', '03-c'), { recursive: true });
    await writeFile(join(dir, '.planning', 'phases', '03-c', '03-PLAN.md'), plan('03-c', 'src/c.ts'));
    // 1 depends_on 2; 2 depends_on 3; 3 fails.
    await writeFile(
      join(dir, '.planning', 'ROADMAP.md'),
      '### Phase 1: A\n**Depends on:** Phase 2\n### Phase 2: B\n**Depends on:** Phase 3\n### Phase 3: C\n',
    );
    await git(['add', '-A']);
    await git(['commit', '-q', '--no-verify', '-m', 'transitive deps']);

    const gsd = new GSD({ projectDir: dir });
    const ran: string[] = [];
    vi.spyOn(gsd as any, 'runPhaseWithRollbackRetry').mockImplementation(async (phase: any) => {
      ran.push(phase.number);
      if (phase.number === '3') {
        return {
          result: {
            ...greenResult('3'), success: false,
            steps: [{ step: PhaseStepType.Execute, success: false, durationMs: 1 }],
          },
          halted: true,
        };
      }
      return { result: greenResult(phase.number), halted: false };
    });
    vi.spyOn(gsd, 'createTools').mockReturnValue({
      roadmapAnalyze: vi.fn().mockResolvedValue({
        phases: ['1', '2', '3'].map((n) => ({
          number: n, disk_status: 'pending', roadmap_complete: false, phase_name: n,
        })),
      }),
    } as never);

    const res = await gsd.runParallel(['1', '2', '3'], { openPullRequests: false });
    // Only phase 3 ran; both 2 (direct) and 1 (transitive) were skipped.
    expect(ran).toEqual(['3']);
    const p2 = res.phases.find((p) => p.phaseNumber === '2')!;
    const p1 = res.phases.find((p) => p.phaseNumber === '1')!;
    expect(p2.skippedReason).toMatch(/depends_on.*\b3\b/);   // direct dependent
    expect(p1.skippedReason).toMatch(/depends_on.*\b2\b/);   // transitive (via 2)
    expect(p1.promoted).toBe(false);
    expect(p2.promoted).toBe(false);
    expect(res.success).toBe(false);
  }, 12000);

  // D2 — a Setext-H1 `=======` underline must NOT false-positive the conflict
  // tripwire. A phase promotes a ROADMAP with a legitimate Setext heading (title
  // line followed by `=======`), NO conflict hunk. The run must NOT throw.
  it('does not false-positive the D2 tripwire on a Setext-H1 ======= underline', async () => {
    const dir = await setupRepo();
    dirs.push(dir);
    const git = gitIn(dir);
    const gsd = new GSD({ projectDir: dir });
    vi.spyOn(gsd as any, 'runPhaseWithRollbackRetry').mockImplementation(async (phase: any) => {
      if (phase.number === '1') {
        // A valid Setext-H1: the `=======` line is a heading underline, not a
        // conflict separator — there is no <<<<<<< / >>>>>>> hunk around it.
        await writeFile(
          join(dir, '.planning', 'ROADMAP.md'),
          'Roadmap\n=======\n\n### Phase 1: A\n### Phase 2: B\n',
        );
        await git(['add', '-A']);
        await git(['commit', '-q', '--no-verify', '-m', 'setext heading']);
      }
      return { result: greenResult(phase.number), halted: false };
    });
    vi.spyOn(gsd, 'createTools').mockReturnValue({
      roadmapAnalyze: vi.fn().mockResolvedValue(twoPhaseRoadmap()),
    } as never);

    // Must resolve (NOT throw a D2 violation) — the Setext underline is not a
    // conflict marker.
    const res = await gsd.runParallel(['1', '2'], { openPullRequests: false });
    expect(res.success).toBe(true);
    const { stdout: roadmap } = await git(['show', 'HEAD:.planning/ROADMAP.md']);
    expect(roadmap).toMatch(/^Roadmap\n={7}$/m); // the Setext heading survived intact
  }, 12000);
});

describe('ADR 0014 Gap A — multi-wave origin-sync (PR-promote path)', () => {
  // Under openPullRequests:true, wave N's phases promote via PRs merged to
  // ORIGIN/protected. Before wave N+1, onWaveStart must fetch + fast-forward
  // local protected to origin so wave N+1 bases off the PROMOTED state — not the
  // pre-wave-N base. FALSIFIER: without the origin-sync, wave 1 forks off the
  // stale local protected (== pre-run base), so the captured base SHA equals the
  // pre-run base instead of origin's advanced HEAD.
  it('fast-forwards local protected to origin between waves so wave 1 bases off wave 0 promoted output', async () => {
    const dir = await setupRepo();
    dirs.push(dir);
    const git = gitIn(dir);

    // Stand up a real `origin` remote (a bare repo) and push main to it.
    const originDir = await mkdtemp(join(tmpdir(), 'gsd-par-origin-'));
    dirs.push(originDir);
    await execFileAsync('git', ['init', '-q', '--bare', '-b', 'main'], { cwd: originDir });
    await git(['remote', 'add', 'origin', originDir]);
    await git(['push', '-q', 'origin', 'main']);
    const preRunBase = (await git(['rev-parse', 'main'])).stdout.trim();

    // Force two waves: phase 2 hard-conflicts phase 1 on src/a.ts.
    await writeFile(
      join(dir, '.planning', 'phases', '02-b', '02-PLAN.md'),
      `---\nphase: 02-b\nfiles_modified:\n  - src/a.ts\n---\n<objective>O</objective>\n<tasks><task type="auto"><name>T</name></task></tasks>\n`,
    );
    await git(['add', '-A']);
    await git(['commit', '-q', '--no-verify', '-m', 'conflict']);
    await git(['push', '-q', 'origin', 'main']);
    const afterConflict = (await git(['rev-parse', 'main'])).stdout.trim();

    const gsd = new GSD({ projectDir: dir });
    const baseShaByPhase = new Map<string, string>();
    // The wave-0 phase "promotes" by advancing ORIGIN/main (as a merged PR does),
    // WITHOUT touching local main — exactly the staleness Gap A must repair.
    let advancedOriginSha = '';
    vi.spyOn(gsd as any, 'runPhaseWithRollbackRetry').mockImplementation(async (phase: any) => {
      baseShaByPhase.set(phase.number, (await git(['rev-parse', 'HEAD'])).stdout.trim());
      if (phase.number === '1') {
        // Simulate the PR admin-merge landing on origin/main: push a new commit to
        // origin via a throwaway local branch, leaving LOCAL main untouched.
        await git(['branch', '-q', 'tmp-promote', 'main']);
        await git(['checkout', '-q', 'tmp-promote']);
        await writeFile(join(dir, 'promoted-by-pr.txt'), 'x\n');
        await git(['add', '-A']);
        await git(['commit', '-q', '--no-verify', '-m', 'promote 1 (origin only)']);
        advancedOriginSha = (await git(['rev-parse', 'tmp-promote'])).stdout.trim();
        await git(['push', '-q', 'origin', 'tmp-promote:main']);
        await git(['checkout', '-q', 'main']); // local main still at afterConflict
      }
      return { result: greenResult(phase.number), halted: false };
    });
    vi.spyOn(gsd, 'createTools').mockReturnValue({
      roadmapAnalyze: vi.fn().mockResolvedValue(twoPhaseRoadmap()),
    } as never);

    // PR-promote path; the fake gh runner just records (the real origin advance
    // is done by the driver stub above to model a merged-PR landing on origin).
    const merges: string[] = [];
    const res = await gsd.runParallel(['1', '2'], {
      openPullRequests: true,
      prRunners: fakePrRunners(merges, []),
    } as never);

    expect(res.waves).toHaveLength(2);
    // Wave 0's phase forked off the pre-run/local base.
    expect(baseShaByPhase.get('1')).toBe(afterConflict);
    expect(baseShaByPhase.get('1')).not.toBe(preRunBase); // sanity: conflict commit advanced local
    // Gap A: wave 1's phase forked off the ORIGIN-advanced HEAD (fetch + ff-only
    // synced local main to origin between waves), NOT the stale local base.
    expect(baseShaByPhase.get('2')).toBe(advancedOriginSha);
    expect(baseShaByPhase.get('2')).not.toBe(afterConflict); // would be this WITHOUT the origin-sync
  }, 15000);
});
