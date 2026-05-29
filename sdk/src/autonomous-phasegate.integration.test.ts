/**
 * Autonomous phase-gate spine — FALSIFIER (ADR 0013 option 4, chunk 1).
 *
 * The make-or-break safety property of the per-phase integration spine: the
 * PHASE is the atomic protected-branch unit. A phase executes on an
 * orchestrator-owned integration branch forked off the last-good protected HEAD
 * and PROMOTES onto protected ONLY on green. These tests FALSIFY that property
 * against a real temp git repo with the REAL production factory wired:
 *
 *  (A) Work never reaches protected before promote — a phase rigged to FAIL its
 *      gate leaves protected at LAST_GOOD; its commits live only on the
 *      integration branch, never on protected. ("The single most dangerous bug
 *      surface" per the design — treated as a release gate.)
 *  (B) Promote moves protected only on green — a phase that passes gate+verify
 *      promotes onto protected, leaves gsd/phase-<N>-base + gsd/phase-<N>-done
 *      tags, and writes a .phase-manifest.json entry with the correct commits.
 *  (C) Gate-off parity — with sdk_worktree_execution false, there is no
 *      integration branch, no tags, and no checkpoint dir (PR #8 behaviour
 *      preserved byte-for-byte).
 *
 * The session-runner + plan-parser are mocked exactly as in
 * build-execution-engine.integration.test.ts / phase-runner-dag.test.ts; the
 * session mock does real per-plan git work in the worktree cwd it receives.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PhaseRunner } from './phase-runner.js';
import type { PhaseRunnerDeps } from './phase-runner.js';
import type { GSDEvent, PhaseOpInfo, PlanInfo, PhasePlanIndex, PlanResult, SessionUsage } from './types.js';
import { PhaseStepType } from './types.js';
import { CONFIG_DEFAULTS } from './config.js';
import type { GSDConfig } from './config.js';
import { buildGitExecutionEngineFactory } from './build-execution-engine.js';
import { readPhaseManifest } from './query/phase-manifest.js';

const execFileAsync = promisify(execFile);

// session-runner + plan-parser mocked; the session mock does real git work in
// the per-plan worktree cwd it receives (mirrors the other integration tests).
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

// ─── Helpers (mirror build-execution-engine.integration.test.ts) ─────────────

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
    workflow: { ...CONFIG_DEFAULTS.workflow, research: false, verifier: false, skip_discuss: true, plan_check: false, auto_advance: true, ...(over.workflow ?? {}) },
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
  const dir = await mkdtemp(join(tmpdir(), 'gsd-pg-repo-'));
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

/** True when `branch` (or tag) resolves to a commit. */
async function refExists(dir: string, ref: string): Promise<boolean> {
  try {
    await gitIn(dir)(['rev-parse', '--verify', `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}
/** Commit subjects reachable from a ref (newest-first). */
async function logSubjects(dir: string, ref: string): Promise<string[]> {
  const { stdout } = await gitIn(dir)(['log', '--format=%s', ref]);
  return stdout.split('\n').map(l => l.trim()).filter(Boolean);
}

// ─── (A) Work never reaches protected before promote (THE falsifier) ─────────

describe('(A) protected never moves while a phase executes / on gate failure', () => {
  beforeEach(() => mockSession.mockReset());

  it('a phase that FAILS its gate leaves protected at LAST_GOOD; commits live only on the integration branch', async () => {
    const { dir, baseSha } = await initRepo();
    try {
      // Executor commits its marker on the per-plan worktree, but the gate exits
      // 1 → the phase is NOT green → promote is skipped.
      mockSession.mockImplementation(async (_p, step, _c, opts: any, _es, ctx: any) => {
        if (step !== PhaseStepType.Execute) return okResult();
        await commitMarker(opts.cwd as string, ctx.planName as string);
        return okResult();
      });
      const config = makeConfig({ git: { ...CONFIG_DEFAULTS.git, sdk_test_command: 'node -e process.exit(1)' } } as Partial<GSDConfig>);
      const factory = await buildGitExecutionEngineFactory(config, dir);

      const { deps } = makeDeps([planInfo({ id: 'A' })], { projectDir: dir, config, executionEngineFactory: factory });
      const result = await new PhaseRunner(deps).run('1');

      // The execute step failed (gate inv-3 downgrade).
      const exec = result.steps.find(s => s.step === PhaseStepType.Execute)!;
      expect(exec.success).toBe(false);

      // THE property: protected (main) is UNCHANGED — still at LAST_GOOD.
      const mainSha = (await gitIn(dir)(['rev-parse', 'main'])).stdout.trim();
      expect(mainSha).toBe(baseSha);

      // The phase's commit lives on the integration branch...
      expect(await refExists(dir, 'gsd-phase-1-int')).toBe(true);
      const intSubjects = await logSubjects(dir, 'gsd-phase-1-int');
      expect(intSubjects).toContain('A');

      // ...but NOT on protected.
      const mainSubjects = await logSubjects(dir, 'main');
      expect(mainSubjects).not.toContain('A');

      // No promotion recorded; no done tag.
      expect(await refExists(dir, 'gsd/phase-1-done')).toBe(false);
      const manifest = await readPhaseManifest(dir);
      expect(manifest['1']).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ─── (B) Promote moves protected only on green ───────────────────────────────

describe('(B) promote moves protected only on green', () => {
  beforeEach(() => mockSession.mockReset());

  it('a phase that passes gate+verify promotes onto protected, tags base+done, and records the manifest entry', async () => {
    const { dir, baseSha } = await initRepo();
    try {
      mockSession.mockImplementation(async (_p, step, _c, opts: any, _es, ctx: any) => {
        if (step !== PhaseStepType.Execute) return okResult();
        await commitMarker(opts.cwd as string, ctx.planName as string);
        return okResult();
      });
      // Gate exits 0 (green). Verifier off → verifyPassed vacuously true (a valid
      // green path per the design's resolved decision).
      const config = makeConfig({ git: { ...CONFIG_DEFAULTS.git, sdk_test_command: 'node -e process.exit(0)' } } as Partial<GSDConfig>);
      const factory = await buildGitExecutionEngineFactory(config, dir);

      const { deps } = makeDeps([planInfo({ id: 'A' })], { projectDir: dir, config, executionEngineFactory: factory });
      const result = await new PhaseRunner(deps).run('1');

      const exec = result.steps.find(s => s.step === PhaseStepType.Execute)!;
      expect(exec.success).toBe(true);

      // Protected MOVED — it now includes the phase work...
      const mainSha = (await gitIn(dir)(['rev-parse', 'main'])).stdout.trim();
      expect(mainSha).not.toBe(baseSha);
      const mainSubjects = await logSubjects(dir, 'main');
      expect(mainSubjects).toContain('A');

      // ...both checkpoint tags exist...
      expect(await refExists(dir, 'gsd/phase-1-base')).toBe(true);
      expect(await refExists(dir, 'gsd/phase-1-done')).toBe(true);
      // base tag pinned at LAST_GOOD; done tag at the new protected HEAD.
      expect((await gitIn(dir)(['rev-parse', 'gsd/phase-1-base^{commit}'])).stdout.trim()).toBe(baseSha);
      expect((await gitIn(dir)(['rev-parse', 'gsd/phase-1-done^{commit}'])).stdout.trim()).toBe(mainSha);

      // ...and the manifest entry is correct.
      const manifest = await readPhaseManifest(dir);
      const entry = manifest['1'];
      expect(entry).toBeDefined();
      expect(entry.base_tag).toBe('gsd/phase-1-base');
      expect(entry.base_sha).toBe(baseSha);
      expect(entry.head_sha).toBe(mainSha);
      expect(entry.depends_on).toEqual([]);
      expect(typeof entry.promoted_at).toBe('string');
      // commits = git rev-list base_sha..head_sha → the plan commit + merge commit.
      const expectedCommits = (await gitIn(dir)(['rev-list', `${baseSha}..${mainSha}`])).stdout
        .split('\n').map(l => l.trim()).filter(Boolean).reverse();
      expect(entry.commits).toEqual(expectedCommits);
      expect(entry.commits.length).toBeGreaterThan(0);
      // The plan's own commit is among them (head reachability check above already
      // proves the marker landed; this proves it is attributed to the phase).
      const planCommit = (await gitIn(dir)(['rev-list', '-1', '--grep=^A$', 'main'])).stdout.trim();
      expect(planCommit.length).toBeGreaterThan(0);
      expect(entry.commits).toContain(planCommit);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ─── (C) Gate-off parity (PR #8 behaviour preserved) ─────────────────────────

describe('(C) gate-off parity — no integration branch / tags / checkpoint dir', () => {
  beforeEach(() => mockSession.mockReset());

  it('with sdk_worktree_execution absent → no factory → no integration branch, no tags, no checkpoint dir', async () => {
    const { dir, baseSha } = await initRepo();
    try {
      // No executionEngineFactory injected → the runner takes the no-op shared-cwd
      // path (engine.isolated === false). Executor commits directly in the shared
      // cwd, exactly as today.
      mockSession.mockImplementation(async (_p, step, _c, opts: any, _es, ctx: any) => {
        if (step !== PhaseStepType.Execute) return okResult();
        await commitMarker((opts.cwd as string) || dir, ctx.planName as string);
        return okResult();
      });
      const { deps } = makeDeps([planInfo({ id: 'A' })], { projectDir: dir });
      const result = await new PhaseRunner(deps).run('1');

      const exec = result.steps.find(s => s.step === PhaseStepType.Execute)!;
      expect(exec.success).toBe(true);

      // No integration branch, no checkpoint/promote tags were created.
      expect(await refExists(dir, 'gsd-phase-1-int')).toBe(false);
      expect(await refExists(dir, 'gsd/phase-1-base')).toBe(false);
      expect(await refExists(dir, 'gsd/phase-1-done')).toBe(false);

      // No checkpoint dir, no phase manifest.
      expect(existsSync(join(dir, '.planning', '.checkpoints'))).toBe(false);
      expect(existsSync(join(dir, '.planning', '.phase-manifest.json'))).toBe(false);

      // Tag count is zero (the repo started with zero tags — net-new convention).
      const tags = (await gitIn(dir)(['tag', '--list'])).stdout.trim();
      expect(tags).toBe('');

      // baseSha referenced so the no-op-path assertion stays anchored to the repo.
      expect(baseSha.length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
