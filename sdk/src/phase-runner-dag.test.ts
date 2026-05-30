/**
 * Phase-runner DAG engine — falsifier + wall-clock tests (ADR 0013, Task 5).
 *
 * The "real gate": these tests falsify the known hazards rather than confirm
 * happy paths.
 *
 *  Correctness falsifiers (git-backed, real temp repo):
 *   - a dependent's worktree base contains its predecessor's commits;
 *   - a plan failure isolates its dependents while independent chains finish;
 *   - resume skips has_summary plans;
 *   - the bulk-delete-revert guard never discards an ancestor's commits;
 *   - a files_modified serialization edge prevents concurrent same-file plans.
 *
 *  Wall-clock harness (injected fake durations, test-controlled clock via the
 *  mocked session runner — never by stubbing Date.now):
 *   - makespan(new DAG) < makespan(old wave model) on an A→B→C + D,E DAG with a
 *     test-dominated gate, AND no regression under that test-dominated case.
 *
 * The git "executor" is the mocked session runner: it does a real commit in the
 * worktree cwd it is handed, so fork-off-predecessor reachability is exercised
 * end-to-end.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PhaseRunner } from './phase-runner.js';
import type { PhaseRunnerDeps, ExecutionEngineFactory } from './phase-runner.js';
import type { GSDEvent, PhaseOpInfo, PlanInfo, PhasePlanIndex, PlanResult, SessionUsage } from './types.js';
import { PhaseStepType, GSDEventType } from './types.js';
import { CONFIG_DEFAULTS } from './config.js';
import type { GSDConfig } from './config.js';
import { GitWorktreeManager, GitMergeSerializer } from './execution-engine.js';

const execFileAsync = promisify(execFile);

// session-runner + plan-parser are mocked; the session mock performs the real
// per-plan git work in the worktree cwd it receives.
vi.mock('./session-runner.js', () => ({
  runPhaseStepSession: vi.fn(),
  runPlanSession: vi.fn(),
}));
vi.mock('./plan-parser.js', () => ({
  parsePlanFile: vi.fn().mockResolvedValue({
    frontmatter: { phase: '1', plan: '01', type: 'execute', wave: 1, depends_on: [], files_modified: [], autonomous: true, requirements: [], must_haves: { truths: [], artifacts: [], key_links: [] } },
    objective: 'obj',
    execution_context: [],
    context_refs: [],
    tasks: [{ name: 't', type: 'auto', files: [], read_first: [], action: 'a', verify: 'v', done: 'd', acceptance_criteria: [] }],
    raw: '',
  }),
}));

import { runPhaseStepSession } from './session-runner.js';
const mockSession = vi.mocked(runPhaseStepSession);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function usage(): SessionUsage {
  return { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
}
function okResult(over: Partial<PlanResult> = {}): PlanResult {
  return { success: true, sessionId: 's', totalCostUsd: 0.01, durationMs: 1, usage: usage(), numTurns: 1, ...over };
}
function failResult(msg: string): PlanResult {
  return { success: false, sessionId: '', totalCostUsd: 0, durationMs: 0, usage: usage(), numTurns: 0, error: { subtype: 'error_during_execution', messages: [msg] } };
}

function planInfo(over: Partial<PlanInfo> & { id: string }): PlanInfo {
  return { wave: 1, depends_on: [], autonomous: true, objective: null, files_modified: [], task_count: 1, has_summary: false, ...over };
}

function makeConfig(over: Partial<GSDConfig> = {}): GSDConfig {
  return {
    ...structuredClone(CONFIG_DEFAULTS),
    ...over,
    workflow: { ...CONFIG_DEFAULTS.workflow, research: false, verifier: false, skip_discuss: true, plan_check: false, ...(over.workflow ?? {}) },
  } as GSDConfig;
}

function makePhaseOp(over: Partial<PhaseOpInfo> = {}): PhaseOpInfo {
  return {
    phase_found: true,
    phase_dir: '.planning/phases/01',
    phase_number: '1',
    phase_name: 'P',
    phase_slug: 'p',
    padded_phase: '01',
    has_research: false,
    has_context: true,
    has_plans: true,
    has_verification: false,
    plan_count: 1,
    roadmap_exists: true,
    planning_exists: true,
    commit_docs: true,
    context_path: '/tmp/CONTEXT.md',
    research_path: '/tmp/RESEARCH.md',
    ...over,
  };
}

function makePlanIndex(plans: PlanInfo[]): PhasePlanIndex {
  return {
    phase: '1',
    plans,
    waves: {},
    incomplete: plans.filter(p => !p.has_summary).map(p => p.id),
    has_checkpoints: false,
  };
}

function makeDeps(plans: PlanInfo[], over: Partial<PhaseRunnerDeps> = {}): { deps: PhaseRunnerDeps; events: GSDEvent[] } {
  const events: GSDEvent[] = [];
  const deps: PhaseRunnerDeps = {
    projectDir: over.projectDir ?? '/tmp/project',
    tools: {
      initPhaseOp: vi.fn().mockResolvedValue(makePhaseOp()),
      phaseComplete: vi.fn().mockResolvedValue(undefined),
      phasePlanIndex: vi.fn().mockResolvedValue(makePlanIndex(plans)),
      exec: vi.fn().mockImplementation((cmd: string) => (cmd === 'check.verification-status' ? Promise.resolve({ status: 'pass' }) : Promise.resolve(undefined))),
    } as any,
    promptFactory: { buildPrompt: vi.fn().mockResolvedValue('p'), loadAgentDef: vi.fn().mockResolvedValue(undefined) } as any,
    contextEngine: { resolveContextFiles: vi.fn().mockResolvedValue({}) } as any,
    eventStream: { emitEvent: vi.fn((e: GSDEvent) => events.push(e)), on: vi.fn(), emit: vi.fn() } as any,
    config: makeConfig(),
    ...over,
  };
  return { deps, events };
}

/** Init a real git repo with one base commit. Returns repo dir + base sha. */
async function initRepo(): Promise<{ dir: string; baseSha: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'gsd-dag-repo-'));
  const git = (args: string[]) => execFileAsync('git', args, { cwd: dir });
  await git(['init', '-q', '-b', 'main']);
  await git(['config', 'user.email', 't@t.t']);
  await git(['config', 'user.name', 'T']);
  await git(['config', 'commit.gpgsign', 'false']);
  await writeFile(join(dir, 'base.txt'), 'base\n');
  await git(['add', '-A']);
  await git(['commit', '-q', '--no-verify', '-m', 'base']);
  const baseSha = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  return { dir, baseSha };
}

function gitIn(dir: string) {
  return (args: string[]) => execFileAsync('git', args, { cwd: dir });
}

/**
 * Idempotent commit of a per-plan marker file in the executor's worktree cwd.
 * Tolerates "nothing to commit" so the lifecycle's retryOnce re-run of a failed
 * execute step (a real resume path) does not crash a previously-succeeded plan.
 */
async function commitMarker(cwd: string, id: string): Promise<void> {
  await writeFile(join(cwd, `${id}.txt`), `${id}\n`);
  const git = gitIn(cwd);
  await git(['add', '-A']);
  try {
    await git(['commit', '-q', '--no-verify', '-m', id]);
  } catch {
    // nothing to commit on a resume re-run — already committed; no-op.
  }
}

describe('PhaseRunner DAG engine — correctness falsifiers (git-backed)', () => {
  beforeEach(() => {
    mockSession.mockReset();
  });

  it("a dependent's worktree base contains its predecessor's commits", async () => {
    const { dir, baseSha } = await initRepo();
    const wtRoot = await mkdtemp(join(tmpdir(), 'gsd-dag-wt-'));
    try {
      const worktrees = new GitWorktreeManager(dir, wtRoot);
      const serializer = new GitMergeSerializer(dir, 'main', async () => 0);
      const factory: ExecutionEngineFactory = () => ({ worktrees, serializer, baseSha });

      // The session mock commits a per-plan file in its worktree cwd, and (for B)
      // asserts that A's file is already present — proving fork-off-predecessor.
      const seenByB: Record<string, boolean> = {};
      mockSession.mockImplementation(async (_p, step, _c, opts, _es, ctx) => {
        if (step !== PhaseStepType.Execute) return okResult();
        const cwd = (opts as any).cwd as string;
        const id = (ctx as any).planName as string;
        if (id === 'B') {
          // B forked off A's merged commit → A's committed file must be present.
          seenByB['A.txt'] = existsSync(join(cwd, 'A.txt'));
        }
        await writeFile(join(cwd, `${id}.txt`), `${id}\n`);
        const git = gitIn(cwd);
        await git(['add', '-A']);
        await git(['commit', '-q', '--no-verify', '-m', `${id}`]);
        return okResult();
      });

      const { deps } = makeDeps(
        [planInfo({ id: 'A' }), planInfo({ id: 'B', depends_on: ['A'] })],
        { projectDir: dir, executionEngineFactory: factory },
      );
      const runner = new PhaseRunner(deps);
      const result = await runner.run('1');

      const exec = result.steps.find(s => s.step === PhaseStepType.Execute)!;
      expect(exec.success).toBe(true);
      // B's worktree, forked off A's merged commit, contained A's committed file.
      expect(seenByB['A.txt']).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(wtRoot, { recursive: true, force: true });
    }
  });

  it('a plan failure isolates its dependents while independent chains finish', async () => {
    const { dir, baseSha } = await initRepo();
    const wtRoot = await mkdtemp(join(tmpdir(), 'gsd-dag-wt-'));
    try {
      const worktrees = new GitWorktreeManager(dir, wtRoot);
      const serializer = new GitMergeSerializer(dir, 'main', async () => 0);
      const factory: ExecutionEngineFactory = () => ({ worktrees, serializer, baseSha });

      const ran = new Set<string>();
      mockSession.mockImplementation(async (_p, step, _c, opts, _es, ctx) => {
        if (step !== PhaseStepType.Execute) return okResult();
        const id = (ctx as any).planName as string;
        ran.add(id);
        if (id === 'A') return failResult('A failed');
        await commitMarker((opts as any).cwd as string, id);
        return okResult();
      });

      // A→B chain (A fails) + independent D.
      const { deps } = makeDeps(
        [planInfo({ id: 'A' }), planInfo({ id: 'B', depends_on: ['A'] }), planInfo({ id: 'D' })],
        { projectDir: dir, executionEngineFactory: factory },
      );
      const runner = new PhaseRunner(deps);
      const result = await runner.run('1');

      const exec = result.steps.find(s => s.step === PhaseStepType.Execute)!;
      // Rebuild the planId → PlanResult lookup explicitly. planResults carries no
      // planId, so the engine emits dispositions and planResults co-indexed in
      // DAG (topological) order; assert that contract holds before pairing rather
      // than silently trusting positional alignment.
      expect(exec.planDispositions!).toHaveLength(exec.planResults!.length);
      const byId = new Map<string, PlanResult>();
      exec.planDispositions!.forEach((d, i) => {
        byId.set(d.planId, exec.planResults![i]);
      });
      // A failed, B was never dispatched (blocked-by-ancestor), D finished.
      expect(ran.has('A')).toBe(true);
      expect(ran.has('B')).toBe(false);
      expect(ran.has('D')).toBe(true);
      expect(byId.get('D')!.success).toBe(true);
      expect(byId.get('A')!.success).toBe(false);
      expect(exec.success).toBe(false); // overall fails (A + blocked B)

      const dispB = exec.planDispositions!.find(d => d.planId === 'B')!;
      expect(dispB.merged).toBe(false);
      expect(dispB.skippedReason).toContain('blocked-by-ancestor');
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(wtRoot, { recursive: true, force: true });
    }
  });

  it('the bulk-delete-revert guard never discards an ancestor\'s commits', async () => {
    const { dir, baseSha } = await initRepo();
    const wtRoot = await mkdtemp(join(tmpdir(), 'gsd-dag-wt-'));
    try {
      // Seed 6 ancestor files on main so a later plan can bulk-delete them.
      const gitRepo = gitIn(dir);
      for (let i = 0; i < 6; i++) await writeFile(join(dir, `f${i}.txt`), `v${i}\n`);
      await gitRepo(['add', '-A']);
      await gitRepo(['commit', '-q', '--no-verify', '-m', 'ancestor files']);

      const worktrees = new GitWorktreeManager(dir, wtRoot);
      const serializer = new GitMergeSerializer(dir, 'main', async () => 0);
      const protectedHead = (await gitRepo(['rev-parse', 'main'])).stdout.trim();
      const factory: ExecutionEngineFactory = () => ({ worktrees, serializer, baseSha: protectedHead });

      // The single plan deletes all 6 ancestor files (a >5-file bulk delete).
      mockSession.mockImplementation(async (_p, step, opts: any) => {
        if (step !== PhaseStepType.Execute) return okResult();
        const cwd = opts.cwd as string;
        const git = gitIn(cwd);
        await git(['rm', '-q', 'f0.txt', 'f1.txt', 'f2.txt', 'f3.txt', 'f4.txt', 'f5.txt']);
        await git(['commit', '-q', '--no-verify', '-m', 'bulk delete']);
        return okResult();
      });

      const { deps } = makeDeps([planInfo({ id: 'X', files_modified: ['f0.txt'] })], {
        projectDir: dir,
        executionEngineFactory: factory,
      });
      const runner = new PhaseRunner(deps);
      await runner.run('1');

      // After the guard suite ran, the bulk-deleted ancestor files are restored
      // on the protected branch — no ancestor work was discarded.
      const tree = (await gitRepo(['ls-tree', '--name-only', 'main'])).stdout;
      for (let i = 0; i < 6; i++) {
        expect(tree).toContain(`f${i}.txt`);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(wtRoot, { recursive: true, force: true });
    }
  });

  it('the resurrected-file guard strips a file an ancestor intentionally deleted', async () => {
    const { dir, baseSha } = await initRepo();
    const wtRoot = await mkdtemp(join(tmpdir(), 'gsd-dag-wt-'));
    try {
      // Ancestor history on main: create `legacy.txt`, then intentionally delete
      // it in a later commit. A subsequent plan must not silently re-add it.
      const gitRepo = gitIn(dir);
      await writeFile(join(dir, 'legacy.txt'), 'legacy\n');
      await gitRepo(['add', '-A']);
      await gitRepo(['commit', '-q', '--no-verify', '-m', 'add legacy']);
      await gitRepo(['rm', '-q', 'legacy.txt']);
      await gitRepo(['commit', '-q', '--no-verify', '-m', 'intentionally delete legacy']);

      const worktrees = new GitWorktreeManager(dir, wtRoot);
      const serializer = new GitMergeSerializer(dir, 'main', async () => 0);
      const protectedHead = (await gitRepo(['rev-parse', 'main'])).stdout.trim();
      const factory: ExecutionEngineFactory = () => ({ worktrees, serializer, baseSha: protectedHead });

      // The plan re-adds the deleted file (a resurrection).
      mockSession.mockImplementation(async (_p, step, opts: any) => {
        if (step !== PhaseStepType.Execute) return okResult();
        const cwd = opts.cwd as string;
        const git = gitIn(cwd);
        await writeFile(join(cwd, 'legacy.txt'), 'resurrected\n');
        await git(['add', '-A']);
        await git(['commit', '-q', '--no-verify', '-m', 'resurrect legacy']);
        return okResult();
      });

      const { deps } = makeDeps([planInfo({ id: 'R', files_modified: ['other.txt'] })], {
        projectDir: dir,
        executionEngineFactory: factory,
      });
      await new PhaseRunner(deps).run('1');

      // The guard suite removed the resurrected file from the protected branch.
      const tree = (await gitRepo(['ls-tree', '--name-only', 'main'])).stdout;
      expect(tree).not.toContain('legacy.txt');
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(wtRoot, { recursive: true, force: true });
    }
  });

  it('a files_modified serialization edge prevents concurrent same-file plans', async () => {
    const { dir, baseSha } = await initRepo();
    const wtRoot = await mkdtemp(join(tmpdir(), 'gsd-dag-wt-'));
    try {
      const worktrees = new GitWorktreeManager(dir, wtRoot);
      const serializer = new GitMergeSerializer(dir, 'main', async () => 0);
      const factory: ExecutionEngineFactory = () => ({ worktrees, serializer, baseSha });

      let active = 0;
      let maxActive = 0;
      mockSession.mockImplementation(async (_p, step, _c, opts, _es, ctx) => {
        if (step !== PhaseStepType.Execute) return okResult();
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise(r => setTimeout(r, 15));
        const cwd = (opts as any).cwd as string;
        const id = (ctx as any).planName as string;
        await writeFile(join(cwd, `${id}.txt`), `${id}\n`);
        const git = gitIn(cwd);
        await git(['add', '-A']);
        await git(['commit', '-q', '--no-verify', '-m', id]);
        active--;
        return okResult();
      });

      // P1 and P2 share src/api.ts, no depends_on → serialization edge added.
      const { deps } = makeDeps(
        [planInfo({ id: 'P1', files_modified: ['src/api.ts'] }), planInfo({ id: 'P2', files_modified: ['src/api.ts'] })],
        { projectDir: dir, executionEngineFactory: factory },
      );
      const runner = new PhaseRunner(deps);
      await runner.run('1');

      // They never ran concurrently.
      expect(maxActive).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(wtRoot, { recursive: true, force: true });
    }
  });

  it('resume skips has_summary plans (kept as satisfied predecessors)', async () => {
    const dispatched = new Set<string>();
    mockSession.mockImplementation(async (_p, step, _c, _o, _es, ctx) => {
      if (step === PhaseStepType.Execute) dispatched.add((ctx as any).planName as string);
      return okResult();
    });
    // A already complete (has_summary); B depends on A. Only B dispatches.
    const { deps } = makeDeps([
      planInfo({ id: 'A', has_summary: true }),
      planInfo({ id: 'B', depends_on: ['A'] }),
    ]);
    const runner = new PhaseRunner(deps);
    const result = await runner.run('1');

    const exec = result.steps.find(s => s.step === PhaseStepType.Execute)!;
    expect(dispatched.has('A')).toBe(false);
    expect(dispatched.has('B')).toBe(true);
    expect(exec.planResults).toHaveLength(1);
    expect(exec.success).toBe(true);
  });

  it('a level gate testExit=124 (inconclusive) forces the affected plan to fail at the step level', async () => {
    // Executor succeeds, but the batched build+test gate returns 124
    // (timeout/inconclusive ≠ pass). The plan must NOT be reported complete:
    // PhaseStepResult.success derives from planResults[*].success, so the
    // gate-not-pass must downgrade the plan's success (invariant 3).
    mockSession.mockImplementation(async (_p, step) => {
      if (step !== PhaseStepType.Execute) return okResult();
      return okResult();
    });

    // Branch non-empty so the merge/gate path runs; the gate always returns 124.
    const factory: ExecutionEngineFactory = () => ({
      worktrees: {
        async create(planId: string) {
          return { cwd: '/tmp/project', branch: `b-${planId}`, baseSha: '' };
        },
        async headSha() {
          return '';
        },
        async cleanup() {},
      } as any,
      serializer: {
        async merge(planId: string) {
          return { planId, merged: true };
        },
        async gate() {
          return { testExit: 124 };
        },
      } as any,
      baseSha: '',
    });

    const { deps } = makeDeps([planInfo({ id: 'G' })], { executionEngineFactory: factory });
    const result = await new PhaseRunner(deps).run('1');

    const exec = result.steps.find(s => s.step === PhaseStepType.Execute)!;
    // The executor "succeeded" but the gate did not pass → step fails.
    expect(exec.success).toBe(false);
    expect(exec.planResults![0].success).toBe(false);
    const disp = exec.planDispositions!.find(d => d.planId === 'G')!;
    expect(disp.testExit).toBe(124);
    expect(disp.merged).toBe(false);
  });
});

// ─── Wall-clock harness ──────────────────────────────────────────────────────

describe('PhaseRunner DAG engine — wall-clock harness (test-dominated gate)', () => {
  beforeEach(() => {
    mockSession.mockReset();
  });

  /**
   * Injected, deterministic durations — the test owns the clock via setTimeout
   * in the mocked session/gate, never by stubbing Date.now inside the SDK.
   *  - exec(plan)  = EXEC_MS per plan (fast agents)
   *  - gate(level) = GATE_MS per batched gate (slow, test-dominated)
   *
   * The harness gate SERIALIZES (one build runner) so the comparison is faithful
   * to a real build+test, not an artificially-parallel gate.
   *
   * Fixture DAG: A→B→C chain + independent D,E. Three topological levels:
   *   L1 {A,D,E}  L2 {B}  L3 {C}
   *
   * OLD wave model (hard barrier per wave: exec wave → gate → next wave exec):
   *   Σ_levels( max-plan-exec-in-level + GATE_MS ) = 3*EXEC_MS + 3*GATE_MS.
   *   Execution is BLOCKED behind each wave's gate — the chain cannot advance
   *   until the prior wave's build+test finishes.
   *
   * NEW DAG model (this engine): the chain advances at executor speed (the merge,
   * not the gate, unblocks a dependent); the batched gate fires per level and
   * runs CONCURRENTLY with later-level execution. The expensive gate never sits
   * on the execution critical path.
   */
  const EXEC_MS = 40;
  const GATE_MS = 60;

  function makeHarness(): {
    factory: ExecutionEngineFactory;
    gateRuns: () => number;
    gatePlanCounts: () => number[];
  } {
    let runs = 0;
    const counts: number[] = [];
    // Serialize the gate like a single real build runner.
    let gateChain: Promise<void> = Promise.resolve();
    const serializer = {
      async merge(planId: string) {
        return { planId, merged: true };
      },
      async gate(ids: string[]) {
        runs++;
        counts.push(ids.length);
        const prev = gateChain;
        let release!: () => void;
        gateChain = new Promise<void>(r => (release = r));
        await prev;
        await new Promise(r => setTimeout(r, GATE_MS));
        release();
        return { testExit: 0 };
      },
    };
    const factory: ExecutionEngineFactory = () => ({
      // Branch non-empty so the merge/gate path is exercised; cwd stays shared
      // (no real git needed for the timing harness).
      worktrees: {
        async create(planId: string) {
          return { cwd: '/tmp/project', branch: `b-${planId}`, baseSha: '' };
        },
        async headSha() {
          return '';
        },
        async cleanup() {},
      },
      serializer: serializer as any,
      baseSha: '',
    });
    return { factory, gateRuns: () => runs, gatePlanCounts: () => counts };
  }

  it('beats the old wave model and does not regress under a test-dominated gate', async () => {
    const plans = [
      planInfo({ id: 'A' }),
      planInfo({ id: 'B', depends_on: ['A'] }),
      planInfo({ id: 'C', depends_on: ['B'] }),
      planInfo({ id: 'D' }),
      planInfo({ id: 'E' }),
    ];
    const harness = makeHarness();

    mockSession.mockImplementation(async (_p, step) => {
      if (step === PhaseStepType.Execute) await new Promise(r => setTimeout(r, EXEC_MS));
      return okResult();
    });

    const { deps } = makeDeps(plans, { executionEngineFactory: harness.factory });
    const t0 = Date.now();
    const result = await new PhaseRunner(deps).run('1');
    const newMakespan = Date.now() - t0;

    const exec = result.steps.find(s => s.step === PhaseStepType.Execute)!;
    expect(exec.success).toBe(true);
    expect(exec.planResults).toHaveLength(5);

    // Batched, NOT per-plan: one gate per occupied level (3), not one per plan (5).
    expect(harness.gateRuns()).toBe(3);
    // Level 1 batches {A,D,E} → 3 plans in one gate (decoupled, coalesced).
    expect(Math.max(...harness.gatePlanCounts())).toBe(3);

    // Old wave model: execution serialized behind a per-wave gate.
    const oldWaveMakespan = 3 * EXEC_MS + 3 * GATE_MS; // 300ms

    // Rejected per-plan-gate model (the hazard the decoupling fixes): a gate per
    // plan, serialized → 5 gates.
    const perPlanGateMakespan = 5 * GATE_MS; // 300ms, and grows with plan count

    // The new model overlaps D,E with the A→B→C chain and overlaps the batched
    // gate with later-level execution. It beats the old wave model with margin.
    expect(newMakespan).toBeLessThan(oldWaveMakespan);
    // And it does not regress to the per-plan-gate cost under the test-dominated
    // gate — this is the explicit falsifier for the decoupling.
    expect(newMakespan).toBeLessThan(perPlanGateMakespan);
  });
});

// ─── Informed-retry context injection (ADR 0013 option 4, chunk 2) ───────────

describe('PhaseRunner prepends prior-failure context to the executor prompt', () => {
  beforeEach(() => mockSession.mockReset());

  it('prepends the PRIOR ATTEMPTS block to the execute-step prompt when priorFailureContext is set', async () => {
    // Capture the prompt the execute session receives.
    let executePrompt = '';
    mockSession.mockImplementation(async (prompt, step) => {
      if (step === PhaseStepType.Execute) executePrompt = prompt as string;
      return okResult();
    });

    const { deps } = makeDeps([planInfo({ id: '01' })]);
    await new PhaseRunner(deps).run('1', {
      priorFailureContext: [
        { attempt: 1, signal: 'gate', detail: 'gate exit 1: assertion X failed' },
        { attempt: 2, signal: 'verify', detail: 'verification found gap Y' },
      ],
    });

    // The block leads the prompt and lists every prior failure verbatim.
    expect(executePrompt).toMatch(/PRIOR ATTEMPTS FAILED — address these before proceeding/);
    expect(executePrompt).toMatch(/Attempt 1 failed \(gate\): gate exit 1: assertion X failed/);
    expect(executePrompt).toMatch(/Attempt 2 failed \(verify\): verification found gap Y/);
    // The built prompt ('p' from the mocked buildPrompt) follows the block.
    expect(executePrompt).toMatch(/proceeding[\s\S]*\bp\b/);
  });

  it('does NOT prepend the block on a first attempt (no priorFailureContext)', async () => {
    let executePrompt = '';
    mockSession.mockImplementation(async (prompt, step) => {
      if (step === PhaseStepType.Execute) executePrompt = prompt as string;
      return okResult();
    });

    const { deps } = makeDeps([planInfo({ id: '01' })]);
    await new PhaseRunner(deps).run('1');

    expect(executePrompt).not.toMatch(/PRIOR ATTEMPTS FAILED/);
  });
});
