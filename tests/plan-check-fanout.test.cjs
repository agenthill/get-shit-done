'use strict';

process.env.GSD_TEST_MODE = '1';

/**
 * Guards dynamic-workflows/gsd-plan-check-fanout.js — the read-only
 * pre-execution plan-check fan-out (ADR 0013 rollout).
 *
 * Asserts:
 *   1. The workflow file `node --check`s clean (valid JS).
 *   2. The module-form markers are present (`export const meta` pure literal,
 *      meta.name, ambient-global usage, top-level `return`, parallel()/agent()/
 *      phase()) and it is NOT a default export.
 *   3. The read-only contract holds: the script writes nothing (no Write/commit
 *      tokens) and performs no fs/require of its own — every read happens inside
 *      a spawned agent.
 *   4. The DISJOINT-DIMENSION FALSIFIER: the per-plan branch runs the per-plan
 *      dimensions and the cross-plan branch runs the cross-plan dimensions, and
 *      no STRICTLY-cross-plan dimension (requirement coverage, dependency graph,
 *      cross-plan data contracts, research resolution) leaks into the per-plan
 *      branch's RUN list. The three dual-facet dimensions (Context/decision,
 *      Nyquist, Pattern/shared) legitimately appear on both sides and are
 *      excluded from the strict check.
 *
 * Uses \r?\n in every cross-line regex and /^---\r?\n/ for any frontmatter
 * regex to stay off the Windows-parity ratchet.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const WORKFLOW_PATH = path.join(REPO_ROOT, 'dynamic-workflows', 'gsd-plan-check-fanout.js');

// The per-plan branch RUNs these dimensions (the dims that need only one plan).
const PER_PLAN_DIMS = [
  'Task Completeness',
  'Scope Sanity',
  'Verification Derivation',
  'Key Links Planned',
  'Context Compliance',
  'Scope-Reduction Detection',
  'Architectural Tier Compliance',
  'CLAUDE.md Compliance',
  'Pattern Compliance',
  'Nyquist',
];

// The cross-plan branch RUNs these dimensions (each needs all plans at once).
const CROSS_PLAN_DIMS = [
  'Requirement Coverage',
  'Decision Coverage',
  'Dependency Correctness',
  'Cross-Plan Data Contracts',
  'Research Resolution',
  'Shared-pattern presence',
];

// STRICTLY cross-plan: a per-plan branch must NEVER be told to run these. The
// dual-facet dims (Context/decision, Nyquist, Pattern/shared) are intentionally
// NOT here — they have a documented per-plan facet too (ADR 0013; agent dims
// 7 / 8 / 12), so the per-plan branch legitimately runs them.
const STRICTLY_CROSS_PLAN_DIMS = [
  'Requirement Coverage',
  'Dependency Correctness',
  'Cross-Plan Data Contracts',
  'Research Resolution',
];

function readSrc() {
  return fs.readFileSync(WORKFLOW_PATH, 'utf8');
}

// Slice the per-plan branch's RUN list — the text between "Run ONLY the PER-PLAN
// dimensions" and the "Do NOT check ..." exclusion sentence. The exclusion
// sentence legitimately NAMES the strictly-cross-plan dims (to disclaim them),
// so the strict-disjoint check must look only at the RUN list, not the
// disclaimer. Returns the RUN-list substring.
function perPlanRunList(src) {
  const start = src.indexOf('Run ONLY the PER-PLAN dimensions');
  assert.ok(start !== -1, 'per-plan prompt must contain its RUN-list header');
  const stop = src.indexOf('Do NOT check', start);
  assert.ok(stop !== -1, 'per-plan prompt must contain its "Do NOT check" exclusion sentence');
  return src.slice(start, stop);
}

// Slice the cross-plan branch's RUN list — from its header to the "Do NOT
// re-check" disclaimer.
function crossPlanRunList(src) {
  const start = src.indexOf('Run ONLY the WHOLE-PHASE dimensions');
  assert.ok(start !== -1, 'cross-plan prompt must contain its RUN-list header');
  const stop = src.indexOf('Do NOT re-check', start);
  assert.ok(stop !== -1, 'cross-plan prompt must contain its "Do NOT re-check" exclusion sentence');
  return src.slice(start, stop);
}

describe('gsd-plan-check-fanout', () => {
  test('the workflow file exists', () => {
    assert.ok(fs.existsSync(WORKFLOW_PATH), `${WORKFLOW_PATH} should exist`);
  });

  test('node --check passes (valid JS)', () => {
    // Throws (non-zero exit) on a syntax error.
    assert.doesNotThrow(() => {
      execFileSync(process.execPath, ['--check', WORKFLOW_PATH], { stdio: 'pipe' });
    });
  });

  test('module form: export const meta, meta.name, ambient globals, top-level return, NOT default export', () => {
    const src = readSrc();

    // `export const meta` (the pure-literal metadata), like the sibling fan-outs.
    assert.match(src, /export const meta = \{/, 'must export a `meta` const');

    // meta.name matches the registered workflow name.
    assert.match(src, /name:\s*'gsd-plan-check-fanout'/, "meta.name must be 'gsd-plan-check-fanout'");

    // NOT a default-exported function.
    assert.doesNotMatch(src, /export\s+default/, 'must NOT be a default export');

    // Ambient globals used (not imported): args, agent, parallel, phase, log.
    for (const g of ['args', 'agent', 'parallel', 'phase', 'log']) {
      assert.match(src, new RegExp(`\\b${g}\\b`), `must use ambient global \`${g}\``);
    }

    // The composition primitives are present as calls.
    assert.ok(src.includes('parallel('), 'must compose a parallel() barrier');
    assert.ok(src.includes('agent('), 'must spawn agent()s');
    assert.ok(src.includes('phase('), 'must call phase()');

    // A top-level `return` value (the workflow result handed back).
    assert.match(src, /^return \{/m, 'must have a top-level `return { ... }`');

    // Spawns the gsd-plan-checker agent.
    assert.match(src, /agentType:\s*'gsd-plan-checker'/, 'must spawn gsd-plan-checker');
  });

  test('read-only contract: no Write/commit tokens, no fs/require of its own', () => {
    const src = readSrc();

    // The script itself performs no filesystem / module-load side effects — every
    // read happens inside a spawned agent (Workflow-tool hard constraint).
    assert.doesNotMatch(src, /\brequire\s*\(/, 'script must not require() anything');
    assert.doesNotMatch(src, /\bfs\./, 'script must not call fs.* itself');

    // No mutation tokens: the script must not instruct a Write nor a git commit
    // of its own. (The prompt text FORBIDS these — those forbidding mentions are
    // allowed; what must be absent is an actual Write tool call / commit verb the
    // script issues. The script issues neither.)
    assert.doesNotMatch(src, /\bWrite\s*\(/, 'script must not call Write()');
    assert.doesNotMatch(src, /\bgit (?:commit|add|push)\b/, 'script must not run a git mutation');

    // Positive read-only contract documented in the shared preamble.
    assert.match(src, /READ-ONLY PLAN CHECK/, 'must document the read-only contract');
    assert.match(src, /Do NOT write, create, or/, 'must forbid writing in the agent contract');
    assert.match(src, /Do NOT run\b/, 'must forbid running the app/tests');
  });

  test('DISJOINT-DIMENSION falsifier: per-plan RUN list ⟂ strictly-cross-plan dims', () => {
    const src = readSrc();
    const perPlan = perPlanRunList(src);
    const crossPlan = crossPlanRunList(src);

    // The per-plan branch is told to run every per-plan dimension.
    for (const dim of PER_PLAN_DIMS) {
      assert.ok(
        perPlan.includes(dim),
        `per-plan RUN list must mention per-plan dimension "${dim}"`,
      );
    }

    // The cross-plan branch is told to run every cross-plan dimension.
    for (const dim of CROSS_PLAN_DIMS) {
      assert.ok(
        crossPlan.includes(dim),
        `cross-plan RUN list must mention cross-plan dimension "${dim}"`,
      );
    }

    // No STRICTLY-cross-plan dimension leaks into the per-plan RUN list. (The
    // per-plan prompt's "Do NOT check ..." disclaimer NAMES these — that sentence
    // is sliced off by perPlanRunList(), so a leak into the RUN list is what
    // fails here.) The dual-facet dims are excluded from this strict check.
    for (const dim of STRICTLY_CROSS_PLAN_DIMS) {
      assert.ok(
        !perPlan.includes(dim),
        `strictly-cross-plan dimension "${dim}" must NOT appear in the per-plan RUN list`,
      );
    }
  });
});
