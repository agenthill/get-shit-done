/**
 * validation.derive / validation.check — project & cross-check the Nyquist
 * validation map across a phase's RESEARCH.md, VALIDATION.md and PLAN.md.
 *
 * The Nyquist validation map is authored once by the researcher in
 * RESEARCH.md § Validation Architecture (the `### Phase Requirements → Test Map`
 * table) and was historically hand-copied into VALIDATION.md's Per-Task
 * Verification Map and again into each PLAN.md `<verification>`/`<automated>`
 * block — three transcriptions of one source of truth, a drift hazard.
 *
 * - `validation.derive <phase>` parses RESEARCH § Validation Architecture and
 *   emits a POPULATED VALIDATION.md Per-Task Verification Map (instead of the
 *   blank `templates/VALIDATION.md`). Task ids are not known at derive time
 *   (the planner assigns them), so the Task ID column is stamped with a
 *   clearly-marked placeholder rather than an invented id.
 * - `validation.check <phase>` is a read-only consistency gate: it asserts
 *   RESEARCH §Validation behaviors ⊆ VALIDATION rows ⊆ PLAN `<verification>`
 *   task-ids (with matching `<automated>` commands) and returns drift as
 *   WARNING findings.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { GSDError, ErrorClassification } from '../errors.js';
import { extractFrontmatter } from './frontmatter.js';
import {
  normalizePhaseName,
  comparePhaseNum,
  phaseTokenMatches,
  planningPaths,
} from './helpers.js';
import type { QueryHandler } from './utils.js';

// The required, greppable section header that gates derive/check — mirrors
// `grep -l "## Validation Architecture"` in workflows/plan-phase.md step 5.5.
const VALIDATION_ARCHITECTURE_HEADER = '## Validation Architecture';

interface DerivedRow {
  requirement: string;
  behavior: string;
  test_type: string;
  command: string;
}

interface Finding {
  severity: 'WARNING';
  message: string;
}

async function resolvePhaseDir(
  phase: string,
  projectDir: string,
  workstream?: string,
): Promise<string | null> {
  const phasesDir = planningPaths(projectDir, workstream).phases;
  const normalized = normalizePhaseName(phase);
  try {
    const entries = await readdir(phasesDir, { withFileTypes: true });
    const dirs = entries
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort((a, b) => comparePhaseNum(a, b));
    const match = dirs.find(d => phaseTokenMatches(d, normalized));
    return match ? join(phasesDir, match) : null;
  } catch {
    return null;
  }
}

async function readPhaseFile(
  phaseDir: string,
  suffix: string,
): Promise<{ name: string; content: string } | null> {
  try {
    const files = await readdir(phaseDir);
    const match = files.filter(f => f.endsWith(suffix)).sort()[0];
    if (!match) return null;
    return { name: match, content: await readFile(join(phaseDir, match), 'utf-8') };
  } catch {
    return null;
  }
}

/** Strip surrounding backticks/whitespace from a markdown table cell. */
function cleanCell(cell: string): string {
  return cell.trim().replace(/^`+|`+$/g, '').trim();
}

/**
 * Parse a GitHub-flavoured markdown table found under `headerRegex` into rows.
 * Returns the header cells and an array of data-row cell arrays (delimiter
 * row excluded). Stops at the next blank line or markdown header.
 */
function parseMarkdownTable(
  section: string,
  headerRegex: RegExp,
): { header: string[]; rows: string[][] } | null {
  const lines = section.split('\n');
  let i = lines.findIndex(l => headerRegex.test(l));
  if (i < 0) return null;
  // Advance to the first table row.
  while (i < lines.length && !lines[i].trim().startsWith('|')) i++;
  if (i >= lines.length) return null;

  const splitRow = (line: string): string[] =>
    line
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map(c => c.trim());

  const header = splitRow(lines[i]).map(cleanCell);
  i++;
  // Skip the `|---|---|` delimiter row.
  if (i < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i])) i++;

  const rows: string[][] = [];
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim().startsWith('|')) break;
    rows.push(splitRow(line).map(cleanCell));
  }
  return { header, rows };
}

/**
 * Extract the `### Phase Requirements → Test Map` table from RESEARCH.md's
 * § Validation Architecture section into structured behavior rows.
 *
 * Source columns (researcher contract): Req ID | Behavior | Test Type |
 * Automated Command | File Exists?. Template placeholder rows (`REQ-XX`,
 * `{behavior}`) are dropped so derive never emits skeleton noise.
 */
function extractValidationRows(researchContent: string): DerivedRow[] {
  const startIdx = researchContent.indexOf(VALIDATION_ARCHITECTURE_HEADER);
  if (startIdx < 0) return [];
  const section = researchContent.slice(startIdx);

  const table = parseMarkdownTable(section, /Phase Requirements\s*(?:→|->|to)\s*Test Map/i);
  if (!table) return [];

  const idx = (names: string[]): number =>
    table.header.findIndex(h => names.some(n => h.toLowerCase().includes(n)));
  const reqCol = idx(['req']);
  const behaviorCol = idx(['behavior']);
  const typeCol = idx(['test type', 'type']);
  const cmdCol = idx(['command', 'automated']);

  const rows: DerivedRow[] = [];
  for (const cells of table.rows) {
    const requirement = reqCol >= 0 ? cells[reqCol] ?? '' : '';
    const behavior = behaviorCol >= 0 ? cells[behaviorCol] ?? '' : '';
    const test_type = typeCol >= 0 ? cells[typeCol] ?? '' : '';
    const command = cmdCol >= 0 ? cells[cmdCol] ?? '' : '';
    // Drop the template skeleton row(s) — `REQ-XX` / `{behavior}` placeholders.
    if (!requirement || /^REQ-\{?XX\}?$/i.test(requirement) || /^\{.*\}$/.test(behavior)) continue;
    rows.push({ requirement, behavior, test_type, command });
  }
  return rows;
}

/**
 * Render a populated VALIDATION.md Per-Task Verification Map.
 *
 * Task IDs are unknown at derive time (the planner stamps them), so the
 * Task ID column carries an explicit `TBD-by-planner` placeholder rather than
 * an invented id. Every other column is populated from RESEARCH §Validation.
 */
function renderValidationMap(
  phaseNum: string,
  slug: string,
  date: string,
  rows: DerivedRow[],
): string {
  const lines: string[] = [
    '---',
    `phase: ${phaseNum}`,
    `slug: ${slug}`,
    'status: draft',
    'nyquist_compliant: false',
    'wave_0_complete: false',
    `created: ${date}`,
    '---',
    '',
    `# Phase ${phaseNum} — Validation Strategy`,
    '',
    '> Per-phase validation contract for feedback sampling during execution.',
    '> Per-Task map derived from RESEARCH.md § Validation Architecture via',
    '> `gsd-sdk query validation.derive`. The planner stamps the Task ID column.',
    '',
    '---',
    '',
    '## Per-Task Verification Map',
    '',
    '| Task ID | Requirement | Behavior | Test Type | Command | Status |',
    '|---------|-------------|----------|-----------|---------|--------|',
  ];
  for (const r of rows) {
    const cmd = r.command ? `\`${r.command}\`` : '';
    lines.push(
      `| TBD-by-planner | ${r.requirement} | ${r.behavior} | ${r.test_type} | ${cmd} | ⬜ pending |`,
    );
  }
  lines.push(
    '',
    '*Task ID `TBD-by-planner` — the planner replaces this with the owning task id during plan-phase.*',
    '*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*',
    '',
    '---',
    '',
    '## Validation Sign-Off',
    '',
    '- [ ] Every Per-Task row maps to a PLAN `<verification>` task with a matching `<automated>` command',
    '- [ ] No watch-mode flags',
    '- [ ] `nyquist_compliant: true` set in frontmatter',
    '',
    '**Approval:** {pending / approved YYYY-MM-DD}',
    '',
  );
  return lines.join('\n');
}

/**
 * `validation.derive <phase>`
 *
 * Parses `<phase>`'s RESEARCH.md § Validation Architecture and returns a
 * populated VALIDATION.md Per-Task Verification Map. The workflow writes
 * `data.content` to `${PHASE_DIR}/${PADDED_PHASE}-VALIDATION.md`.
 */
export const validationDerive: QueryHandler = async (args, projectDir, workstream) => {
  const phase = args[0];
  if (!phase) {
    throw new GSDError('phase required', ErrorClassification.Validation);
  }
  const normalized = normalizePhaseName(phase);
  const phaseDir = await resolvePhaseDir(phase, projectDir, workstream);
  if (!phaseDir) {
    return { data: { phase: normalized, rows: [] as DerivedRow[], reason: 'Phase not found' } };
  }

  const research = await readPhaseFile(phaseDir, '-RESEARCH.md');
  if (!research) {
    return { data: { phase: normalized, rows: [] as DerivedRow[], reason: 'No RESEARCH.md in phase' } };
  }
  if (!research.content.includes(VALIDATION_ARCHITECTURE_HEADER)) {
    return {
      data: {
        phase: normalized,
        rows: [] as DerivedRow[],
        reason: `RESEARCH.md has no "${VALIDATION_ARCHITECTURE_HEADER}" section`,
      },
    };
  }

  const rows = extractValidationRows(research.content);
  if (rows.length === 0) {
    return {
      data: {
        phase: normalized,
        rows,
        reason: 'Validation Architecture section has no parseable "Phase Requirements → Test Map" rows',
      },
    };
  }

  const fm = extractFrontmatter(research.content) as Record<string, unknown>;
  const slug = typeof fm.slug === 'string' && fm.slug
    ? fm.slug
    : String(fm.phase ?? normalized).replace(/^\d+-?/, '') || normalized;
  const date = new Date().toISOString().split('T')[0];
  const content = renderValidationMap(normalized, slug, date, rows);

  return { data: { phase: normalized, rows, content, source: research.name } };
};

/** Extract the Requirement column values from VALIDATION.md's Per-Task map. */
function extractValidationRequirements(validationContent: string): Set<string> {
  const table = parseMarkdownTable(validationContent, /Per-Task Verification Map/i);
  const reqs = new Set<string>();
  if (!table) return reqs;
  const reqCol = table.header.findIndex(h => h.toLowerCase().includes('requirement'));
  if (reqCol < 0) return reqs;
  for (const cells of table.rows) {
    const req = cells[reqCol];
    if (req && !/^REQ-\{?XX\}?$/i.test(req)) reqs.add(req);
  }
  return reqs;
}

/** Extract every `<automated>` command across all PLAN.md files in a phase. */
async function extractPlanCommands(phaseDir: string): Promise<Set<string>> {
  const commands = new Set<string>();
  let files: string[];
  try {
    files = await readdir(phaseDir);
  } catch {
    return commands;
  }
  const planFiles = files.filter(f => f.endsWith('-PLAN.md') || f === 'PLAN.md').sort();
  for (const planFile of planFiles) {
    const content = await readFile(join(phaseDir, planFile), 'utf-8');
    const re = /<automated>([\s\S]*?)<\/automated>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const cmd = cleanCell(m[1]);
      if (cmd) commands.add(cmd);
    }
  }
  return commands;
}

/**
 * `validation.check <phase>` (read-only)
 *
 * Asserts the subset chain RESEARCH §Validation behaviors ⊆ VALIDATION rows ⊆
 * PLAN `<automated>` commands. Drift surfaces as WARNING findings; never
 * throws on drift (it's an advisory gate).
 */
export const validationCheck: QueryHandler = async (args, projectDir, workstream) => {
  const phase = args[0];
  if (!phase) {
    throw new GSDError('phase required', ErrorClassification.Validation);
  }
  const normalized = normalizePhaseName(phase);
  const phaseDir = await resolvePhaseDir(phase, projectDir, workstream);
  if (!phaseDir) {
    return { data: { phase: normalized, aligned: true, findings: [] as Finding[], reason: 'Phase not found' } };
  }

  const research = await readPhaseFile(phaseDir, '-RESEARCH.md');
  const findings: Finding[] = [];

  if (!research || !research.content.includes(VALIDATION_ARCHITECTURE_HEADER)) {
    // No Validation Architecture → nothing to cross-check (Nyquist not in play).
    return {
      data: {
        phase: normalized,
        aligned: true,
        findings,
        reason: 'No RESEARCH § Validation Architecture — nothing to cross-check',
      },
    };
  }

  const researchRows = extractValidationRows(research.content);
  const validation = await readPhaseFile(phaseDir, '-VALIDATION.md');
  const validationReqs = validation
    ? extractValidationRequirements(validation.content)
    : new Set<string>();
  const planCommands = await extractPlanCommands(phaseDir);

  if (!validation) {
    findings.push({
      severity: 'WARNING',
      message: 'RESEARCH § Validation Architecture present but no VALIDATION.md — run validation.derive',
    });
  }

  // RESEARCH behaviors ⊆ VALIDATION rows.
  for (const row of researchRows) {
    if (!validationReqs.has(row.requirement)) {
      findings.push({
        severity: 'WARNING',
        message: `RESEARCH behavior "${row.behavior}" (${row.requirement}) has no VALIDATION.md row`,
      });
    }
  }

  // VALIDATION/RESEARCH commands ⊆ PLAN <automated> commands.
  for (const row of researchRows) {
    if (!row.command) continue;
    if (!planCommands.has(row.command)) {
      findings.push({
        severity: 'WARNING',
        message: `Command for ${row.requirement} ("${row.command}") has no matching <automated> in any PLAN.md`,
      });
    }
  }

  const warnings = findings.filter(f => f.severity === 'WARNING');
  return { data: { phase: normalized, aligned: warnings.length === 0, findings } };
};
