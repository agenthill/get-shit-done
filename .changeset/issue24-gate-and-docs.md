---
type: Fixed
pr: 30
---

fix(sdk): enforce phase_level gate in runParallel + document raw-worktree divergence + refresh M1 hints (issue #24 items 2-4)

**Item 2 (gate):** `resolvePhaseLevelParallelism` was defined and unit-tested but never called in production. `GSD.runParallel` now checks the flag immediately after `loadConfig` and throws fail-closed if `parallelization.phase_level` is not `true`. The three integration test `setupRepo` helpers are updated to write the opt-in config so all ~18 existing callers continue passing. A new rejection test (gate falsifier) verifies the throw.

**Item 3 (doc):** Added a concise comment above `createPhaseWorktree` in `sdk/src/index.ts` documenting why this path intentionally uses raw `git worktree --detach` rather than `execution-engine.ts GitWorktreeManager` (branch-centric, no mutex, no commondir retry). Notes #24 item 3 as the consolidation follow-up. No functional change.

**Item 4 (cosmetic):** Replaced stale raw line-number hints in the M1 D3 and D2 NOTE comments with stable `it()` description anchors so the cross-references cannot silently rot.
