---
name: gsd:execute-parallel
description: Run N independent backlog phases concurrently in conflict-graph waves
argument-hint: "<phase...>   # e.g. 43 44 45"
allowed-tools:
  - Read
  - Write
  - Bash
  - Glob
  - Grep
  - AskUserQuestion
  - Agent
requires: [phase, progress]
---
<objective>
Execute N named backlog phases in parallel concurrency waves (ADR 0014). Schedules the phases with `gsd-sdk query conflict-graph <phase...>` so within-wave phases are hard-disjoint in `files_modified`, then fans out one phase-agent per wave member through the standard research→plan→execute→verify lifecycle in an isolated worktree. Each green phase promotes as its own auto-merged PR; promotes are serialized in wave order. Wave N+1 starts only after wave N settles.

Gated by `git.sdk_worktree_execution` + Claude runtime + `parallelization.phase_level: true`. When a phase exhausts its retry budget, its siblings finish and only its `depends_on` dependents are skipped.

**Creates/Updates:**
- `.planning/STATE.md` / `.planning/ROADMAP.md` — orchestrator is the sole writer across the wave (D2)
- One PR per green phase (D6)
- `.planning/.phase-manifest.json`, `.planning/ROLLBACK.json` — promotion + rollback ledgers

**After:** The scheduled phases are merged (or cleanly rolled back), each as its own per-feature PR.
</objective>

<context>
Args: two or more phase tokens (`43 44 45`). Requires `git.sdk_worktree_execution: true`, `parallelization.phase_level: true`, and a branch-protected remote for PR-per-phase auto-merge. With fewer than two phases the conflict-graph verb errors; use `/gsd-execute-phase` for a single phase.
</context>

<process>
Resolve config + runtime gate, then invoke `GSD.runParallel(<phases>)`. Surface the per-wave schedule and each phase's PR url. Preserve all workflow gates (checkpoint, Tier-1/Tier-2 rollback, skip-dependents).

**Liveness:** A spawned phase-agent's `.output` mtime can freeze while the agent is still alive. Authoritative liveness = new git commits on the agent's branch/worktree + worktree FILE mtimes. Never `TaskStop` on a stale `.output` mtime alone — confirm via worktree file mtimes and/or a non-destructive probe first.
</process>
