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

import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
   * Reserved for chunk 4's per-step crash-resume done-flags. Absent today; the
   * shape is declared so chunk 4 extends rather than reshapes.
   */
  steps?: Record<string, unknown>;
}

/** `.planning/ROLLBACK.json` for a project. */
export function rollbackLedgerPath(projectDir: string): string {
  return join(projectDir, '.planning', 'ROLLBACK.json');
}

/** Read the ledger, or null when absent/malformed (it is a derived signal). */
export async function readRollbackLedger(projectDir: string): Promise<RollbackLedger | null> {
  try {
    const raw = await readFile(rollbackLedgerPath(projectDir), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as RollbackLedger;
    }
    return null;
  } catch {
    return null;
  }
}

/** Write the ledger (pretty-printed, trailing newline). */
export async function writeRollbackLedger(
  projectDir: string,
  ledger: RollbackLedger,
): Promise<void> {
  const path = rollbackLedgerPath(projectDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(ledger, null, 2)}\n`);
}
