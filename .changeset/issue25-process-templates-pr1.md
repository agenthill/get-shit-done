---
type: Changed
pr: TBD
---
<!-- docs-exempt: prompt-template changes only — no user-facing API or SDK surface changed -->
**Process-template hardening (PR-1 of issue #25, gaps 1/2/3/5/9):** Five directive additions to agent/command prompt files.

- **Gap 1 (hermetic tests):** `tdd.md` — "No live network/RPC" rule: network-client tasks must mock at the client boundary, run file-scoped, and carry an explicit timeout. `gsd-planner.md` Nyquist Rule references tdd.md for hermetic/env rules.
- **Gap 2 (one-turn contract):** `gsd-executor.md` — `<turn_contract>` block: executor is NOT re-invoked after ending its turn; complete all waves in one turn, run tests foreground with explicit timeout, commit progress and report if work can't finish. Mirrored in `execute-phase.md` `<parallel_execution>` and `execute-plan.md` Pattern A.
- **Gap 3 (ENV-mode forcing):** `tdd.md` — "Deterministic ENV-mode forcing" rule: tests must override ENV-resolved mode/flag in `beforeEach`/`afterEach`, not rely on ambient defaults (prevents CI-flip divergence).
- **Gap 5 (verify-after-Write):** `gsd-executor.md` step 0b-verify: after each Edit/Write in worktree mode, verify file landed inside the worktree. `worktree-path-safety.md` — adds Post-Edit/Write verification section and Parent stray-file check section (advisory: warn+record, not a hard halt).
- **Gap 9 (.output mtime):** `execute-phase.md` stall-surveillance — `.output` mtime is NOT a liveness signal; authoritative liveness = new git commits + worktree FILE mtimes. Parallel notes added to `autonomous.md` and `execute-parallel.md`.
