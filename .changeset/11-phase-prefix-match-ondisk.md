---
type: Changed
pr: 0
---
**`phase.add`, `phase.insert`, `phase.add-batch`, `phase.scaffold`, and the first-touch directory computation in `init.plan-phase` / `init.discuss-phase` now match the phase-directory naming convention already on disk instead of applying the `project_code` prefix unconditionally.** When a project's existing phase dirs are bare (`NN-slug`), a new phase stays bare even if `project_code` is set; when existing dirs are already prefixed (`<code>-NN-slug`), new phases stay prefixed; with no existing phase dirs (greenfield / first phase) the legacy behavior is preserved (prefix iff `project_code` is set). A shared `resolvePhasePrefix(dirNames, projectCode)` policy helper centralizes the decision. This stops projects that adopt `project_code` mid-stream from silently producing a mixed `NN-slug` + `<code>-NN-slug` layout. (#11)
