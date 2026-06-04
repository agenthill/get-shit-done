---
type: Added
pr: 29
---
**Auto-determination checkpoint (`resolution="auto"`) + the `workflow.unattended` flag (#25, gap 12).** A background / UNATTENDED run no longer hangs forever on a human checkpoint nobody is present to answer.

`resolution="auto"` is an attribute on an existing NON-security checkpoint (`checkpoint:human-verify` / `checkpoint:human-action`), mirroring how `gate="blocking-human"` is an attribute rather than a new type. Its two-branch contract: (a) resolve deterministically when an optional `<resolver>` criterion is available (fires in any mode — a machine-answerable check is not really a human checkpoint); (b) else, **only** when the run is unattended, take the declared conservative `<fallback>` (safe/refusal) branch and continue. A `resolution="auto"` task with no `<fallback>` is invalid.

The trust source is a NEW dedicated `workflow.unattended` boolean (default `false`), **distinct from `auto_advance`** — it is the operator's affirmation that NO human is reachable for the run. Auto-resolution fires only when `unattended === true`, so interactive and interactive-autonomous runs are unchanged (they still pause for humans; zero hang-risk regression). `check.auto-mode` now surfaces `unattended` and `human_reachable` so the executor and the execute-phase orchestrator gate the resolve-then-fallback path on a single resolver-derived signal rather than proxying `auto_advance`.

`gate="blocking-human"` auth/security checkpoints are excluded: they HALT and defer to end-of-phase human UAT even when `unattended` is `true` (a halt is the correct safe branch for an auth/security gate). Documented in `docs/CONFIGURATION.md` and the Checkpoints Reference `<auto_determination>` contract. (#29)
