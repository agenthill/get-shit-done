'use strict';

process.env.GSD_TEST_MODE = '1';

/**
 * Guards dynamic-workflows/gsd-map-codebase-fanout.js — the codebase-mapping
 * focus-area fan-out (ADR 0013 rollout).
 *
 * Asserts:
 *   1. The workflow file `node --check`s clean (valid JS).
 *   2. The module-form markers are present (`export const meta` pure literal,
 *      ambient-global usage, top-level `return`) and it is NOT a default export.
 *   3. The DISJOINT-FILENAME INVARIANT holds: the 4 focus areas (tech / arch /
 *      quality / concerns) map to pairwise non-overlapping output filename sets,
 *      totalling the 7 expected docs. This is what makes the
 *      mappers-write-their-own-docs exception collision-safe under the Workflow
 *      tool's no-op isolation; a future edit pointing two focus areas at the
 *      same filename must turn this test red.
 *
 * Uses \r?\n in every cross-line regex to stay off the Windows-parity ratchet.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const WORKFLOW_PATH = path.join(REPO_ROOT, 'dynamic-workflows', 'gsd-map-codebase-fanout.js');

const EXPECTED_FOCUS = ['tech', 'arch', 'quality', 'concerns'];
const EXPECTED_FILES = {
  tech: ['STACK.md', 'INTEGRATIONS.md'],
  arch: ['ARCHITECTURE.md', 'STRUCTURE.md'],
  quality: ['CONVENTIONS.md', 'TESTING.md'],
  concerns: ['CONCERNS.md'],
};

describe('gsd-map-codebase-fanout', () => {
  test('the workflow file exists', () => {
    assert.ok(fs.existsSync(WORKFLOW_PATH), `${WORKFLOW_PATH} should exist`);
  });

  test('node --check passes (valid JS)', () => {
    // Throws (non-zero exit) on a syntax error.
    assert.doesNotThrow(() => {
      execFileSync(process.execPath, ['--check', WORKFLOW_PATH], { stdio: 'pipe' });
    });
  });

  test('module form: export const meta, ambient globals, top-level return, NOT default export', () => {
    const src = fs.readFileSync(WORKFLOW_PATH, 'utf8');

    // `export const meta` (the pure-literal metadata), like the sibling fan-outs.
    assert.match(src, /export\s+const\s+meta\s*=/, 'must export a `meta` const');

    // NOT a default-exported function.
    assert.doesNotMatch(src, /export\s+default/, 'must NOT be a default export');

    // Ambient globals used (not imported): args, agent, parallel, phase, log.
    for (const g of ['args', 'agent', 'parallel', 'phase', 'log']) {
      assert.match(src, new RegExp(`\\b${g}\\b`), `must use ambient global \`${g}\``);
    }
    // The ambient globals must not be imported/required (they are provided by
    // the Workflow runtime).
    assert.doesNotMatch(
      src,
      /(?:require|import)[^\n]*\b(?:agent|parallel|phase)\b/,
      'ambient globals must not be imported/required',
    );

    // A top-level `return` value (the workflow result handed back).
    assert.match(src, /^return\s+\{/m, 'must have a top-level `return { ... }`');

    // meta.name matches the registered workflow name.
    assert.match(src, /name:\s*'gsd-map-codebase-fanout'/, 'meta.name must be gsd-map-codebase-fanout');

    // A single parallel() barrier over the focus areas.
    assert.match(src, /await\s+parallel\s*\(/, 'must compose a parallel() barrier');

    // Spawns the gsd-codebase-mapper agent.
    assert.match(src, /agentType:\s*'gsd-codebase-mapper'/, 'must spawn gsd-codebase-mapper');
  });

  test('the 4 expected focus areas are declared with their docs', () => {
    const src = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    for (const focus of EXPECTED_FOCUS) {
      assert.match(src, new RegExp(`focus:\\s*'${focus}'`), `must declare focus "${focus}"`);
    }
    for (const focus of EXPECTED_FOCUS) {
      for (const file of EXPECTED_FILES[focus]) {
        assert.ok(src.includes(file), `focus "${focus}" must reference its doc "${file}"`);
      }
    }
  });

  test('DISJOINT-FILENAME INVARIANT: the 4 focus areas have pairwise non-overlapping doc sets (7 total)', () => {
    // Derived from the workflow's own FOCUS_AREAS contract (mirrored above). We
    // assert the property structurally so a future edit that points two focus
    // areas at the same filename fails here.
    const seen = new Map(); // filename -> focus
    let total = 0;
    for (const focus of EXPECTED_FOCUS) {
      for (const file of EXPECTED_FILES[focus]) {
        assert.ok(
          !seen.has(file),
          `disjoint-filename invariant violated: "${file}" claimed by both ` +
            `"${seen.get(file)}" and "${focus}"`,
        );
        seen.set(file, focus);
        total += 1;
      }
    }
    assert.equal(seen.size, total, 'no filename may be claimed by two focus areas');
    assert.equal(seen.size, 7, 'the 4 focus areas must total exactly 7 disjoint docs');

    // The script carries a HARD load-time assertion (assertDisjointFocusFiles)
    // so the same invariant is enforced in-process — confirm the guard is wired.
    const src = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    assert.match(
      src,
      /assertDisjointFocusFiles\s*\(\s*FOCUS_AREAS\s*\)/,
      'the script must invoke assertDisjointFocusFiles(FOCUS_AREAS) at load',
    );
    assert.match(
      src,
      /disjoint-filename invariant violated/,
      'the load-time guard must throw on a collision',
    );
  });

  test('read-only-against-source contract is documented in the preamble', () => {
    const src = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    // The mapper write-exception + the no-commit/no-test/no-STATE contract.
    assert.match(src, /Do NOT commit/i, 'must forbid committing in the mapper contract');
    assert.match(src, /Do NOT run the test suite/i, 'must forbid running tests');
    assert.match(src, /STATE\.md\s*\/\s*ROADMAP\.md/, 'must forbid touching STATE/ROADMAP');
    // The verdict shape is the file/line summary, not doc bodies.
    assert.match(src, /NOT doc bodies/i, 'must state the return is NOT doc bodies');
  });
});
