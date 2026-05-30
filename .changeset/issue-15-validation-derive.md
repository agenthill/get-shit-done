---
type: Added
pr: 16
---

**`gsd-sdk query validation.derive <phase>` projects the Nyquist validation map from one source of truth** — it parses `RESEARCH.md` § Validation Architecture's `Phase Requirements → Test Map` table and emits a POPULATED `VALIDATION.md` Per-Task Verification Map (Task ID / Requirement / Behavior / Test Type / Command / status) instead of the blank `templates/VALIDATION.md`. Task ids are unknown at derive time, so the Task ID column is stamped `TBD-by-planner` rather than inventing ids. `workflows/plan-phase.md` step 5.5 now calls the verb and falls back to the blank template when no parseable table is present. A companion read-only `validation.check <phase>` asserts the subset chain RESEARCH §Validation behaviors ⊆ VALIDATION rows ⊆ PLAN `<automated>` commands and returns drift as WARNING findings. Closes #15.
