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
    const git = vi.fn(async (args: string[]) => {
      calls.push(['git', ...args]);
      return '';
    });

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
