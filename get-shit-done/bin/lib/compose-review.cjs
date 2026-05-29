'use strict';

/**
 * Deterministic REVIEW.md composer for the code-review dimension fan-out
 * (ADR 0013, "Rollout template" — review-dimension fan-out).
 *
 * In the fan-out model the three read-only dimension agents (bugs/logic,
 * security, code-quality) RETURN findings via schema and write nothing; the
 * orchestrator owns the single write of REVIEW.md. This module is that write:
 * a PURE, dependency-free (node builtins only) assembler that turns the
 * aggregated findings into a REVIEW.md byte-compatible with what
 * gsd-code-reviewer.md authored before (write_review step) — so the existing
 * present_results parser and the --fix / --auto pipeline (which parse
 * `CR-`/`WR-`/`IN-` finding IDs, `files_reviewed_list`, severity counts, and
 * `status`) keep working unchanged.
 *
 * Source of truth for the emitted shape: agents/gsd-code-reviewer.md
 * `write_review` (frontmatter + body headings ## Critical Issues / ## Warnings
 * / ## Info with `### CR-01:` / `### WR-01:` / `### IN-01:` finding blocks).
 */

const fs = require('fs');

/**
 * @typedef {Object} Finding
 * @property {'critical'|'warning'|'info'} severity
 * @property {string} file
 * @property {string} line
 * @property {string} title
 * @property {string} issue
 * @property {string} fix
 * @property {string} [dimension]  bugs | security | quality (advisory tag)
 */

/**
 * @typedef {Object} ComposeMeta
 * @property {string|number} phase            phase identifier (e.g. "02-name" or 2)
 * @property {string} [padded_phase]          zero-padded phase number (e.g. "02")
 * @property {'quick'|'standard'|'deep'} depth
 * @property {string[]} filesReviewed         exact file scope (REQUIRED for --auto)
 * @property {string|object} [structuralFindings]  fallow JSON (string or parsed)
 * @property {string} [reviewedAt]            ISO timestamp; defaults to now
 */

const SEVERITY_TIERS = [
  { key: 'critical', prefix: 'CR', heading: '## Critical Issues' },
  { key: 'warning', prefix: 'WR', heading: '## Warnings' },
  { key: 'info', prefix: 'IN', heading: '## Info' },
];

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Compose a byte-compatible REVIEW.md from aggregated fan-out findings.
 *
 * @param {Finding[]} findings
 * @param {ComposeMeta} meta
 * @returns {string} full REVIEW.md content
 */
function composeReview(findings, meta) {
  const list = Array.isArray(findings) ? findings : [];
  const filesReviewed = Array.isArray(meta && meta.filesReviewed) ? meta.filesReviewed : [];
  const depth = (meta && meta.depth) || 'standard';
  const phase = meta && meta.phase != null ? meta.phase : '';
  const reviewedAt = (meta && meta.reviewedAt) || new Date().toISOString();

  // Group findings into severity tiers, preserving input order within a tier.
  const byTier = { critical: [], warning: [], info: [] };
  for (const f of list) {
    const sev = f && byTier[f.severity] ? f.severity : 'info';
    byTier[sev].push(f);
  }

  const counts = {
    critical: byTier.critical.length,
    warning: byTier.warning.length,
    info: byTier.info.length,
    total: byTier.critical.length + byTier.warning.length + byTier.info.length,
  };
  const status = counts.total === 0 ? 'clean' : 'issues_found';

  const structural = normalizeStructural(meta && meta.structuralFindings);

  // --- YAML frontmatter (must match gsd-code-reviewer.md write_review) ---
  const fm = [];
  fm.push('---');
  fm.push(`phase: ${phase}`);
  fm.push(`reviewed: ${reviewedAt}`);
  fm.push(`depth: ${depth}`);
  fm.push(`files_reviewed: ${filesReviewed.length}`);
  fm.push('files_reviewed_list:');
  for (const file of filesReviewed) fm.push(`  - ${file}`);
  fm.push('findings:');
  fm.push(`  critical: ${counts.critical}`);
  fm.push(`  warning: ${counts.warning}`);
  fm.push(`  info: ${counts.info}`);
  fm.push(`  total: ${counts.total}`);
  fm.push(`status: ${status}`);
  fm.push('---');

  // --- Body ---
  const body = [];
  body.push('');
  body.push(`# Phase ${phase}: Code Review Report`);
  body.push('');
  body.push(`**Reviewed:** ${reviewedAt}`);
  body.push(`**Depth:** ${depth}`);
  body.push(`**Files Reviewed:** ${filesReviewed.length}`);
  body.push(`**Status:** ${status}`);
  body.push('');
  body.push('## Summary');
  body.push('');
  body.push(summaryLine(filesReviewed.length, depth, counts));
  body.push('');
  if (status === 'clean') {
    body.push('All reviewed files meet quality standards. No issues found.');
    body.push('');
  }

  // Structural substrate (fallow) BEFORE the narrative section.
  if (structural) {
    body.push('## Structural Findings (fallow)');
    body.push('');
    body.push('```json');
    body.push(structural);
    body.push('```');
    body.push('');
  }

  if (status !== 'clean') {
    body.push('## Narrative Findings (AI reviewer)');
    body.push('');
    for (const tier of SEVERITY_TIERS) {
      const tierFindings = byTier[tier.key];
      if (tierFindings.length === 0) continue; // omit empty severity sections
      body.push(tier.heading);
      body.push('');
      tierFindings.forEach((f, idx) => {
        const id = `${tier.prefix}-${pad2(idx + 1)}`;
        body.push(...renderFinding(id, f));
      });
    }
  }

  // Footer.
  body.push('---');
  body.push('');
  body.push(`_Reviewed: ${reviewedAt}_`);
  body.push('_Reviewer: Claude (gsd-code-reviewer dimension fan-out)_');
  body.push(`_Depth: ${depth}_`);
  body.push('');

  return fm.join('\n') + '\n' + body.join('\n');
}

function summaryLine(fileCount, depth, counts) {
  return (
    `Reviewed ${fileCount} file${fileCount === 1 ? '' : 's'} at ${depth} depth. ` +
    `Findings: ${counts.critical} critical, ${counts.warning} warning, ${counts.info} info ` +
    `(${counts.total} total).`
  );
}

/**
 * Render one finding block matching gsd-code-reviewer.md body shape so the
 * `grep -A 3 "^### CR-\\|^### BL-\\|^### WR-"` preview and the fixer's
 * `### {ID}: {Title}` / **File:** / **Issue:** / **Fix:** parser both match.
 */
function renderFinding(id, f) {
  const file = f && f.file ? String(f.file) : '';
  const line = f && f.line != null && String(f.line).length ? String(f.line) : '';
  const fileRef = line ? `${file}:${line}` : file;
  const lines = [];
  const dim = f && f.dimension ? ` (${f.dimension})` : '';
  lines.push(`### ${id}: ${(f && f.title) || 'Untitled finding'}${dim}`);
  lines.push('');
  lines.push(`**File:** \`${fileRef}\``);
  lines.push(`**Issue:** ${(f && f.issue) || ''}`);
  lines.push(`**Fix:** ${(f && f.fix) || ''}`);
  lines.push('');
  return lines;
}

/**
 * Normalize a structural-findings input (string JSON, object, or empty) into a
 * pretty-printed JSON string, or '' when there is nothing to surface. Never
 * throws — a malformed string is surfaced verbatim rather than crashing the
 * single orchestrator write.
 */
function normalizeStructural(structural) {
  if (structural == null) return '';
  if (typeof structural === 'string') {
    const trimmed = structural.trim();
    if (!trimmed) return '';
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      return trimmed;
    }
  }
  if (typeof structural === 'object') {
    try {
      return JSON.stringify(structural, null, 2);
    } catch {
      return '';
    }
  }
  return '';
}

/**
 * Thin I/O wrapper: read the fan-out findings JSON, read the optional fallow
 * structural JSON, compose, and write REVIEW.md. The orchestrator is the single
 * writer — this is the only fs.write in the path.
 *
 * @param {Object} opts
 * @param {string} opts.findingsPath           path to .code-review-findings.json
 * @param {string} opts.reviewPath             output REVIEW.md path
 * @param {string|number} opts.phase
 * @param {string} [opts.padded_phase]
 * @param {string} opts.depth
 * @param {string[]} opts.filesReviewed
 * @param {string} [opts.structuralFindingsPath]  path to FALLOW.json ('' to skip)
 * @param {string} [opts.reviewedAt]
 */
function composeReviewToFile(opts) {
  const o = opts || {};
  const raw = fs.readFileSync(o.findingsPath, 'utf-8');
  const parsed = JSON.parse(raw);
  const findings = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed && parsed.findings)
      ? parsed.findings
      : [];

  let structuralFindings = '';
  if (o.structuralFindingsPath && String(o.structuralFindingsPath).trim()) {
    try {
      structuralFindings = fs.readFileSync(o.structuralFindingsPath, 'utf-8');
    } catch {
      structuralFindings = '';
    }
  }

  const content = composeReview(findings, {
    phase: o.phase,
    padded_phase: o.padded_phase,
    depth: o.depth,
    filesReviewed: Array.isArray(o.filesReviewed) ? o.filesReviewed : [],
    structuralFindings,
    reviewedAt: o.reviewedAt,
  });

  fs.writeFileSync(o.reviewPath, content);
}

module.exports = { composeReview, composeReviewToFile };
