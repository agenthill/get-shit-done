/**
 * Production execution-engine builder — falsifier + wiring tests (ADR 0013
 * option 3). These FALSIFY the safety properties of the config-gated git engine
 * rather than confirm happy paths:
 *
 *  - the fail-closed pre-flight THROWS (and never runs a single shared-cwd
 *    executor) when git worktree isolation is unavailable;
 *  - the real build+test gate downgrades a plan to failed (inv-3) when the
 *    configured test command exits non-zero, and lets it pass when it exits 0;
 *  - a create() failure under the isolated engine is FATAL (the plan fails;
 *    no silent shared-cwd degrade);
 *  - the builder constructs the real GitWorktreeManager + GitMergeSerializer.
 *
 * Co-located *.integration.test.ts so run-tests.cjs groups it with the other
 * git-temp-repo SDK tests. The session mock does real git work in the worktree
 * cwd it receives, exactly like phase-runner-dag.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PhaseRunner } from './phase-runner.js';
import type { PhaseRunnerDeps, ExecutionEngineFactory } from './phase-runner.js';
import type { GSDEvent, PhaseOpInfo, PlanInfo, PhasePlanIndex, PlanResult, SessionUsage } from './types.js';
import { PhaseStepType } from './types.js';
import { CONFIG_DEFAULTS } from './config.js';
import type { GSDConfig } from './config.js';
import { GitWorktreeManager, GitMergeSerializer } from './execution-engine.js';
import {
  buildGitExecutionEngineFactory,
  resolveTestCommand,
  buildRunGate,
} from './build-execution-engine.js';

const execFileAsync = promisify(execFile);

// session-runner + plan-parser mocked; the session mock does real per-plan git
// work in the worktree cwd it receives (mirrors phase-runner-dag.test.ts).
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

// ─── Helpers (mirrors phase-runner-dag.test.ts) ──────────────────────────────

function usage(): SessionUsage {
  return { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
}
function okResult(over: Partial<PlanResult> = {}): PlanResult {
  return { success: true, sessionId: 's', totalCostUsd: 0.01, durationMs: 1, usage: usage(), numTurns: 1, ...over };
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
    phase_found: true, phase_dir: '.planning/phases/01', phase_number: '1', phase_name: 'P', phase_slug: 'p',
    padded_phase: '01', has_research: false, has_context: true, has_plans: true, has_verification: false,
    plan_count: 1, roadmap_exists: true, planning_exists: true, commit_docs: true,
    context_path: '/tmp/CONTEXT.md', research_path: '/tmp/RESEARCH.md', ...over,
  };
}
function makePlanIndex(plans: PlanInfo[]): PhasePlanIndex {
  return { phase: '1', plans, waves: {}, incomplete: plans.filter(p => !p.has_summary).map(p => p.id), has_checkpoints: false };
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

function gitIn(dir: string) {
  return (args: string[]) => execFileAsync('git', args, { cwd: dir });
}
async function initRepo(): Promise<{ dir: string; baseSha: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'gsd-be-repo-'));
  const git = gitIn(dir);
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
async function commitMarker(cwd: string, id: string): Promise<void> {
  await writeFile(join(cwd, `${id}.txt`), `${id}\n`);
  const git = gitIn(cwd);
  await git(['add', '-A']);
  try {
    await git(['commit', '-q', '--no-verify', '-m', id]);
  } catch { /* nothing to commit on a resume re-run */ }
}

// ─── Pure-unit: test-command resolver ────────────────────────────────────────

describe('resolveTestCommand', () => {
  it('splits an explicit git.sdk_test_command on whitespace', () => {
    const config = makeConfig({ git: { ...CONFIG_DEFAULTS.git, sdk_test_command: 'node -e "process.exit(1)"' } } as Partial<GSDConfig>);
    expect(resolveTestCommand(config, '/nonexistent')).toEqual(['node', '-e', '"process.exit(1)"']);
  });

  it('falls back to ["npm","test"] when a package.json with a test script exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gsd-be-pkg-'));
    try {
      await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
      expect(resolveTestCommand(makeConfig(), dir)).toEqual(['npm', 'test']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns null when there is no command and no test script', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gsd-be-empty-'));
    try {
      expect(resolveTestCommand(makeConfig(), dir)).toBe(null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ─── Pure-unit: runGate exit-code semantics ──────────────────────────────────

describe('buildRunGate', () => {
  it('returns 0 when the command exits 0', async () => {
    const gate = buildRunGate(['node', '-e', 'process.exit(0)'], process.cwd());
    expect(await gate(['p'])).toBe(0);
  });
  it('returns the non-zero exit code when the command fails', async () => {
    const gate = buildRunGate(['node', '-e', 'process.exit(3)'], process.cwd());
    expect(await gate(['p'])).toBe(3);
  });
  it('returns 0 (no-op pass) when there is no command', async () => {
    const gate = buildRunGate(null, process.cwd());
    expect(await gate(['p'])).toBe(0);
  });
});

// ─── Engine-wiring smoke ─────────────────────────────────────────────────────

describe('buildGitExecutionEngineFactory — wiring smoke', () => {
  it('constructs the real GitWorktreeManager + GitMergeSerializer (isolated)', async () => {
    const { dir } = await initRepo();
    try {
      const factory = await buildGitExecutionEngineFactory(makeConfig(), dir);
      const engine = factory({ projectDir: dir, phaseNumber: '1' });
      expect(engine.worktrees).toBeInstanceOf(GitWorktreeManager);
      expect(engine.serializer).toBeInstanceOf(GitMergeSerializer);
      expect(engine.isolated).toBe(true);
      expect(engine.baseSha.length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ─── Fail-closed pre-flight (THE falsifier) ──────────────────────────────────

describe('fail-closed worktree pre-flight', () => {
  beforeEach(() => mockSession.mockReset());

  it('THROWS and runs ZERO shared-cwd executors when worktree isolation is unavailable', async () => {
    // A non-git directory: `git worktree add` is impossible, so the probe MUST
    // throw and the phase MUST abort before any executor runs.
    const nonGit = await mkdtemp(join(tmpdir(), 'gsd-be-nongit-'));
    mockSession.mockImplementation(async () => okResult());
    try {
      let threw = false;
      let runner: PhaseRunner | undefined;
      try {
        // Production order: build the factory FIRST (this is where runPhase awaits
        // the fail-closed probe), only then construct + run the PhaseRunner.
        const factory = await buildGitExecutionEngineFactory(makeConfig(), nonGit);
        const { deps } = makeDeps([planInfo({ id: 'A' })], { projectDir: nonGit, executionEngineFactory: factory });
        runner = new PhaseRunner(deps);
        await runner.run('1');
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
      // The single most important property: NO executor ran on the shared tree.
      expect(mockSession).toHaveBeenCalledTimes(0);
      expect(runner).toBeUndefined();
    } finally {
      await rm(nonGit, { recursive: true, force: true });
    }
  });
});

// ─── Real build+test gate enforcement (THE falsifier) ────────────────────────

describe('real build+test gate (inv-3) under the production factory', () => {
  beforeEach(() => mockSession.mockReset());

  it('downgrades a plan to FAILED when the configured test command exits non-zero', async () => {
    const { dir } = await initRepo();
    try {
      // Executor commits successfully, but the gate command exits 1.
      mockSession.mockImplementation(async (_p, step, _c, opts: any, _es, ctx: any) => {
        if (step !== PhaseStepType.Execute) return okResult();
        await commitMarker(opts.cwd as string, ctx.planName as string);
        return okResult();
      });
      const config = makeConfig({ git: { ...CONFIG_DEFAULTS.git, sdk_test_command: 'node -e process.exit(1)' } } as Partial<GSDConfig>);
      const factory = await buildGitExecutionEngineFactory(config, dir);

      const { deps } = makeDeps([planInfo({ id: 'A' })], { projectDir: dir, config, executionEngineFactory: factory });
      const result = await new PhaseRunner(deps).run('1');

      const exec = result.steps.find(s => s.step === PhaseStepType.Execute)!;
      expect(exec.success).toBe(false);
      expect(exec.planResults![0].success).toBe(false);
      const disp = exec.planDispositions!.find(d => d.planId === 'A')!;
      expect(disp.testExit).not.toBe(0);
      expect(disp.merged).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('counter-test: the plan SUCCEEDS when the configured test command exits 0', async () => {
    const { dir } = await initRepo();
    try {
      mockSession.mockImplementation(async (_p, step, _c, opts: any, _es, ctx: any) => {
        if (step !== PhaseStepType.Execute) return okResult();
        await commitMarker(opts.cwd as string, ctx.planName as string);
        return okResult();
      });
      const config = makeConfig({ git: { ...CONFIG_DEFAULTS.git, sdk_test_command: 'node -e process.exit(0)' } } as Partial<GSDConfig>);
      const factory = await buildGitExecutionEngineFactory(config, dir);

      const { deps } = makeDeps([planInfo({ id: 'A' })], { projectDir: dir, config, executionEngineFactory: factory });
      const result = await new PhaseRunner(deps).run('1');

      const exec = result.steps.find(s => s.step === PhaseStepType.Execute)!;
      expect(exec.success).toBe(true);
      expect(exec.planResults![0].success).toBe(true);
      const disp = exec.planDispositions!.find(d => d.planId === 'A')!;
      expect(disp.testExit).toBe(0);
      expect(disp.merged).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ─── create()-fatal under the isolated engine ────────────────────────────────

describe('worktree create() failure is fatal under the isolated engine', () => {
  beforeEach(() => mockSession.mockReset());

  it('marks the plan failed and never runs the executor on the shared tree', async () => {
    // Isolated engine whose create() always throws. The runner must NOT degrade
    // to shared cwd (which would dispatch the executor) — the plan must fail.
    const factory: ExecutionEngineFactory = () => ({
      worktrees: {
        async create(): Promise<never> { throw new Error('worktree add failed'); },
        async headSha() { return ''; },
        async cleanup() {},
      } as any,
      serializer: {
        async merge(planId: string) { return { planId, merged: true }; },
        async gate() { return { testExit: 0 }; },
      } as any,
      baseSha: '',
      isolated: true,
    });
    mockSession.mockImplementation(async () => okResult());

    const { deps } = makeDeps([planInfo({ id: 'A' })], { executionEngineFactory: factory });
    const result = await new PhaseRunner(deps).run('1');

    const exec = result.steps.find(s => s.step === PhaseStepType.Execute)!;
    expect(exec.success).toBe(false);
    expect(exec.planResults![0].success).toBe(false);
    // The executor never ran — no silent shared-cwd degrade.
    expect(mockSession).toHaveBeenCalledTimes(0);
  });

  it('the NO-OP engine (isolated absent) still degrades to shared cwd on create() failure', async () => {
    // Counter-test proving the discriminator: when isolated is NOT set, a create()
    // failure is swallowed and the executor runs in shared cwd (today's behavior).
    let ran = false;
    const factory: ExecutionEngineFactory = () => ({
      worktrees: {
        async create(): Promise<never> { throw new Error('worktree add failed'); },
        async headSha() { return ''; },
        async cleanup() {},
      } as any,
      serializer: {
        async merge(planId: string) { return { planId, merged: true }; },
        async gate() { return { testExit: 0 }; },
      } as any,
      baseSha: '',
      // isolated intentionally omitted → no-op semantics
    });
    mockSession.mockImplementation(async (_p, step) => {
      if (step === PhaseStepType.Execute) ran = true;
      return okResult();
    });

    const { deps } = makeDeps([planInfo({ id: 'A' })], { executionEngineFactory: factory });
    const result = await new PhaseRunner(deps).run('1');

    const exec = result.steps.find(s => s.step === PhaseStepType.Execute)!;
    expect(ran).toBe(true);              // degraded to shared cwd
    expect(exec.success).toBe(true);     // and succeeded there
  });
});
