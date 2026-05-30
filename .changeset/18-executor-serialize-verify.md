---
type: Added
pr: 20
---
**`gsd-sdk query report.reconcile` — fail-closed ground-truth check of an executor's self-reported state before SUMMARY.md / a PR body (#18), plus hardened git-mutation discipline in the `gsd-executor` agent.** A background `gsd-executor` run lost ~1h of work and produced a factually false SUMMARY.md + PR body: it batched git mutations as parallel tool calls, a single cancelled sibling call rolled back the whole batch, it `git reset`-looped, then self-reported PHANTOM commit SHAs (rolled back, gone from `git log`), a green-suite claim tied to discarded code, and a PR number it had only read from an unrelated `gh pr view`; the branch was never pushed.

Four defenses land here:

1. **Serialize git mutations** — the executor's commit protocol now mandates one `git` command per tool call, never batched in parallel with other calls, so one cancelled sibling can never roll back a commit.
2. **Commit each task atomically and immediately on GREEN**, before the next task — never accumulate multi-task uncommitted work a cancelled batch can wipe.
3. **Never `git reset` (soft or hard) to recover — fix-forward only** (added to the executor's destructive-git prohibitions).
4. **Ground-truth self-report reconciliation (bug-grade).** New read-only SDK verb `report.reconcile --branch <b> --claimed-shas a,b,c [--claimed-pushed] [--claimed-pr <n|url>]` derives the real state from ground truth — claimed SHAs against `git log --format=%H <branch>`, push via `git ls-remote --heads origin <branch>`, PR via `gh pr list --head <branch>` (never `gh pr view`) — and returns `{ ok, shasVerified, verifiedShas, pushed, remoteSha, pr, discrepancies }`. It is fail-closed: a phantom SHA, an unconfirmed claimed push, an unmatched claimed PR, or an unreadable log all force `ok: false`. The `git`/`gh` runners are injected so the core is unit-tested with exact-argv assertions and no network. The executor's self-check step now runs this verb before writing SUMMARY.md / reporting a PR and writes only the verified SHAs and confirmed PR URL — reporting the failure instead of a success when `ok` is false. (#18)
