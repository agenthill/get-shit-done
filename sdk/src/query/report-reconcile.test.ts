/**
 * Unit tests for report.reconcile — fail-closed ground-truth reconciliation
 * of an executor's self-reported state before it writes SUMMARY.md / a PR body.
 *
 * Issue #18: a gsd-executor run reported PHANTOM commit SHAs (rolled back, gone
 * from `git log`), claimed a push that never happened, and cited a PR number it
 * read from an UNRELATED `gh pr view`. This verb derives the real state from
 * ground truth and REFUSES to confirm a success report when believed ≠ actual.
 *
 * The `git` / `gh` runners are injected so every assertion checks the exact argv
 * the reconciler issues — no real network, no real repo.
 */

import { describe, it, expect } from 'vitest';
import { reconcileReport, type ReconcileRunners } from './report-reconcile.js';

// ─── Runner doubles ──────────────────────────────────────────────────────────

interface Call {
  bin: 'git' | 'gh';
  args: string[];
}

/**
 * Build injectable runners that record every argv and reply from a fixture map.
 * `gitReplies` / `ghReplies` map a `join(' ')` argv key to a runner result.
 * A missing key returns a non-zero exit (the command "failed"), which is the
 * realistic ground-truth signal for "ref/PR does not exist".
 */
function makeRunners(opts: {
  gitReplies?: Record<string, { exitCode?: number; stdout?: string; stderr?: string }>;
  ghReplies?: Record<string, { exitCode?: number; stdout?: string; stderr?: string }>;
}): { runners: ReconcileRunners; calls: Call[] } {
  const calls: Call[] = [];
  const reply =
    (bin: 'git' | 'gh', table: Record<string, { exitCode?: number; stdout?: string; stderr?: string }>) =>
    (args: string[]) => {
      calls.push({ bin, args });
      const key = args.join(' ');
      const hit = table[key];
      if (!hit) return { exitCode: 1, stdout: '', stderr: `no fixture for: ${bin} ${key}` };
      return { exitCode: hit.exitCode ?? 0, stdout: hit.stdout ?? '', stderr: hit.stderr ?? '' };
    };
  const runners: ReconcileRunners = {
    git: reply('git', opts.gitReplies ?? {}),
    gh: reply('gh', opts.ghReplies ?? {}),
  };
  return { runners, calls };
}

const BRANCH = 'fix/issue-18-executor-serialize-verify';
// Real commits that exist on the branch's `git log` in the happy path.
const REAL_SHAS = ['9ffa652aaaa', 'd96b763bbbb', '9eb5122cccc'];
const GIT_LOG_KEY = `log --format=%H ${BRANCH}`;
const LS_REMOTE_KEY = `ls-remote --heads origin ${BRANCH}`;
const GH_PR_KEY = `pr list --head ${BRANCH} --json number,url`;

// ─── Falsifier 1: phantom SHA (claimed, not in git log) ───────────────────────

describe('reconcileReport — phantom SHA detection (#18 falsifier 1)', () => {
  it('refuses the success claim and does NOT echo a phantom SHA', () => {
    // Claimed includes a phantom SHA (4f1f389…) that is NOT in the real log.
    const { runners, calls } = makeRunners({
      gitReplies: {
        [GIT_LOG_KEY]: { stdout: REAL_SHAS.join('\n') },
        [LS_REMOTE_KEY]: { stdout: `${REAL_SHAS[0]}\trefs/heads/${BRANCH}` },
      },
      ghReplies: {},
    });

    const result = reconcileReport(
      { branch: BRANCH, claimedShas: ['9ffa652', '4f1f389'] },
      runners,
    );

    // Fail-closed: a phantom claim must not produce a success verdict.
    expect(result.ok).toBe(false);
    // The phantom SHA must NOT appear in verified output.
    expect(result.verifiedShas).toContain('9ffa652');
    expect(result.verifiedShas).not.toContain('4f1f389');
    // It must be surfaced as a discrepancy referencing the phantom value.
    expect(result.discrepancies.some(d => d.includes('4f1f389'))).toBe(true);

    // Exact argv assertion: the reconciler read ground truth from git log.
    expect(calls).toContainEqual({ bin: 'git', args: ['log', '--format=%H', BRANCH] });
  });

  it('confirms every claimed SHA when all exist in the log', () => {
    const { runners } = makeRunners({
      gitReplies: {
        [GIT_LOG_KEY]: { stdout: REAL_SHAS.join('\n') },
        [LS_REMOTE_KEY]: { stdout: `${REAL_SHAS[0]}\trefs/heads/${BRANCH}` },
      },
      ghReplies: { [GH_PR_KEY]: { stdout: '[]' } },
    });

    const result = reconcileReport(
      { branch: BRANCH, claimedShas: ['9ffa652', 'd96b763', '9eb5122'] },
      runners,
    );

    expect(result.shasVerified).toBe(true);
    expect(result.verifiedShas).toEqual(['9ffa652', 'd96b763', '9eb5122']);
    expect(result.discrepancies).toEqual([]);
  });
});

// ─── Falsifier 2: unpushed branch ─────────────────────────────────────────────

describe('reconcileReport — push confirmation (#18 falsifier 2)', () => {
  it('reports pushed:false for a branch with no remote ref (never a phantom "pushed")', () => {
    // ls-remote has NO fixture → exit 1 + empty stdout = ref absent.
    const { runners, calls } = makeRunners({
      gitReplies: {
        [GIT_LOG_KEY]: { stdout: REAL_SHAS.join('\n') },
      },
    });

    const result = reconcileReport(
      { branch: BRANCH, claimedShas: ['9ffa652'], claimedPushed: true },
      runners,
    );

    expect(result.pushed).toBe(false);
    expect(result.remoteSha).toBeNull();
    // A claimed push that isn't real is fail-closed.
    expect(result.ok).toBe(false);
    expect(result.discrepancies.some(d => /push/i.test(d))).toBe(true);

    // Exact argv: push is confirmed via ls-remote against origin, not in-memory.
    expect(calls).toContainEqual({ bin: 'git', args: ['ls-remote', '--heads', 'origin', BRANCH] });
  });

  it('reports pushed:true with the remote SHA when the ref exists', () => {
    const { runners } = makeRunners({
      gitReplies: {
        [GIT_LOG_KEY]: { stdout: REAL_SHAS.join('\n') },
        [LS_REMOTE_KEY]: { stdout: `${REAL_SHAS[0]}\trefs/heads/${BRANCH}` },
      },
    });

    const result = reconcileReport(
      { branch: BRANCH, claimedShas: ['9ffa652'], claimedPushed: true },
      runners,
    );

    expect(result.pushed).toBe(true);
    expect(result.remoteSha).toBe(REAL_SHAS[0]);
  });
});

// ─── Falsifier 3: no PR for the branch ────────────────────────────────────────

describe('reconcileReport — PR confirmation (#18 falsifier 3)', () => {
  it('returns pr:null for a branch with no PR (never a number from an unrelated PR)', () => {
    // The executor "believed" PR #999 (read from an unrelated `gh pr view`).
    // `gh pr list --head <branch>` is the source of truth and returns [].
    const { runners, calls } = makeRunners({
      gitReplies: {
        [GIT_LOG_KEY]: { stdout: REAL_SHAS.join('\n') },
        [LS_REMOTE_KEY]: { stdout: `${REAL_SHAS[0]}\trefs/heads/${BRANCH}` },
      },
      ghReplies: { [GH_PR_KEY]: { stdout: '[]' } },
    });

    const result = reconcileReport(
      { branch: BRANCH, claimedShas: ['9ffa652'], claimedPr: '999' },
      runners,
    );

    expect(result.pr).toBeNull();
    expect(result.ok).toBe(false);
    // The phantom PR number must surface as a discrepancy and never be echoed
    // back as a confirmed PR.
    expect(result.discrepancies.some(d => d.includes('999'))).toBe(true);

    // Exact argv: PR confirmation goes through `gh pr list --head <branch>`,
    // NOT `gh pr view`.
    expect(calls).toContainEqual({ bin: 'gh', args: ['pr', 'list', '--head', BRANCH, '--json', 'number,url'] });
    expect(calls.every(c => !(c.bin === 'gh' && c.args[1] === 'view'))).toBe(true);
  });

  it('captures the real PR url/number returned by gh pr list --head', () => {
    const { runners } = makeRunners({
      gitReplies: {
        [GIT_LOG_KEY]: { stdout: REAL_SHAS.join('\n') },
        [LS_REMOTE_KEY]: { stdout: `${REAL_SHAS[0]}\trefs/heads/${BRANCH}` },
      },
      ghReplies: {
        [GH_PR_KEY]: {
          stdout: JSON.stringify([
            { number: 42, url: `https://github.com/agenthill/get-shit-done-in-workflow/pull/42` },
          ]),
        },
      },
    });

    const result = reconcileReport(
      { branch: BRANCH, claimedShas: ['9ffa652'], claimedPr: '42' },
      runners,
    );

    expect(result.pr).not.toBeNull();
    expect(result.pr?.number).toBe(42);
    expect(result.pr?.url).toBe('https://github.com/agenthill/get-shit-done-in-workflow/pull/42');
    expect(result.discrepancies).toEqual([]);
  });
});

// ─── Whole-report fail-closed verdict ─────────────────────────────────────────

describe('reconcileReport — composite verdict', () => {
  it('ok:true only when SHAs verified and no claimed-but-unconfirmed push/PR', () => {
    const { runners } = makeRunners({
      gitReplies: {
        [GIT_LOG_KEY]: { stdout: REAL_SHAS.join('\n') },
        [LS_REMOTE_KEY]: { stdout: `${REAL_SHAS[0]}\trefs/heads/${BRANCH}` },
      },
      ghReplies: {
        [GH_PR_KEY]: {
          stdout: JSON.stringify([{ number: 42, url: 'https://example.test/pull/42' }]),
        },
      },
    });

    const result = reconcileReport(
      { branch: BRANCH, claimedShas: ['9ffa652', 'd96b763'], claimedPushed: true, claimedPr: '42' },
      runners,
    );

    expect(result.ok).toBe(true);
    expect(result.shasVerified).toBe(true);
    expect(result.pushed).toBe(true);
    expect(result.pr?.number).toBe(42);
    expect(result.discrepancies).toEqual([]);
  });

  it('refuses when git log itself fails (cannot establish ground truth)', () => {
    // No git log fixture → exit 1. Without ground truth we must NOT confirm.
    const { runners } = makeRunners({ gitReplies: {} });

    const result = reconcileReport(
      { branch: BRANCH, claimedShas: ['9ffa652'] },
      runners,
    );

    expect(result.ok).toBe(false);
    expect(result.shasVerified).toBe(false);
    expect(result.discrepancies.some(d => /ground truth|git log/i.test(d))).toBe(true);
  });
});
