---
type: Changed
pr: 27
---
<!-- docs-exempt: prompt-template changes only — no user-facing API or SDK surface changed -->
**Research external-encoding contracts (part of issue #25, gaps 4/10/11):** Hardens the RESEARCH phase against silently-wrong external encodings and un-shippable returned artifacts. Domain-agnostic principle; Anchor discriminators / IDL anchor-version / bridge v0-tx are canonical examples only.

- **Gap 4 (pin encodings, never recompute):** `gsd-phase-researcher.md` — new Step 2.7 "External Encoding & Returned-Artifact Contracts" probe plus an `## External Encoding Contracts` output-template section. Research captures the EXACT emitted bytes/selectors FROM the SDK's own codegen/IDL output, tagged `[VERIFIED]` with the codegen source, rather than re-deriving them.
- **Gap 10 (artifact version/toolchain):** Same probe + section record the codegen/toolchain version embedded in any fetched IDL/ABI/schema and flag a host-vs-artifact mismatch; derived encodings are pinned from the artifact's own codegen, never recomputed under the host toolchain.
- **Gap 11 (probe returned artifact; typed-refusal fallback):** Research probes the shape/version of any artifact an external system RETURNS before designing around it; when the returned shape is incompatible with a FROZEN/invariant binding, the plan designs a conservative typed-refusal so the direction ships as an explicit honest refusal.
- **Enforcement:** `gsd-plan-checker.md` Dimension 11 (research_resolution) gains an External Encoding Contracts sub-check — BLOCKER if a plan recomputes an encoding the research pinned (must consume the pinned `[VERIFIED]` value) or leaves a frozen-binding-incompatible returned artifact without a typed-refusal design. Dimension 7b (scope reduction) carves a narrow, explicit exception so a documented typed-refusal is a SANCTIONED outcome — gated on the research having pinned the incompatibility via the `[VERIFIED]` returned-shape probe (the trust source), so it cannot be abused as a generic scope escape.
- `gsd-planner.md` consumes the pinned contracts verbatim (compact pointer — never recompute; design the named typed-refusal).
