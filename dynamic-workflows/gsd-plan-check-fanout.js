// gsd-plan-check-fanout — read-only pre-execution plan-check fan-out (ADR 0013,
// "Rollout template": plan-phase → fan out the gsd-plan-checker dimensions).
//
// Replaces plan-phase.md's single whole-set gsd-plan-checker agent (step 10) with
// one parallel() over N+1 read-only branches:
//   - one PER-PLAN branch per PLAN.md, running the dimensions that need only that
//     one plan (task completeness, scope, must_haves derivation, context/CLAUDE.md/
//     tier/pattern compliance, scope-reduction, per-task Nyquist presence), and
//   - one CROSS-PLAN branch over the FULL plan set, running the whole-phase
//     dimensions (requirement + decision coverage, dependency graph / cycles,
//     cross-plan data contracts, Wave-0 cross-reference + sampling continuity,
//     research-open-questions resolution, shared-pattern presence).
// Each branch RETURNS findings via schema and WRITES NOTHING; the orchestrator
// aggregates the verdict, drives the revision loop, and owns all writes
// (STATE.md / ROADMAP.md / the plan commit) and all interactive gates. Collapses
// the serial whole-set check from sum → max(slowest-plan-branch, cross-plan).
//
// Plan AUTHORING stays SERIAL on the Agent tool (it writes PLAN.md files — not a
// read-only fan-out). This workflow is the CHECK stage only.
//
// MODULE FORM: dynamic-Workflow script, NOT a default-exported function.
// `export const meta` first (pure literal), then a top-level async body using the
// ambient globals `args`, `agent`, `parallel`, `phase`, `log`. The final `return`
// is the workflow result handed back to the orchestrator.
//
// HARD CONSTRAINTS (Workflow tool):
//   - No fs/git/bash/clock/randomness in the SCRIPT — it only spawns agents (which
//     do every read via Read/Bash/Glob/Grep) and composes parallel(). It cannot
//     AskUserQuestion. Anything needing git/HEAD/clock (head_sha, changed-plan set,
//     response_language) is resolved by the orchestrator pre-flight and passed via args.
//   - READ-ONLY: every branch reads plans + artifacts and RETURNS findings; the
//     orchestrator owns ALL writes. No worktree isolation needed — nothing mutates.
//   - COLLISION-SAFETY: no branch runs a test process, modifies source, or writes a
//     file — gsd-plan-checker is static plan analysis only (tools Read/Bash/Glob/Grep,
//     no Write). So the fan-out is collision-free against the shared working tree.

export const meta = {
  name: 'gsd-plan-check-fanout',
  description:
    'Read-only pre-execution plan-check fan-out: one branch per PLAN.md runs the per-plan dimensions and one cross-plan branch runs the whole-phase dimensions (requirement/decision coverage, dependency graph, cross-plan data contracts, Wave-0 cross-reference, research resolution). Each branch returns BLOCKER/WARNING findings via schema and writes nothing; the orchestrator aggregates the verdict and drives the revision loop.',
  phases: [{ title: 'check', detail: 'fan out read-only plan-check dimensions' }],
};

const planSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['plan_id', 'status', 'findings'],
  properties: {
    plan_id: { type: 'string' },
    status: { type: 'string', enum: ['passed', 'issues_found', 'error'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['dimension', 'severity', 'description'],
        properties: {
          dimension: { type: 'string' },
          severity: { type: 'string', enum: ['blocker', 'warning', 'info'] },
          description: { type: 'string' },
          task: { type: 'string' },
          fix_hint: { type: 'string' },
        },
      },
    },
  },
};

const crossSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'findings'],
  properties: {
    status: { type: 'string', enum: ['passed', 'issues_found', 'error'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['dimension', 'severity', 'description'],
        properties: {
          dimension: { type: 'string' },
          severity: { type: 'string', enum: ['blocker', 'warning', 'info'] },
          description: { type: 'string' },
          plans: { type: 'array', items: { type: 'string' } },
          fix_hint: { type: 'string' },
        },
      },
    },
  },
};

const a = args || {};
const plans = Array.isArray(a.plans) ? a.plans.filter((p) => p && p.path) : [];
const allPlanPaths = Array.isArray(a.all_plan_paths) ? a.all_plan_paths : plans.map((p) => p.path);

const ctx = [
  `Phase: ${a.phase_number}`,
  `Phase directory: ${a.phase_dir}`,
  a.phase_goal ? `Phase goal: ${a.phase_goal}` : '',
  a.phase_req_ids ? `Phase requirement IDs (MUST all be covered): ${a.phase_req_ids}` : '',
  a.roadmap_path ? `Roadmap: ${a.roadmap_path}` : '',
  a.requirements_path ? `Requirements: ${a.requirements_path}` : '',
  a.context_path ? `CONTEXT.md (locked decisions): ${a.context_path}` : '',
  a.research_path ? `RESEARCH.md (Validation Architecture / Open Questions): ${a.research_path}` : '',
  a.patterns_path ? `PATTERNS.md: ${a.patterns_path}` : '',
  a.response_language ? `response_language: ${a.response_language}` : '',
  '',
  'READ-ONLY PLAN CHECK. Static plan analysis only. Read the plan files and the',
  'artifacts above and RETURN findings via the schema. Do NOT write, create, or',
  'commit ANY file (no CHECK.md, no edits to PLAN.md / STATE.md / ROADMAP.md) — the',
  'orchestrator owns all writes and drives the revision loop. Do NOT run the',
  'application or the test suite. Run no git-mutating commands.',
  '',
  'Classify EVERY finding with a severity: "blocker" (phase goal will not be',
  'achieved unless fixed before execution), "warning" (quality degraded, execution',
  'can proceed), or "info". status:"passed" when your scope is clean, "issues_found"',
  'when you have findings, "error" only on a genuine failure to analyze.',
].filter(Boolean).join('\n');

phase('check');
log(`gsd-plan-check-fanout: ${plans.length} per-plan branch(es) + 1 cross-plan branch (iteration ${a.iteration || 1})`);

const thunks = [];

for (const p of plans) {
  thunks.push(() => agent(
    `${ctx}\n\nPLAN UNDER CHECK: ${p.id} (${p.path})\n` +
      `Run ONLY the PER-PLAN dimensions for THIS plan:\n` +
      `- Task Completeness (every task has files/action/verify/done per its type)\n` +
      `- Scope Sanity (tasks/plan + files/plan thresholds)\n` +
      `- Verification Derivation / must_haves (user-observable truths; artifacts map to truths)\n` +
      `- Key Links Planned (artifacts wired WITHIN this plan)\n` +
      `- Context Compliance (this plan honors locked D-XX; no deferred ideas)\n` +
      `- Scope-Reduction Detection (no "v1"/"static for now"/"stub" reductions) — ALWAYS blocker\n` +
      `- Architectural Tier Compliance (tasks target the responsibility-map tier)\n` +
      `- CLAUDE.md Compliance (this plan respects project conventions)\n` +
      `- Pattern Compliance (each new/modified file references its PATTERNS.md analog)\n` +
      `- Nyquist: per-task <automated> presence + feedback-latency for THIS plan's tasks\n` +
      `Do NOT check requirement coverage, the dependency graph, cross-plan data\n` +
      `contracts, Wave-0 cross-references, or RESEARCH open questions — the cross-plan\n` +
      `branch owns those. Set plan_id to "${p.id}".`,
    { agentType: 'gsd-plan-checker', schema: planSchema, label: `plan-${p.id}` },
  ));
}

thunks.push(() => agent(
  `${ctx}\n\nCROSS-PLAN CHECK over the FULL plan set:\n` +
    allPlanPaths.map((f) => `- ${f}`).join('\n') + '\n\n' +
    `Run ONLY the WHOLE-PHASE dimensions (each needs all plans at once):\n` +
    `- Requirement Coverage: every phase requirement ID appears in >=1 plan's\n` +
    `  requirements field — a missing ID is a BLOCKER.\n` +
    `- Decision Coverage: every locked CONTEXT.md D-XX is referenced by >=1 plan.\n` +
    `- Dependency Correctness: build the depends_on graph across ALL plans; flag\n` +
    `  cycles, missing/forward references, wave inconsistency (BLOCKER).\n` +
    `- Cross-Plan Data Contracts: incompatible transforms on a shared data entity\n` +
    `  with no preservation mechanism (BLOCKER), potential conflicts (WARNING).\n` +
    `- Cross-Plan Data-Contract Ordering: a plan ASSERTS against shared data (fixture/\n` +
    `  allowlist/golden/snapshot) that a LATER plan (by wave/depends_on) is the one to\n` +
    `  produce/commit — asserting against data that does not yet exist (BLOCKER).\n` +
    `- Canary/Negative-Test Allowlist Invariant: a LATER plan allowlists a target that\n` +
    `  an existing refusal/negative test asserts is REFUSED, silently inverting the\n` +
    `  canary to passing-by-accident (BLOCKER).\n` +
    `- Nyquist cross-plan: Wave-0 cross-reference for <automated>MISSING</automated>\n` +
    `  and sampling continuity across waves.\n` +
    `- Research Resolution: RESEARCH.md "## Open Questions" all resolved.\n` +
    `- Shared-pattern presence: every PATTERNS.md ## Shared Pattern appears in each\n` +
    `  plan it applies to.\n` +
    `Do NOT re-check per-plan task completeness/scope/must_haves — the per-plan\n` +
    `branches own those. Tag each finding with the plans[] it spans.`,
  { agentType: 'gsd-plan-checker', schema: crossSchema, label: 'cross-plan' },
));

const results = await parallel(thunks);

const crossRaw = results[results.length - 1];
const planRaws = results.slice(0, results.length - 1);

const findings = [];
const per_plan = [];
for (let i = 0; i < plans.length; i++) {
  const r = checkResult(planRaws[i]);
  const b = countSev(r.findings, 'blocker');
  const w = countSev(r.findings, 'warning');
  per_plan.push({ plan_id: plans[i].id, status: r.status, blocker_count: b, warning_count: w });
  for (const f of r.findings) findings.push({ scope: 'plan', plan_id: plans[i].id, ...f });
}

const cross = checkResult(crossRaw);
const crossB = countSev(cross.findings, 'blocker');
const crossW = countSev(cross.findings, 'warning');
for (const f of cross.findings) findings.push({ scope: 'cross', ...f });
const cross_plan = { status: cross.status, blocker_count: crossB, warning_count: crossW };

const blocker_count = countSev(findings, 'blocker');
const warning_count = countSev(findings, 'warning');
const allErrored = [cross, ...planRaws.map(checkResult)].every((r) => r.status === 'error');
const status = allErrored ? 'error' : (blocker_count + warning_count) > 0 ? 'issues_found' : 'passed';

log(`gsd-plan-check-fanout: verdict=${status} blockers=${blocker_count} warnings=${warning_count}`);

return { status, blocker_count, warning_count, findings, per_plan, cross_plan };

// Normalize a branch return (or a null from a failed parallel() thunk) into the
// {status, findings} shape — never throws, so one flaky branch cannot sink the
// fan-out. A missing/invalid return contributes zero findings and status:error.
function checkResult(ret) {
  if (!ret || typeof ret !== 'object') {
    return { status: 'error', findings: [] };
  }
  const f = Array.isArray(ret.findings) ? ret.findings.filter((x) => x && typeof x === 'object') : [];
  return { status: ret.status || (f.length > 0 ? 'issues_found' : 'error'), findings: f };
}

function countSev(list, sev) {
  return list.reduce((n, f) => (f && f.severity === sev ? n + 1 : n), 0);
}
