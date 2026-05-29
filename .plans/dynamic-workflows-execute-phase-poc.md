# Implementation Plan — `execute-phase` Dynamic-Workflow POC

- **ADR:** `docs/adr/0013-dynamic-workflow-parallelization.md`
- **Branch:** `feat/dynamic-workflows-execute-phase`
- **Goal:** prove the fork-off-predecessor DAG protocol on `execute-phase`, across both execution engines (Agent-tool + SDK) plus the read-only post-execution fan-out as a dynamic workflow, with the metaframework intact and the win measured.

## Build order

Risk-first: the load-bearing assumption was validated before any production code (Task 0). Engine split is set by Task 0 — **execution → Agent-tool/SDK; read-only fan-out → Workflow tool.**

### Task 0 — De-risk probes ✅ DONE

Three probes ran (see ADR §"Validation findings"):
- ✅ **Commit persistence:** a commit in one worktree is reachable from a sibling by sha; `reset --hard` reproduces it → fork-off-predecessor git mechanism sound.
- ❌ **Workflow tool `agent({isolation:'worktree'})`:** no-op (agents land in the main repo) → execution cannot run inside a workflow here.
- ✅ **Agent tool `isolation:"worktree"`:** real fresh worktree on a `worktree-agent-*` branch → execution runs on the Agent tool (interactive) and the SDK.

Outcome: **reshaped** the engine choice (see ADR Status). A generic probe agent without GSD's `<worktree_branch_check>` caused a recoverable `reset --hard` on the feature branch — recovered fully; production `gsd-executor` fails closed and would not.

### Task 1 — Shared DAG run-spec builder (`bin/lib/`)

- Add a `dag-runspec` query (alongside `phase-plan-index`) emitting the reduced incomplete-plan DAG: nodes, **direct** `depends_on` edges (not levels), `files_modified` serialization edges, `expectedBase`, per-plan model, `has_summary` exclusions. Reuse the `phase.cjs` Kahn pass but **keep the edge set** (today it is discarded after computing the integer level).
- Unit tests: edge preservation, serialization-edge insertion on file overlap, `has_summary` pruning + satisfied-predecessor treatment, cycle abort. Consumed by **both** engines.

### Task 2 — Interactive execution engine: `execute-phase.md` `execute_waves` → Agent-tool DAG dispatch

- Rewrite `execute_waves` to dispatch the DAG's **ready-set** as `Agent(subagent_type:'gsd-executor', isolation:"worktree", model?)` calls — **multiple in one message** (the Agent tool serializes worktree creation internally; remove today's one-`Agent()`-per-message stagger), gated on each plan's direct `depends_on` (+ serialization edges), not on whole-wave barriers.
- Template `EXPECTED_BASE` = predecessor `head_sha`; multi-predecessor → merge predecessor branches in-worktree.
- Orchestrator post: per-plan topological integration (reuse the existing serial-merge guard block **verbatim**, single-plan deltas) → **batched per-level** build+test gate → `STATE`/`ROADMAP` writes on green → interactive gates → manifest cleanup.
- Keep the sequential fallback intact (`parallelization=false` / codex FATAL / no-Agent-tool runtime).

### Task 3 — SDK execution engine: `phase-runner.ts` `runExecuteStep`

- Replace `for(waves)+Promise.allSettled` with the memoized-promise DAG + `Semaphore(cap=min(16,cores−2))` + worktree-per-plan + `MergeSerializer`.
- **Decouple per-plan merge from the per-level batched build+test gate** (the determining fix — per-plan gating is slower than today under a test-dominated suite).
- `WaveTracker` for synthetic `WaveStart`/`WaveComplete`; additive disposition field; unchanged `PhaseStepResult` shape; keep `allSettled` failure-isolation, cost aggregation, `parallelization===false` fast-path, idempotent gap-closure.

### Task 4 — Read-only fan-out workflow: `dynamic-workflows/gsd-verify-fanout.js` (the dynamic-workflow POC)

- Tracked source at `dynamic-workflows/gsd-verify-fanout.js` (NOT `.claude/workflows/` — that's the gitignored install destination). Correct Workflow module form: `export const meta` literal + top-level body using ambient `agent`/`parallel`/`phase`/`log`/`args` + a top-level `return` verdict (NOT a default-exported function).
- `parallel()` the 5 independent, read-only gates: static goal verify ∥ code review ∥ prior-phase regression ∥ schema-drift ∥ codebase-drift — collapsing the serial chain from **sum → max**. **Hardened for collision-safety:** exactly ONE branch runs a test process (regression over prior phases — the current suite was already gated per-level in Task 2); every branch returns findings and writes nothing (orchestrator owns all writes). Returns `{ status, gaps[], human_verification[], per_gate[] }`.
- `execute-phase.md` post_execution_fanout shell: `Workflow({name:'gsd-verify-fanout', args})` → consume verdict → preserve schema-drift BLOCK → run `human_needed`/`gaps_found` interactive gates → `update_roadmap` on passed/approved. Falls back to the verbatim serial chain when the Workflow tool is unavailable.
- `node --check` passes; correct-form markers verified. **Install residual:** `bin/install.js` must copy `dynamic-workflows/*.js` → `.claude/workflows/` for Claude-Code installs (deferred — see ADR Consequences).

### Task 5 — Tests: correctness falsifiers + wall-clock harness

- **Invariant falsifiers** (the real gate): per-plan-delta guards see one plan; bulk-delete revert never discards an ancestor; dependent worktree contains predecessor commits; undeclared cross-chain file collision is caught; resume skips `has_summary`; failure isolates dependents while independent chains finish.
- **Wall-clock harness:** fixture DAG (`A→B→C` + `D`,`E`) with a stubbed **test-dominated** gate; assert `makespan(new) < makespan(old)` and **no regression** under the test-dominated case (the explicit falsifier). Separately assert the read-only fan-out collapses sum → max.
- Full existing `sdk` suite green (`phase-runner.test.ts`, event-stream, e2e).

### Task 6 — Changeset + PR (stop at PR-opened for review)

## Out of scope for the POC (rollout follow-ups)

`plan-phase` per-plan planner fan-out · `map-codebase`/`code-review` dimension fan-out · `autonomous` cross-phase pipeline (needs the rollback protocol from ADR §D5).

## Open questions — awaiting your specs

You chose to specify these (rather than take my defaults). Bind at Task 1+:

1. **Doc home** — ADR + `.plans/` here, or route through GSD's own `.planning/` dogfood loop?
2. **Runtime gate** — confirm: read-only fan-out hard-gates on Claude Code + Workflow-tool presence; execution hard-gates on Agent-tool/SDK worktree isolation; non-Claude runtimes keep today's sequential path?
3. **Peak worktree ceiling** — cap in-flight dispatch below a worktree count, prune-predecessor-on-last-successor-fork, or both?
