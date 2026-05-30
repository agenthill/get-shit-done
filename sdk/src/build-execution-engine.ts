/**
 * Production builder for the SDK's git-backed execution engine (ADR 0013
 * option 3). Wires the REAL {@link GitWorktreeManager} + {@link GitMergeSerializer}
 * into `PhaseRunner.runPlanDag` behind a config gate, replacing the no-op
 * shared-cwd path with per-plan worktree isolation + a single-writer merge
 * serializer + a real build+test gate (invariant 3).
 *
 * The two safety properties this module owns:
 *
 *  1. FAIL-CLOSED PRE-FLIGHT. {@link buildGitExecutionEngineFactory} probes real
 *     git worktree creation and THROWS on any failure. GSD.runPhase awaits it
 *     BEFORE constructing the PhaseRunner, so a failed probe aborts the phase
 *     before any plan is dispatched — the no-op engine is NEVER substituted. (The
 *     probe runs in the async builder, not the synchronous factory closure
 *     runPlanDag calls.) A silent fallback would bypass inv-3 and run concurrent
 *     shared-tree mutation, so the throw is the single most important guarantee.
 *
 *  2. REAL TEST GATE. `runGate` runs the resolved test command in the
 *     post-merge protected checkout and returns its exit code (timeout → 124,
 *     which inv-3 treats as inconclusive ≠ pass). This is the gate that
 *     phase-runner.ts:1091-1106 reads to downgrade a plan's success.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { GSDConfig } from './config.js';
import type { ExecutionEngineFactory } from './phase-runner.js';
import {
  GitWorktreeManager,
  GitMergeSerializer,
  GitPhaseIntegrationManager,
} from './execution-engine.js';

const execFileAsync = promisify(execFile);

/** Exit code inv-3 treats as inconclusive (NOT a pass). */
const TIMEOUT_EXIT = 124;
/** Build+test gate timeout (ms). Generous — the suite is the slow path. */
const GATE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Resolve the build+test command for the gate.
 *   - `git.sdk_test_command` when explicitly set (split on whitespace);
 *   - else `['npm', 'test']` when a package.json with a `test` script exists;
 *   - else `null` → the gate is a no-op pass (no test runner available).
 *
 * Mirrors the package.json-reading pattern in query/docs-init.ts:117.
 */
export function resolveTestCommand(config: GSDConfig, projectDir: string): string[] | null {
  const explicit = config.git?.sdk_test_command;
  if (typeof explicit === 'string' && explicit.trim().length > 0) {
    return explicit.trim().split(/\s+/);
  }
  try {
    const pkg = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf-8')) as Record<
      string,
      unknown
    >;
    const scripts = pkg.scripts as Record<string, unknown> | undefined;
    if (scripts && typeof scripts.test === 'string' && scripts.test.trim().length > 0) {
      return ['npm', 'test'];
    }
  } catch {
    /* no package.json or no test script → no command */
  }
  return null;
}

/**
 * Build the real `runGate` for {@link GitMergeSerializer}. Runs the resolved
 * test command in the protected checkout (`repoDir`) via execFile with a
 * timeout. Returns the process exit code; a timeout returns 124 (inconclusive),
 * and a missing command returns 0 (no runner → nothing to fail). Never throws —
 * inv-3 reads only the exit code.
 */
export function buildRunGate(
  command: string[] | null,
  repoDir: string,
): (planIds: string[]) => Promise<number> {
  return async (_planIds: string[]): Promise<number> => {
    if (!command || command.length === 0) return 0;
    const [bin, ...args] = command;
    try {
      await execFileAsync(bin, args, { cwd: repoDir, timeout: GATE_TIMEOUT_MS });
      return 0;
    } catch (err) {
      const e = err as { killed?: boolean; signal?: string; code?: unknown };
      // execFile sets killed=true (and signal SIGTERM) on timeout.
      if (e && (e.killed === true || e.signal === 'SIGTERM')) return TIMEOUT_EXIT;
      if (typeof e?.code === 'number') return e.code;
      // Non-numeric failure (e.g. ENOENT for a missing binary) → inconclusive.
      return TIMEOUT_EXIT;
    }
  };
}

function git(args: string[], cwd: string) {
  return execFileAsync('git', args, { cwd });
}

/**
 * Resolve the protected branch the engine merges plan deltas onto.
 * Honors `config.git.base_branch` when set; else mirrors check-ship-ready.ts:84-87
 * (try `main`, then `master`, then the current branch).
 */
async function resolveProtectedBranch(config: GSDConfig, projectDir: string): Promise<string> {
  const configured = config.git?.base_branch;
  if (typeof configured === 'string' && configured.trim().length > 0) {
    return configured.trim();
  }
  const exists = async (ref: string): Promise<boolean> => {
    try {
      await git(['rev-parse', '--verify', ref], projectDir);
      return true;
    } catch {
      return false;
    }
  };
  if (await exists('main')) return 'main';
  if (await exists('master')) return 'master';
  const { stdout } = await git(['rev-parse', '--abbrev-ref', 'HEAD'], projectDir);
  return stdout.trim();
}

/**
 * FAIL-CLOSED probe: assert real linked-worktree creation works. Creates a
 * detached worktree at a temp dir off HEAD, asserts it is a LINKED worktree
 * (its --git-common-dir differs from --git-dir), then removes it. THROWS on any
 * failure. Never returns a degraded engine.
 */
async function assertWorktreeCapability(projectDir: string): Promise<void> {
  const probeDir = await mkdtemp(join(tmpdir(), 'gsd-wt-probe-'));
  try {
    await git(['worktree', 'add', '--detach', probeDir, 'HEAD'], projectDir);
  } catch (err) {
    await rm(probeDir, { recursive: true, force: true }).catch(() => {});
    throw new Error(
      `SDK worktree execution requested (git.sdk_worktree_execution=true) but git ` +
        `worktree isolation is unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    const commonDir = (await git(['rev-parse', '--git-common-dir'], probeDir)).stdout.trim();
    const gitDir = (await git(['rev-parse', '--git-dir'], probeDir)).stdout.trim();
    if (commonDir === gitDir) {
      throw new Error(
        `SDK worktree execution requested but the probe worktree is not LINKED ` +
          `(git-common-dir === git-dir: ${gitDir}); per-plan isolation would not hold.`,
      );
    }
  } finally {
    // Best-effort teardown; a leaked probe worktree must not mask the verdict.
    await git(['worktree', 'remove', '--force', probeDir], projectDir).catch(() => {});
    await rm(probeDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Build the production {@link ExecutionEngineFactory} for the git-backed engine.
 *
 * runPlanDag (phase-runner.ts:876) calls the factory SYNCHRONOUSLY, so the async
 * fail-closed probe cannot run inside the returned closure. Instead it runs HERE
 * at build time — and this builder is awaited by GSD.runPhase BEFORE the
 * PhaseRunner is constructed, so any probe failure throws and aborts the phase
 * before a single plan is dispatched. The no-op engine is never substituted.
 *
 * This builder:
 *   1. resolves the protected branch + base sha;
 *   2. runs the FAIL-CLOSED worktree-capability probe (throws on failure);
 *   3. resolves the real test command + runGate;
 *   4. returns a pure synchronous factory that constructs the real
 *      GitWorktreeManager + GitMergeSerializer, marked `isolated: true` so a
 *      per-plan create() failure is fatal (phase-runner.ts:989-993).
 */
export async function buildGitExecutionEngineFactory(
  config: GSDConfig,
  projectDir: string,
): Promise<ExecutionEngineFactory> {
  // Resolve protected branch + base sha, and run the fail-closed probe NOW
  // (build time, before runPhase wires the runner). Any failure throws here and
  // aborts the phase before a single plan is dispatched — the no-op engine is
  // never substituted.
  const protectedBranch = await resolveProtectedBranch(config, projectDir);
  await assertWorktreeCapability(projectDir);
  const baseSha = (await git(['rev-parse', 'HEAD'], projectDir)).stdout.trim();

  const testCommand = resolveTestCommand(config, projectDir);
  const runGate = buildRunGate(testCommand, projectDir);

  // Deterministic worktree root OUTSIDE the working tree (shares the object
  // store via the linked worktree). Outside-tree placement avoids polluting
  // `git status`; a deterministic (non-mkdtemp) path lets the manager's resume
  // logic reattach to a prior run's worktrees after a crash.
  const projectHash = createHash('sha1').update(projectDir).digest('hex').slice(0, 12);

  return ({ projectDir: phaseDir, phaseNumber }) => {
    // HONOR the PASSED projectDir (ADR 0014 #13 gap-2, Chunk C PR-1): under the
    // parallel wave executor the runner passes the phase's OWN linked worktree as
    // `projectDir`, so the per-plan worktrees, merge serializer, and integration
    // manager all operate inside that isolated tree — never the shared build-time
    // projectDir whose HEAD/index two concurrent phases would race. The sequential
    // path passes the build-time projectDir, so behaviour there is unchanged.
    // `baseSha`/`protectedBranch` are resolved at build time against the real repo
    // (a linked worktree shares the object store, so the base commit + protected
    // ref are reachable from the phase worktree).
    const engineDir = phaseDir;
    const worktreeRoot = join(tmpdir(), 'gsd-sdk-worktrees', projectHash, `phase-${phaseNumber}`);
    // `git worktree add` creates the leaf dir but not intermediate parents; the
    // manager does not mkdir its root, so ensure it exists here.
    mkdirSync(worktreeRoot, { recursive: true });
    const serializer = new GitMergeSerializer(engineDir, protectedBranch, runGate);
    return {
      worktrees: new GitWorktreeManager(engineDir, worktreeRoot),
      serializer,
      baseSha,
      isolated: true,
      // Per-phase branch + promote-on-green (ADR 0013 option 4). Shares the
      // serializer so its promote merge reuses the same guard suite.
      phaseIntegration: new GitPhaseIntegrationManager(engineDir, serializer),
      protectedBranch,
    };
  };
}
