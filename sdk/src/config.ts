/**
 * Config reader — loads `.planning/config.json` and merges with defaults.
 *
 * Mirrors the default structure from `get-shit-done/bin/lib/config.cjs`
 * `buildNewProjectConfig()`.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { relPlanningPath } from './workstream-utils.js';
import {
  CONFIG_DEFAULTS as CANONICAL_CONFIG_DEFAULTS,
  mergeDefaults as canonicalMergeDefaults,
  normalizeLegacyKeys,
} from './configuration/index.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface GitConfig {
  branching_strategy: string;
  phase_branch_template: string;
  milestone_branch_template: string;
  quick_branch_template: string | null;
  /** Protected branch the SDK execution engine merges plan deltas onto; null = autodetect origin/HEAD (try main, then master, then current branch). Mirrors the manifest's existing git.base_branch key. */
  base_branch?: string | null;
  /**
   * ADR 0013 option 3. When true (and the runtime is Claude), the SDK phase
   * runner injects the real git-backed execution engine: per-plan worktree
   * isolation + a single-writer merge serializer + a real build+test gate
   * (invariant 3). Default false preserves today's in-process, shared-cwd,
   * always-pass no-op path byte-for-byte. Gated by a fail-closed worktree
   * capability pre-flight that THROWS (never silently falls back) when git
   * worktree isolation is unavailable.
   */
  sdk_worktree_execution?: boolean;
  /**
   * ADR 0013 option 3. Test command for the real build+test gate when
   * `sdk_worktree_execution` is on. When null/absent, falls back to `npm test`
   * if a package.json with a `test` script exists, else the gate is a no-op
   * pass. Run via execFile in the post-merge protected checkout; a timeout
   * returns exit 124 (inconclusive ≠ pass).
   */
  sdk_test_command?: string | null;
  /**
   * ADR 0013 option 4 (autonomous cross-phase + rollback). Maximum total
   * attempts for a single phase before the autonomous driver HALTS for a human.
   * Each GENUINE (non-transient) failure rolls the phase back (Tier-1) and
   * re-runs it with the accumulated prior-failure context injected, up to this
   * cap. Transient/quota failures resume the same phase via WAITING.json and do
   * NOT consume an attempt. Absent/null → default 5.
   */
  sdk_max_phase_attempts?: number | null;
}

/**
 * ADR 0014 nested parallelization config (D5). `enabled` is the master switch
 * (the flat `parallelization: false` form is still accepted for back-compat).
 * `phase_level` opts into cross-phase wave parallelism (GSD.runParallel).
 * `max_concurrent_phases` sub-budgets the ONE global agent semaphore.
 */
export interface ParallelizationConfig {
  enabled?: boolean;
  phase_level?: boolean;
  max_concurrent_phases?: number;
}

export interface WorkflowConfig {
  research: boolean;
  plan_check: boolean;
  verifier: boolean;
  nyquist_validation: boolean;
  /** Mirrors gsd-tools flat `config.tdd_mode` (from `workflow.tdd_mode`). */
  tdd_mode: boolean;
  /**
   * Issue #3309. `end-of-phase` (default) suppresses mid-flight
   * `<task type="checkpoint:human-verify">` task emission; the planner
   * embeds verification details into the relevant `auto` task's
   * `<verify><human-check>` block and the verifier harvests them at
   * end-of-phase into the existing HUMAN-UAT.md path. `mid-flight`
   * restores the pre-#3309 behavior where the executor halts at each
   * `checkpoint:human-verify` task and pays a full executor cold-start
   * cost (CLAUDE.md, MEMORY.md, STATE.md, plan re-read on respawn) per
   * round-trip.
   */
  human_verify_mode: 'mid-flight' | 'end-of-phase';
  auto_advance: boolean;
  /** Internal auto-chain flag used by workflow routing. */
  _auto_chain_active?: boolean;
  node_repair: boolean;
  node_repair_budget: number;
  ui_phase: boolean;
  ui_safety_gate: boolean;
  text_mode: boolean;
  research_before_questions: boolean;
  discuss_mode: string;
  skip_discuss: boolean;
  /** Maximum self-discuss passes in auto/headless mode before forcing proceed. Default: 3. */
  max_discuss_passes: number;
  /** Subagent timeout in ms (matches `get-shit-done/bin/lib/core.cjs` default 300000). */
  subagent_timeout: number;
  /**
   * Issue #2492. When true (default), enforces that every trackable decision in
   * CONTEXT.md `<decisions>` is referenced by at least one plan (translation
   * gate, blocking) and reports decisions not honored by shipped artifacts at
   * verify-phase (validation gate, non-blocking). Set false to disable both.
   */
  context_coverage_gate: boolean;
}

export interface HooksConfig {
  context_warnings: boolean;
}

export interface GSDConfig {
  model_profile: string;
  commit_docs: boolean;
  parallelization: boolean | ParallelizationConfig;
  search_gitignored: boolean;
  brave_search: boolean;
  firecrawl: boolean;
  exa_search: boolean;
  git: GitConfig;
  workflow: WorkflowConfig;
  hooks: HooksConfig;
  agent_skills: Record<string, unknown>;
  /** Project slug for branch templates; mirrors gsd-tools `config.project_code`. */
  project_code?: string | null;
  /** Interactive vs headless; mirrors gsd-tools flat `config.mode`. */
  mode?: string;
  [key: string]: unknown;
}

// ─── Defaults ────────────────────────────────────────────────────────────────

/**
 * Canonical CONFIG_DEFAULTS delegated to the Configuration Module (ADR-3524).
 * Cast to GSDConfig to preserve typed access for existing consumers.
 * The canonical manifest may include additional keys beyond GSDConfig's
 * declared fields (e.g. resolve_model_ids, context_window, planning.*,
 * ship.*, workflow.security_*, workflow.code_review_*); these are accessible
 * via the [key: string]: unknown index signature on GSDConfig.
 *
 * BEHAVIOR CHANGE (Cycle 3, #3536): CONFIG_DEFAULTS now includes all keys from
 * sdk/shared/config-defaults.manifest.json. Keys added vs old inline literal:
 *   top-level: resolve_model_ids (false), context_window (200000),
 *               phase_naming ('sequential'), claude_md_path ('./CLAUDE.md')
 *   git: create_tag (true), base_branch (null)
 *   workflow: ai_integration_phase (true), code_review (true),
 *             code_review_depth ('standard'), code_review_command (null),
 *             pattern_mapper (true), plan_bounce (false), plan_bounce_script (null),
 *             plan_bounce_passes (2), auto_prune_state (false),
 *             post_planning_gaps (true), security_enforcement (true),
 *             security_asvs_level (1), security_block_on ('high'),
 *             context_coverage_gate: true (unchanged from old literal)
 *   planning: { commit_docs: true, search_gitignored: false, sub_repos: [], granularity: 'standard' }
 *   hooks: workflow_guard (false)
 *   ship: { pr_body_sections: [] }
 */
export const CONFIG_DEFAULTS: GSDConfig = CANONICAL_CONFIG_DEFAULTS as unknown as GSDConfig;

// ─── Loader ──────────────────────────────────────────────────────────────────

/**
 * Load project config from `.planning/config.json`, merging with defaults.
 * When project config is missing or empty, this returns `mergeDefaults({})`
 * (built-in defaults only; no `~/.gsd/defaults.json` layering).
 * Throws on malformed JSON with a helpful error message.
 */
export async function loadConfig(projectDir: string, workstream?: string): Promise<GSDConfig> {
  const configPath = join(projectDir, relPlanningPath(workstream), 'config.json');
  const rootConfigPath = join(projectDir, '.planning', 'config.json');

  let raw: string;
  let projectConfigFound = false;
  try {
    raw = await readFile(configPath, 'utf-8');
    projectConfigFound = true;
  } catch {
    // If workstream config missing, fall back to root config
    if (workstream) {
      try {
        raw = await readFile(rootConfigPath, 'utf-8');
        projectConfigFound = true;
      } catch {
        raw = '';
      }
    } else {
      raw = '';
    }
  }

  // Pre-project context: no .planning/config.json exists.
  // Use built-in defaults only so SDK query parity stays stable across machines.
  if (!projectConfigFound) {
    return mergeDefaults({});
  }

  const trimmed = raw.trim();
  if (trimmed === '') {
    // Empty project config — treat as no project config.
    return mergeDefaults({});
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse config at ${configPath}: ${msg}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Config at ${configPath} must be a JSON object`);
  }

  // Project config exists — user-level defaults are ignored (CJS parity).
  // `buildNewProjectConfig` already baked them into config.json at /gsd-new-project.
  // Normalize legacy top-level keys (branching_strategy → git.branching_strategy, etc.)
  // before merging with defaults, matching the Configuration Module's loadConfig pipeline.
  const { parsed: normalized } = normalizeLegacyKeys(parsed);
  return mergeDefaults(normalized);
}

/**
 * Merge config with defaults using the Configuration Module's deep-merge.
 * Delegates to canonicalMergeDefaults (ADR-3524, Cycle 3, #3536).
 *
 * BEHAVIOR CHANGE (Cycle 3, #3536): The old implementation used spread-per-section
 * (shallow merge for git/workflow/hooks/agent_skills, spread for top-level).
 * The new implementation uses recursive deep-merge via canonicalMergeDefaults,
 * which means partial nested objects (e.g. { workflow: { research: false } })
 * are now deep-merged rather than replacing the entire section's defaults.
 * The practical difference: deep-merge preserves sibling default keys within
 * nested sections even when the overlay only specifies one key — which was
 * already the intended behavior of the old spread-per-section approach.
 * Legacy branching_strategy top-level → git.branching_strategy normalization
 * is now handled by normalizeLegacyKeys inside canonicalMergeDefaults's pipeline
 * (via loadConfig); for the raw mergeDefaults path, legacy key handling is
 * delegated to the canonical module.
 */
function mergeDefaults(parsed: Record<string, unknown>): GSDConfig {
  return canonicalMergeDefaults(parsed) as unknown as GSDConfig;
}

// ─── ADR 0014 parallelization resolvers (D5) ───────────────────────────────────
//
// `parallelization` is `true` by default in the manifest (a plain boolean) and
// stays that way so existing flat-boolean / string-projection consumers
// (init.ts, state-project-load.ts, config.test.ts) are unchanged. A user opts
// into cross-phase parallelism by writing the NESTED object form in config.json:
//   { "parallelization": { "enabled": true, "phase_level": true, "max_concurrent_phases": 5 } }
// These resolvers accept EITHER form, so the manifest default need not change.

/** Read `parallelization.phase_level` (ADR 0014 D5). Flat-boolean form → false. */
export function resolvePhaseLevelParallelism(config: GSDConfig): boolean {
  const p = config.parallelization as boolean | ParallelizationConfig;
  return typeof p === 'object' && p !== null ? p.phase_level === true : false;
}

/** Read `parallelization.max_concurrent_phases` (ADR 0014 D5). Default 3. */
export function resolveMaxConcurrentPhases(config: GSDConfig): number {
  const p = config.parallelization as boolean | ParallelizationConfig;
  const n = typeof p === 'object' && p !== null ? p.max_concurrent_phases : undefined;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 3;
}

/** True unless parallelization is explicitly disabled (flat `false` or `enabled:false`). */
export function resolvePlanLevelParallel(config: GSDConfig): boolean {
  const p = config.parallelization as boolean | ParallelizationConfig;
  if (p === false) return false;
  if (typeof p === 'object' && p !== null) return p.enabled !== false;
  return true;
}
