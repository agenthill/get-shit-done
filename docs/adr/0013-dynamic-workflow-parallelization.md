# ADR 0013 — Dynamic-Workflow Parallelization of GSD Execution

- **Status:** Proposed (awaiting review)
- **Date:** 2026-05-29
- **Scope:** `execute-phase` proof-of-concept (markdown surface + SDK surface); rollout template for the rest
- **Related:** `references/model-profiles.md`, `workflows/execute-phase.md`, `sdk/src/phase-runner.ts`, `3524-cjs-sdk-hard-seam.md`

> Companion implementation plan: `.plans/dynamic-workflows-execute-phase-poc.md`.

## TL;DR

GSD's quality (`max`) mode is slow for a structural reason, not a model-choice one: execution fans out through an **LLM orchestrator reasoning turn-by-turn**, gated by **coarse wave-level barriers** that are strictly cruder than the real per-plan dependency DAG. We replace the dispatch layer with **deterministic dynamic-workflow scripts** that express the *true* `depends_on` DAG, so independent chains run concurrently and a dependent plan starts the instant its predecessor's commits exist — never at a whole-level barrier. The GSD metaframework (gates, atomic commits, `STATE.md` single-writer, verifiers, worktree safety) is **preserved unchanged**: agents are called as-is via `agentType`; only *who schedules them* changes.

The chosen protocol — **fork-off-predecessor + per-plan topological integration + per-level batched test gate** — survived an adversarial design review that killed two plausible alternatives. The proof-of-concept lands on `execute-phase` across both execution surfaces; the same pattern then templates to verification, `plan-phase`, `map-codebase`/`code-review`, and (later, with a rollback protocol) the cross-phase `autonomous` pipeline.

## Context

### Two execution surfaces, one duplicated wave engine

| Surface | What runs | Concurrency today |
|---|---|---|
| **Markdown orchestration** (`/gsd:execute-phase`, `plan-phase`, `autonomous`…) | An LLM orchestrator reads ~1,800-line prompts and emits `Agent(subagent_type=…)` calls | Fan-out *reasoned* by the model each turn. In `max` mode every wave boundary, overlap check, and spot-check is an Opus orchestrator turn — the dominant tax |
| **TS SDK** (`sdk/src/phase-runner.ts`) | Real in-code `Promise.allSettled` over a wave | Concurrent but **no cap, no worktree isolation**; headless/`gsd-sdk auto` only |

The two surfaces are independent (neither calls the other) and hand-maintain the same wave/isolation logic, which drifts.

### The structural bottlenecks (from the subsystem characterization)

1. **Wave barriers are coarser than the DAG.** Waves are Kahn topological *levels* — `phase.cjs` computes the precise `depends_on` edge set, then **discards it** for integer bucketing. A level-2 plan depending on one level-0 plan still waits for *all* of level-1 to finish, merge, build, and test.
2. **Serialized worktree creation.** Within a parallel wave, `Agent()` calls are hand-staggered one-per-message to dodge a `.git/config.lock` race on concurrent `git worktree add`.
3. **M serial build+test cycles** (one per wave) plus a **serial merge loop**.
4. **Fully serial post-execution gate chain** (code-review → regression → schema-drift → codebase-drift → verify) — all read-only and independent.
5. **`plan-phase` is 100% sequential** — a monolithic planner authors every `PLAN.md` in one agent; the revision loop re-checks all plans.
6. **`autonomous`** wraps two sequential layers (K phases × serial stages) around the one parallel layer.

### The Workflow tool — capability and hard constraints

A dynamic **Workflow** is a JS script the orchestrator launches in the **background**. It enables deterministic fan-out via `pipeline()` (no barrier between stages — per-item flow), `parallel()` (barrier), and `agent({agentType, isolation:'worktree', model, schema})`, with a concurrency cap of `min(16, cores−2)`.

Three constraints shape the entire design:

- **No filesystem, git, bash, or clock/randomness of its own.** Every side effect (git merge, worktree ops, `gsd-sdk query`) happens **inside a spawned agent** or **back in the orchestrator** — never in the workflow script.
- **No `AskUserQuestion`.** A workflow cannot prompt the user mid-run.
- **Concurrency-capped and background.** It returns structured data to the orchestrator; it is not interactive.

## Decision

### D1 — Ship versioned, named workflow scripts (not LLM-generated inline scripts)

GSD ships `.claude/workflows/gsd-execute-phase-dag.js` (etc.) as **tested, version-controlled artifacts**. The slash command becomes a thin interactive shell that calls `Workflow({name, args: <resolved JSON>})`. Rejected alternative: orchestrator-generated inline scripts — nondeterministic, untestable, and they re-introduce the per-turn LLM-reasoning tax we are removing.

### D2 — Orchestrator owns interaction + single-writer side effects; workflow owns non-interactive fan-out

Every reader of every subsystem converged on this split, and the Workflow constraints force it:

- **Orchestrator (the slash-command shell):** pre-flight (`gsd-sdk query`, gates, DAG build, model resolution), **all** `AskUserQuestion` interaction, **all** git merges to the protected branch, and **all** `STATE.md`/`ROADMAP.md` writes (single-writer).
- **Workflow (background):** the non-interactive fan-out — scheduling executor agents over the true DAG — and returns a **schema-forced verdict object**.
- **Handshake:** when the workflow hits something needing the user (stall, conflict, checkpoint, `human_needed`), it **encodes it into the verdict and returns early** — it never blocks. The orchestrator runs `AskUserQuestion` and resumes via `resumeFromRunId` (already-OK plans return cached) or a fresh workflow over the unblocked sub-DAG.

### D3 — Protocol: fork-off-predecessor + per-plan topological integration + per-level batched test gate

This is the load-bearing decision; §"The DAG protocol" specifies it and §"Rejected protocols" records why the alternatives are unsound.

- **Fork-off-predecessor:** a dependent plan's executor, as step 0 in its harness-created worktree, sets its base to its direct predecessor's branch tip via the executor's *existing* `git reset --hard {EXPECTED_BASE}` step (we template `EXPECTED_BASE` = predecessor `head_sha`). Worktrees share one object store, so a sibling's commit sha is reachable. Multi-predecessor (diamond) plans `git merge` the additional predecessor branches into their own `worktree-agent-*` branch (legal — they stay in their own namespace). **No mid-run merge to the protected branch; no integration branch; no orchestrator callback.**
- **Per-plan topological integration:** after the workflow returns, the orchestrator (single writer) merges each plan's **own commit delta** onto the protected branch in topo order, so every existing merge guard sees a **single-plan delta** — exactly today's semantics.
- **Per-level batched test gate:** the expensive build+test gate runs at **level boundaries**, not per plan-merge. This is the single change that determines whether the design is a net win (see §Measure of success).

### D4 — Both surfaces share one spec

The markdown surface (Workflow tool, side effects in agents) and the SDK surface (`phase-runner.ts`, git-direct TS) implement the *same* DAG/integration/gating spec. The SDK additionally gets a `Semaphore(cap)`, worktree isolation (it has none today), and a `MergeSerializer` single-writer mutex — while keeping `PhaseStepResult`'s shape byte-compatible and emitting synthetic `WaveStart`/`WaveComplete` at level boundaries so the event-stream tests stay green.

### D5 — Aggressive *within-phase* DAG now; cross-phase pipeline deferred

The within-phase per-plan DAG is the prize and is safe. Cross-phase pipelining (overlapping independent phases in `autonomous`) carries a **state-rollback hazard** — a `human_needed`/conflict gate on phase N firing after N+1 has forked orphans commits. It moves to a later milestone with its own phase-level `depends_on` metadata, a rollback protocol, and a rule that barriers phase N's interactive gates before N+1 forks.

## The DAG protocol — markdown surface

### Stages

**Orchestrator pre-flight** (slash-command shell, has git):
1. `gsd-sdk query init.execute-phase` + `phase-plan-index` → `plans[]` with the **true** `depends_on[]`, computed wave, `files_modified[]`, `has_summary`, `autonomous`. Cycle detection already ran in `phase.cjs` (inv 8) — abort on a cycle warning.
2. Resolve gates the workflow cannot: `parallelization===false` → `SEQUENTIAL_FORCE`; `runtime=codex && use_worktrees!=false` → **FATAL** (inv 12); resolve `executor_model`, omit when `inherit` (inv 13); `safe_resume`, blocking-antipattern, stall/checkpoint config.
3. Filter `has_summary:true` out of the dispatch set (inv 10) but **keep them in the DAG as already-integrated predecessors** (their commits are already on the protected branch, so a dependent of a skipped plan needs no rebase for that edge).
4. Build the reduced DAG over incomplete plans; add a **serialization edge** between any two plans sharing a `files_modified` entry that are not already `depends_on`-ordered (inv 9). Persist a run-spec JSON; reap orphan worktrees (inv 7).

**Workflow** (`execute-phase-dag.js`, background, no git/fs):
5. One memoized `Promise` per plan. A plan's gate `await`s all direct-predecessor promises (each resolves with `{branch, head_sha, worktree_path}`). **No wave barrier.**
6. On gate release, dispatch `agent(prompt, {agentType:'gsd-executor', isolation:'worktree', model?, schema:ExecutorReturn, label, phase})`. The prompt injects each predecessor's `{branch, head_sha}` and sets `EXPECTED_BASE`.
7. The executor runs `execute-plan.md` **unchanged**: step 0 asserts HEAD ∈ `worktree-agent-*` (inv 5), `reset --hard` to the predecessor tip (or merges multiple predecessor branches in-worktree); then atomic per-task commits with hooks (inv 1), writes + commits `SUMMARY.md` before returning (inv 4), never touches `STATE.md`/`ROADMAP.md` (inv 2). Returns `ExecutorReturn`.
8. The plan's promise resolves with `ExecutorReturn` — dependents unblock the instant it returns. A non-OK return **rejects** the promise, propagating `blocked-by-ancestor` to transitive dependents while independent chains keep running. Worktrees/branches are **not** removed (descendants and final integration read from them).
9. The workflow returns `WorkflowVerdict`.

**Orchestrator post** (single writer, has git):
10. If `needs_user_decision` present → `AskUserQuestion` (inv 14), then resume the unblocked sub-DAG.
11. Else perform **per-plan topological integration**: for each plan in `integration_order`, merge its **own delta** onto the protected branch behind the full guard suite (deletion-diff, >5-file bulk-delete revert, `STATE`/`ROADMAP` restore, resurrected-file — inv 6). Because each branch already contains its ancestors, a descendant after its ancestor is a fast-forward-or-trivial merge.
12. Run the build+test gate **batched per level**. Mark a plan complete and write `STATE.md`/`ROADMAP.md` only for plans on the protected branch with `TEST_EXIT==0` (timeout 124 = inconclusive, not pass — inv 3). Manifest-scoped cleanup (inv 7). Interactive gates surface here.

### Worked example — `A→B→C` chain + `D` independent

`files_modified`: A,B,C all touch `src/api.ts`; D touches `src/ui.tsx`. Base = protected-branch HEAD `S0`.

- A and D gates open immediately. A's executor forks a worktree off `S0` → `wt-A`, commits `a1,a2,SUMMARY-A`, returns `head_sha=Wa`. D forks off `S0` → `wt-D`, returns `Wd`. **A and D execute concurrently.**
- A's promise resolves → B's gate opens. B's executor `reset --hard Wa` (its worktree now sits on A's tip, containing `a1,a2`), commits `b1,SUMMARY-B`, returns `Wb`. Then C `reset --hard Wb` → C transitively contains A+B. **The chain advances at executor speed, not at a level barrier; D never blocks it.**
- Orchestrator post: topo order `[A, B, C, D]`. Merge A's delta, then B's delta (merge-base = A's merged tip → single-plan delta), then C's, then D's — every guard sees one plan. Batched test gate. `STATE` writes for the green set.

Today's model would serialize: wave-0 `{A,D}` → barrier+merge+build+test → wave-1 `{B}` → barrier+merge+build+test → wave-2 `{C}`. The new model overlaps D with the whole A→B→C chain and removes the inter-wave build+test cycles, collapsing makespan toward `critical-path(chain) + batched gate`.

### JS sketch (`execute-phase-dag.js`)

```js
// input: runSpec {plans, edges, serialEdges, expectedBase, meta}. No fs/git/clock.
const { plans, predsOf, model, schema } = prepare(runSpec); // predsOf = direct deps + serial-edge peers
const ready = new Map();   // plan_id -> Promise<ExecutorReturn>

function runPlan(p) {
  const gate = Promise.all(predsOf(p.id).map(d => ready.get(d)));   // true DAG gate, NOT a wave barrier
  return gate.then(predReturns => {
    const prompt = buildExecutorPrompt(p, predReturns, runSpec.expectedBase); // injects pred {branch,head_sha}
    return agent(prompt, { agentType: 'gsd-executor', isolation: 'worktree',
      ...(model ? { model } : {}), schema, label: p.id, phase: p.wave });      // inv 13: omit when inherit
  }).then(ret => { if (ret.status !== 'ok') throw { plan_id: p.id, ...ret }; return ret; });
}
for (const p of plans) ready.set(p.id, null);              // wire promises before awaiting
for (const p of plans) ready.set(p.id, runPlan(p));        // per-item, no parallel() barrier
const settled = await Promise.allSettled(plans.map(p => ready.get(p.id)));
return buildVerdict(plans, settled, runSpec);              // leaves, blocked, conflicts, integration_order
```

### Handshake contract

```
ExecutorReturn (agent schema): { plan_id, status:'ok'|'conflict'|'stall'|'self_check_failed'|'timeout'|'hook_failed',
  branch, head_sha, worktree_path, summary_committed, predecessors_integrated:[{plan_id,head_sha,method:'reset'|'merge'}],
  conflict?:{against_plan_id, files[]}, detail? }

WorkflowVerdict (workflow return): { run_id, completed[], leaves:[{plan_id,branch,head_sha,worktree_path}],
  integration_order:[branch], blocked:[{plan_id,blocked_by}], stalled[], conflicts[],
  manifest_path, needs_user_decision?:{kind:'stall'|'conflict'|'checkpoint'|'human_verify', plan_id, detail} }
```

**Resume:** dispatch keys on `plan_id + summary-committed`; branch names are deterministic per `plan_id` within a run, so a resumed run reattaches to surviving `worktree-agent-*` branches instead of forking duplicates. `resumeFromRunId` replays the same run-spec so the DAG topology is stable.

## The DAG protocol — SDK surface (`phase-runner.ts`)

The SDK is git-direct TS, so the integration/guard logic that the markdown surface puts in agents runs as code here:

- Replace `for (waves) { Promise.allSettled }` with one **memoized promise per plan** gated on its pruned `depends_on` predecessors (has_summary preds are satisfied external deps).
- `Semaphore(cap = parallelization===false ? 1 : min(16, cores−2))` bounds in-flight executors (the SDK has no cap today).
- **Worktree-per-plan** (`git worktree add --detach <base>` then `worktree-agent-<phase>-<id>`); the base is the predecessor's exact merged commit — *strict isolation*, not a live integration tip, so a gate failure is attributable to its own closure.
- A `MergeSerializer` (async mutex) is the single-writer stand-in for the orchestrator: it runs the guard suite (inv 6) and marks complete only on `TEST_EXIT===0` (inv 3).
- **Critical fix from review:** the merge and the build+test gate are **decoupled** — per-plan merge unblocks dependents cheaply; the full gate is **batched at level boundaries** (or coalesced when the serializer queue drains), or the design is *slower* than today under a test-dominated suite.
- A `WaveTracker` fires synthetic `WaveStart(L)`/`WaveComplete(L)` at level transitions so event-stream cardinality and `PhaseStepResult` shape stay byte-compatible. Per-plan disposition (`merged`, `testExit`, `skippedReason`) rides in an **additive** field.
- Resume/gap-closure stay idempotent via `has_summary` filtering and re-seeding the integration ref from current HEAD each `runExecuteStep`.

## Rejected protocols (the adversarial findings)

| Approach | Verdict | Why |
|---|---|---|
| **Merge-agents on a shared integration branch** | **Dead (FATAL)** | Git forbids one branch checked out in two worktrees, and the executor's `<worktree_branch_check>` HARD-pins HEAD to `worktree-agent-*`. So merge-agents can be *neither* on `integration` *nor* concurrent. The "lanes parallelize merges" claim is false — there is only one integration checkout. |
| **Leaf-only final integration** (merge only leaf branches) | **CRITICAL data loss** | Reusing per-wave guards on stacked branches: `git reset --hard HEAD~1` bulk-delete revert discards *ancestor* plans' work; three-dot deletion-diff (merge-base `M0`) surfaces every ancestor deletion and strands the chain. **Fixed by per-plan topo integration** (single-plan deltas). |
| **Per-plan build+test gate** (SDK, gate inside the merge mutex) | **Can be slower than today** | Runs P serialized test runs instead of W. **Fixed by batching the gate at level boundaries.** |
| **Cross-phase shared integration ref** (autonomous) | **Deferred** | A `human_needed` gate on phase N after N+1 forked orphans commits; clean per-phase rollback is lost. Needs a rollback protocol — later milestone. |

## Preservation-invariant compliance

| # | Invariant | How the design preserves it |
|---|---|---|
| 1 | Atomic per-task commits with hooks | Executor agent runs `execute-plan.md` unchanged inside its worktree |
| 2 | `STATE.md`/`ROADMAP.md` single-writer (orchestrator, post-green-gate) | Workflow/executors never touch them; only the orchestrator writes, after integration + batched gate |
| 3 | Complete only on `TEST_EXIT==0` (124 = inconclusive) | Batched per-level gate gates completion marking; timeout treated as not-pass |
| 4 | `SUMMARY.md` committed before worktree removal | Executor commits it before returning; cleanup deferred to orchestrator post |
| 5 | HEAD ∈ `worktree-agent-*`; no ref self-recovery | Executor's existing step-0 check is unchanged; base set via `reset --hard {EXPECTED_BASE}` keeps HEAD in namespace |
| 6 | Serial merge guards | Run unchanged in the orchestrator's per-plan topo integration (single-plan deltas) |
| 7 | Manifest-scoped worktree cleanup | Orchestrator post, from `manifest_path`; never broad discovery |
| 8 | Cycle detection | Runs in `phase.cjs` pre-flight; abort before dispatch |
| 9 | `files_modified` overlap safety | Serialization edge added in the DAG between file-colliding plans not already ordered |
| 10 | Resumability (skip `has_summary`) | Filtered from dispatch; kept as satisfied predecessors |
| 11 | `parallelization===false` → sequential | `SEQUENTIAL_FORCE` / `cap=1` topo-ordered path |
| 12 | Runtime fail-closed (no worktree isolation) | Pre-flight FATAL for codex; SDK asserts worktree capability before dispatch |
| 13 | `inherit` → omit `model` param | Pre-flight resolves; `agent({...(model?{model}:{})})` omits it |
| 14 | Interactive gates outside the workflow | Encoded in `needs_user_decision`; orchestrator runs `AskUserQuestion` and resumes |

**Residual risk to validate in the POC:** the protocol relies on a `isolation:'worktree'` agent's commits landing on a **named branch that persists in the shared object store after the agent completes**, reachable by a sibling agent. If the harness discards worktree commits on cleanup, the markdown surface must adopt the SDK-style git-direct path. **This is POC de-risk #1** — see the plan.

## Measure of success

**The construct:** parallelism that cuts wall-clock *without* breaking any invariant.

- **Wall-clock (falsifiable, independent of the change):** on a fixture phase with an uneven multi-chain DAG (e.g. `A→B→C` + independent `D`,`E`) **and a test-dominated gate** (deliberately long suite, fast agents — the case that *falsifies* a naive overlap claim), `makespan(new) < makespan(old)`. The honest predicted win: `critical-path(DAG)·exec + Σ batched-level-gates` vs today's `Σ-levels·exec + Σ-per-level-gates`. The win lives in **execution overlap**, bounded below by the gate — we measure against that, not agent-overlap in isolation.
- **Correctness (the real gate):** the existing `phase-runner` invariant suite stays green, plus new tests that *falsify* the known hazards — per-plan-delta guards see one plan; bulk-delete revert never discards an ancestor; a dependent's worktree contains its predecessor's commits; an undeclared cross-chain file collision is caught (not silently merged).
- **Independence:** wall-clock is measured by the harness, correctness by the test suite — neither is self-reported by the agents under test.

## Rollout template (post-POC)

The orchestrator-shell / background-workflow / schema-verdict split is reusable:

- **Post-execution verification** — `parallel()` the independent read-only gates (static verify, behavioral test run, code-review, regression, drift); collapses sum → max. Lowest risk (read-only).
- **`plan-phase`** — `pipeline(research → pattern-map → plan → check)`; fan out per-plan planners (outline → `parallel()` per-plan); revise only changed plans.
- **`map-codebase` / `code-review`** — dynamic mapper set; review-dimension → verify-finding → fix pipeline.
- **`autonomous` cross-phase** — only after the rollback protocol (D5).

## Consequences

- **Positive:** real concurrency bounded by `min(16,cores−2)`; the worktree-creation race and per-turn LLM-dispatch tax disappear; one shared DAG spec across surfaces; metaframework untouched.
- **Negative / cost:** peak worktree count rises to in-flight plan count (mitigated by removing a predecessor's worktree once all successors have forked, since the branch ref persists); the markdown surface gains a dependency on the Workflow tool (Claude Code runtimes only — non-Claude runtimes keep today's sequential/SDK paths via the runtime gate); two surfaces to keep spec-aligned (mitigated by a shared fixture/contract test).
