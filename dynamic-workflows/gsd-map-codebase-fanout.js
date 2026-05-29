// gsd-map-codebase-fanout — codebase-mapping focus-area fan-out (ADR 0013,
// "Rollout template": map-codebase / code-review → dynamic mapper set).
//
// Replaces map-codebase.md's 4 hand-staggered run_in_background Agent() mapper
// dispatches + the TaskOutput collect loop with one parallel() over the FOUR
// focus-area mapper branches — tech / arch / quality / concerns — each an
// agent({agentType:'gsd-codebase-mapper', ...}). Invoked by the map-codebase
// orchestrator shell as Workflow({name:'gsd-map-codebase-fanout', args}).
//
// KEY DESIGN DECISION — mappers WRITE their own disjoint docs (DELIBERATE, a
// scoped exception to ADR 0013 D2's "agents return findings; orchestrator owns
// all writes" rule). Unlike gsd-code-review-fanout / gsd-verify-fanout (where
// every branch writes NOTHING), each mapper here WRITES its 1-2
// .planning/codebase/*.md docs DIRECTLY, exactly as map-codebase.md does today.
// The exception is justified by the DISJOINT-FILENAME INVARIANT: the 4 focus
// areas map to 7 NON-OVERLAPPING filenames —
//   tech     → STACK.md, INTEGRATIONS.md
//   arch     → ARCHITECTURE.md, STRUCTURE.md
//   quality  → CONVENTIONS.md, TESTING.md
//   concerns → CONCERNS.md
// — so even under the Workflow tool's no-op worktree isolation (every agent
// lands in the shared main tree — ADR 0013 §"Validation findings"), there is
// ZERO file-content collision and NO branch runs a test process →
// collision-free. The benefit this preserves: the orchestrator never ingests
// doc BODIES (only {file, lines, status} per focus), avoiding the context tax —
// that is the whole point of map-codebase's design. Do NOT "fix" this to make
// mappers return content; that throws away the context-saving design.
//
// A HARD ASSERTION (assertDisjointFocusFiles, run at load) proves the 4 focus
// areas' filename sets are pairwise non-overlapping, so a future edit cannot
// silently introduce a collision (also covered by tests/map-codebase-fanout.test.cjs).
//
// MODULE FORM: this is a dynamic-Workflow script, NOT a default-exported
// function. `export const meta` first (pure literal), then a top-level async
// body that uses the ambient globals `args`, `agent`, `parallel`, `phase`,
// `log`. The script's final `return` value is the workflow result handed back
// to the orchestrator.
//
// HARD CONSTRAINTS (Workflow tool):
//   - No fs/git/bash/clock/randomness in the SCRIPT — it only spawns agents
//     (which do every read AND their own disjoint doc write) and composes
//     parallel(). It cannot call AskUserQuestion. HEAD is resolved by the
//     orchestrator in pre-flight and passed as args.head_sha (the script has no
//     git/clock of its own).
//   - READ-ONLY AGAINST SOURCE: mappers READ code and WRITE ONLY their own
//     disjoint .planning/codebase/ docs. They do NOT commit, do NOT touch
//     STATE.md / ROADMAP.md, do NOT run tests, and run no other git-mutating
//     commands. The orchestrator owns the commit + ALL interaction.
//   - COLLISION-SAFETY: the 7 output filenames are pairwise disjoint across the
//     4 focus areas and no branch runs a test process, so concurrent execution
//     against the single shared working tree cannot collide.

export const meta = {
  name: 'gsd-map-codebase-fanout',
  description:
    'Codebase-mapping focus-area fan-out: tech, arch, quality, and concerns mappers run concurrently, each writing its own disjoint .planning/codebase/ docs (a scoped exception to D2, safe via the disjoint-filename invariant) and returning {focus, status, files:[{file,lines}]} — never doc bodies. Returns one aggregated verdict for the orchestrator to verify, scan, and commit.',
  phases: [{ title: 'map', detail: 'fan out codebase-mapping focus areas' }],
};

// The 4 focus areas → the disjoint docs each writes. SINGLE SOURCE OF TRUTH for
// both the per-branch prompts and the disjoint-filename invariant.
const FOCUS_AREAS = [
  {
    focus: 'tech',
    files: ['STACK.md', 'INTEGRATIONS.md'],
    description: 'Map codebase tech stack',
    instruction:
      'Analyze this codebase for technology stack and external integrations.\n\n' +
      'Write these documents to .planning/codebase/:\n' +
      '- STACK.md — Languages, runtime, frameworks, dependencies, configuration\n' +
      '- INTEGRATIONS.md — External APIs, databases, auth providers, webhooks',
  },
  {
    focus: 'arch',
    files: ['ARCHITECTURE.md', 'STRUCTURE.md'],
    description: 'Map codebase architecture',
    instruction:
      'Analyze this codebase architecture and directory structure.\n\n' +
      'Write these documents to .planning/codebase/:\n' +
      '- ARCHITECTURE.md — Pattern, layers, data flow, abstractions, entry points\n' +
      '- STRUCTURE.md — Directory layout, key locations, naming conventions',
  },
  {
    focus: 'quality',
    files: ['CONVENTIONS.md', 'TESTING.md'],
    description: 'Map codebase conventions',
    instruction:
      'Analyze this codebase for coding conventions and testing patterns.\n\n' +
      'Write these documents to .planning/codebase/:\n' +
      '- CONVENTIONS.md — Code style, naming, patterns, error handling\n' +
      '- TESTING.md — Framework, structure, mocking, coverage',
  },
  {
    focus: 'concerns',
    files: ['CONCERNS.md'],
    description: 'Map codebase concerns',
    instruction:
      'Analyze this codebase for technical debt, known issues, and areas of concern.\n\n' +
      'Write this document to .planning/codebase/:\n' +
      '- CONCERNS.md — Tech debt, bugs, security, performance, fragile areas',
  },
];

// HARD INVARIANT: the focus areas' output filename sets are pairwise
// non-overlapping. This is what makes the mappers-write-their-own-docs exception
// collision-safe under the no-op isolation. A future edit that points two focus
// areas at the same filename throws here at load (and is caught by the test).
function assertDisjointFocusFiles(areas) {
  const seen = new Map(); // filename -> focus that owns it
  for (const area of areas) {
    for (const file of area.files) {
      if (seen.has(file)) {
        throw new Error(
          `gsd-map-codebase-fanout: disjoint-filename invariant violated — ` +
            `"${file}" claimed by both "${seen.get(file)}" and "${area.focus}". ` +
            `Focus-area output filename sets MUST be pairwise non-overlapping ` +
            `(see the disjoint-write exception in the header).`,
        );
      }
      seen.set(file, area.focus);
    }
  }
  return seen.size; // total distinct filenames (7)
}

assertDisjointFocusFiles(FOCUS_AREAS);

// Per-branch (per-focus) return schema. Each mapper RETURNS only {focus, status,
// files:[{file, lines}]} — NOT doc bodies — so the orchestrator never ingests
// the document text (the context-saving point of map-codebase's design).
const focusSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['focus', 'status', 'files'],
  properties: {
    focus: { type: 'string', enum: ['tech', 'arch', 'quality', 'concerns'] },
    status: { type: 'string', enum: ['ok', 'empty', 'error'] },
    files: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'lines'],
        properties: {
          file: { type: 'string' },
          lines: { type: 'number' },
        },
      },
    },
  },
};

const a = args || {};
const pathScope = typeof a.path_scope === 'string' ? a.path_scope.trim() : '';
const headSha = a.head_sha || '';

// Shared preamble injected into every mapper prompt. Carries the scope, the HEAD
// sha to stamp, and the read-only-against-source / write-only-your-own-docs
// contract. (The script has no git/clock — head_sha is resolved by the
// orchestrator pre-flight and passed in.)
const ctx = [
  a.phase_number ? `Phase: ${a.phase_number}` : '',
  pathScope ? `${pathScope}` : '',
  pathScope
    ? '(--paths supplied: restrict ALL Glob/Grep/Bash exploration to those repo-relative prefixes only — no whole-repo scan.)'
    : '(No --paths: full-repo scan.)',
  headSha ? `HEAD commit (stamp this): ${headSha}` : '',
  a.response_language ? `response_language: ${a.response_language}` : '',
  '',
  'CONTRACT — read source, write ONLY your own disjoint docs:',
  '- READ code with Read/Grep/Glob/Bash. WRITE ONLY the .planning/codebase/ doc(s)',
  '  named for your focus below — never another focus’s file.',
  headSha
    ? `- On write, stamp \`last_mapped_commit: ${headSha}\` into the YAML frontmatter`
    : '- On write, stamp `last_mapped_commit` into the YAML frontmatter',
  '  of every document you produce (see bin/lib/drift.cjs:writeMappedCommit).',
  '- Do NOT commit. Do NOT touch STATE.md / ROADMAP.md. Do NOT run the test suite.',
  '  Run no git-mutating commands — the orchestrator owns the commit and ALL',
  '  interaction.',
  '- Use the Write tool for files; never heredoc/cat. Use the templates.',
  '',
  'RETURN (via schema, NOT doc bodies): { focus, status, files:[{file, lines}] }.',
  'status:"ok" when your doc(s) were written; "empty" if you genuinely found',
  'nothing to map for your focus; "error" only on a real failure. `lines` is the',
  'final line count of each doc you wrote.',
].filter(Boolean).join('\n');

phase('map');
log(
  `gsd-map-codebase-fanout: 4 focus-area mappers (${FOCUS_AREAS.map((f) => f.focus).join(', ')}) ` +
    `→ ${assertDisjointFocusFiles(FOCUS_AREAS)} disjoint docs${pathScope ? ` (scoped: ${pathScope})` : ' (full repo)'}`,
);

// One parallel() barrier. Each branch is independent and writes ONLY its own
// disjoint docs (no test process, no shared filename) → concurrent execution
// against the single shared working tree is collision-free.
const results = await parallel(
  FOCUS_AREAS.map((area) => () =>
    agent(
      `${ctx}\n\nFOCUS: ${area.focus}\n\n${area.instruction}\n\n` +
        `Explore thoroughly, then write the document(s) above directly using the ` +
        `templates. Return ONLY the schema verdict (focus="${area.focus}", status, ` +
        `files:[{file, lines}]) — NOT the document contents.`,
      { agentType: 'gsd-codebase-mapper', schema: focusSchema, label: area.focus },
    ),
  ),
);

const per_focus = FOCUS_AREAS.map((area, i) => focusResult(area.focus, results[i]));

const allErrored = per_focus.every((f) => f.status === 'error');
const anyError = per_focus.some((f) => f.status === 'error');
const status = allErrored ? 'error' : anyError ? 'partial' : 'ok';

const totalDocs = per_focus.reduce((n, f) => n + f.files.length, 0);
log(
  `gsd-map-codebase-fanout: verdict=${status} docs=${totalDocs} ` +
    `(${per_focus.map((f) => `${f.focus}=${f.status}`).join(' ')})`,
);

return { status, per_focus };

// Normalize a mapper return (or a null from a failed parallel() thunk) into the
// per-focus shape — never throws, so one flaky mapper cannot sink the fan-out. A
// missing/invalid return contributes zero files and status:error.
function focusResult(focus, ret) {
  if (!ret || typeof ret !== 'object') {
    return { focus, status: 'error', files: [] };
  }
  const files = Array.isArray(ret.files)
    ? ret.files
        .filter((f) => f && typeof f === 'object' && typeof f.file === 'string')
        .map((f) => ({ file: f.file, lines: typeof f.lines === 'number' ? f.lines : 0 }))
    : [];
  const status =
    ret.status === 'ok' || ret.status === 'empty' || ret.status === 'error'
      ? ret.status
      : files.length > 0
        ? 'ok'
        : 'error';
  return { focus, status, files };
}
