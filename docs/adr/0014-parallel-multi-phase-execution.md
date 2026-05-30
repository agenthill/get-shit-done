# ADR 0014 — Parallel Multi-Phase Execution

- **Status:** Proposed
- **Date:** 2026-05-30
- **Scope:** `/gsd-execute-parallel` command + SDK `runParallel` engine — a cross-phase concurrency layer over the ADR 0013 worktree engine
- **Related:** `docs/adr/0013-dynamic-workflow-parallelization.md` (parent), issue #13, `sdk/src/query/conflict-graph.ts` (gap 1, shipped in #14), `sdk/src/execution-engine.ts`, `sdk/src/index.ts` (`GSD.run`), `sdk/src/query/phase-depends-on.ts`, `sdk/src/query/rollback-engine.ts`

> Companion implementation plan: `.plans/parallel-multi-phase-execution.md`.

## TL;DR

GSD parallelizes *plans within one phase* (ADR 0013) but executes *phases* strictly sequentially — `GSD.run` is a `while` loop over `currentPhases[0]`. When N independent backlog phases touch disjoint file sets, they can instead run concurrently, each through its own research→plan→execute→PR lifecycle in an isolated worktree, draining the backlog in parallel wall-clock time rather than sum-of-phases. This ADR lifts the proven plan-level engine (worktree manager, semaphore, merge serializer, file-overlap DAG) up one level to phases, scheduled by the `conflict-graph` verb (issue #13 gap 1, shipped in #14).

The execution model is **parallel within a wave, sequential across waves**. The conflict-graph guarantees within-wave phases are hard-disjoint in `files_modified`; that invariant makes a mid-wave failure naturally isolated and reduces cross-phase rollback to the *existing* sequential logic at wave boundaries — dissolving the hardest design surface (parallel rollback under a non-total promote order).

## Context

### What ADR 0013 built, and what it deferred

ADR 0013 shipped a per-**plan** parallel execution engine with verified worktree isolation on the Agent-tool and SDK surfaces:

- `GitWorktreeManager` — one linked worktree per plan; branch `worktree-agent-<phase>-<id>`; reap on completion.
- `Semaphore` + `resolveConcurrencyCap` → `min(16, cores−2)`.
- `buildPlanDag` (`sharesFile` → serialization edges) — the file-overlap DAG at *plan* granularity.
- `GitMergeSerializer` + guard suite — single-writer merge to protected.
- `GSD.run` (#9) — the autonomous cross-phase loop with per-phase checkpoint and Tier-1/Tier-2 rollback — but **strictly sequential**: `while (currentPhases.length) { run currentPhases[0]; re-discover }`.

ADR 0013 D5 deferred the cross-phase *pipeline*; #9 resolved the *sequential* autonomous case. This ADR resolves the *parallel* cross-phase case.

### Issue #13's two gaps

1. **Conflict-graph scheduling** from `files_modified` — **shipped** as `gsd-sdk query conflict-graph <phase...>` (#14): unions each phase's PLAN.md `files_modified`, builds the phase×phase overlap graph, classifies overlaps **soft** (ROADMAP/STATE/registry hotspots — trivial merge) vs **hard**, and partitions phases into concurrency waves via greedy coloring on the hard subgraph.
2. **Parallel orchestrator + async dispatch** — this ADR.

## Decision

A new `/gsd-execute-parallel <phase...>` command, backed by a new SDK entrypoint (`GSD.runParallel`) that reuses `GSD.run`'s phase-runner / checkpoint / rollback primitives and the ADR 0013 SDK worktree engine. Gated behind `git.sdk_worktree_execution` + Claude runtime, like the existing engine.

### D1 — Execution model: parallel within waves, sequential across waves

1. `conflict-graph <phase...>` → `waves[]`.
2. Per wave (a sequential barrier): fan out one worktree phase-agent per phase, each on an integration branch forked off the **wave base SHA**, running its plans through the existing intra-phase engine.
3. On green test+verify, each phase pushes its branch, opens **its own PR**, which the orchestrator **auto-merges (admin) on green** — promotes serialized in wave order.
4. Wave N+1 starts only after wave N settles.

### D2 — Single-writer ledgers lifted to wave scope

The orchestrator is the sole writer of `ROADMAP.md` / `STATE.md` across every phase in a wave (ADR 0013 D2 lifted from phase to wave scope). Within-wave phases are hard-disjoint in every *other* file by the conflict-graph guarantee, so the only shared writes are these soft-conflict ledgers, which the orchestrator serializes — no concurrent co-write race.

### D3 — Per-phase base SHA

Replace the global `LAST_GOOD` assumption with a per-phase base SHA captured at wave start. Promotes are serialized by the merge mechanism (ordered PR auto-merges), so the "did *this* promote move protected HEAD" detection (`phase-runner.ts`) keeps holding under concurrent execution + ordered promotion. A later-promoting sibling rebases trivially (only soft ledger conflicts, since hard files are disjoint).

### D4 — Failure isolation: continue independents, skip dependents

When a phase exhausts its retry/rollback budget, its never-promoted integration branch is discarded (clean Tier-1, fully isolated by disjointness). Its wave-siblings finish and promote. Only later phases in the failed phase's `depends_on` closure (`phase-depends-on.ts`) are skipped; unrelated later waves proceed. Across-wave failures use the existing sequential Tier-1/Tier-2 rollback unchanged at wave boundaries.

### D5 — Nested global agent budget

Add `parallelization.phase_level` + `parallelization.max_concurrent_phases`, enforced as a sub-budget of ONE global agent semaphore (total `min(16, cores−2)`) shared across phase + plan dispatch, so N phases × M plans cannot oversubscribe CPU/API.

### D6 — PR-per-phase as the promotion + audit vehicle

On a branch-protected repo, "promote" is realized as push-branch → open PR → orchestrator admin-merge on green. Each phase therefore lands as its own reviewable, per-feature PR (issue #13's explicit want), and that PR is simultaneously the merge mechanism. Auto-merges are serialized (ordered) to preserve the single-writer property.

## Consequences

**Positive**

- Independent backlogs drain in ~max(phase) wall-clock, not sum-of-phases.
- `files_modified` frontmatter becomes load-bearing — the conflict-graph consumes what already exists.
- Reuses nearly all proven ADR 0013 machinery; the net-new surface is small and bounded (D1 wave loop, D3 per-phase base SHA, D6 PR-per-phase).
- Per-feature PRs preserved; failure isolation guaranteed by the disjointness invariant, not by best-effort cleanup.

**Negative / residual risk**

- Per-phase base SHA (D3) and wave-scoped sole-writer (D2) are net-new invariants the guard suite must enforce; a defect here risks ledger corruption under concurrency. Mitigated by D2 serialization and the integration harness below.
- Auto-merge-on-green removes the human review gate for promotion — the chosen autonomy trade-off; test+verify is the sole gate.
- Conflict-graph soft/hard classification is now safety-relevant: misclassifying a hard conflict as soft could co-schedule genuinely conflicting phases. The hotspot allowlist is deliberately conservative (ROADMAP.md / STATE.md / registry append points only).

## Measure of success (falsifiable)

An integration harness over phases with known `files_modified` asserts: three hard-disjoint phases run concurrently and all three PRs auto-merge; a phase sharing a non-hotspot file is provably scheduled to a later wave; an injected failure in one phase leaves siblings merged and only its `depends_on` dependents skipped; `ROADMAP.md` / `STATE.md` stay uncorrupted under concurrency; wall-clock ≈ max(phase), not sum.

## Alternatives considered

- **Advisor-only** (surface the schedule; operator runs phases by hand) — rejected: barely more than the shipped conflict-graph verb; no GSD-native worktree/PR orchestration.
- **`--parallel` flag on `/gsd-autonomous`** as the primary surface — rejected: inherits the sequential milestone loop and its total-promote-order rollback assumptions; a distinct command reusing `GSD.run` internals is cleaner.
- **Single integration branch + one batch PR** — rejected: loses the per-feature review #13 explicitly wants.
- **Fully-general parallel Tier-2 attribution** (concurrent promotes onto shared files with cross-phase blame) — rejected for v1: the disjointness invariant makes it unnecessary within a wave, and across waves the sequential logic suffices. Revisit only if soft-conflict concurrent co-writes are ever allowed.
- **Interactive Agent-tool engine** as the substrate — deferred: the SDK engine is the lower-risk reuse target (headless, git-direct, proven); a parity interactive engine can follow per ADR 0013 D4's dual-engine pattern.

## Implementation phasing

- **Chunk A** — phase-level conflict-graph → wave executor with auto-promote (PR-per-phase + serialized auto-merge); happy path + disjointness isolation; no advanced rollback.
- **Chunk B** — per-phase base SHA (D3) + across-wave Tier-1/Tier-2 rollback reuse + skip-dependents (D4).
- **Chunk C** — nested global agent budget (D5) + `parallelization.phase_level` config + `/gsd-execute-parallel` command surface & docs.
