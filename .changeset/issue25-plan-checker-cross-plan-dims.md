---
type: Changed
pr: 0
---

**Plan-checker cross-plan validation: data-contract ordering, canary/allowlist invariant, and a planner author-time fixture-label collision check (part of #25, gaps 6/7/8).** Two new cross-plan `gsd-plan-checker` dimensions (siblings of Dimension 9) — **9a Cross-Plan Data-Contract Ordering** flags a BLOCKER when a plan asserts against shared data (fixture/allowlist/golden/snapshot) that a later plan by wave/`depends_on` is the one to produce/commit, and **9b Canary/Negative-Test Allowlist Invariant** flags a BLOCKER when a later plan allowlists a target an existing refusal/deferral canary asserts is refused (silently inverting it to passing-by-accident). Both are wired into the `gsd-plan-check-fanout` cross-plan RUN list. The `gsd-planner` prompt gains an author-time rule to grep the live target test/fixture file before assigning any fixture label, numeric range, double-letter anchor, or test anchor, so it never silently reuses a label already in use.

<!-- docs-exempt: prompt-only changes to agent/workflow .md and the fan-out workflow JS; no user-facing config key, CLI surface, or feature flag added -->
