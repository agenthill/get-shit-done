'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { composeReview } = require('../get-shit-done/bin/lib/compose-review.cjs');

const FIXED_TS = '2026-05-29T12:00:00Z';

function meta(extra) {
  return Object.assign(
    {
      phase: '02-code-review-command',
      padded_phase: '02',
      depth: 'standard',
      filesReviewed: ['src/a.ts', 'src/b.ts'],
      reviewedAt: FIXED_TS,
    },
    extra || {},
  );
}

function finding(extra) {
  return Object.assign(
    {
      severity: 'warning',
      file: 'src/a.ts',
      line: '42',
      title: 'Some issue',
      issue: 'Description of the problem',
      fix: 'Do the thing',
    },
    extra || {},
  );
}

// --- Byte-compat parsers: replicate the EXACT logic present_results /
// code-review-fix.md / commit_review use against REVIEW.md, so the test
// falsifies any drift from the contract those consumers parse. ---

// present_results / commit_review: frontmatter is the FIRST `---\n...\n---` block.
function extractFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\n---/);
  return match ? match[1] : null;
}

// present_results bash: STATUS=$(grep "^status:" | cut -d: -f2 | xargs)
function grepField(frontmatter, key) {
  const line = frontmatter.split('\n').find((l) => l.startsWith(`${key}:`));
  if (!line) return null;
  return line.slice(line.indexOf(':') + 1).trim();
}

// present_results bash for nested severity counts:
//   CRITICAL=$(grep -E "^[[:space:]]*(critical|blocker):" | head -1 | cut -d: -f2 | xargs)
function grepNestedCount(frontmatter, key) {
  const re = new RegExp(`^\\s*${key}:`);
  const line = frontmatter.split('\n').find((l) => re.test(l));
  if (!line) return null;
  return line.slice(line.indexOf(':') + 1).trim();
}

// code-review-fix.md files_reviewed_list (YAML list form) extractor, verbatim logic.
function extractFilesReviewedList(frontmatter) {
  const out = [];
  let inList = false;
  for (const line of frontmatter.split('\n')) {
    if (/files_reviewed_list:/.test(line)) {
      inList = true;
      continue;
    }
    if (inList && /^\s+-\s+(.+)/.test(line)) {
      out.push(line.match(/^\s+-\s+(.+)/)[1].trim());
    } else if (inList && /^\S/.test(line)) {
      break;
    }
  }
  return out;
}

describe('composeReview frontmatter', () => {
  it('emits status, files_reviewed_list, and severity counts matching input', () => {
    const out = composeReview(
      [finding({ severity: 'critical' }), finding({ severity: 'warning' }), finding({ severity: 'info' })],
      meta(),
    );
    const fm = extractFrontmatter(out);
    assert.ok(fm, 'frontmatter block must be present and parseable');

    assert.equal(grepField(fm, 'status'), 'issues_found');
    assert.equal(grepField(fm, 'reviewed'), FIXED_TS);
    assert.equal(grepField(fm, 'depth'), 'standard');
    assert.equal(grepField(fm, 'files_reviewed'), '2');

    assert.equal(grepNestedCount(fm, 'critical'), '1');
    assert.equal(grepNestedCount(fm, 'warning'), '1');
    assert.equal(grepNestedCount(fm, 'info'), '1');
    assert.equal(grepNestedCount(fm, 'total'), '3');

    assert.deepEqual(extractFilesReviewedList(fm), ['src/a.ts', 'src/b.ts']);
  });
});

describe('composeReview finding grouping + numbering', () => {
  it('numbers two criticals CR-01, CR-02 and tier-specific prefixes', () => {
    const out = composeReview(
      [
        finding({ severity: 'critical', title: 'First crit' }),
        finding({ severity: 'critical', title: 'Second crit' }),
        finding({ severity: 'warning', title: 'A warn' }),
        finding({ severity: 'info', title: 'An info' }),
      ],
      meta(),
    );

    assert.match(out, /^### CR-01: First crit/m);
    assert.match(out, /^### CR-02: Second crit/m);
    assert.match(out, /^### WR-01: A warn/m);
    assert.match(out, /^### IN-01: An info/m);

    // Severity section headings present in canonical form.
    assert.match(out, /^## Critical Issues$/m);
    assert.match(out, /^## Warnings$/m);
    assert.match(out, /^## Info$/m);
  });

  it('renders File / Issue / Fix fields per finding (fixer parser contract)', () => {
    const out = composeReview([finding({ severity: 'critical', file: 'src/x.ts', line: '7' })], meta());
    assert.match(out, /^### CR-01: /m);
    assert.match(out, /\*\*File:\*\* `src\/x\.ts:7`/);
    assert.match(out, /\*\*Issue:\*\* Description of the problem/);
    assert.match(out, /\*\*Fix:\*\* Do the thing/);
  });
});

describe('composeReview empty findings', () => {
  it('status: clean and no severity sections', () => {
    const out = composeReview([], meta());
    const fm = extractFrontmatter(out);
    assert.equal(grepField(fm, 'status'), 'clean');
    assert.equal(grepNestedCount(fm, 'total'), '0');

    assert.doesNotMatch(out, /^## Critical Issues$/m);
    assert.doesNotMatch(out, /^## Warnings$/m);
    assert.doesNotMatch(out, /^## Info$/m);
    assert.doesNotMatch(out, /^### CR-/m);
    // clean reviews still carry the files_reviewed_list scope for --auto.
    assert.deepEqual(extractFilesReviewedList(fm), ['src/a.ts', 'src/b.ts']);
  });
});

describe('composeReview byte-compat falsifier (present_results parser)', () => {
  it('the composed output, parsed by present_results regex, yields expected values', () => {
    const out = composeReview(
      [finding({ severity: 'critical' }), finding({ severity: 'warning' })],
      meta({ filesReviewed: ['src/only.ts'] }),
    );
    const fm = extractFrontmatter(out);
    assert.ok(fm, 'frontmatter must match /^---\\n([\\s\\S]*?)\\n---/');

    // commit_review HAS_STATUS check: frontmatter contains status:
    assert.match(fm, /status:/);
    // present_results field extraction
    assert.equal(grepField(fm, 'status'), 'issues_found');
    assert.equal(grepField(fm, 'files_reviewed'), '1');
    assert.equal(grepNestedCount(fm, 'critical'), '1');
    assert.equal(grepNestedCount(fm, 'warning'), '1');
    assert.equal(grepNestedCount(fm, 'info'), '0');
    assert.equal(grepNestedCount(fm, 'total'), '2');

    // present_results top-issues preview: grep -A 3 "^### CR-\|^### BL-\|^### WR-"
    const previewRe = /^### CR-|^### BL-|^### WR-/m;
    assert.match(out, previewRe, 'composed body must contain ### CR-/### WR- headings for the inline preview');
  });
});

describe('composeReview structural findings ordering', () => {
  it('Structural Findings (fallow) appears before Narrative Findings', () => {
    const structural = JSON.stringify({ unused_exports: ['src/a.ts#foo'] });
    const out = composeReview([finding({ severity: 'warning' })], meta({ structuralFindings: structural }));

    const structuralIdx = out.indexOf('## Structural Findings (fallow)');
    const narrativeIdx = out.indexOf('## Narrative Findings (AI reviewer)');
    assert.ok(structuralIdx !== -1, 'structural section must be present');
    assert.ok(narrativeIdx !== -1, 'narrative section must be present');
    assert.ok(structuralIdx < narrativeIdx, 'structural must precede narrative');
    // The fallow JSON payload is surfaced.
    assert.match(out, /unused_exports/);
  });

  it('omits the structural section when no structural findings supplied', () => {
    const out = composeReview([finding({ severity: 'info' })], meta());
    assert.doesNotMatch(out, /## Structural Findings \(fallow\)/);
  });
});
