# get-shit-done-in-workflow — project instructions

Dynamic-workflow fork of the GSD toolkit. The TypeScript SDK is under `sdk/` (ESM, `tsc` build, vitest `unit` + `integration` projects).

## Merge gate (no CI)
- No GitHub Actions CI — the merge gate is local tests + review. Build (`cd sdk && npm run build`) and run the relevant vitest project before merging.
- Branch protection requires a review → merge with `gh pr merge <N> --admin --squash --delete-branch`.
- Run tests file- or project-scoped with a `timeout`; never an unfiltered full `npx vitest run` (a single hanging test blocks the whole run with no signal).

## Known pre-existing test failures (NOT regressions)
- Unit: `milestone-runner.test.ts` (×3), `golden/golden-policy.test.ts` (1), `runtime-bridge-sync/index.test.ts` (1).
- Integration: golden/parity `gsd-tools.cjs` shell-projection failures when run inside a git worktree (path resolution).
- Reproduce on the PR base before attributing any failure to your change.

## Changesets
- Each PR needs a `.changeset/*.md` with `type:` (Added/Fixed/Changed) and `pr:` (PR number). An `Added` type trips the docs-required lint — add `<!-- docs-exempt: ... -->` if docs land separately.
