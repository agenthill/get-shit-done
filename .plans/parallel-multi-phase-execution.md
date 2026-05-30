# Parallel Multi-Phase Execution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `GSD.runParallel` engine + `/gsd-execute-parallel` command that drains N independent backlog phases in concurrency waves (scheduled by the shipped `conflict-graph` verb), each phase running through the existing ADR 0013 worktree/checkpoint/rollback machinery and promoting as its own auto-merged PR.

**Architecture:** A wave loop sits above `GSD.run`'s per-phase rollback/retry driver. `conflict-graph` partitions phases into waves where within-wave phases are hard-disjoint in `files_modified`; the orchestrator fans out one phase-agent per wave member (capped by a single nested global `Semaphore`), each forked off a per-phase base SHA, and serializes the green phases' promotions as ordered PR auto-merges. The orchestrator remains the sole writer of `ROADMAP.md`/`STATE.md` (lifted to wave scope), and failure isolation reuses the existing Tier-1/Tier-2 rollback at wave boundaries, skipping only the `depends_on` closure of a failed phase.

**Tech Stack:** TypeScript (ESM, `tsc` build under `sdk/`), Node `node:child_process` execFile for git, vitest 3.x (`unit` + `integration` projects), `gh` CLI for PR auto-merge, GSD command markdown under `commands/gsd/`.

---

## File Structure

| File | Create/Modify | Responsibility |
| --- | --- | --- |
| `sdk/src/parallel-runner.ts` | Create | `GSD.runParallel` core: wave loop, per-wave fan-out, per-phase base SHA, ordered promote, skip-dependents. Net-new module imported by `index.ts`. |
| `sdk/src/query/wave-scheduler.ts` | Create | Thin in-process adapter over `conflictGraph` that returns `{ waves, footprints, edges }` for the runner (no CLI round-trip). |
| `sdk/src/pr-merge.ts` | Create | `pushBranchAndOpenPr` + `adminMergeOnGreen` — the D6 PR-per-phase promotion vehicle over `gh` CLI, with an injectable runner for tests. |
| `sdk/src/index.ts` | Modify | Add `async runParallel(phaseNumbers, options)` method delegating to `parallel-runner.ts`; re-export `runParallel` types. |
| `sdk/src/types.ts` | Modify | Add `ParallelRunnerOptions`, `ParallelRunnerResult`, `WaveResult`, `PhaseParallelOutcome`. |
| `sdk/src/config.ts` | Modify | Add `parallelization.phase_level` + `parallelization.max_concurrent_phases` to a new `ParallelizationConfig` interface; resolve nested-or-flat. |
| `sdk/shared/config-defaults.manifest.json` | Modify | Add the two new `parallelization.*` keys under a nested `parallelization` object (D5). |
| `sdk/src/global-budget.ts` | Create | Process-wide singleton `Semaphore` accessor (`acquireGlobalBudget`) shared across phase + plan dispatch (D5 nested global budget). |
| `sdk/src/query/command-static-catalog-domain.ts` | Modify | (Chunk C) no new verb — `runParallel` consumes `conflictGraph` in-process; left unchanged, documented as a no-op decision. |
| `commands/gsd/execute-parallel.md` | Create | `/gsd-execute-parallel <phase...>` command surface (Chunk C). |
| `docs/CONFIGURATION.md` | Modify | Document `parallelization.phase_level` + `parallelization.max_concurrent_phases`. |
| `docs/CLI-TOOLS.md` | Modify | Document the `runParallel` SDK entrypoint + the `/gsd-execute-parallel` flow. |
| `.changeset/14-parallel-multi-phase-execution.md` | Create | `type: Added` changeset fragment. |
| `sdk/src/wave-scheduler.test.ts` | Create | Unit tests for the scheduler adapter. |
| `sdk/src/pr-merge.test.ts` | Create | Unit tests for the PR-merge helpers (injected runner). |
| `sdk/src/global-budget.test.ts` | Create | Unit tests for the shared global budget. |
| `sdk/src/parallel-runner.integration.test.ts` | Create | The ADR measure-of-success falsifier over a real temp git repo. |

**ADR decision → chunk map:**
- **Chunk A** (D1 wave loop + D6 PR-per-phase auto-merge): Tasks A1–A5.
- **Chunk B** (D3 per-phase base SHA + D2 wave-scoped sole-writer + D4 continue-independents/skip-dependents + across-wave rollback reuse): Tasks B1–B4.
- **Chunk C** (D5 nested global budget + `parallelization.phase_level` config + `/gsd-execute-parallel` + docs): Tasks C1–C5.

---

## Chunk A — Wave executor + PR-per-phase auto-merge (D1, D6)

### Task A1 — Wave-scheduler adapter over `conflict-graph`

Maps the ADR's "step 1: `conflict-graph <phase...>` → `waves[]`" onto the shipped verb in-process (no CLI round-trip), so the runner consumes `schedule.waves` directly.

**Files:**
- Create: `sdk/src/query/wave-scheduler.ts`
- Test: `sdk/src/wave-scheduler.test.ts`

- [ ] Write the failing test `sdk/src/wave-scheduler.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scheduleWavesForPhases } from './query/wave-scheduler.js';

let tmpDir: string;

function plan(phase: string, filesModified: string[]): string {
  const list = filesModified.map((f) => `  - ${f}`).join('\n');
  return `---\nphase: ${phase}\nfiles_modified:\n${list}\n---\n\n<objective>O</objective>\n<tasks><task type="auto"><name>T</name></task></tasks>\n`;
}
async function writePlan(phaseDir: string, fileName: string, content: string): Promise<void> {
  const dir = join(tmpDir, '.planning', 'phases', phaseDir);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, fileName), content);
}

beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), 'gsd-wsched-')); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

describe('scheduleWavesForPhases', () => {
  it('returns disjoint phases in one wave and serializes a hard conflict', async () => {
    await writePlan('43-curve', '43-PLAN.md', plan('43-curve', ['src/a.ts']));
    await writePlan('44-nonce', '44-PLAN.md', plan('44-nonce', ['src/b.ts']));
    await writePlan('46-prev', '46-PLAN.md', plan('46-prev', ['src/a.ts']));

    const r = await scheduleWavesForPhases(['43', '44', '46'], tmpDir);
    // 43 and 44 are disjoint → can share a wave; 46 hard-conflicts with 43.
    const wave43 = r.waves.findIndex((w) => w.includes('43'));
    const wave46 = r.waves.findIndex((w) => w.includes('46'));
    expect(wave43).not.toBe(wave46);
    expect(r.footprints.find((p) => p.phase === '43')!.files_modified).toEqual(['src/a.ts']);
    expect(r.edges.some((e) => e.classification === 'hard')).toBe(true);
  });

  it('throws on fewer than two phases (matches conflict-graph contract)', async () => {
    await expect(scheduleWavesForPhases(['43'], tmpDir)).rejects.toThrow(/at least two phases/);
  });
});
```
- [ ] Run it, expect FAIL (module does not exist):
```bash
cd sdk && npx vitest run src/wave-scheduler.test.ts --project unit
```
- [ ] Create `sdk/src/query/wave-scheduler.ts` with the minimal implementation calling the real verb:
```typescript
/**
 * Wave-scheduler adapter (ADR 0014, D1 step 1). Calls the shipped `conflictGraph`
 * verb in-process and projects its `ConflictGraphResult` into the shape the
 * parallel runner consumes: the ordered concurrency waves plus the per-phase
 * footprints + edges (for logging / skip-dependents reasoning). No CLI round-trip.
 */
import { conflictGraph } from './conflict-graph.js';
import type { ConflictGraphResult, PhaseFootprint, ConflictEdge } from './conflict-graph.js';

export interface WaveSchedule {
  /** Concurrency waves, in execution order (parallel within, sequential across). */
  waves: string[][];
  /** Per-phase `files_modified` union (canonical phase tokens). */
  footprints: PhaseFootprint[];
  /** The classified overlap edges (soft/hard). */
  edges: ConflictEdge[];
}

/**
 * Schedule `phaseNumbers` into concurrency waves via `conflictGraph`. Throws the
 * verb's own validation error when fewer than two phases are supplied.
 */
export async function scheduleWavesForPhases(
  phaseNumbers: string[],
  projectDir: string,
  workstream?: string,
): Promise<WaveSchedule> {
  const { data } = await conflictGraph(phaseNumbers, projectDir, workstream);
  const result = data as ConflictGraphResult;
  return { waves: result.schedule.waves, footprints: result.phases, edges: result.edges };
}
```
- [ ] Run it, expect PASS:
```bash
cd sdk && npx vitest run src/wave-scheduler.test.ts --project unit
```
- [ ] Commit:
```bash
git add sdk/src/query/wave-scheduler.ts sdk/src/wave-scheduler.test.ts
git commit -m "feat(parallel): wave-scheduler adapter over conflict-graph (ADR 0014 D1)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task A2 — PR-per-phase promotion vehicle (D6)

The D6 promotion mechanism: push the integration branch, open a per-phase PR, and admin-merge it on green. Wrapped behind an injectable `GhRunner` so unit tests assert the exact `gh` argv without touching a real repo.

**Files:**
- Create: `sdk/src/pr-merge.ts`
- Test: `sdk/src/pr-merge.test.ts`

- [ ] Write the failing test `sdk/src/pr-merge.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest';
import { pushBranchAndOpenPr, adminMergeOnGreen } from './pr-merge.js';

describe('pr-merge', () => {
  it('pushes the branch then opens a PR and returns its url', async () => {
    const calls: string[][] = [];
    const gh = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'pr' && args[1] === 'create') return 'https://github.com/o/r/pull/7\n';
      return '';
    });
    const git = vi.fn(async (args: string[]) => { calls.push(['git', ...args]); return ''; });

    const url = await pushBranchAndOpenPr(
      { branch: 'gsd-phase-1-int', baseBranch: 'main', title: 'Phase 1', body: 'auto' },
      { gh, git },
    );

    expect(url).toBe('https://github.com/o/r/pull/7');
    expect(calls).toContainEqual(['git', 'push', '--force-with-lease', 'origin', 'gsd-phase-1-int']);
    expect(gh.mock.calls[0][0]).toEqual([
      'pr', 'create', '--base', 'main', '--head', 'gsd-phase-1-int',
      '--title', 'Phase 1', '--body', 'auto',
    ]);
  });

  it('admin-merges (squash, delete-branch) the PR on green', async () => {
    const gh = vi.fn(async () => '');
    await adminMergeOnGreen('https://github.com/o/r/pull/7', { gh });
    expect(gh).toHaveBeenCalledWith([
      'pr', 'merge', 'https://github.com/o/r/pull/7',
      '--admin', '--squash', '--delete-branch',
    ]);
  });
});
```
- [ ] Run it, expect FAIL:
```bash
cd sdk && npx vitest run src/pr-merge.test.ts --project unit
```
- [ ] Create `sdk/src/pr-merge.ts`:
```typescript
/**
 * PR-per-phase promotion vehicle (ADR 0014, D6). On a branch-protected repo
 * "promote" is realized as push-branch → open PR → admin-merge on green. Each
 * phase lands as its own reviewable per-feature PR, which is simultaneously the
 * merge mechanism. The orchestrator serializes these auto-merges in wave order
 * to preserve the single-writer property (D2).
 *
 * Runners are injected so unit tests assert exact argv with no real gh/git.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** A process runner returning trimmed-friendly stdout (callers trim). */
export type Runner = (args: string[]) => Promise<string>;

export interface PrMergeRunners {
  gh: Runner;
  git: Runner;
}

/** Default gh/git runners bound to a project dir. */
export function defaultRunners(projectDir: string): PrMergeRunners {
  const run = (bin: string): Runner => async (args) =>
    (await execFileAsync(bin, args, { cwd: projectDir })).stdout;
  return { gh: run('gh'), git: run('git') };
}

export interface OpenPrInput {
  branch: string;
  baseBranch: string;
  title: string;
  body: string;
}

/**
 * Push the phase's integration branch (force-with-lease — the branch is
 * orchestrator-owned and re-pushed on resume) and open a PR. Returns the PR url.
 */
export async function pushBranchAndOpenPr(
  input: OpenPrInput,
  runners: Pick<PrMergeRunners, 'gh' | 'git'>,
): Promise<string> {
  const { branch, baseBranch, title, body } = input;
  await runners.git(['push', '--force-with-lease', 'origin', branch]);
  const out = await runners.gh([
    'pr', 'create', '--base', baseBranch, '--head', branch,
    '--title', title, '--body', body,
  ]);
  return out.trim();
}

/**
 * Admin-merge the PR on green. Squash + delete-branch mirror the repo's PR
 * convention; `--admin` is the auto-merge-on-green path (test+verify already
 * gated the phase upstream — D6's chosen autonomy trade-off).
 */
export async function adminMergeOnGreen(
  prUrl: string,
  runners: Pick<PrMergeRunners, 'gh'>,
): Promise<void> {
  await runners.gh(['pr', 'merge', prUrl, '--admin', '--squash', '--delete-branch']);
}
```
- [ ] Run it, expect PASS:
```bash
cd sdk && npx vitest run src/pr-merge.test.ts --project unit
```
- [ ] Commit:
```bash
git add sdk/src/pr-merge.ts sdk/src/pr-merge.test.ts
git commit -m "feat(parallel): PR-per-phase promotion vehicle (ADR 0014 D6)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task A3 — Parallel-runner types

The result/option types the runner returns. Defined before the runner so later tasks reference real names.

**Files:**
- Modify: `sdk/src/types.ts`
- Test: none standalone — the types are compiled by `npm run build` here and exercised by the A4/A5 integration tests that consume them

- [ ] Add the types after the `MilestoneRunnerResult` interface (`sdk/src/types.ts`, ~line 583). Insert:
```typescript
// ─── ADR 0014: parallel multi-phase execution ────────────────────────────────

/** Per-phase outcome inside a wave. */
export interface PhaseParallelOutcome {
  phaseNumber: string;
  /** The PhaseRunnerResult the rollback/retry driver settled on. */
  result: PhaseRunnerResult;
  /** True when the phase went green, promoted, and (if remote) auto-merged. */
  promoted: boolean;
  /** PR url when a PR was opened (D6); undefined on failure or local-only. */
  prUrl?: string;
  /** Set when this phase was SKIPPED because a depends_on predecessor failed (D4). */
  skippedReason?: string;
}

/** Result of one wave (parallel within, sequential across). */
export interface WaveResult {
  waveIndex: number;
  phases: PhaseParallelOutcome[];
}

/** Options for a parallel multi-phase run. Superset of MilestoneRunnerOptions. */
export interface ParallelRunnerOptions extends MilestoneRunnerOptions {
  /**
   * When true, the orchestrator opens + admin-merges a PR per green phase (D6).
   * When false, promotion stops at the local protected-branch merge (the
   * existing GSD.run promote-on-green) — useful for tests / non-remote repos.
   * Default true.
   */
  openPullRequests?: boolean;
}

/** Result of a full parallel multi-phase run. */
export interface ParallelRunnerResult {
  success: boolean;
  waves: WaveResult[];
  /** Every phase outcome, flattened in execution order. */
  phases: PhaseParallelOutcome[];
  totalCostUsd: number;
  totalDurationMs: number;
}
```
- [ ] Build to confirm the types compile (no test yet — exercised by A4/A5):
```bash
cd sdk && npm run build
```
- [ ] Commit:
```bash
git add sdk/src/types.ts
git commit -m "feat(parallel): runner option + result types (ADR 0014)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task A4 — `GSD.runParallel`: happy-path wave loop (D1)

The core wave loop: schedule → per wave, fan out one phase-agent per member through the EXISTING `runPhaseWithRollbackRetry` driver (which already does checkpoint + Tier-1/Tier-2 + promote-on-green), collect outcomes, advance to the next wave only after the current settles. Reuses the existing factory gate. No PR step yet (added in A5), no skip-dependents yet (added in B3).

**Files:**
- Create: `sdk/src/parallel-runner.ts`
- Modify: `sdk/src/index.ts`
- Test: `sdk/src/parallel-runner.integration.test.ts`

- [ ] Write the failing test `sdk/src/parallel-runner.integration.test.ts` (real temp git repo; PhaseRunner.run stubbed at the unit boundary, mirroring `autonomous-rollback-retry.integration.test.ts`):
```typescript
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
    phaseNumber, phaseName: `P${phaseNumber}`,
    steps: [{ step: PhaseStepType.Execute, success: true, durationMs: 1 }],
    success: true, totalCostUsd: 0, totalDurationMs: 1,
  };
}

let dirs: string[] = [];
afterEach(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); dirs = []; });

describe('GSD.runParallel — happy path wave loop (D1)', () => {
  it('runs two disjoint phases in one wave and both go green', async () => {
    const dir = await setupRepo(); dirs.push(dir);
    const gsd = new GSD({ projectDir: dir });
    // Stub the per-phase driver so we exercise the wave loop, not the executor.
    const runSpy = vi
      .spyOn(gsd as any, 'runPhaseWithRollbackRetry')
      .mockImplementation(async (phase: any) => ({ result: greenResult(phase.number), halted: false }));
    // Stub roadmap discovery to resolve phase metadata for the two phases.
    vi.spyOn(gsd.createTools().constructor.prototype as any, 'roadmapAnalyze')
      .mockResolvedValue({ phases: [
        { number: '1', disk_status: 'pending', roadmap_complete: false, phase_name: 'A' },
        { number: '2', disk_status: 'pending', roadmap_complete: false, phase_name: 'B' },
      ] } as RoadmapAnalysis);

    const res = await gsd.runParallel(['1', '2'], { openPullRequests: false });

    expect(res.success).toBe(true);
    expect(res.waves).toHaveLength(1);
    expect(res.waves[0].phases.map((p) => p.phaseNumber).sort()).toEqual(['1', '2']);
    expect(res.phases.every((p) => p.promoted)).toBe(true);
    expect(runSpy).toHaveBeenCalledTimes(2);
  });
});
```
- [ ] Run it, expect FAIL (`runParallel` does not exist):
```bash
cd sdk && npx vitest run src/parallel-runner.integration.test.ts --project integration
```
- [ ] Create `sdk/src/parallel-runner.ts`:
```typescript
/**
 * Parallel multi-phase wave executor (ADR 0014). Lifts the proven per-plan
 * engine up one level to phases: schedule N phases into concurrency waves via
 * `conflict-graph`, then per wave fan out one phase-agent per member through the
 * EXISTING per-phase rollback/retry driver (checkpoint + Tier-1/Tier-2 +
 * promote-on-green), advancing to wave N+1 only after wave N settles.
 *
 * The runner is a free function the GSD class binds its private driver into, so
 * it can reuse runPhaseWithRollbackRetry / maybeCascadeTier2 without exposing
 * them. PR-per-phase promotion (D6), per-phase base SHA (D3), and skip-dependents
 * (D4) are layered in by later tasks.
 */
import type {
  ParallelRunnerOptions,
  ParallelRunnerResult,
  WaveResult,
  PhaseParallelOutcome,
  PhaseRunnerResult,
  RoadmapPhaseInfo,
} from './types.js';
import { scheduleWavesForPhases } from './query/wave-scheduler.js';
import { Semaphore, resolveConcurrencyCap } from './execution-engine.js';

/** The orchestration surface the GSD class supplies to the wave loop. */
export interface ParallelDriverContext {
  projectDir: string;
  workstream?: string;
  parallelization: boolean;
  /** Resolve a phase's roadmap metadata by token (from roadmapAnalyze). */
  resolvePhase: (phaseNumber: string) => Promise<RoadmapPhaseInfo>;
  /** The EXISTING per-phase rollback/retry driver (GSD.runPhaseWithRollbackRetry). */
  runPhase: (phase: RoadmapPhaseInfo) => Promise<{ result: PhaseRunnerResult; halted: boolean }>;
}

/**
 * Drive the wave loop. Within a wave, phases run concurrently capped by a shared
 * Semaphore; across waves they run sequentially (a wave barrier). A wave member
 * that fails does NOT abort its siblings — they finish and settle (D4
 * continue-independents; skip-dependents is layered in by B3).
 */
export async function runParallelWaves(
  phaseNumbers: string[],
  options: ParallelRunnerOptions | undefined,
  ctx: ParallelDriverContext,
): Promise<ParallelRunnerResult> {
  const startTime = Date.now();
  const schedule = await scheduleWavesForPhases(phaseNumbers, ctx.projectDir, ctx.workstream);

  // One nested global Semaphore caps in-flight phase-agents (B-stub; D5 lifts it
  // to a process-wide singleton in chunk C).
  const cap = resolveConcurrencyCap(ctx.parallelization);
  const semaphore = new Semaphore(cap);

  const waves: WaveResult[] = [];
  const allOutcomes: PhaseParallelOutcome[] = [];
  let success = true;

  for (let waveIndex = 0; waveIndex < schedule.waves.length; waveIndex++) {
    const members = schedule.waves[waveIndex]!;
    const outcomes = await Promise.all(
      members.map((phaseNumber) =>
        semaphore.run(async (): Promise<PhaseParallelOutcome> => {
          const phase = await ctx.resolvePhase(phaseNumber);
          const { result, halted } = await ctx.runPhase(phase);
          const promoted = result.success && !halted;
          return { phaseNumber, result, promoted };
        }),
      ),
    );
    waves.push({ waveIndex, phases: outcomes });
    allOutcomes.push(...outcomes);
    if (outcomes.some((o) => !o.promoted)) success = false;
  }

  const totalCostUsd = allOutcomes.reduce((s, o) => s + o.result.totalCostUsd, 0);
  return {
    success,
    waves,
    phases: allOutcomes,
    totalCostUsd,
    totalDurationMs: Date.now() - startTime,
  };
}
```
- [ ] Add `runParallel` to the `GSD` class (`sdk/src/index.ts`). Add the import near the existing imports:
```typescript
import { runParallelWaves } from './parallel-runner.js';
import type { ParallelRunnerOptions, ParallelRunnerResult } from './types.js';
```
  Then add the method after `run(...)` (after line 378):
```typescript
  /**
   * Run N independent backlog phases in concurrency waves (ADR 0014). Schedules
   * the phases via `conflict-graph` (hard-disjoint within a wave) and fans out
   * one phase-agent per wave member through the SAME per-phase rollback/retry
   * driver `run()` uses — reusing checkpoint + Tier-1/Tier-2 + promote-on-green.
   * Parallel within a wave, sequential across waves.
   */
  async runParallel(
    phaseNumbers: string[],
    options?: ParallelRunnerOptions,
  ): Promise<ParallelRunnerResult> {
    const tools = this.createTools();
    const config = await loadConfig(this.projectDir, this.workstream);
    const maxPhaseAttempts = config.git?.sdk_max_phase_attempts ?? 5;

    // Resolve roadmap metadata once; the wave loop looks phases up by token.
    const analysis = await tools.roadmapAnalyze();
    const byNumber = new Map(analysis.phases.map((p) => [p.number, p] as const));

    return runParallelWaves(phaseNumbers, options, {
      projectDir: this.projectDir,
      ...(this.workstream && { workstream: this.workstream }),
      parallelization: config.parallelization !== false,
      resolvePhase: async (phaseNumber) => {
        const found = byNumber.get(phaseNumber);
        if (!found) {
          throw new Error(`Phase ${phaseNumber} not found in ROADMAP for parallel run`);
        }
        return found;
      },
      runPhase: (phase) => this.runPhaseWithRollbackRetry(phase, options, maxPhaseAttempts),
    });
  }
```
- [ ] Re-export the new module + types at the bottom of `sdk/src/index.ts` (after the PhaseRunner re-export, ~line 897):
```typescript
// ADR 0014: parallel multi-phase execution
export { runParallelWaves } from './parallel-runner.js';
export type { ParallelDriverContext } from './parallel-runner.js';
```
- [ ] Run it, expect PASS:
```bash
cd sdk && npx vitest run src/parallel-runner.integration.test.ts --project integration
```
- [ ] Commit:
```bash
git add sdk/src/parallel-runner.ts sdk/src/index.ts sdk/src/parallel-runner.integration.test.ts
git commit -m "feat(parallel): GSD.runParallel happy-path wave loop (ADR 0014 D1)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task A5 — Wire PR-per-phase auto-merge into the wave loop (D6)

After a phase goes green and promotes locally (via the existing `runPhaseWithRollbackRetry` → promote-on-green), open its PR and admin-merge it. Auto-merges are serialized in wave order behind a `Mutex` to preserve the single-writer property (D2).

**Files:**
- Modify: `sdk/src/parallel-runner.ts`
- Test: `sdk/src/parallel-runner.integration.test.ts`

- [ ] Add the failing test to `sdk/src/parallel-runner.integration.test.ts` (inside the existing `describe`):
```typescript
  it('opens + admin-merges a PR per green phase, serialized in wave order (D6)', async () => {
    const dir = await setupRepo(); dirs.push(dir);
    const gsd = new GSD({ projectDir: dir });
    vi.spyOn(gsd as any, 'runPhaseWithRollbackRetry')
      .mockImplementation(async (phase: any) => ({ result: greenResult(phase.number), halted: false }));
    vi.spyOn(gsd.createTools().constructor.prototype as any, 'roadmapAnalyze')
      .mockResolvedValue({ phases: [
        { number: '1', disk_status: 'pending', roadmap_complete: false, phase_name: 'A' },
        { number: '2', disk_status: 'pending', roadmap_complete: false, phase_name: 'B' },
      ] });

    const merges: string[] = [];
    const fakeRunners = {
      gh: vi.fn(async (args: string[]) => {
        if (args[0] === 'pr' && args[1] === 'create') return `https://x/pull/${args[args.indexOf('--head') + 1]}\n`;
        if (args[0] === 'pr' && args[1] === 'merge') merges.push(args[2]);
        return '';
      }),
      git: vi.fn(async () => ''),
    };

    const res = await gsd.runParallel(['1', '2'], { openPullRequests: true, prRunners: fakeRunners } as any);

    expect(res.phases.every((p) => p.prUrl)).toBe(true);
    // One merge per green phase, in wave order (both members of wave 0).
    expect(merges).toHaveLength(2);
  });
```
- [ ] Run it, expect FAIL (no PR step / `prRunners` not threaded):
```bash
cd sdk && npx vitest run src/parallel-runner.integration.test.ts --project integration
```
- [ ] Extend `runParallel`'s options + the runner. In `sdk/src/types.ts`, add to `ParallelRunnerOptions`:
```typescript
  /**
   * Injectable gh/git runners for the PR-per-phase promotion (D6). Tests pass a
   * fake; production omits it → defaultRunners(projectDir). Internal seam.
   */
  prRunners?: { gh: (args: string[]) => Promise<string>; git: (args: string[]) => Promise<string> };
```
- [ ] In `sdk/src/parallel-runner.ts`, add imports + a `Mutex` and a `promotePr` hook to the context:
```typescript
import { Semaphore, Mutex, resolveConcurrencyCap } from './execution-engine.js';
```
  Add to `ParallelDriverContext`:
```typescript
  /**
   * Open + admin-merge the phase's PR after a green local promote (D6). Returns
   * the PR url. Absent → no PR step (local-only / openPullRequests:false).
   */
  promotePhasePr?: (phase: RoadmapPhaseInfo, result: PhaseRunnerResult) => Promise<string>;
```
  Replace the inner `semaphore.run` body and add the serializing mutex:
```typescript
  const promoteMutex = new Mutex();
```
  inside the wave map, after computing `promoted`:
```typescript
          let prUrl: string | undefined;
          if (promoted && ctx.promotePhasePr) {
            // Serialize PR auto-merges in wave order — preserves the single-writer
            // (D2) property: ordered promotes onto protected, never concurrent.
            prUrl = await promoteMutex.runExclusive(() => ctx.promotePhasePr!(phase, result));
          }
          return { phaseNumber, result, promoted, ...(prUrl && { prUrl }) };
```
- [ ] In `sdk/src/index.ts` `runParallel`, thread the promote hook (import the pr-merge helpers at the top: `import { pushBranchAndOpenPr, adminMergeOnGreen, defaultRunners } from './pr-merge.js';` and `import { integrationBranchFor } from './query/phase-checkpoint.js';`):
```typescript
    const openPrs = options?.openPullRequests !== false;
    const protectedBranch = await this.resolveProtectedBranch(config);
    const runners = options?.prRunners ?? defaultRunners(this.projectDir);
```
  add to the context object:
```typescript
      ...(openPrs && {
        promotePhasePr: async (phase, result) => {
          const branch = integrationBranchFor(phase.number);
          const url = await pushBranchAndOpenPr(
            { branch, baseBranch: protectedBranch, title: `Phase ${phase.number}: ${result.phaseName}`, body: `Auto-generated parallel phase PR (ADR 0014). Closes the phase backlog item.` },
            runners,
          );
          await adminMergeOnGreen(url, runners);
          return url;
        },
      }),
```
- [ ] Run it, expect PASS:
```bash
cd sdk && npx vitest run src/parallel-runner.integration.test.ts --project integration
```
- [ ] Commit:
```bash
git add sdk/src/parallel-runner.ts sdk/src/index.ts sdk/src/types.ts sdk/src/parallel-runner.integration.test.ts
git commit -m "feat(parallel): wire PR-per-phase auto-merge into wave loop (ADR 0014 D6)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Chunk B — Per-phase base SHA + rollback/isolation + skip-dependents (D2, D3, D4)

### Task B1 — Per-phase base SHA captured at wave start (D3)

The existing engine factory captures ONE `baseSha = git rev-parse HEAD` at build time (`build-execution-engine.ts:191`). Under sequential `GSD.run` that is fine, but for parallel waves each phase must fork off the protected HEAD as it stands at WAVE start (a later-promoting sibling rebases trivially on soft ledger conflicts only). This task rebuilds the engine factory per wave so each wave's phases share the wave-start base SHA, replacing the global `LAST_GOOD` assumption (D3).

**Files:**
- Modify: `sdk/src/index.ts`
- Modify: `sdk/src/parallel-runner.ts`
- Test: `sdk/src/parallel-runner.integration.test.ts`

- [ ] Add the failing test (inside the existing `describe`):
```typescript
  it('captures a fresh base SHA per wave (D3): wave 1 forks off wave 0 promotes', async () => {
    const dir = await setupRepo(); dirs.push(dir);
    const git = gitIn(dir);
    const base0 = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    const gsd = new GSD({ projectDir: dir });

    const seenBaseShas: string[] = [];
    // Driver stub: record the base SHA the engine would fork off (read HEAD now),
    // then move protected forward to simulate a promote.
    vi.spyOn(gsd as any, 'runPhaseWithRollbackRetry').mockImplementation(async (phase: any) => {
      seenBaseShas.push((await git(['rev-parse', 'HEAD'])).stdout.trim());
      await writeFile(join(dir, `phase-${phase.number}.txt`), 'x\n');
      await git(['add', '-A']);
      await git(['commit', '-q', '--no-verify', '-m', `promote ${phase.number}`]);
      return { result: greenResult(phase.number), halted: false };
    });
    vi.spyOn(gsd.createTools().constructor.prototype as any, 'roadmapAnalyze').mockResolvedValue({
      phases: [
        { number: '1', disk_status: 'pending', roadmap_complete: false, phase_name: 'A' },
        { number: '2', disk_status: 'pending', roadmap_complete: false, phase_name: 'B' },
      ],
    });
    // Force two waves: make phase 2 hard-conflict with phase 1.
    await writeFile(join(dir, '.planning', 'phases', '02-b', '02-PLAN.md'),
      `---\nphase: 02-b\nfiles_modified:\n  - src/a.ts\n---\n<objective>O</objective>\n<tasks><task type="auto"><name>T</name></task></tasks>\n`);
    await git(['add', '-A']);
    await git(['commit', '-q', '--no-verify', '-m', 'conflict']);

    const res = await gsd.runParallel(['1', '2'], { openPullRequests: false });
    expect(res.waves).toHaveLength(2);
    // Wave 1's phase started AFTER wave 0 advanced protected → different base SHA.
    expect(seenBaseShas[0]).not.toBe(seenBaseShas[1]);
    expect(seenBaseShas[0]).not.toBe(base0); // base advanced by the conflict commit
  });
```
- [ ] Run it, expect FAIL (the wave loop does not re-seed the base between waves; both phases see the same HEAD if run concurrently in one wave):
```bash
cd sdk && npx vitest run src/parallel-runner.integration.test.ts --project integration
```
- [ ] In `sdk/src/parallel-runner.ts`, add an optional per-wave hook to `ParallelDriverContext`:
```typescript
  /**
   * Called once at the START of each wave (D3): re-resolves the protected HEAD
   * as the per-phase base SHA for this wave's phases, so a wave forks off the
   * SHA left by the prior wave's promotes — not a stale global LAST_GOOD.
   */
  onWaveStart?: (waveIndex: number) => Promise<void>;
```
  and call it at the top of the wave loop body, before the `Promise.all`:
```typescript
    if (ctx.onWaveStart) await ctx.onWaveStart(waveIndex);
```
- [ ] In `sdk/src/index.ts` `runParallel`, the per-phase engine is rebuilt inside `runPhaseWithRollbackRetry → runPhase → buildGitExecutionEngineFactory`, which already reads `git rev-parse HEAD` at build time. Since `runPhase` builds the factory fresh per call, the wave-start hook only needs to ensure protected is checked out at the wave boundary. Add to the context object:
```typescript
      onWaveStart: async () => {
        // D3: ensure the working tree is on protected before the wave's phases
        // build their engines, so each captures the current protected HEAD as its
        // per-phase base SHA (a prior wave's promotes have advanced it).
        await execFileAsync('git', ['checkout', protectedBranch], { cwd: this.projectDir }).catch(() => undefined);
      },
```
  (`execFileAsync` is already imported at the top of `index.ts`, line 28.)
- [ ] Run it, expect PASS:
```bash
cd sdk && npx vitest run src/parallel-runner.integration.test.ts --project integration
```
- [ ] Commit:
```bash
git add sdk/src/parallel-runner.ts sdk/src/index.ts sdk/src/parallel-runner.integration.test.ts
git commit -m "feat(parallel): per-phase base SHA captured at wave start (ADR 0014 D3)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task B2 — Wave-scoped sole-writer assertion for ROADMAP/STATE (D2)

The existing `GitMergeSerializer.applyGuardSuite` already RESTORES `ROADMAP.md`/`STATE.md` from `baseTip` if a per-plan merge touched them (execution-engine.ts:451-458). Under parallel waves the orchestrator is the sole writer of these ledgers across every phase in a wave (D2). This task adds a runner-level assertion that no wave member's promote left `ROADMAP.md`/`STATE.md` in a conflicted/divergent state — a regression tripwire for D2, reusing the existing serializer guard, not re-implementing it.

**Files:**
- Modify: `sdk/src/parallel-runner.ts`
- Test: `sdk/src/parallel-runner.integration.test.ts`

- [ ] Add the failing test:
```typescript
  it('keeps ROADMAP.md / STATE.md uncorrupted across a concurrent wave (D2)', async () => {
    const dir = await setupRepo(); dirs.push(dir);
    const git = gitIn(dir);
    const gsd = new GSD({ projectDir: dir });
    vi.spyOn(gsd as any, 'runPhaseWithRollbackRetry').mockImplementation(async (phase: any) => {
      // Each phase appends to STATE.md then "promotes" — concurrent co-writes the
      // orchestrator must serialize (the guard restores; the assertion verifies).
      await writeFile(join(dir, '.planning', 'STATE.md'), `status: ready\nphase-${phase.number}\n`);
      await git(['add', '-A']);
      await git(['commit', '-q', '--no-verify', '-m', `p${phase.number}`]);
      return { result: greenResult(phase.number), halted: false };
    });
    vi.spyOn(gsd.createTools().constructor.prototype as any, 'roadmapAnalyze').mockResolvedValue({
      phases: [
        { number: '1', disk_status: 'pending', roadmap_complete: false, phase_name: 'A' },
        { number: '2', disk_status: 'pending', roadmap_complete: false, phase_name: 'B' },
      ],
    });
    const res = await gsd.runParallel(['1', '2'], { openPullRequests: false });
    // No merge conflict markers ever land in the ledgers.
    const { stdout: state } = await git(['show', 'HEAD:.planning/STATE.md']);
    expect(state).not.toMatch(/^<{7}|^={7}|^>{7}/m);
    expect(res.success).toBe(true);
  });
```
- [ ] Run it, expect FAIL (assertion helper not present / the runner does not check):
```bash
cd sdk && npx vitest run src/parallel-runner.integration.test.ts --project integration
```
- [ ] In `sdk/src/parallel-runner.ts`, add an `assertLedgersClean` hook to `ParallelDriverContext` and call it after each wave settles (before pushing to `waves`):
```typescript
  /**
   * Called after a wave settles (D2 tripwire): verifies the orchestrator-owned
   * ledgers (ROADMAP.md / STATE.md) carry no conflict markers on protected. The
   * GitMergeSerializer guard already restores them on merge; this is the
   * regression assertion that the single-writer invariant held under concurrency.
   */
  assertLedgersClean?: () => Promise<void>;
```
  after `waves.push(...)` add:
```typescript
    if (ctx.assertLedgersClean) await ctx.assertLedgersClean();
```
- [ ] In `sdk/src/index.ts` `runParallel`, add the hook to the context object:
```typescript
      assertLedgersClean: async () => {
        for (const doc of ['.planning/ROADMAP.md', '.planning/STATE.md']) {
          try {
            const { stdout } = await execFileAsync('git', ['show', `${protectedBranch}:${doc}`], { cwd: this.projectDir });
            if (/^<{7}|^={7}|^>{7}/m.test(stdout)) {
              throw new Error(`D2 violation: ${doc} on ${protectedBranch} contains conflict markers after a wave`);
            }
          } catch (err) {
            // A missing doc (never created) is not a violation; only a present-but-
            // conflicted doc is. Re-throw only the explicit D2 violation.
            if (err instanceof Error && err.message.startsWith('D2 violation')) throw err;
          }
        }
      },
```
- [ ] Run it, expect PASS:
```bash
cd sdk && npx vitest run src/parallel-runner.integration.test.ts --project integration
```
- [ ] Commit:
```bash
git add sdk/src/parallel-runner.ts sdk/src/index.ts sdk/src/parallel-runner.integration.test.ts
git commit -m "feat(parallel): wave-scoped sole-writer ledger tripwire (ADR 0014 D2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task B3 — Skip-dependents on phase failure (D4)

When a phase exhausts its retry/rollback budget, its siblings finish (already true from A4's `Promise.all`). Only LATER phases in the FAILED phase's `depends_on` closure are skipped; unrelated later waves proceed. The failing phase's never-promoted integration branch is discarded by the EXISTING Tier-1 rollback inside `runPhaseWithRollbackRetry`. This task computes the skip set via `readPhaseDependsOn` + `transitiveDependsOnClosure` and short-circuits skipped phases.

**Files:**
- Modify: `sdk/src/parallel-runner.ts`
- Test: `sdk/src/parallel-runner.integration.test.ts`

- [ ] Add the failing test:
```typescript
  it('skips only the depends_on closure of a failed phase; unrelated phases proceed (D4)', async () => {
    const dir = await setupRepo(); dirs.push(dir);
    const git = gitIn(dir);
    // Three phases: 1 (fails), 2 (depends on 1 → skipped), 3 (independent → runs).
    await mkdir(join(dir, '.planning', 'phases', '03-c'), { recursive: true });
    const plan = (ph: string, f: string) =>
      `---\nphase: ${ph}\nfiles_modified:\n  - ${f}\n---\n<objective>O</objective>\n<tasks><task type="auto"><name>T</name></task></tasks>\n`;
    await writeFile(join(dir, '.planning', 'phases', '03-c', '03-PLAN.md'), plan('03-c', 'src/c.ts'));
    // ROADMAP declares phase 2 depends on phase 1.
    await writeFile(join(dir, '.planning', 'ROADMAP.md'),
      '### Phase 1: A\n### Phase 2: B\n**Depends on:** Phase 1\n### Phase 3: C\n');
    await git(['add', '-A']);
    await git(['commit', '-q', '--no-verify', '-m', 'roadmap deps']);

    const gsd = new GSD({ projectDir: dir });
    const ran: string[] = [];
    vi.spyOn(gsd as any, 'runPhaseWithRollbackRetry').mockImplementation(async (phase: any) => {
      ran.push(phase.number);
      if (phase.number === '1') {
        return { result: { ...greenResult('1'), success: false, steps: [{ step: PhaseStepType.Execute, success: false, durationMs: 1 }] }, halted: true };
      }
      return { result: greenResult(phase.number), halted: false };
    });
    vi.spyOn(gsd.createTools().constructor.prototype as any, 'roadmapAnalyze').mockResolvedValue({
      phases: [
        { number: '1', disk_status: 'pending', roadmap_complete: false, phase_name: 'A' },
        { number: '2', disk_status: 'pending', roadmap_complete: false, phase_name: 'B' },
        { number: '3', disk_status: 'pending', roadmap_complete: false, phase_name: 'C' },
      ],
    });

    const res = await gsd.runParallel(['1', '2', '3'], { openPullRequests: false });
    // Phase 1 ran and failed; phase 2 (depends on 1) was SKIPPED, never ran;
    // phase 3 (independent) ran and promoted.
    expect(ran).toContain('1');
    expect(ran).not.toContain('2');
    expect(ran).toContain('3');
    const p2 = res.phases.find((p) => p.phaseNumber === '2')!;
    expect(p2.skippedReason).toMatch(/depends_on.*1/);
    const p3 = res.phases.find((p) => p.phaseNumber === '3')!;
    expect(p3.promoted).toBe(true);
    expect(res.success).toBe(false);
  });
```
- [ ] Run it, expect FAIL (no skip-dependents logic):
```bash
cd sdk && npx vitest run src/parallel-runner.integration.test.ts --project integration
```
- [ ] In `sdk/src/parallel-runner.ts`, add imports + a failed-set tracker + a per-phase `dependsOn` resolver on the context:
```typescript
import { transitiveDependsOnClosure } from './query/phase-depends-on.js';
import type { PhaseManifest } from './query/phase-manifest.js';
```
  Add to `ParallelDriverContext`:
```typescript
  /**
   * Resolve a phase's direct `depends_on` (ROADMAP edges, canonical phase tokens)
   * — used to skip the closure of a failed predecessor (D4).
   */
  resolveDependsOn: (phaseNumber: string) => Promise<string[]>;
```
  Rework the wave map so a phase whose `depends_on` intersects the accumulated failed set is short-circuited as skipped. Maintain `const failed = new Set<string>();` before the wave loop, and inside each wave member:
```typescript
        semaphore.run(async (): Promise<PhaseParallelOutcome> => {
          const deps = await ctx.resolveDependsOn(phaseNumber);
          // Build the transitive closure over the failed set so a 2-hop dependent
          // (3→2→1) is skipped too. Synthesize a single-edge manifest per phase.
          const synthManifest: PhaseManifest = {};
          for (const d of deps) {
            synthManifest[phaseNumber] = { base_tag: '', base_sha: '', head_sha: '', commits: [], promoted_at: '', depends_on: deps };
          }
          const closure = transitiveDependsOnClosure(synthManifest, phaseNumber).closure;
          const blocking = [...new Set([...deps, ...closure])].filter((d) => failed.has(d));
          if (blocking.length > 0) {
            const skippedReason = `skipped: depends_on failed phase(s) ${blocking.join(', ')}`;
            const result: PhaseRunnerResult = {
              phaseNumber, phaseName: phaseNumber, steps: [], success: false, totalCostUsd: 0, totalDurationMs: 0,
            };
            failed.add(phaseNumber); // a skipped phase is itself a failed predecessor for its dependents
            return { phaseNumber, result, promoted: false, skippedReason };
          }
          const phase = await ctx.resolvePhase(phaseNumber);
          const { result, halted } = await ctx.runPhase(phase);
          const promoted = result.success && !halted;
          if (!promoted) failed.add(phaseNumber);
          let prUrl: string | undefined;
          if (promoted && ctx.promotePhasePr) {
            prUrl = await promoteMutex.runExclusive(() => ctx.promotePhasePr!(phase, result));
          }
          return { phaseNumber, result, promoted, ...(prUrl && { prUrl }) };
        }),
```
  Note: `transitiveDependsOnClosure` walks the manifest keyed by phase; the synthesized single-entry manifest is sufficient to capture direct edges, and across waves the failed-set check catches multi-hop chains because each skipped dependent is itself added to `failed` (so a wave-N+1 phase depending on a wave-N skip is skipped in turn).
- [ ] In `sdk/src/index.ts` `runParallel`, add the resolver to the context (import `readPhaseDependsOn` at the top — it is already imported at line 49):
```typescript
      resolveDependsOn: async (phaseNumber) => {
        try {
          return await readPhaseDependsOn(this.projectDir, phaseNumber, this.workstream);
        } catch {
          return [];
        }
      },
```
- [ ] Run it, expect PASS:
```bash
cd sdk && npx vitest run src/parallel-runner.integration.test.ts --project integration
```
- [ ] Commit:
```bash
git add sdk/src/parallel-runner.ts sdk/src/index.ts sdk/src/parallel-runner.integration.test.ts
git commit -m "feat(parallel): continue-independents / skip-dependents on failure (ADR 0014 D4)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task B4 — Across-wave rollback reuse documented + asserted

D4 states across-wave failures use the EXISTING sequential Tier-1/Tier-2 rollback unchanged at wave boundaries. Within `runPhaseWithRollbackRetry` (reused verbatim) this already happens: a genuine failure runs `rollbackTier1`, then `maybeCascadeTier2` may run `cascadeRollbackTier2`. This task adds a regression test that a failed phase's integration branch is gone after the wave (clean Tier-1) — no new production code, just a guard that the reuse holds end to end.

**Files:**
- Test: `sdk/src/parallel-runner.integration.test.ts`

- [ ] Add the failing test (real Tier-1: do NOT stub `runPhaseWithRollbackRetry`; stub `runPhase` (the inner per-phase runner) to fail green-gate so the real Tier-1 path fires). Use the existing engine via `git.sdk_worktree_execution`:
```typescript
  it('a failed phase leaves no integration branch after the wave (Tier-1 reuse)', async () => {
    const dir = await setupRepo(); dirs.push(dir);
    const git = gitIn(dir);
    const gsd = new GSD({ projectDir: dir });
    // Stub the per-phase runner (runPhase) to settle non-green with a rollback
    // context the real runPhaseWithRollbackRetry will act on via rollbackTier1.
    const { createPhaseCheckpoint, ensureCheckpointGitignore, integrationBranchFor } = await import('./query/phase-checkpoint.js');
    await ensureCheckpointGitignore(dir);
    const cp = await createPhaseCheckpoint({ projectDir: dir, phaseNumber: '1', protectedBranch: 'main' });
    await git(['checkout', '-B', integrationBranchFor('1'), cp.lastGoodSha]);
    await writeFile(join(dir, 'work.txt'), 'w\n');
    await git(['add', '-A']);
    await git(['commit', '-q', '--no-verify', '-m', 'int work']);
    await git(['checkout', 'main']);

    vi.spyOn(gsd as any, 'runPhase').mockResolvedValue({
      phaseNumber: '1', phaseName: 'A', steps: [{ step: PhaseStepType.Execute, success: false, durationMs: 1 }],
      success: false, totalCostUsd: 0, totalDurationMs: 1,
      rollbackContext: { phaseNumber: '1', protectedBranch: 'main', lastGoodSha: cp.lastGoodSha, snapshotDir: cp.snapshotDir, integrationBranch: integrationBranchFor('1') },
    });
    vi.spyOn(gsd.createTools().constructor.prototype as any, 'roadmapAnalyze').mockResolvedValue({
      phases: [
        { number: '1', disk_status: 'pending', roadmap_complete: false, phase_name: 'A' },
        { number: '2', disk_status: 'pending', roadmap_complete: false, phase_name: 'B' },
      ],
    });

    const res = await gsd.runParallel(['1', '2'], { openPullRequests: false });
    // Tier-1 fired: integration branch deleted, protected still at LAST_GOOD.
    await expect(git(['rev-parse', '--verify', `refs/heads/${integrationBranchFor('1')}`])).rejects.toThrow();
    expect((await git(['rev-parse', 'main'])).stdout.trim()).toBe(cp.lastGoodSha);
    expect(res.phases.find((p) => p.phaseNumber === '1')!.promoted).toBe(false);
  });
```
- [ ] Run it, expect PASS (the reused driver already does this — this test guards the reuse, no new code):
```bash
cd sdk && npx vitest run src/parallel-runner.integration.test.ts --project integration
```
- [ ] Commit:
```bash
git add sdk/src/parallel-runner.integration.test.ts
git commit -m "test(parallel): assert across-wave Tier-1 rollback reuse (ADR 0014 D4)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Chunk C — Nested global budget + config + command + docs (D5)

### Task C1 — Config keys: `parallelization.phase_level` + `parallelization.max_concurrent_phases` (D5)

Add the two D5 keys. The manifest currently carries a FLAT `parallelization: true`; CONFIGURATION.md already documents a NESTED `parallelization.*` shape (enabled/plan_level/...). To match D5 and the documented nested shape WITHOUT breaking the flat `GSDConfig.parallelization: boolean` consumers, add a `ParallelizationConfig` interface and a resolver that accepts either form. The manifest gains a nested `parallelization` object that ALSO keeps the flat boolean for back-compat (the existing `resolveConcurrencyCap(config.parallelization)` reads the boolean).

**Files:**
- Modify: `sdk/shared/config-defaults.manifest.json`
- Modify: `sdk/src/config.ts`
- Test: `sdk/src/config.test.ts`

- [ ] Add the failing test to `sdk/src/config.test.ts` (append a new `describe`):
```typescript
import { resolvePhaseLevelParallelism, resolveMaxConcurrentPhases } from './config.js';

describe('ADR 0014 parallelization.phase_level / max_concurrent_phases', () => {
  it('defaults phase_level off and max_concurrent_phases to the nested default', () => {
    const cfg = structuredClone(CONFIG_DEFAULTS) as any;
    expect(resolvePhaseLevelParallelism(cfg)).toBe(false);
    expect(resolveMaxConcurrentPhases(cfg)).toBe(3);
  });
  it('reads nested overrides', () => {
    const cfg = { parallelization: { enabled: true, phase_level: true, max_concurrent_phases: 5 } } as any;
    expect(resolvePhaseLevelParallelism(cfg)).toBe(true);
    expect(resolveMaxConcurrentPhases(cfg)).toBe(5);
  });
  it('tolerates the flat boolean form (phase_level off, default cap)', () => {
    const cfg = { parallelization: true } as any;
    expect(resolvePhaseLevelParallelism(cfg)).toBe(false);
    expect(resolveMaxConcurrentPhases(cfg)).toBe(3);
  });
});
```
- [ ] Run it, expect FAIL (resolvers do not exist):
```bash
cd sdk && npx vitest run src/config.test.ts --project unit
```
- [ ] Add to `sdk/shared/config-defaults.manifest.json` — replace the flat `"parallelization": true,` line with a nested object that PRESERVES the boolean-truthiness consumers rely on by keeping `enabled`:
```json
  "parallelization": {
    "enabled": true,
    "phase_level": false,
    "max_concurrent_phases": 3
  },
```
  NOTE: `resolveConcurrencyCap(config.parallelization)` checks `=== false`; a nested object is truthy → cap resolves to `min(16, cores-2)`, preserving today's plan-level behaviour. The flat-false escape hatch is preserved by `resolvePlanLevelParallel` below.
- [ ] In `sdk/src/config.ts`, add the interface (after `GitConfig`, before `WorkflowConfig`):
```typescript
/**
 * ADR 0014 nested parallelization config (D5). `enabled` is the master switch
 * (the flat `parallelization: false` form is still accepted for back-compat).
 * `phase_level` opts into cross-phase wave parallelism (GSD.runParallel).
 * `max_concurrent_phases` sub-budgets the ONE global agent semaphore.
 */
export interface ParallelizationConfig {
  enabled?: boolean;
  phase_level?: boolean;
  max_concurrent_phases?: number;
}
```
  add the resolvers at the bottom of the file:
```typescript
/** Read `parallelization.phase_level` (ADR 0014 D5). Flat-boolean form → false. */
export function resolvePhaseLevelParallelism(config: GSDConfig): boolean {
  const p = config.parallelization as boolean | ParallelizationConfig;
  return typeof p === 'object' && p !== null ? p.phase_level === true : false;
}

/** Read `parallelization.max_concurrent_phases` (ADR 0014 D5). Default 3. */
export function resolveMaxConcurrentPhases(config: GSDConfig): number {
  const p = config.parallelization as boolean | ParallelizationConfig;
  const n = typeof p === 'object' && p !== null ? p.max_concurrent_phases : undefined;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 3;
}

/** True unless parallelization is explicitly disabled (flat `false` or `enabled:false`). */
export function resolvePlanLevelParallel(config: GSDConfig): boolean {
  const p = config.parallelization as boolean | ParallelizationConfig;
  if (p === false) return false;
  if (typeof p === 'object' && p !== null) return p.enabled !== false;
  return true;
}
```
  Change `GSDConfig.parallelization` from `boolean` to `boolean | ParallelizationConfig`:
```typescript
  parallelization: boolean | ParallelizationConfig;
```
- [ ] Update the existing `resolveConcurrencyCap` call sites that pass `config.parallelization` directly to a boolean (search-and-fix): in `phase-runner.ts:1081-1082` and `parallel-runner.ts`, replace `this.config.parallelization !== false` / `config.parallelization !== false` with `resolvePlanLevelParallel(this.config)` and pass `resolvePlanLevelParallel(config)` to `resolveConcurrencyCap`. Import `resolvePlanLevelParallel` in both files. (Grep the repo: `grep -rn "config.parallelization" sdk/src` and triage each hit.)
- [ ] Run it, expect PASS:
```bash
cd sdk && npx vitest run src/config.test.ts --project unit
```
- [ ] Regenerate the configuration CJS projection and verify freshness (the manifest feeds `configuration.generated.cjs`):
```bash
cd sdk && npm run gen:configuration && npm run check:configuration-fresh
```
- [ ] Commit:
```bash
git add sdk/shared/config-defaults.manifest.json sdk/src/config.ts sdk/src/config.test.ts sdk/src/phase-runner.ts sdk/src/parallel-runner.ts get-shit-done/bin/lib/configuration.generated.cjs
git commit -m "feat(parallel): parallelization.phase_level + max_concurrent_phases config (ADR 0014 D5)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task C2 — Nested global agent budget (D5)

A single process-wide `Semaphore` of `min(16, cores-2)` shared across BOTH plan dispatch (`phase-runner.runPlanDag`) AND phase dispatch (`parallel-runner`), so N phases × M plans never oversubscribe CPU/API. `parallel-runner` additionally caps in-flight phases at `max_concurrent_phases` (a sub-budget). This task adds the singleton and threads it into the wave loop.

**Files:**
- Create: `sdk/src/global-budget.ts`
- Modify: `sdk/src/parallel-runner.ts`
- Modify: `sdk/src/index.ts`
- Test: `sdk/src/global-budget.test.ts`

- [ ] Write the failing test `sdk/src/global-budget.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { getGlobalBudget, resetGlobalBudgetForTest } from './global-budget.js';

describe('global agent budget (ADR 0014 D5)', () => {
  it('returns the same singleton semaphore across calls', () => {
    resetGlobalBudgetForTest();
    const a = getGlobalBudget();
    const b = getGlobalBudget();
    expect(a).toBe(b);
  });
  it('caps in-flight to its permit count', async () => {
    resetGlobalBudgetForTest(2);
    const sem = getGlobalBudget();
    let inFlight = 0;
    let maxInFlight = 0;
    const task = () => sem.run(async () => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    });
    await Promise.all([task(), task(), task(), task()]);
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });
});
```
- [ ] Run it, expect FAIL:
```bash
cd sdk && npx vitest run src/global-budget.test.ts --project unit
```
- [ ] Create `sdk/src/global-budget.ts`:
```typescript
/**
 * ADR 0014 D5 — ONE process-wide agent budget shared across phase + plan
 * dispatch. Both the per-plan DAG (phase-runner.runPlanDag) and the cross-phase
 * wave loop (parallel-runner) acquire from this single Semaphore so N phases × M
 * plans cannot oversubscribe CPU/API. The total is min(16, cores-2)
 * (resolveConcurrencyCap with parallelization enabled). parallel-runner ALSO
 * applies a max_concurrent_phases sub-cap on top of this global budget.
 */
import { Semaphore, resolveConcurrencyCap } from './execution-engine.js';

let singleton: Semaphore | undefined;

/** The process-wide agent budget (lazily created at the global cap). */
export function getGlobalBudget(): Semaphore {
  if (!singleton) singleton = new Semaphore(resolveConcurrencyCap(true));
  return singleton;
}

/** Test-only: reset (optionally to a fixed permit count). */
export function resetGlobalBudgetForTest(permits?: number): void {
  singleton = permits !== undefined ? new Semaphore(permits) : undefined;
}
```
- [ ] In `sdk/src/parallel-runner.ts`, replace the locally-created `Semaphore` with the global budget plus a per-run phase sub-cap. Add `import { getGlobalBudget } from './global-budget.js';` and add `maxConcurrentPhases` to `ParallelDriverContext`:
```typescript
  /** Sub-cap on in-flight phases (D5 max_concurrent_phases). */
  maxConcurrentPhases: number;
```
  Replace `const cap = resolveConcurrencyCap(...)` + `const semaphore = new Semaphore(cap);` with:
```typescript
  // One global budget shared with plan dispatch (D5), plus a phase sub-cap.
  const globalBudget = getGlobalBudget();
  const phaseSubCap = new Semaphore(Math.max(1, ctx.maxConcurrentPhases));
  // Acquire BOTH: the phase sub-cap bounds concurrent phases; the global budget
  // bounds total agents across phase + plan dispatch.
  const acquireSlot = <T>(fn: () => Promise<T>): Promise<T> =>
    phaseSubCap.run(() => globalBudget.run(fn));
```
  and use `acquireSlot(...)` in place of `semaphore.run(...)` in the wave map. (Remove the now-unused `resolveConcurrencyCap`/`parallelization` from the import + interface if orphaned.)
- [ ] In `sdk/src/index.ts` `runParallel`, add `maxConcurrentPhases` to the context (import the resolver: `import { resolveMaxConcurrentPhases } from './config.js';`):
```typescript
      maxConcurrentPhases: resolveMaxConcurrentPhases(config),
```
- [ ] Thread the global budget into plan dispatch too: in `sdk/src/phase-runner.ts` `runPlanDag`, replace `const semaphore = new Semaphore(cap);` with `const semaphore = getGlobalBudget();` (import it) so plan executors and phase-agents share ONE budget. Keep `cap`/`resolveConcurrencyCap` only if still referenced for wave-event enablement; otherwise remove the orphaned local.
- [ ] Run it, expect PASS:
```bash
cd sdk && npx vitest run src/global-budget.test.ts --project unit
```
- [ ] Run the existing phase-runner DAG suite to confirm the budget swap is non-regressive:
```bash
cd sdk && npx vitest run src/phase-runner-dag.test.ts --project unit
```
- [ ] Commit:
```bash
git add sdk/src/global-budget.ts sdk/src/global-budget.test.ts sdk/src/parallel-runner.ts sdk/src/index.ts sdk/src/phase-runner.ts
git commit -m "feat(parallel): nested global agent budget shared phase+plan dispatch (ADR 0014 D5)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task C3 — `/gsd-execute-parallel` command surface

The command file routing `/gsd-execute-parallel <phase...>` to the parallel runner, modeled on `commands/gsd/autonomous.md`.

**Files:**
- Create: `commands/gsd/execute-parallel.md`

- [ ] Create `commands/gsd/execute-parallel.md`:
```markdown
---
name: gsd:execute-parallel
description: Run N independent backlog phases concurrently in conflict-graph waves
argument-hint: "<phase...>   # e.g. 43 44 45"
allowed-tools:
  - Read
  - Write
  - Bash
  - Glob
  - Grep
  - AskUserQuestion
  - Agent
requires: [phase, progress]
---
<objective>
Execute N named backlog phases in parallel concurrency waves (ADR 0014). Schedules the phases with `gsd-sdk query conflict-graph <phase...>` so within-wave phases are hard-disjoint in `files_modified`, then fans out one phase-agent per wave member through the standard research→plan→execute→verify lifecycle in an isolated worktree. Each green phase promotes as its own auto-merged PR; promotes are serialized in wave order. Wave N+1 starts only after wave N settles.

Gated by `git.sdk_worktree_execution` + Claude runtime + `parallelization.phase_level: true`. When a phase exhausts its retry budget, its siblings finish and only its `depends_on` dependents are skipped.

**Creates/Updates:**
- `.planning/STATE.md` / `.planning/ROADMAP.md` — orchestrator is the sole writer across the wave (D2)
- One PR per green phase (D6)
- `.planning/.phase-manifest.json`, `.planning/ROLLBACK.json` — promotion + rollback ledgers

**After:** The scheduled phases are merged (or cleanly rolled back), each as its own per-feature PR.
</objective>

<context>
Args: two or more phase tokens (`43 44 45`). Requires `git.sdk_worktree_execution: true`, `parallelization.phase_level: true`, and a branch-protected remote for PR-per-phase auto-merge. With fewer than two phases the conflict-graph verb errors; use `/gsd-execute-phase` for a single phase.
</context>

<process>
Resolve config + runtime gate, then invoke `GSD.runParallel(<phases>)`. Surface the per-wave schedule and each phase's PR url. Preserve all workflow gates (checkpoint, Tier-1/Tier-2 rollback, skip-dependents).
</process>
```
- [ ] Sanity-check the front-matter parses (no test harness for command markdown — lint by reading; confirm `name`/`allowed-tools` shape matches `autonomous.md`):
```bash
head -14 commands/gsd/execute-parallel.md
```
- [ ] Commit:
```bash
git add commands/gsd/execute-parallel.md
git commit -m "feat(parallel): /gsd-execute-parallel command surface (ADR 0014)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task C4 — Docs: CONFIGURATION.md + CLI-TOOLS.md

**Files:**
- Modify: `docs/CONFIGURATION.md`
- Modify: `docs/CLI-TOOLS.md`

- [ ] In `docs/CONFIGURATION.md`, add two rows to the parallelization table (after the `parallelization.max_concurrent_agents` row, ~line 524):
```markdown
| `parallelization.phase_level` | boolean | `false` | **ADR 0014.** Opt into cross-phase wave parallelism (`GSD.runParallel` / `/gsd-execute-parallel`). When `true` (with `git.sdk_worktree_execution` + Claude runtime), N independent backlog phases run concurrently in conflict-graph waves; each green phase promotes as its own auto-merged PR. Default `false` preserves sequential phase execution |
| `parallelization.max_concurrent_phases` | number | `3` | **ADR 0014.** Sub-cap on in-flight phase-agents in a parallel wave, enforced on top of the single global agent budget (`min(16, cores−2)`) shared across phase + plan dispatch, so N phases × M plans cannot oversubscribe CPU/API |
```
- [ ] In `docs/CLI-TOOLS.md`, add a parallel-execution subsection after the `conflict-graph` block (after ~line 88):
```markdown
### Parallel multi-phase execution (ADR 0014)

```bash
# Run N independent backlog phases concurrently in conflict-graph waves.
# Schedules via conflict-graph (hard-disjoint within a wave), fans out one
# phase-agent per wave member through the standard lifecycle in an isolated
# worktree, and promotes each green phase as its own auto-merged PR (serialized
# in wave order). Wave N+1 starts only after wave N settles.
/gsd-execute-parallel 43 44 45        # command surface
GSD.runParallel(['43','44','45'])     # SDK entrypoint (sdk/src/index.ts)
```

Gated by `git.sdk_worktree_execution` + Claude runtime + `parallelization.phase_level: true`. Reuses the per-phase checkpoint + Tier-1/Tier-2 rollback machinery (the orchestrator is the sole writer of `ROADMAP.md`/`STATE.md` across a wave). On a phase failure, siblings finish and only the failed phase's `depends_on` closure is skipped. Returns `{ success, waves, phases, totalCostUsd, totalDurationMs }`.
```
- [ ] Confirm the edits landed (no generated-file regen needed — these docs are hand-authored, not generated):
```bash
grep -n "phase_level\|max_concurrent_phases\|execute-parallel\|runParallel" docs/CONFIGURATION.md docs/CLI-TOOLS.md
```
- [ ] Commit:
```bash
git add docs/CONFIGURATION.md docs/CLI-TOOLS.md
git commit -m "docs(parallel): document parallelization.* config + runParallel/execute-parallel (ADR 0014)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task C5 — Changeset fragment + full-suite green gate

**Files:**
- Create: `.changeset/14-parallel-multi-phase-execution.md`

- [ ] Create `.changeset/14-parallel-multi-phase-execution.md`:
```markdown
---
type: Added
pr: 15
---
**`GSD.runParallel(<phase...>)` + the `/gsd-execute-parallel` command — parallel multi-phase execution (ADR 0014).** N independent backlog phases run concurrently in conflict-graph-scheduled waves (parallel within a wave, sequential across), each through its own research→plan→execute→verify lifecycle in an isolated worktree, promoting as its own auto-merged PR. Reuses the ADR 0013 worktree/checkpoint/rollback engine: per-phase base SHA captured at wave start (D3), the orchestrator is the sole writer of `ROADMAP.md`/`STATE.md` across a wave (D2), failure isolation continues independents and skips only the failed phase's `depends_on` closure (D4), and a single global agent budget shared across phase + plan dispatch (`parallelization.max_concurrent_phases`, D5) prevents oversubscription. Gated by `git.sdk_worktree_execution` + Claude runtime + new `parallelization.phase_level`. (#15)
```
- [ ] Run the FULL SDK suite (unit + integration) — the green gate before this chunk is done:
```bash
cd sdk && npm run build && npx vitest run --project unit --project integration
```
- [ ] Run the freshness guards touched by this work (configuration projection):
```bash
cd sdk && npm run check:configuration-fresh
```
- [ ] Commit:
```bash
git add .changeset/14-parallel-multi-phase-execution.md
git commit -m "chore(parallel): changeset fragment for ADR 0014 parallel multi-phase execution

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Measure of success (falsifiable integration harness)

The ADR's measure of success, as one consolidated integration test asserting all five claims. This is the release gate for the feature.

### Task M1 — The measure-of-success falsifier

**Files:**
- Test: `sdk/src/parallel-runner.integration.test.ts` (new `describe('ADR 0014 measure of success', ...)`)

- [ ] Add the consolidated falsifier:
```typescript
describe('ADR 0014 measure of success', () => {
  it('three hard-disjoint phases all promote; a sharer is a later wave; a failure isolates; ledgers clean', async () => {
    const dir = await setupRepo(); dirs.push(dir);
    const git = gitIn(dir);
    // Phases: 43,44,45 disjoint (wave 0); 46 shares src/a.ts with 43 (later wave);
    // 47 depends_on 43 and 43 is rigged to fail → 47 skipped, 44/45 still promote.
    const plan = (ph: string, f: string) =>
      `---\nphase: ${ph}\nfiles_modified:\n  - ${f}\n---\n<objective>O</objective>\n<tasks><task type="auto"><name>T</name></task></tasks>\n`;
    for (const [d, ph, f] of [
      ['43-x', '43-x', 'src/a.ts'], ['44-y', '44-y', 'src/b.ts'], ['45-z', '45-z', 'src/c.ts'],
      ['46-w', '46-w', 'src/a.ts'], ['47-v', '47-v', 'src/d.ts'],
    ] as const) {
      await mkdir(join(dir, '.planning', 'phases', d), { recursive: true });
      await writeFile(join(dir, '.planning', 'phases', d, `${ph.split('-')[0]}-PLAN.md`), plan(ph, f));
    }
    await writeFile(join(dir, '.planning', 'ROADMAP.md'),
      '### Phase 43: X\n### Phase 44: Y\n### Phase 45: Z\n### Phase 46: W\n### Phase 47: V\n**Depends on:** Phase 43\n');
    await git(['add', '-A']); await git(['commit', '-q', '--no-verify', '-m', 'fixtures']);

    const gsd = new GSD({ projectDir: dir });
    const merges: string[] = [];
    vi.spyOn(gsd as any, 'runPhaseWithRollbackRetry').mockImplementation(async (phase: any) => {
      if (phase.number === '43') {
        return { result: { phaseNumber: '43', phaseName: 'X', steps: [{ step: PhaseStepType.Execute, success: false, durationMs: 1 }], success: false, totalCostUsd: 0, totalDurationMs: 1 }, halted: true };
      }
      return { result: greenResult(phase.number), halted: false };
    });
    vi.spyOn(gsd.createTools().constructor.prototype as any, 'roadmapAnalyze').mockResolvedValue({
      phases: ['43', '44', '45', '46', '47'].map((n) => ({ number: n, disk_status: 'pending', roadmap_complete: false, phase_name: n })),
    });
    const fakeRunners = {
      gh: vi.fn(async (a: string[]) => { if (a[1] === 'create') return `https://x/pull/${a[a.indexOf('--head') + 1]}\n`; if (a[1] === 'merge') merges.push(a[2]); return ''; }),
      git: vi.fn(async () => ''),
    };

    const res = await gsd.runParallel(['43', '44', '45', '46', '47'], { openPullRequests: true, prRunners: fakeRunners } as any);

    // (1) hard-disjoint 44 & 45 promote (43 fails); 44/45 in wave 0.
    expect(res.phases.find((p) => p.phaseNumber === '44')!.promoted).toBe(true);
    expect(res.phases.find((p) => p.phaseNumber === '45')!.promoted).toBe(true);
    // (2) 46 shares a non-hotspot file with 43 → scheduled to a LATER wave than 43.
    const wave43 = res.waves.findIndex((w) => w.phases.some((p) => p.phaseNumber === '43'));
    const wave46 = res.waves.findIndex((w) => w.phases.some((p) => p.phaseNumber === '46'));
    expect(wave46).toBeGreaterThan(wave43);
    // (3) injected failure in 43 → its depends_on dependent 47 is skipped; siblings merged.
    expect(res.phases.find((p) => p.phaseNumber === '43')!.promoted).toBe(false);
    expect(res.phases.find((p) => p.phaseNumber === '47')!.skippedReason).toMatch(/depends_on.*43/);
    // (4) a PR auto-merged per green phase (44,45,46 at least — not 43, not 47).
    expect(merges.length).toBeGreaterThanOrEqual(3);
    // (5) overall run reports failure (a phase failed) but isolated the blast radius.
    expect(res.success).toBe(false);
  });
});
```
- [ ] Run it, expect PASS:
```bash
cd sdk && npx vitest run src/parallel-runner.integration.test.ts --project integration
```
- [ ] Commit:
```bash
git add sdk/src/parallel-runner.integration.test.ts
git commit -m "test(parallel): ADR 0014 measure-of-success falsifier (release gate)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification gate

- [ ] Build + full suite green:
```bash
cd sdk && npm run build && npx vitest run --project unit --project integration
```
- [ ] All freshness guards touched are fresh:
```bash
cd sdk && npm run check:configuration-fresh
```
- [ ] Format-fanout sanity: the new config shape did not strand a flat-boolean consumer:
```bash
grep -rn "config.parallelization" sdk/src | grep -v resolvePlanLevelParallel
```
  (Expect: zero raw `=== false` / `!== false` reads left; all route through `resolvePlanLevelParallel`.)
- [ ] Lint/typecheck clean:
```bash
cd sdk && npx tsc --noEmit
```

---

## ADR coverage map (self-review)

| ADR section / decision | Task(s) |
| --- | --- |
| D1 — parallel within waves, sequential across | A1 (schedule), A4 (wave loop) |
| D2 — single-writer ledgers lifted to wave scope | A5 (serialized promote mutex), B2 (ledger tripwire) |
| D3 — per-phase base SHA | B1 |
| D4 — failure isolation: continue independents, skip dependents | A4 (`Promise.all` continues siblings), B3 (skip closure), B4 (Tier-1 reuse) |
| D5 — nested global agent budget | C1 (config), C2 (global budget + phase sub-cap) |
| D6 — PR-per-phase auto-merge | A2 (helpers), A5 (wire-in) |
| Implementation phasing (Chunk A/B/C) | A1–A5 / B1–B4 / C1–C5 |
| Measure of success (falsifiable) | M1 |
| Repo gates (changeset / docs / fresh) | C1 (config fresh), C4 (docs), C5 (changeset + suite) |
