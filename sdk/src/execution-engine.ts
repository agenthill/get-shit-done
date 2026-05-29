/**
 * Execution engine collaborators for the per-plan DAG (ADR 0013, SDK surface).
 *
 * The SDK runs each plan in its own git worktree forked off its predecessor's
 * merged commit, then a single-writer MergeSerializer integrates each plan's
 * delta onto the protected branch behind the guard suite and gates completion
 * on a BATCHED build+test run at level boundaries.
 *
 * These behaviours are expressed as injectable collaborators so that:
 *  - unit tests (which mock the session runner and run in a non-git temp dir)
 *    keep today's in-process, shared-cwd semantics via the no-op defaults;
 *  - falsifier/integration tests inject the real git-backed implementations
 *    against a temp repository to verify fork-off-predecessor, single-plan-delta
 *    guards, and bulk-delete-revert safety.
 *
 * No clock/randomness of our own beyond Date.now (as the SDK already uses today);
 * wall-clock test harnesses inject their own controllable durations via the
 * mocked session runner, never by stubbing this module's timing.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';

const execFileAsync = promisify(execFile);

// ─── Concurrency cap ───────────────────────────────────────────────────────

/**
 * Resolve the in-flight executor cap.
 *   parallelization === false → 1 (strictly sequential)
 *   otherwise                 → min(16, max(1, availableParallelism - 2))
 */
export function resolveConcurrencyCap(parallelization: boolean): number {
  if (parallelization === false) return 1;
  const cores =
    typeof os.availableParallelism === 'function'
      ? os.availableParallelism()
      : os.cpus().length;
  return Math.min(16, Math.max(1, cores - 2));
}

/**
 * Minimal counting semaphore. Acquire before dispatching a plan, release after.
 * No external dependency; FIFO over the waiter queue.
 */
export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.available = Math.max(1, permits);
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return;
    }
    await new Promise<void>(resolve => this.waiters.push(resolve));
    // Permit was handed directly to us by release(); do not decrement again.
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      // Hand the permit straight to the next waiter without bouncing the count.
      next();
    } else {
      this.available++;
    }
  }

  /** Run fn while holding a permit. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

/**
 * Async mutex — the single-writer lock for the MergeSerializer. Guarantees that
 * no two plan deltas are merged onto the protected branch concurrently.
 */
export class Mutex {
  private chain: Promise<void> = Promise.resolve();
  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    // Standard chained mutex: each caller waits for the prior holder to release,
    // then runs its section exclusively. The chain links on a fresh release
    // promise (NOT on fn's own settlement), so a prior fn that throws can never
    // re-invoke the next caller's fn (the bug in `.then(fn, fn)`), and a
    // rejection never wedges the lock — `prev.catch()` swallows the prior
    // outcome for ordering only.
    const prev = this.chain;
    let release!: () => void;
    this.chain = new Promise<void>(r => (release = r));
    await prev.catch(() => {}); // wait for prior holder, ignore its outcome
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

// ─── Worktree manager ──────────────────────────────────────────────────────

export interface PlanWorktree {
  /** Working directory the executor session should run in. */
  cwd: string;
  /** Branch the plan's commits land on (deterministic per plan within a run). */
  branch: string;
  /** Commit sha the worktree was forked off (predecessor tip or run base). */
  baseSha: string;
}

/**
 * Creates and tracks one worktree per plan, forked off a base commit that
 * already contains the plan's predecessors' commits (fork-off-predecessor).
 */
export interface WorktreeManager {
  /**
   * Create a worktree for a plan off `baseSha` (the predecessor's merged tip, or
   * the run base for roots). Returns the cwd + branch the executor runs in.
   */
  create(planId: string, phase: number, baseSha: string): Promise<PlanWorktree>;
  /** The current tip sha of a plan's branch (after the executor committed). */
  headSha(planId: string): Promise<string>;
  /** Remove a plan's worktree (manifest-scoped; never broad discovery). */
  cleanup(planId: string): Promise<void>;
}

/**
 * No-op worktree manager: every plan runs in the shared project cwd, exactly as
 * the SDK does today (no isolation). Default when no git engine is injected.
 */
export class SharedCwdWorktreeManager implements WorktreeManager {
  constructor(private readonly projectDir: string) {}
  async create(): Promise<PlanWorktree> {
    return { cwd: this.projectDir, branch: '', baseSha: '' };
  }
  async headSha(): Promise<string> {
    return '';
  }
  async cleanup(): Promise<void> {
    /* nothing to clean — shared cwd */
  }
}

/**
 * Git-backed worktree manager. One linked worktree per plan, on a deterministic
 * `worktree-agent-<phase>-<id>` branch forked off `baseSha`. Worktrees share the
 * repo object store, so a sibling's commit sha is reachable (Task 0 validation).
 */
export class GitWorktreeManager implements WorktreeManager {
  private readonly tracked = new Map<string, { dir: string; branch: string }>();

  constructor(
    private readonly repoDir: string,
    /** Directory under which per-plan worktrees are created. */
    private readonly worktreeRoot: string,
  ) {}

  private git(args: string[], cwd = this.repoDir) {
    return execFileAsync('git', args, { cwd });
  }

  async create(planId: string, phase: number, baseSha: string): Promise<PlanWorktree> {
    const branch = branchNameFor(phase, planId);
    const dir = `${this.worktreeRoot}/wt-${phase}-${sanitize(planId)}`;

    // Resume case (prior crash): <dir> may already be a REGISTERED worktree. A
    // plain `worktree add` then fails ("already exists"), and the caller's
    // fallback-to-shared-cwd would make a dependent miss its predecessor's
    // commits (invariant 4). Reuse the registered worktree by checking it out to
    // this plan's branch in place rather than re-adding.
    if (await this.isRegisteredWorktree(dir)) {
      await this.ensureBranch(branch, baseSha);
      await this.git(['checkout', '-f', branch], dir);
      this.tracked.set(planId, { dir, branch });
      return { cwd: dir, branch, baseSha };
    }

    // Reattach to a surviving branch on resume rather than forking a duplicate.
    let exists = false;
    try {
      await this.git(['rev-parse', '--verify', `refs/heads/${branch}`]);
      exists = true;
    } catch {
      exists = false;
    }
    if (exists) {
      await this.git(['worktree', 'add', '--force', dir, branch]);
    } else {
      await this.git(['worktree', 'add', '-b', branch, dir, baseSha]);
    }
    this.tracked.set(planId, { dir, branch });
    return { cwd: dir, branch, baseSha };
  }

  /** True when `dir` is already registered as a linked worktree (resume path). */
  private async isRegisteredWorktree(dir: string): Promise<boolean> {
    try {
      const { stdout } = await this.git(['worktree', 'list', '--porcelain']);
      for (const line of stdout.split('\n')) {
        if (line.startsWith('worktree ') && line.slice('worktree '.length).trim() === dir) {
          return true;
        }
      }
    } catch {
      // `git worktree list` failing → treat as not-registered; the add path
      // below will surface any real error.
    }
    return false;
  }

  /** Ensure the plan's branch exists, creating it at `baseSha` if absent. */
  private async ensureBranch(branch: string, baseSha: string): Promise<void> {
    try {
      await this.git(['rev-parse', '--verify', `refs/heads/${branch}`]);
    } catch {
      await this.git(['branch', branch, baseSha]).catch(() => {});
    }
  }

  async headSha(planId: string): Promise<string> {
    const entry = this.tracked.get(planId);
    if (!entry) return '';
    const { stdout } = await this.git(['rev-parse', 'HEAD'], entry.dir);
    return stdout.trim();
  }

  async cleanup(planId: string): Promise<void> {
    const entry = this.tracked.get(planId);
    if (!entry) return;
    try {
      await this.git(['worktree', 'remove', '--force', entry.dir]);
    } catch {
      // best-effort; branch ref persists for descendants/integration
    }
    this.tracked.delete(planId);
  }
}

export function branchNameFor(phase: number, planId: string): string {
  return `worktree-agent-${phase}-${sanitize(planId)}`;
}

function sanitize(planId: string): string {
  return planId.replace(/[^A-Za-z0-9._-]/g, '-');
}

// ─── Merge serializer + batched gate ─────────────────────────────────────────

export interface MergeOutcome {
  planId: string;
  /** True when the plan's delta was merged onto the protected branch. */
  merged: boolean;
  /** Reason a merge was skipped (e.g. blocked-by-ancestor). */
  skippedReason?: string;
}

export interface GateOutcome {
  /** Process exit code of the batched build+test gate. 0 = pass. */
  testExit: number;
}

/**
 * Single-writer integration of plan deltas + the batched build+test gate.
 *
 * `merge` is the cheap step that unblocks dependents (per-plan topological
 * integration, single-plan delta, behind the guard suite). `gate` is the
 * EXPENSIVE build+test step, run BATCHED at level boundaries — never per merge.
 * This decoupling is what keeps the design a net win under a test-dominated
 * suite (ADR 0013, "Rejected protocols": per-plan gate is slower than today).
 */
export interface MergeSerializer {
  /**
   * Merge one plan's own delta onto the protected branch behind the guard suite.
   * Serialized — only one writer at a time. Returns whether it merged.
   */
  merge(planId: string, branch: string): Promise<MergeOutcome>;
  /**
   * Run the batched build+test gate once for a set of just-merged plans.
   * Completion is marked only on testExit === 0 (124 = inconclusive, not pass).
   */
  gate(planIds: string[]): Promise<GateOutcome>;
}

/**
 * No-op serializer: marks every plan merged, gate always passes. Default when no
 * git engine is injected — preserves today's "no merge step, no gate" SDK path.
 */
export class NoopMergeSerializer implements MergeSerializer {
  async merge(planId: string): Promise<MergeOutcome> {
    return { planId, merged: true };
  }
  async gate(): Promise<GateOutcome> {
    return { testExit: 0 };
  }
}

/**
 * Git-backed single-writer integration with the guard suite (invariant 6) and a
 * batched, injectable build+test gate (invariant 3). Used by falsifier tests.
 *
 * Each merge runs under the shared {@link Mutex}, merges one plan branch's own
 * delta onto the protected branch, and applies the guard suite to that
 * single-plan delta:
 *  - deletion-diff against the merge-base (single-plan, not the whole chain);
 *  - >5-file bulk-delete revert that restores files the merge dropped;
 *  - STATE.md / ROADMAP.md restore (parallel plans never write them);
 *  - resurrected-file guard (a file an ancestor deleted is not re-added).
 *
 * The bulk-delete revert restores from the protected branch's pre-merge tree, so
 * it can NEVER discard an ancestor plan's committed work — the merge-base is the
 * protected tip the ancestor already landed on, not a stacked branch (this is
 * the per-plan-delta fix for the leaf-only integration data-loss hazard).
 */
export class GitMergeSerializer implements MergeSerializer {
  private readonly mutex = new Mutex();

  constructor(
    private readonly repoDir: string,
    private readonly protectedBranch: string,
    /**
     * Injectable batched build+test gate. Returns a process-style exit code
     * (0 = pass, 124 = timeout/inconclusive). Tests inject a controllable fake;
     * production wires the real `gsd-sdk` build+test command.
     */
    private readonly runGate: (planIds: string[]) => Promise<number>,
    private readonly bulkDeleteThreshold = 5,
  ) {}

  private git(args: string[]) {
    return execFileAsync('git', args, { cwd: this.repoDir });
  }

  async merge(planId: string, branch: string): Promise<MergeOutcome> {
    return this.mutex.runExclusive(async () => {
      // Snapshot the protected tip BEFORE merging so the guard suite can restore
      // from a known-good single-plan-delta baseline.
      const baseTip = (await this.git(['rev-parse', this.protectedBranch])).stdout.trim();

      // Merge the plan's own delta. Because a descendant branch already contains
      // its ancestors' commits (fork-off-predecessor), a descendant merged after
      // its ancestor is a fast-forward-or-trivial merge — a single-plan delta.
      try {
        await this.git(['merge', '--no-ff', '--no-edit', branch]);
      } catch {
        await this.git(['merge', '--abort']).catch(() => {});
        return { planId, merged: false, skippedReason: 'merge_conflict' };
      }

      await this.applyGuardSuite(baseTip);
      return { planId, merged: true };
    });
  }

  /**
   * Guard suite over the just-merged single-plan delta, diffed against the
   * pre-merge protected tip (`baseTip`).
   */
  private async applyGuardSuite(baseTip: string): Promise<void> {
    // Two-dot diff baseTip..HEAD = exactly this plan's delta (single-plan), not
    // a three-dot merge-base diff that would surface ancestor deletions.
    const { stdout } = await this.git(['diff', '--name-status', `${baseTip}..HEAD`]);
    const deletions: string[] = [];
    const additions: string[] = [];
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [status, ...rest] = trimmed.split('\t');
      const file = rest.join('\t');
      if (status.startsWith('D')) deletions.push(file);
      else if (status.startsWith('A')) additions.push(file);
    }

    // Resurrected-file guard (invariant 6, ADR 0013 / #2501): a file an ancestor
    // INTENTIONALLY deleted on the protected branch must not be silently re-added
    // by this plan's merge. Scoped to the single-plan delta (files this delta
    // ADDED, baseTip..HEAD). A file is a resurrection only when the protected
    // branch's history at baseTip shows a prior deletion event for it — matching
    // the production guard's `git log --diff-filter=D` history check, not a bare
    // "absent from the pre-merge tree" test (which would wrongly drop genuinely
    // new files). Resurrections are removed and folded into the guard commit.
    const resurrected: string[] = [];
    for (const f of additions) {
      try {
        const { stdout: log } = await this.git([
          'log',
          '--diff-filter=D',
          '--format=',
          '--name-only',
          baseTip,
          '--',
          f,
        ]);
        if (log.split('\n').some(l => l.trim().length > 0)) {
          resurrected.push(f);
        }
      } catch {
        // history unavailable for this path → not provably a resurrection; skip.
      }
    }
    for (const f of resurrected) {
      await this.git(['rm', '-f', '--', f]).catch(() => {});
    }

    // STATE.md / ROADMAP.md restore: parallel plans must never write them
    // (invariant 2 — single-writer is the orchestrator/runner post-green-gate).
    const stateFiles = new Set<string>();
    for (const f of deletions) {
      if (/(?:^|\/)STATE\.md$/.test(f) || /(?:^|\/)ROADMAP\.md$/.test(f)) {
        stateFiles.add(f);
      }
    }

    // >N-file bulk-delete revert: restore EVERY file this delta deleted from the
    // pre-merge protected tree. Sourcing from baseTip guarantees no ancestor
    // work is discarded (the ancestor's commit is already at/under baseTip).
    const bulkDelete = deletions.length > this.bulkDeleteThreshold;
    const toRestore = new Set<string>();
    if (bulkDelete) {
      for (const f of deletions) toRestore.add(f);
    }
    for (const f of stateFiles) toRestore.add(f);

    // Nothing for the bulk-delete/state restore AND no resurrection to strip →
    // no guard commit needed.
    if (toRestore.size === 0 && resurrected.length === 0) return;

    for (const f of toRestore) {
      try {
        await this.git(['checkout', baseTip, '--', f]);
      } catch {
        // file may not exist at baseTip (genuinely new deletion) — skip
      }
    }
    await this.git(['add', '-A']);
    const restoreNote =
      toRestore.size > 0 ? `restore ${toRestore.size} file(s)` : '';
    const resurrectNote =
      resurrected.length > 0 ? `strip ${resurrected.length} resurrected file(s)` : '';
    const note = [restoreNote, resurrectNote].filter(Boolean).join(', ');
    await this.git([
      'commit',
      '--no-verify',
      '-m',
      `guard: ${note} (bulk-delete/state/resurrection guard)`,
    ]).catch(() => {
      /* nothing staged → no guard commit needed */
    });
  }

  async gate(planIds: string[]): Promise<GateOutcome> {
    const testExit = await this.runGate(planIds);
    return { testExit };
  }
}
