/**
 * Rollback retry ledger (ADR 0013 option 4, chunk 2 — autonomous cross-phase +
 * rollback). Persists the autonomous driver's per-phase retry state at
 * `.planning/ROLLBACK.json` so a human (and chunk 4's crash-resume) can see what
 * failed, how many times, and whether the driver halted.
 *
 * Shape is intentionally EXTENSIBLE: chunk 4 adds per-step crash-resume
 * done-flags here (a `steps` map). This module owns only the attempt/failure
 * bookkeeping; it does NOT implement crash-mid-rollback resume.
 *
 * Single-writer: only the orchestrator's driver writes this, sequentially.
 */

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { PhaseFailureContext } from '../types.js';

export type RollbackLedgerStatus = 'retrying' | 'halted';

export interface RollbackLedger {
  /** The phase the driver is retrying / halted on. */
  failed_phase: string;
  /** Total attempts made so far (1-based; incremented before each re-run). */
  attempt_count: number;
  /** Per-attempt failure records, accumulated oldest-first. */
  failure_context: PhaseFailureContext[];
  /** 'retrying' while attempts remain; 'halted' once the cap is hit. */
  status: RollbackLedgerStatus;
  /**
   * Rollback tier this ledger records (chunk 3). Absent/1 = a Tier-1 retry
   * ledger (chunk 2). 2 = a Tier-2 cascade unwound a promoted predecessor — a
   * fail-closed HALT for a human (reverting promoted work unattended is
   * halt-worthy). Additive so chunk-2 writers stay valid.
   */
  tier?: 1 | 2;
  /**
   * For a Tier-2 ledger: the promoted predecessor phases the cascade reverted,
   * in the REVERSE promotion order they were reverted. Absent for Tier-1.
   */
  cascade_set?: string[];
  /**
   * Per-step crash-resume journal (ADR 0013 option 4, chunk 4). Keyed by the
   * REVERTED phase number; each value is the done-flags for that phase's Tier-2
   * unwind, persisted IMMEDIATELY after each step succeeds so a crash mid-Tier-2
   * leaves flags 1..N set and the resume entry point replays only steps N+1.. .
   * Scoped to Tier-2 only — Tier-1 is naturally idempotent (protected is provably
   * at LAST_GOOD; checkout/branch -D/tag -d/copyFile all replay cleanly) so it is
   * NOT journaled. Absent for a Tier-1 ledger or a chunk-2/3 writer (additive).
   */
  steps?: Record<string, RollbackStepFlags>;
}

/**
 * Per-phase Tier-2 step completion flags (chunk 4). Each flag flips true once
 * that step has SUCCEEDED on protected/disk; a true flag means the step is
 * already applied and the resume must SKIP it (each step is independently
 * skip-safe — see rollbackTier2). The five steps mirror rollbackTier2's forced
 * restore order: git revert, quarantine move, ROADMAP uncomplete, REQUIREMENTS
 * mark-incomplete, STATE restore.
 */
export interface RollbackStepFlags {
  git_done: boolean;
  quarantine_done: boolean;
  roadmap_done: boolean;
  requirements_done: boolean;
  state_done: boolean;
}

/** `.planning/ROLLBACK.json` for a project. */
export function rollbackLedgerPath(projectDir: string): string {
  return join(projectDir, '.planning', 'ROLLBACK.json');
}

/**
 * Thrown by {@link readRollbackLedger} when `ROLLBACK.json` is PRESENT but cannot
 * be parsed into a ledger object (truncated / corrupt JSON, or a non-object
 * top-level value). The GROUP-E fix: this case MUST be distinguishable from an
 * ABSENT ledger (which returns `null`). A non-atomic write that crashed
 * mid-flight can leave a half-written file; resuming on it must HALT (a possibly
 * half-unwound tree), never silently treat it as "no rollback in progress" and
 * auto-advance.
 */
export class CorruptRollbackLedgerError extends Error {
  constructor(
    public readonly path: string,
    public readonly cause: unknown,
  ) {
    super(
      `ROLLBACK.json at ${path} is present but unparseable — refusing to treat a corrupt rollback ledger as absent: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = 'CorruptRollbackLedgerError';
  }
}

/**
 * Read the ledger. Returns `null` ONLY when the file is ABSENT (ENOENT). A file
 * that is PRESENT but unparseable THROWS {@link CorruptRollbackLedgerError} —
 * the caller must treat that as a HALT, not as "no ledger" (GROUP-E fix).
 */
export async function readRollbackLedger(projectDir: string): Promise<RollbackLedger | null> {
  const path = rollbackLedgerPath(projectDir);
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    // A non-ENOENT read error (EACCES, EISDIR, …) is an inability to read a
    // ledger that may exist — fail closed rather than guess "absent".
    throw new CorruptRollbackLedgerError(path, err);
  }
  // Present file: a parse failure or a non-object top-level value is CORRUPT.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CorruptRollbackLedgerError(path, err);
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as RollbackLedger;
  }
  throw new CorruptRollbackLedgerError(path, new Error('top-level value is not a ledger object'));
}

/**
 * Write the ledger ATOMICALLY (GROUP-E fix): write the full payload to a
 * `ROLLBACK.json.tmp` sibling, then `rename` it over `ROLLBACK.json`. `rename`
 * within a directory is atomic on POSIX + Windows, so a crash mid-write can
 * never leave a half-written `ROLLBACK.json` for the resume path to misread as
 * corrupt-but-present. `persistStepFlag` calls this after every Tier-2 step —
 * exactly when a crash is likely — so atomicity is load-bearing here.
 */
export async function writeRollbackLedger(
  projectDir: string,
  ledger: RollbackLedger,
): Promise<void> {
  const path = rollbackLedgerPath(projectDir);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(ledger, null, 2)}\n`);
  await rename(tmp, path);
}
