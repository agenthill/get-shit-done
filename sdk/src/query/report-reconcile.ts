/**
 * report.reconcile — fail-closed ground-truth reconciliation of an executor's
 * self-reported state BEFORE it writes SUMMARY.md / a PR body (issue #18, #4).
 *
 * The bug: a gsd-executor run reported PHANTOM commit SHAs (rolled back by a
 * cancelled parallel-batch, gone from `git log`), claimed a push that never
 * happened, and cited a PR number it read from an UNRELATED `gh pr view`. If
 * that report had auto-merged, the PR body would have carried false claims.
 *
 * This verb derives the real state from ground truth and REFUSES to emit a
 * success verdict (`ok: false`) when believed ≠ actual:
 *   - claimed SHAs are checked against `git log --format=%H <branch>` (a phantom
 *     SHA is dropped from `verifiedShas` and surfaced as a discrepancy);
 *   - a claimed push is confirmed via `git ls-remote --heads origin <branch>`
 *     (no remote ref ⇒ `pushed: false`, never a phantom "pushed");
 *   - a claimed PR is confirmed via `gh pr list --head <branch>` — the URL it
 *     returns is captured, NEVER a number read from an unrelated `gh pr view`.
 *
 * The agent must write ONLY the verified SHAs / PR-URL into the summary, and
 * report the failure instead of a success when `ok` is false.
 *
 * Read-only: this verb queries ground truth; it never stages, commits, pushes,
 * or opens a PR. The `git` / `gh` runners are injected so the core is unit-
 * testable with exact-argv assertions and no real network.
 *
 * SDK-only — no gsd-tools.cjs mirror (like `conflict-graph` / `validation.*`).
 */

import { spawnSync } from 'node:child_process';
import { GSDError, ErrorClassification } from '../errors.js';
import type { QueryHandler } from './utils.js';

// ─── Runner contract ─────────────────────────────────────────────────────────

export interface RunnerResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** A command runner — receives argv (no binary name), returns the result. */
export type Runner = (args: string[]) => RunnerResult;

/** Injectable git/gh runners. Tests pass doubles; production uses spawnSync. */
export interface ReconcileRunners {
  git: Runner;
  gh: Runner;
}

// ─── Input / output shapes ───────────────────────────────────────────────────

export interface ReconcileInput {
  /** Branch whose ground truth is being reconciled. */
  branch: string;
  /** Commit SHAs (short or full) the agent BELIEVES it created for this plan. */
  claimedShas: string[];
  /** True when the agent believes it pushed the branch. */
  claimedPushed?: boolean;
  /** A PR number or URL the agent believes it opened (may be phantom). */
  claimedPr?: string;
}

export interface ReconciledPr {
  number: number;
  url: string;
}

export interface ReconcileResult {
  branch: string;
  /** Overall fail-closed verdict: true ONLY when every check the agent claimed is confirmed. */
  ok: boolean;
  /** True when ground truth was established AND every claimed SHA exists in the log. */
  shasVerified: boolean;
  /** The subset of claimed SHAs confirmed present in `git log` (phantoms excluded). */
  verifiedShas: string[];
  /** Whether the branch has a remote ref on origin. */
  pushed: boolean;
  /** The SHA origin points the branch ref at, or null when unpushed. */
  remoteSha: string | null;
  /** The PR confirmed via `gh pr list --head <branch>`, or null when none exists. */
  pr: ReconciledPr | null;
  /** Human-readable believed≠actual mismatches. Empty ⇒ report is trustworthy. */
  discrepancies: string[];
}

// ─── Production runners ──────────────────────────────────────────────────────

function spawnRunner(bin: string): Runner {
  return (args: string[]): RunnerResult => {
    const r = spawnSync(bin, args, { stdio: 'pipe', encoding: 'utf-8' });
    return {
      exitCode: r.status ?? 1,
      stdout: (r.stdout ?? '').toString().trim(),
      stderr: (r.stderr ?? '').toString().trim(),
    };
  };
}

/** Real runners. `cwd` defaults to process.cwd(); git is invoked with `-C`. */
function realRunners(projectDir: string): ReconcileRunners {
  const gitBin = spawnRunner('git');
  return {
    // Pin git to the project dir so the verb reconciles the right worktree.
    git: (args: string[]) => gitBin(['-C', projectDir, ...args]),
    gh: spawnRunner('gh'),
  };
}

// ─── Core reconciliation (pure over injected runners) ────────────────────────

/**
 * One claimed SHA matches a real log SHA when either is a prefix of the other
 * (claimed short hash vs full log hash, or vice versa). Case-insensitive.
 */
function shaMatches(claimed: string, realFull: string): boolean {
  const a = claimed.toLowerCase();
  const b = realFull.toLowerCase();
  return b.startsWith(a) || a.startsWith(b);
}

/**
 * Reject a branch value that could smuggle a flag into a git/gh argv. A value
 * beginning with `-` is the classic argument-injection vector — for `git
 * ls-remote` it reaches `--upload-pack=<cmd>` (remote command execution), and for
 * `git log` a `--all` would make EVERY repo commit "verified", defeating this
 * verb's own fail-closed purpose. Defense-in-depth alongside the
 * `--end-of-options` separators below: any value that reaches a runner is a plain
 * ref token. Enforced inside `reconcileReport` so unit-tested callers are guarded
 * too, not only the CLI handler.
 */
function assertSafeBranch(branch: string): void {
  if (!branch || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)) {
    throw new GSDError(
      `report.reconcile: unsafe branch name ${JSON.stringify(branch)} — must match /^[A-Za-z0-9][A-Za-z0-9._/-]*$/ (no leading '-', no argv-flag smuggling)`,
      ErrorClassification.Validation,
    );
  }
}

/**
 * Reconcile an executor's believed state against ground truth.
 *
 * Pure over the injected runners — no global state, no network of its own. The
 * verdict is fail-closed: any failed ground-truth check, any claimed-but-
 * unconfirmed push/PR, or any phantom SHA forces `ok: false`.
 */
export function reconcileReport(input: ReconcileInput, runners: ReconcileRunners): ReconcileResult {
  const { branch, claimedShas, claimedPushed, claimedPr } = input;
  assertSafeBranch(branch);
  const discrepancies: string[] = [];

  // ── 1. SHA ground truth: `git log --format=%H <branch>` ──
  const logResult = runners.git(['log', '--format=%H', '--end-of-options', branch]);
  let shasVerified = false;
  let verifiedShas: string[] = [];
  if (logResult.exitCode !== 0) {
    // Cannot establish ground truth — never confirm against an unknown log.
    discrepancies.push(
      `cannot read ground truth: \`git log --format=%H ${branch}\` failed (${logResult.stderr || 'non-zero exit'})`,
    );
  } else {
    const realShas = logResult.stdout.split('\n').map(s => s.trim()).filter(Boolean);
    verifiedShas = claimedShas.filter(c => realShas.some(real => shaMatches(c, real)));
    const phantomShas = claimedShas.filter(c => !realShas.some(real => shaMatches(c, real)));
    for (const phantom of phantomShas) {
      discrepancies.push(`claimed SHA ${phantom} is NOT in \`git log\` for ${branch} (phantom — rolled back or never committed)`);
    }
    // All claimed SHAs accounted for (and at least the claim set is non-empty
    // or trivially satisfied) ⇒ SHAs verified.
    shasVerified = phantomShas.length === 0;
  }

  // ── 2. Push ground truth: `git ls-remote --heads origin <branch>` ──
  const lsRemote = runners.git(['ls-remote', '--heads', '--end-of-options', 'origin', branch]);
  let pushed = false;
  let remoteSha: string | null = null;
  if (lsRemote.exitCode === 0 && lsRemote.stdout.trim() !== '') {
    pushed = true;
    // Output: "<sha>\trefs/heads/<branch>". Capture the SHA column.
    remoteSha = lsRemote.stdout.split(/\s+/)[0] || null;
  }
  if (claimedPushed && !pushed) {
    discrepancies.push(`claimed the branch was pushed, but \`git ls-remote --heads origin ${branch}\` shows no remote ref (NOT pushed)`);
  }

  // ── 3. PR ground truth: `gh pr list --head <branch> --json number,url` ──
  // The source of truth for "is there a PR for THIS branch", NOT `gh pr view`
  // (which can read an unrelated pre-existing PR).
  const prList = runners.gh(['pr', 'list', '--head', branch, '--json', 'number,url']);
  let pr: ReconciledPr | null = null;
  if (prList.exitCode === 0 && prList.stdout.trim() !== '') {
    try {
      const parsed = JSON.parse(prList.stdout) as Array<{ number?: number; url?: string }>;
      const first = parsed.find(p => typeof p.number === 'number' && typeof p.url === 'string');
      if (first) pr = { number: first.number as number, url: first.url as string };
    } catch {
      discrepancies.push(`could not parse \`gh pr list --head ${branch}\` output as JSON`);
    }
  }
  if (claimedPr && claimedPr.trim() !== '') {
    if (!pr) {
      discrepancies.push(`claimed PR ${claimedPr}, but \`gh pr list --head ${branch}\` returns no PR for this branch (phantom — likely read from an unrelated \`gh pr view\`)`);
    } else if (!prClaimMatches(claimedPr, pr)) {
      discrepancies.push(`claimed PR ${claimedPr}, but the PR for ${branch} is #${pr.number} (${pr.url})`);
    }
  }

  const ok = discrepancies.length === 0 && shasVerified;

  return { branch, ok, shasVerified, verifiedShas, pushed, remoteSha, pr, discrepancies };
}

/** A claimed PR (a number like "42" or a URL) matches the confirmed PR. */
function prClaimMatches(claimed: string, pr: ReconciledPr): boolean {
  const c = claimed.trim();
  if (c === String(pr.number) || c === `#${pr.number}`) return true;
  if (c === pr.url) return true;
  // A URL ending in /pull/<number>.
  const m = c.match(/\/pull\/(\d+)\b/);
  if (m && Number(m[1]) === pr.number) return true;
  return false;
}

// ─── Arg parsing ─────────────────────────────────────────────────────────────

/** Pull the value following `--flag` from argv, or undefined. */
function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1 || i + 1 >= args.length) return undefined;
  const v = args[i + 1];
  return v.startsWith('--') ? undefined : v;
}

// ─── Query handler ───────────────────────────────────────────────────────────

/**
 * report.reconcile — `gsd-sdk query report.reconcile --branch <b> --claimed-shas a,b,c [--claimed-pushed] [--claimed-pr <n|url>]`
 *
 * Returns the {@link ReconcileResult}. Callers (the executor before SUMMARY/PR)
 * MUST treat `ok: false` as "report the failure, not a success", and write only
 * `verifiedShas` / the confirmed `pr.url` into the summary.
 */
export const reportReconcile: QueryHandler = async (args, projectDir) => {
  const branch = flagValue(args, '--branch');
  if (!branch) {
    throw new GSDError(
      'report.reconcile requires --branch <name>',
      ErrorClassification.Validation,
    );
  }
  const claimedShasRaw = flagValue(args, '--claimed-shas');
  const claimedShas = claimedShasRaw
    ? claimedShasRaw.split(',').map(s => s.trim()).filter(Boolean)
    : [];
  const claimedPushed = args.includes('--claimed-pushed');
  const claimedPr = flagValue(args, '--claimed-pr');

  const result = reconcileReport(
    { branch, claimedShas, claimedPushed, claimedPr },
    realRunners(projectDir),
  );
  return { data: result };
};
