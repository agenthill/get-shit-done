/**
 * Unit tests for validation.derive / validation.check.
 *
 * validation.derive projects RESEARCH.md § Validation Architecture's
 * "Phase Requirements → Test Map" table into a populated VALIDATION.md
 * Per-Task Verification Map. validation.check asserts the subset chain
 * RESEARCH §Validation ⊆ VALIDATION rows ⊆ PLAN <verification> task-ids
 * and surfaces drift as WARNING findings.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validationDerive, validationCheck } from './validation.js';

// RESEARCH.md with a § Validation Architecture section carrying a 3-row
// "Phase Requirements → Test Map" table (the researcher's canonical format).
const RESEARCH_WITH_VA = `---
phase: 09-foundation
---

# Phase 09 — Research

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 3.x |
| Quick run command | \`npm test\` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| REQ-01 | parses the table | unit | \`npm test -- validation\` | ✅ |
| REQ-02 | emits populated rows | unit | \`npm test -- derive\` | ❌ Wave 0 |
| REQ-03 | rejects missing section | integration | \`npm test -- check\` | ✅ |

### Sampling Rate
- **Per task commit:** \`npm test\`
`;

const RESEARCH_NO_VA = `---
phase: 09-foundation
---

# Phase 09 — Research

## Findings

Nothing to validate here.
`;

let tmpDir: string;
let phaseDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'gsd-validation-'));
  phaseDir = join(tmpDir, '.planning', 'phases', '09-foundation');
  await mkdir(phaseDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('validationDerive', () => {
  it('projects RESEARCH §Validation Architecture rows into a populated VALIDATION.md map', async () => {
    await writeFile(join(phaseDir, '09-RESEARCH.md'), RESEARCH_WITH_VA);

    const r = await validationDerive(['9'], tmpDir);
    const d = r.data as {
      phase: string;
      rows: Array<{ requirement: string; behavior: string; test_type: string; command: string }>;
      content: string;
    };

    // Three behavior rows, fully populated (NOT placeholders).
    expect(d.rows).toHaveLength(3);
    expect(d.rows[0]).toMatchObject({
      requirement: 'REQ-01',
      behavior: 'parses the table',
      test_type: 'unit',
      command: 'npm test -- validation',
    });
    expect(d.rows[1].requirement).toBe('REQ-02');
    expect(d.rows[2].requirement).toBe('REQ-03');

    // Rendered VALIDATION.md content carries the populated Per-Task map,
    // not the placeholder template tokens.
    expect(d.content).toMatch(/Per-Task Verification Map/);
    expect(d.content).toMatch(/REQ-01/);
    expect(d.content).toMatch(/parses the table/);
    expect(d.content).toMatch(/npm test -- validation/);
    // None of the template placeholder tokens leak through.
    expect(d.content).not.toMatch(/REQ-\{XX\}/);
    expect(d.content).not.toMatch(/\{command\}/);
  });

  it('returns a clear reason (not a crash) when RESEARCH has no § Validation Architecture', async () => {
    await writeFile(join(phaseDir, '09-RESEARCH.md'), RESEARCH_NO_VA);

    const r = await validationDerive(['9'], tmpDir);
    const d = r.data as { rows: unknown[]; reason?: string };
    expect(d.rows).toEqual([]);
    expect(d.reason).toMatch(/Validation Architecture/i);
  });

  it('returns a clear reason when the phase has no RESEARCH.md', async () => {
    const r = await validationDerive(['9'], tmpDir);
    const d = r.data as { rows: unknown[]; reason?: string };
    expect(d.rows).toEqual([]);
    expect(d.reason).toBeTruthy();
  });
});

describe('validationCheck', () => {
  const VALIDATION_ALL_ROWS = `---
phase: 09-foundation
nyquist_compliant: false
---

## Per-Task Verification Map

| Task ID | Requirement | Behavior | Test Type | Command | Status |
|---------|-------------|----------|-----------|---------|--------|
| 09-01-01 | REQ-01 | parses the table | unit | \`npm test -- validation\` | ⬜ pending |
| 09-01-02 | REQ-02 | emits populated rows | unit | \`npm test -- derive\` | ⬜ pending |
| 09-01-03 | REQ-03 | rejects missing section | integration | \`npm test -- check\` | ⬜ pending |
`;

  const VALIDATION_MISSING_ROW = `---
phase: 09-foundation
---

## Per-Task Verification Map

| Task ID | Requirement | Behavior | Test Type | Command | Status |
|---------|-------------|----------|-----------|---------|--------|
| 09-01-01 | REQ-01 | parses the table | unit | \`npm test -- validation\` | ⬜ pending |
| 09-01-02 | REQ-02 | emits populated rows | unit | \`npm test -- derive\` | ⬜ pending |
`;

  const PLAN_ALL_TASKS = `---
phase: 09-foundation
plan: 01
---

<tasks>
<task type="auto"><name>parse</name><verify><automated>npm test -- validation</automated></verify></task>
<task type="auto"><name>emit</name><verify><automated>npm test -- derive</automated></verify></task>
<task type="auto"><name>reject</name><verify><automated>npm test -- check</automated></verify></task>
</tasks>

<verification>
- [ ] all green
</verification>
`;

  it('returns a drift WARNING naming a RESEARCH behavior with no VALIDATION row', async () => {
    await writeFile(join(phaseDir, '09-RESEARCH.md'), RESEARCH_WITH_VA);
    await writeFile(join(phaseDir, '09-VALIDATION.md'), VALIDATION_MISSING_ROW);
    await writeFile(join(phaseDir, '09-01-PLAN.md'), PLAN_ALL_TASKS);

    const r = await validationCheck(['9'], tmpDir);
    const d = r.data as { findings: Array<{ severity: string; message: string }>; aligned: boolean };

    expect(d.aligned).toBe(false);
    const warnings = d.findings.filter(f => f.severity === 'WARNING');
    expect(warnings.length).toBeGreaterThan(0);
    // The missing behavior (REQ-03 / "rejects missing section") is named.
    expect(warnings.some(w => /REQ-03|rejects missing section/.test(w.message))).toBe(true);
  });

  it('returns no warnings when RESEARCH ⊆ VALIDATION ⊆ PLAN are aligned', async () => {
    await writeFile(join(phaseDir, '09-RESEARCH.md'), RESEARCH_WITH_VA);
    await writeFile(join(phaseDir, '09-VALIDATION.md'), VALIDATION_ALL_ROWS);
    await writeFile(join(phaseDir, '09-01-PLAN.md'), PLAN_ALL_TASKS);

    const r = await validationCheck(['9'], tmpDir);
    const d = r.data as { findings: Array<{ severity: string; message: string }>; aligned: boolean };

    expect(d.findings.filter(f => f.severity === 'WARNING')).toHaveLength(0);
    expect(d.aligned).toBe(true);
  });
});
