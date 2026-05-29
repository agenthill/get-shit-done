/**
 * dag-runspec query — per-plan depends_on DAG run-spec for the execution
 * engines (ADR 0013, D3/D4).
 *
 * Unlike phase-plan-index (which discards the depends_on edge set after
 * computing the integer wave level), dag-runspec KEEPS the direct edges, adds
 * files_modified serialization edges (invariant 9), keeps has_summary plans as
 * satisfied predecessors (invariant 10), and aborts on a depends_on cycle
 * (invariant 8).
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

function writePlan(phaseDir, name, lines) {
  fs.writeFileSync(path.join(phaseDir, name), lines.join('\n') + '\n');
}

describe('dag-runspec command', () => {
  let tmpDir;
  let phaseDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    phaseDir = path.join(tmpDir, '.planning', 'phases', '03-api');
    fs.mkdirSync(phaseDir, { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // ── Edge preservation ──────────────────────────────────────────────────────
  test('preserves the direct depends_on edge set (not just a wave number)', () => {
    writePlan(phaseDir, '03-01-PLAN.md', ['---', 'depends_on: []', '---', '## Task 1']);
    writePlan(phaseDir, '03-02-PLAN.md', ['---', 'depends_on:', '  - 03-01', '---', '## Task 1']);

    const result = runGsdTools('dag-runspec 03', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const out = JSON.parse(result.output);
    const p1 = out.plans.find(p => p.id === '03-01');
    const p2 = out.plans.find(p => p.id === '03-02');

    assert.deepStrictEqual(p1.depends_on, [], '03-01 has no predecessors');
    assert.deepStrictEqual(p2.depends_on, ['03-01'], '03-02 keeps its direct edge to 03-01');
    // Edge is also distinct from the wave bucket: 03-02 is wave 2, 03-01 wave 1.
    assert.ok(p2.wave > p1.wave, 'wave still computed alongside the edge');
  });

  test('depends_on resolves a short canonical prefix to the full plan id (#3266 parity)', () => {
    // Descriptive filename — id becomes '03-01-auth-hardening'.
    writePlan(phaseDir, '03-01-auth-hardening-PLAN.md', ['---', 'depends_on: []', '---', '## Task 1']);
    // Dependent declares the canonical prefix '03-01', not the full stem.
    writePlan(phaseDir, '03-02-followup-PLAN.md', ['---', 'depends_on:', "  - '03-01'", '---', '## Task 1']);

    const result = runGsdTools('dag-runspec 03', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const out = JSON.parse(result.output);
    const dependent = out.plans.find(p => p.id === '03-02-followup');
    assert.deepStrictEqual(
      dependent.depends_on,
      ['03-01-auth-hardening'],
      'short prefix resolves to the full descriptive id, not the raw "03-01"',
    );
  });

  // ── Serialization edges (invariant 9) ──────────────────────────────────────
  test('inserts a serialization edge for same-wave file-colliding plans not depends_on-ordered', () => {
    // 03-01 and 03-02 are both wave 1 (no deps) and both touch src/api.ts.
    writePlan(phaseDir, '03-01-PLAN.md', ['---', 'depends_on: []', 'files_modified:', '  - src/api.ts', '---', '## Task 1']);
    writePlan(phaseDir, '03-02-PLAN.md', ['---', 'depends_on: []', 'files_modified:', '  - src/api.ts', '---', '## Task 1']);

    const result = runGsdTools('dag-runspec 03', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.deepStrictEqual(
      out.serialization_edges,
      [['03-01', '03-02']],
      'a serialization edge guards the undeclared cross-plan file collision',
    );
  });

  test('does NOT insert a serialization edge when colliding plans are already depends_on-ordered', () => {
    // 03-02 depends on 03-01 and both touch src/api.ts — already ordered, so no
    // extra serialization edge is needed.
    writePlan(phaseDir, '03-01-PLAN.md', ['---', 'depends_on: []', 'files_modified:', '  - src/api.ts', '---', '## Task 1']);
    writePlan(phaseDir, '03-02-PLAN.md', ['---', 'depends_on:', '  - 03-01', 'files_modified:', '  - src/api.ts', '---', '## Task 1']);

    const result = runGsdTools('dag-runspec 03', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.deepStrictEqual(
      out.serialization_edges,
      [],
      'no serialization edge when the depends_on closure already orders the pair',
    );
  });

  test('serialization edge uses the transitive reachability closure (A→B→C, A and C collide)', () => {
    // Chain A→B→C; A and C both touch src/api.ts. C transitively depends on A,
    // so the pair is already ordered — no serialization edge.
    writePlan(phaseDir, '03-01-PLAN.md', ['---', 'depends_on: []', 'files_modified:', '  - src/api.ts', '---', '## Task 1']);
    writePlan(phaseDir, '03-02-PLAN.md', ['---', 'depends_on:', '  - 03-01', 'files_modified:', '  - src/other.ts', '---', '## Task 1']);
    writePlan(phaseDir, '03-03-PLAN.md', ['---', 'depends_on:', '  - 03-02', 'files_modified:', '  - src/api.ts', '---', '## Task 1']);

    const result = runGsdTools('dag-runspec 03', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.deepStrictEqual(
      out.serialization_edges,
      [],
      'C transitively depends on A through B — no serialization edge',
    );
  });

  // ── has_summary pruning (invariant 10) ─────────────────────────────────────
  test('complete plans land in skipped_complete, stay in the DAG, and are absent from incomplete', () => {
    writePlan(phaseDir, '03-01-PLAN.md', ['---', 'depends_on: []', '---', '## Task 1']);
    fs.writeFileSync(path.join(phaseDir, '03-01-SUMMARY.md'), '# Summary\n');
    writePlan(phaseDir, '03-02-PLAN.md', ['---', 'depends_on:', '  - 03-01', '---', '## Task 1']);

    const result = runGsdTools('dag-runspec 03', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.deepStrictEqual(out.skipped_complete, ['03-01'], 'completed plan is in skipped_complete');
    assert.deepStrictEqual(out.incomplete, ['03-02'], 'completed plan is NOT in incomplete');

    // It must remain a usable, satisfied predecessor: still a node, and 03-02's
    // edge to it is preserved.
    const complete = out.plans.find(p => p.id === '03-01');
    assert.ok(complete, 'completed plan is kept as a node in the DAG (not dropped)');
    assert.strictEqual(complete.has_summary, true, 'completed plan marked has_summary');
    const dependent = out.plans.find(p => p.id === '03-02');
    assert.deepStrictEqual(dependent.depends_on, ['03-01'], 'dependent still points at the satisfied predecessor');
  });

  // ── Cycle abort (invariant 8) ───────────────────────────────────────────────
  test('aborts (exit 1) on a depends_on cycle', () => {
    writePlan(phaseDir, '03-01-PLAN.md', ['---', 'depends_on:', '  - 03-02', '---', '## Task 1']);
    writePlan(phaseDir, '03-02-PLAN.md', ['---', 'depends_on:', '  - 03-01', '---', '## Task 1']);

    const result = runGsdTools('dag-runspec 03', tmpDir);
    assert.strictEqual(result.success, false, 'cycle must fail the command');
    assert.strictEqual(result.exitCode, 1, 'cycle exits non-zero');
    assert.match(result.error, /cycle/i, 'error message mentions the cycle');
  });

  // ── Shape / metadata ────────────────────────────────────────────────────────
  test('emits parallelization, runtime, and a resolved (or inherit) executor model', () => {
    writePlan(phaseDir, '03-01-PLAN.md', ['---', 'depends_on: []', '---', '## Task 1']);

    const result = runGsdTools('dag-runspec 03', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.strictEqual(typeof out.parallelization, 'boolean', 'parallelization is a bool from config');
    assert.ok('runtime' in out, 'runtime key is always present');
    const p1 = out.plans[0];
    assert.ok('model' in p1, 'each plan carries a model field');
    // Default (no config) → balanced profile → a resolved string, never undefined.
    assert.ok(p1.model === null || typeof p1.model === 'string', 'model is a string or null');
  });

  test('phase not found returns the empty run-spec shape (no throw)', () => {
    const result = runGsdTools('dag-runspec 99', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.strictEqual(out.error, 'Phase not found');
    assert.deepStrictEqual(out.plans, []);
    assert.deepStrictEqual(out.serialization_edges, []);
    assert.deepStrictEqual(out.incomplete, []);
    assert.deepStrictEqual(out.skipped_complete, []);
  });
});
