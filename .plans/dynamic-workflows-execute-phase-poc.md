# Implementation Plan — `execute-phase` Dynamic-Workflow POC

- **ADR:** `docs/adr/0013-dynamic-workflow-parallelization.md`
- **Branch:** `feat/dynamic-workflows-execute-phase`
- **Goal:** prove the fork-off-predecessor DAG protocol on `execute-phase`, across both surfaces, with the metaframework intact and the win measured.

## Build order

The order is risk-first: validate the one assumption the whole design rests on **before** writing any production dispatch code.

### Task 0 — De-risk probe: worktree-branch persistence (BLOCKING)

The protocol assumes a `isolation:'worktree'` agent's commits land on a **named branch that survives the agent's completion** and is reachable by a sibling agent via sha/branch in the shared object store.

- **Probe:** a throwaway workflow spawns agent P1 (`isolation:'worktree'`) that creates `worktree-agent-probe`, commits a file, returns its `head_sha`. Then spawns P2 (`isolation:'worktree'`) that runs `git cat-file -e <P1.head_sha>` and `git reset --hard <P1.head_sha>` and reports whether the file is present.
- **Pass:** P2 sees P1's commit → fork-off-predecessor is viable on the markdown surface.
- **Fail:** the harness discards worktree commits on cleanup → markdown surface falls back to the SDK-style git-direct path (executor returns a patch/bundle the orchestrator applies), and the ADR is updated. **Do not proceed to Task 2 until this resolves.**
- Also confirm: `agent({agentType:'gsd-executor'})` resolves the installed GSD agent, `model` override works, and `schema` forces the `ExecutorReturn` shape.

### Task 1 — Shared DAG spec + run-spec builder (`bin/lib/`)

- Extend `phase-plan-index` / add a `dag-runspec` query that emits the reduced incomplete-plan DAG: nodes, **direct** `depends_on` edges (not levels), `files_modified` serialization edges, `expectedBase`, per-plan model, `has_summary` exclusions. Reuse `phase.cjs` Kahn pass but **keep the edge set**.
- Unit tests: edge preservation, serialization-edge insertion on file overlap, has_summary pruning, cycle abort.

### Task 2 — Markdown surface: `gsd-execute-phase-dag.js` + slash-command rewire

- Ship `.claude/workflows/gsd-execute-phase-dag.js` per the ADR JS sketch (promise-per-plan gate, `agent({agentType:'gsd-executor', isolation:'worktree', schema})`, `WorkflowVerdict` return).
- Rewrite `workflows/execute-phase.md` `execute_waves` into the **shell**: pre-flight → `Workflow({name, args})` → consume verdict → per-plan topo integration (reuse the existing serial-merge guard block verbatim) → batched per-level gate → `STATE`/`ROADMAP` writes → interactive gates → manifest cleanup.
- Template `EXPECTED_BASE` = predecessor `head_sha`; multi-predecessor merge instruction in the executor prompt.
- Keep the sequential fallback (`SEQUENTIAL_FORCE`, codex FATAL) intact.

### Task 3 — SDK surface: `phase-runner.ts` `runExecuteStep`

- Replace `for(waves)+Promise.allSettled` with the memoized-promise DAG + `Semaphore(cap)` + worktree-per-plan + `MergeSerializer`.
- **Decouple per-plan merge from the per-level batched build+test gate** (the determining fix).
- `WaveTracker` for synthetic `WaveStart`/`WaveComplete`; additive disposition field; unchanged `PhaseStepResult` shape.
- Keep `allSettled` failure-isolation, cost aggregation, `parallelization===false` fast-path, idempotent gap-closure.

### Task 4 — Tests: correctness falsifiers + wall-clock harness

- **Invariant falsifiers** (the real gate): per-plan-delta guards see one plan; bulk-delete revert never discards an ancestor; dependent worktree contains predecessor commits; undeclared cross-chain file collision is caught; resume skips `has_summary`; failure isolates dependents while independent chains finish.
- **Wall-clock harness:** fixture DAG (`A→B→C` + `D`,`E`) with a stubbed test-dominated gate; assert `makespan(new) < makespan(old)`; assert it does **not** regress under the test-dominated case (the SDK reviewer's explicit falsifier).
- Run the full existing `sdk` suite green (`phase-runner.test.ts`, event-stream, e2e).

### Task 5 — Changeset + ADR status → Accepted; PR (stop at PR-opened for review)

## Out of scope for the POC (rollout follow-ups)

Post-execution verification fan-out · `plan-phase` per-plan planner fan-out · `map-codebase`/`code-review` dimension fan-out · `autonomous` cross-phase pipeline (needs the rollback protocol from ADR §D5).

## Open questions for review

1. **Doc home** — ADR + `.plans/` here, or does GSD want this tracked through its own `.planning/` dogfood loop?
2. **Workflow-tool availability gate** — confirm the markdown surface should hard-gate on Claude Code runtime + Workflow-tool presence, falling back to today's path elsewhere.
3. **Peak worktree ceiling** — cap in-flight dispatch below a worktree count, or prune-predecessor-on-last-successor-fork, or both?
