// gsd-verify-fanout — read-only post-execution verification fan-out (ADR 0013, Task 4).
//
// Replaces execute-phase's serial post-execution gate chain (code review →
// regression → schema-drift → codebase-drift → goal verification) with a single
// parallel() fan-out, collapsing it from sum → max wall-clock. Invoked by the
// execute-phase orchestrator shell as Workflow({name:'gsd-verify-fanout', args}).
//
// MODULE FORM: this is a dynamic-Workflow script, NOT a default-exported function.
// `export const meta` first (pure literal), then a top-level async body that uses
// the ambient globals `args`, `agent`, `parallel`, `phase`, `log`. The script's
// final `return` value is the workflow result handed back to the orchestrator.
//
// HARD CONSTRAINTS (Workflow tool):
//   - No fs/git/bash/clock/randomness in the SCRIPT — it only spawns agents (which
//     do every read) and composes parallel(). It cannot call AskUserQuestion.
//   - READ-ONLY: every branch returns findings; the orchestrator owns ALL writes
//     (VERIFICATION.md / STATE.md / ROADMAP.md) and ALL interaction. No worktree
//     isolation is needed because nothing here mutates the tree.
//   - COLLISION-SAFETY: exactly ONE branch runs a test process (regression over
//     prior phases — the current-phase suite was already gated per-level in
//     execute_waves). No two branches write the same report file. So the fan-out
//     is safe to run concurrently against the single shared working tree.

export const meta = {
  name: 'gsd-verify-fanout',
  description:
    'Read-only post-execution verification fan-out: static goal verification, code review, prior-phase regression, schema-drift and codebase-drift detection run concurrently; returns one schema-forced verdict for the orchestrator to act on interactively.',
  phases: [{ title: 'verify', detail: 'fan out read-only post-execution gates' }],
};

// Shared per-gate return schema. needs_user_decision is the sentinel that routes a
// gate to the orchestrator's interactive layer (the workflow never prompts).
const gateSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'findings'],
  properties: {
    status: { type: 'string', enum: ['passed', 'gaps_found', 'human_needed', 'error'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        required: ['detail'],
        properties: {
          detail: { type: 'string' },
          severity: { type: 'string', enum: ['info', 'warn', 'gap', 'blocking'] },
          file: { type: 'string' },
        },
      },
    },
    needs_user_decision: {
      type: 'object',
      additionalProperties: true,
      required: ['kind', 'detail'],
      properties: {
        kind: { type: 'string', enum: ['human_verify', 'decision', 'blocking'] },
        detail: { type: 'string' },
      },
    },
    human_verification: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        required: ['item'],
        properties: { item: { type: 'string' }, expected: { type: 'string' } },
      },
    },
  },
};

const a = args || {};
const ctx = [
  `Phase: ${a.phase_number}`,
  `Phase directory: ${a.phase_dir}`,
  a.phase_goal ? `Phase goal: ${a.phase_goal}` : '',
  a.phase_req_ids ? `Requirement IDs: ${a.phase_req_ids}` : '',
  a.response_language ? `response_language: ${a.response_language}` : '',
  '',
  'READ-ONLY GATE. Read files and RETURN findings via the schema. Do NOT write,',
  'create, commit, or mutate ANY file (no VERIFICATION.md / REVIEW.md / codebase',
  'docs) — the orchestrator owns all writes. Run no git-mutating commands.',
].filter(Boolean).join('\n');

phase('verify');
log(`gsd-verify-fanout: 5 read-only gates for phase ${a.phase_number}`);

// One parallel() barrier. Each branch is independent and read-only; exactly one
// (regression) runs a test process, so concurrent execution is collision-free.
const results = await parallel([
  // 1. Static goal verification — goal-backward, NO test run (the per-level gate
  //    in execute_waves already exercised the current-phase suite).
  () => agent(
    `${ctx}\n\nStatically verify the phase GOAL was achieved (not just that tasks ran).\n` +
      `Cross-reference must_haves + requirement IDs against the actual codebase and the\n` +
      `phase SUMMARY.md / PLAN.md. Do NOT run the test suite (already gated) and do NOT\n` +
      `write VERIFICATION.md. If items genuinely require a human to exercise the running\n` +
      `system, return status:"human_needed" + human_verification[] (item + expected). If a\n` +
      `must_have is unmet, status:"gaps_found" with one finding per gap. Else status:"passed".`,
    { agentType: 'gsd-verifier', schema: gateSchema, label: 'static-verify' },
  ),

  // 2. Code review of the phase's source changes (advisory).
  () => agent(
    `${ctx}\n\nReview the source files changed during this phase for bugs, security issues,\n` +
      `and code-quality problems. Advisory. Do NOT write REVIEW.md — return findings.\n` +
      `status:"passed" when clean, else status:"gaps_found" (one finding per issue:\n` +
      `severity + file + detail).`,
    { agentType: 'gsd-code-reviewer', schema: gateSchema, label: 'code-review' },
  ),

  // 3. Regression — the ONLY test-running branch. Runs PRIOR phases' suites (distinct
  //    from the current-phase per-level gate) to catch cross-phase regressions.
  () => agent(
    `${ctx}\n\nRun PRIOR phases' test suites to catch cross-phase regressions from this\n` +
      `phase. ` +
      (a.regression_files ? `Prior-phase test files: ${a.regression_files}\n` : '') +
      (a.prior_phase ? `Most recent prior phase: ${a.prior_phase}\n` : '') +
      `Report pass/fail only — do NOT fix code. status:"passed" when no regressions;\n` +
      `status:"gaps_found" with the regressed tests as findings.`,
    { agentType: 'gsd-verifier', schema: gateSchema, label: 'regression' },
  ),

  // 4. Schema-drift — BLOCKING when drift is found (handshake encoded for the shell).
  () => agent(
    `${ctx}\n\nDetect schema drift: schema-relevant files changed this phase with no DB push\n` +
      `executed (build/types pass from config, not the live DB → false-positive PASS).\n` +
      `Read-only. If drift is detected, status:"human_needed" with\n` +
      `needs_user_decision:{kind:"blocking", detail:<schema files, ORMs needing push, push cmds>}.\n` +
      `If no drift, status:"passed".`,
    { agentType: 'gsd-verifier', schema: gateSchema, label: 'schema-drift' },
  ),

  // 5. Codebase-drift — structural, non-blocking by contract. Do NOT rewrite the
  //    .planning/codebase docs (that is a separate, orchestrator-driven remap).
  () => agent(
    `${ctx}\n\nDetect structural / codebase drift introduced by this phase. Non-blocking:\n` +
      `surface findings ONLY; do NOT regenerate the .planning/codebase docs. status:"passed"\n` +
      `when no actionable drift, else status:"gaps_found" with findings; never block on this.`,
    { agentType: 'gsd-codebase-mapper', schema: gateSchema, label: 'codebase-drift' },
  ),
]);

const [staticVerify, codeReview, regression, schemaDrift, codebaseDrift] = results;
const per_gate = [
  { gate: 'static-verify', ...gateResult(staticVerify) },
  { gate: 'code-review', ...gateResult(codeReview) },
  { gate: 'regression', ...gateResult(regression) },
  { gate: 'schema-drift', ...gateResult(schemaDrift) },
  { gate: 'codebase-drift', ...gateResult(codebaseDrift) },
];

const gaps = [];
const human_verification = [];
for (const g of per_gate) {
  // codebase-drift is non-blocking by contract: its findings are surfaced but
  // never become phase-failing gaps.
  if (g.status === 'gaps_found' && g.gate !== 'codebase-drift') {
    for (const f of g.findings || []) gaps.push({ gate: g.gate, ...f });
  }
  for (const hv of g.human_verification || []) human_verification.push({ gate: g.gate, ...hv });
  if (g.needs_user_decision) {
    human_verification.push({ gate: g.gate, item: g.needs_user_decision.detail, kind: g.needs_user_decision.kind });
  }
}

const anyHuman = per_gate.some((g) => g.status === 'human_needed' || g.needs_user_decision);
const status = anyHuman ? 'human_needed' : gaps.length > 0 ? 'gaps_found' : 'passed';
log(`gsd-verify-fanout: verdict=${status} gaps=${gaps.length} human=${human_verification.length}`);

return { status, gaps, human_verification, per_gate };

// Normalize an agent return (or a null from a failed parallel() thunk) into the
// per_gate shape — never throws, so one flaky gate cannot sink the fan-out.
function gateResult(ret) {
  if (!ret || typeof ret !== 'object') {
    return { status: 'error', findings: [{ detail: 'gate returned no result' }] };
  }
  return {
    status: ret.status || 'error',
    findings: Array.isArray(ret.findings) ? ret.findings : [],
    ...(ret.needs_user_decision ? { needs_user_decision: ret.needs_user_decision } : {}),
    ...(Array.isArray(ret.human_verification) ? { human_verification: ret.human_verification } : {}),
  };
}
