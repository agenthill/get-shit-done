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
