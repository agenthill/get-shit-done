// gsd-code-review-fanout — read-only code-review dimension fan-out (ADR 0013,
// "Rollout template": map-codebase / code-review → review-dimension fan-out).
//
// Replaces code-review.md's single gsd-code-reviewer agent (which authored
// REVIEW.md itself) with one parallel() over THREE read-only dimension agents —
// bugs/logic, security, code-quality — each reviewing the FULL file set at the
// resolved depth. Each branch RETURNS findings via schema and WRITES NOTHING;
// the orchestrator aggregates the verdict and owns the single REVIEW.md write
// (via get-shit-done/bin/lib/compose-review.cjs). Collapses the serial
// per-dimension cost from sum → max(3 dimensions).
//
// Fan-out axis = dimension-only (3 branches). NO file-sharding (deferred): each
// dimension agent sees the full set, so deep depth is preserved. verify-finding
// middle stage is DEFERRED — a single parallel() barrier only (mirrors
// gsd-verify-fanout).
//
// MODULE FORM: this is a dynamic-Workflow script, NOT a default-exported
// function. `export const meta` first (pure literal), then a top-level async
// body that uses the ambient globals `args`, `agent`, `parallel`, `phase`,
// `log`. The script's final `return` value is the workflow result handed back
// to the orchestrator.
//
// HARD CONSTRAINTS (Workflow tool):
//   - No fs/git/bash/clock/randomness in the SCRIPT — it only spawns agents
//     (which do every read) and composes parallel(). It cannot call
//     AskUserQuestion.
//   - READ-ONLY: every branch reads source and RETURNS findings; the
//     orchestrator owns ALL writes (REVIEW.md). No worktree isolation is needed
//     because nothing here mutates the tree.
//   - COLLISION-SAFETY: no branch runs a test process and no branch writes any
//     file — all three only read source and return. So the fan-out is safe to
//     run concurrently against the single shared working tree.

export const meta = {
  name: 'gsd-code-review-fanout',
  description:
    'Read-only code-review dimension fan-out: bugs/logic, security, and code-quality reviewers run concurrently over the full file set at the resolved depth, each returning findings via schema (writing nothing). Returns one aggregated verdict for the orchestrator to compose into REVIEW.md.',
  phases: [{ title: 'review', detail: 'fan out read-only code-review dimensions' }],
};

// Per-branch (per-dimension) return schema. Each finding is a structured row
// the orchestrator's compose-review.cjs turns into a CR-/WR-/IN- block.
const dimensionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'findings'],
  properties: {
    status: { type: 'string', enum: ['passed', 'gaps_found', 'error'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'file', 'line', 'title', 'issue', 'fix'],
        properties: {
          severity: { type: 'string', enum: ['critical', 'warning', 'info'] },
          file: { type: 'string' },
          line: { type: 'string' },
          title: { type: 'string' },
          issue: { type: 'string' },
          fix: { type: 'string' },
        },
      },
    },
  },
};

const a = args || {};
const files = Array.isArray(a.files) ? a.files : [];
const depth = a.depth || 'standard';

// Shared read-only preamble injected into every dimension prompt. Lists the
// files, the depth, and the structural findings (ground truth when present),
// and HARD-pins the read-only / no-write / no-test / no-source-mutation
// contract.
const ctx = [
  `Phase: ${a.phase_number}`,
  `Phase directory: ${a.phase_dir}`,
  `Review depth: ${depth}`,
  a.diff_base ? `Diff base: ${a.diff_base}` : '',
  '',
  'Files to review (the FULL set — review every one at the depth above):',
  ...files.map((f) => `- ${f}`),
  '',
  a.structural_findings
    ? `Structural findings (fallow) — treat as GROUND TRUTH for cross-module facts (unused exports, duplicate blocks, circular deps); build on this substrate, do not contradict it:\n${a.structural_findings}`
    : '',
  '',
  'READ-ONLY. Read source and RETURN findings via the schema. Do NOT write,',
  'create, or commit REVIEW.md or ANY file — the orchestrator owns all writes.',
  'Do NOT run the test suite. Do NOT modify source. Run no git-mutating commands.',
  '',
  'Each finding: severity (critical|warning|info) + file + line (e.g. "42" or',
  '"42-45") + a short title + the issue + a concrete fix. status:"passed" when',
  'your dimension is clean, "gaps_found" when you have findings, "error" only on',
  'a genuine failure to review.',
].filter(Boolean).join('\n');

phase('review');
log(`gsd-code-review-fanout: 3 read-only dimensions over ${files.length} files at ${depth} depth`);

// One parallel() barrier. Each branch is independent, read-only, writes
// nothing, and runs no test process → concurrent execution is collision-free.
const results = await parallel([
  // 1. Bugs / logic dimension.
  () => agent(
    `${ctx}\n\nDIMENSION: BUGS / LOGIC. Scope your review to bug and logic defects only:\n` +
      `logic errors, null/undefined handling, off-by-one errors, type mismatches,\n` +
      `unhandled edge cases, incorrect conditionals, variable shadowing, dead/unreachable\n` +
      `code paths, infinite loops, incorrect operators, missing error handling in\n` +
      `async/await, unhandled promise rejections. Trace edge cases (nulls, empty\n` +
      `collections, boundary values). Do NOT report security or pure style issues —\n` +
      `other dimensions cover those.`,
    { agentType: 'gsd-code-reviewer', schema: dimensionSchema, label: 'bugs' },
  ),

  // 2. Security dimension.
  () => agent(
    `${ctx}\n\nDIMENSION: SECURITY. Scope your review to security vulnerabilities only:\n` +
      `injection (SQL, command, path traversal), XSS, hardcoded secrets/credentials,\n` +
      `insecure crypto usage, unsafe deserialization, missing input validation,\n` +
      `directory traversal, eval usage, insecure random generation, authentication\n` +
      `bypasses, authorization gaps. Do NOT report non-security bugs or style issues —\n` +
      `other dimensions cover those.`,
    { agentType: 'gsd-code-reviewer', schema: dimensionSchema, label: 'security' },
  ),

  // 3. Code-quality dimension.
  () => agent(
    `${ctx}\n\nDIMENSION: CODE QUALITY. Scope your review to maintainability/quality only:\n` +
      `dead code, unused imports/variables, poor naming, inconsistent patterns, overly\n` +
      `complex functions (high cyclomatic complexity), code duplication, magic numbers,\n` +
      `commented-out code. Performance (O(n^2), memory leaks) is OUT OF SCOPE unless it\n` +
      `is also a correctness bug. Do NOT report security issues or correctness bugs —\n` +
      `other dimensions cover those.`,
    { agentType: 'gsd-code-reviewer', schema: dimensionSchema, label: 'quality' },
  ),
]);

const [bugs, security, quality] = results;
const per = [
  { dimension: 'bugs', ...dimResult(bugs) },
  { dimension: 'security', ...dimResult(security) },
  { dimension: 'quality', ...dimResult(quality) },
];

// Flatten the three branches into one findings list, tagging each with its
// dimension. compose-review.cjs groups by severity (not dimension), so order is
// preserved per dimension for stable numbering.
const findings = [];
for (const d of per) {
  for (const f of d.findings) findings.push({ ...f, dimension: d.dimension });
}

const per_dimension = per.map((d) => ({ dimension: d.dimension, status: d.status, count: d.findings.length }));
const allErrored = per.every((d) => d.status === 'error');
const status = allErrored ? 'error' : findings.length > 0 ? 'issues_found' : 'clean';

log(
  `gsd-code-review-fanout: verdict=${status} findings=${findings.length} ` +
    `(bugs=${per_dimension[0].count} security=${per_dimension[1].count} quality=${per_dimension[2].count})`,
);

return { status, findings, per_dimension };

// Normalize an agent return (or a null from a failed parallel() thunk) into the
// per-dimension shape — never throws, so one flaky dimension cannot sink the
// fan-out. A missing/invalid return contributes zero findings and status:error.
function dimResult(ret) {
  if (!ret || typeof ret !== 'object') {
    return { status: 'error', findings: [] };
  }
  const findings = Array.isArray(ret.findings) ? ret.findings.filter((f) => f && typeof f === 'object') : [];
  return {
    status: ret.status || (findings.length > 0 ? 'gaps_found' : 'error'),
    findings,
  };
}
