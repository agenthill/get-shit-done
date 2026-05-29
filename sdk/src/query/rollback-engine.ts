/**
 * Tier-1 rollback engine (ADR 0013 option 4, chunk 2 — autonomous cross-phase
 * + rollback).
 *
 * Tier-1 = a CLEAN rollback of a phase that FAILED its gate/verify and was
 * therefore NEVER promoted onto the protected branch. Because the per-phase
 * integration spine (chunk 1) is atomic — protected moves ONLY on a green
 * promote — the protected branch is provably still at LAST_GOOD when this runs.
 * Tier-1's job is to make the WHOLE working state consistent with that: tear
 * down the failed phase's integration branch + checkpoint tag, discard its
 * per-plan worktrees WITHOUT merging them anywhere, and restore the planning
 * docs from the byte-snapshot the checkpoint took.
 *
 * Tier-2 (reverting an ALREADY-PROMOTED earlier phase via the manifest) is
 * chunk 3 and is NOT implemented here.
 *
 * The load-bearing safety distinction (vs the wave-cleanup path): reaping a
 * failed phase's worktrees must DELETE the branches (`git branch -D`), never
 * merge them. `executeWorktreeWaveCleanupPlan` (bin/lib/worktree-safety.cjs)
 * merges a worktree's branch onto HEAD — using it here would land the failed
 * work on protected, the exact corruption the integration spine exists to
 * prevent. So this engine force-removes the worktrees and force-deletes the
 * branches directly.
 *
 * Single-writer: only the orchestrator drives rollback, sequentially, between
 * phases — never concurrent with the per-plan merge mutex.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, access, mkdir, rename, readFile, readdir } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import { GSDError, ErrorClassification } from '../errors.js';
import { branchNameFor } from '../execution-engine.js';
import { baseTagFor, checkpointDirFor } from './phase-checkpoint.js';
import type { PhaseManifest } from './phase-manifest.js';
import { phaseUncomplete, requirementsMarkIncomplete } from './phase-lifecycle.js';
import { readPhaseRequirements } from './phase-depends-on.js';
import { normalizePhaseName, phaseTokenMatches, planningPaths } from './helpers.js';
import { readRollbackLedger, writeRollbackLedger } from './rollback-ledger.js';
import type { RollbackLedger, RollbackStepFlags } from './rollback-ledger.js';

const execFileAsync = promisify(execFile);

/** Planning docs the checkpoint snapshotted; restored byte-for-byte on rollback. */
const CHECKPOINT_DOCS = ['STATE.md', 'ROADMAP.md', 'REQUIREMENTS.md'] as const;

export interface RollbackTier1Input {
  projectDir: string;
  /** Phase number as it appears on the roadmap (e.g. "1", "02", "5.1"). */
  phaseNumber: string;
  /** The branch the phase was supposed to promote onto (still at LAST_GOOD). */
  protectedBranch: string;
  /** Protected HEAD at checkpoint time — the recoverable point we assert against. */
  lastGoodSha: string;
  /** Checkpoint snapshot dir (`.planning/.checkpoints/phase-<N>/`) to restore from. */
  snapshotDir: string;
  /** The orchestrator-owned per-phase integration branch (`gsd-phase-<N>-int`). */
  integrationBranch: string;
}

export interface RollbackTier1Result {
  /** Protected HEAD after rollback — asserted to equal lastGoodSha. */
  protectedSha: string;
  /** True if the integration branch was present and deleted. */
  integrationBranchDeleted: boolean;
  /** True if the `gsd/phase-<N>-base` tag was present and deleted. */
  baseTagDeleted: boolean;
  /** Per-plan worktree branches reaped (force-removed + branch -D), oldest-first. */
  reapedBranches: string[];
  /** Planning docs restored from the snapshot (subset of CHECKPOINT_DOCS that existed). */
  restoredDocs: string[];
}

/**
 * Roll back a phase that FAILED and was NEVER promoted, leaving a clean tree
 * with protected provably still at LAST_GOOD.
 *
 * Sequence (each step fail-tolerant where the post-condition is what matters;
 * the final assert is the hard gate):
 *   1. `git checkout <protectedBranch>` (it is still at LAST_GOOD) then
 *      `git branch -D <integrationBranch>`; delete the `gsd/phase-<N>-base` tag.
 *   2. Reap the phase's per-plan worktrees: `git worktree remove --force` each
 *      worktree whose branch is `worktree-agent-<phase>-*`, then `git branch -D`
 *      the branch. Force-DELETE (never merge) — the failed work is discarded.
 *   3. Restore STATE.md / ROADMAP.md / REQUIREMENTS.md from the checkpoint
 *      byte-snapshot (a non-green phase never committed these to protected, so
 *      this restores the working copy).
 *   4. Assert protected HEAD == LAST_GOOD. If protected moved, THROW — something
 *      promoted work that should never have reached protected (fail-closed).
 */
export async function rollbackTier1(input: RollbackTier1Input): Promise<RollbackTier1Result> {
  const { projectDir, phaseNumber, protectedBranch, lastGoodSha, snapshotDir, integrationBranch } =
    input;
  const git = (args: string[], cwd = projectDir) => execFileAsync('git', args, { cwd });

  // ── 1. Return protected to the foreground, tear down the integration branch + base tag ──
  // Protected is still at LAST_GOOD (the phase never promoted). Check it out so
  // the working tree is on protected before we delete the integration branch
  // (you cannot delete the branch you are on). Plain `checkout` (not -f) is
  // intentional: protected has no failed work, and the per-plan deltas live on
  // the integration branch / worktree branches we are about to discard.
  await git(['checkout', protectedBranch]);

  let integrationBranchDeleted = false;
  if (await branchExists(git, integrationBranch)) {
    // -D (force) deletes regardless of merge status — the integration branch
    // carries the failed phase's commits and is NOT merged into protected.
    await git(['branch', '-D', integrationBranch]);
    integrationBranchDeleted = true;
  }

  let baseTagDeleted = false;
  const baseTag = baseTagFor(phaseNumber);
  if (await tagExists(git, baseTag)) {
    await git(['tag', '-d', baseTag]);
    baseTagDeleted = true;
  }

  // ── 2. Reap the phase's per-plan worktrees (force-remove + branch -D) ──
  // The per-plan branches are `worktree-agent-<phase>-<id>` (branchNameFor). We
  // derive the deterministic prefix (a sanitized planId always follows the
  // trailing dash) and reap every worktree/branch under it. This DELETES the
  // branches — it never merges them, the load-bearing distinction from
  // executeWorktreeWaveCleanupPlan.
  const reapedBranches = await reapPhaseWorktrees(git, projectDir, phaseNumber);

  // ── 3. Restore the planning docs from the checkpoint byte-snapshot ──
  // phaseComplete never committed these to protected on a non-green phase, so
  // restoring the working copy returns disk_status to planned/pending. Only the
  // docs that were snapshotted (i.e. existed at checkpoint time) are restored.
  const restoredDocs: string[] = [];
  for (const doc of CHECKPOINT_DOCS) {
    const src = join(snapshotDir, doc);
    if (await pathExists(src)) {
      await copyFile(src, join(projectDir, '.planning', doc));
      restoredDocs.push(doc);
    }
  }

  // ── 4. Fail-closed assert: protected HEAD must still be LAST_GOOD ──
  const protectedSha = (await git(['rev-parse', protectedBranch])).stdout.trim();
  if (protectedSha !== lastGoodSha) {
    throw new GSDError(
      `Tier-1 rollback invariant violated: protected branch ${protectedBranch} is at ${protectedSha}, ` +
        `expected LAST_GOOD ${lastGoodSha}. A non-green phase appears to have moved protected — ` +
        `refusing to declare a clean rollback.`,
      ErrorClassification.Execution,
    );
  }

  return {
    protectedSha,
    integrationBranchDeleted,
    baseTagDeleted,
    reapedBranches,
    restoredDocs,
  };
}

// ─── Tier-2: cascade-revert an ALREADY-PROMOTED predecessor (chunk 3) ─────────

/** Minimal serializer surface the Tier-2 revert reuses (the guard suite over the
 * revert delta). Satisfied by GitMergeSerializer.runGuardSuite. */
export interface GuardSuiteRunner {
  runGuardSuite(baseTip: string): Promise<void>;
}

export interface RollbackTier2Input {
  projectDir: string;
  /** The protected branch the reverts land on (history-preserving). */
  protectedBranch: string;
  /** Protected HEAD BEFORE this phase's revert — the guard-suite baseTip. */
  protectedTipBeforeRevert: string;
  /** The promoted phase being unwound. */
  phaseNumber: string;
  /** The phase's manifest entry (its `commits` are reverted, newest-first). */
  manifest: PhaseManifest;
  /** Reuses the merge serializer's guard suite over the revert delta. */
  serializer: GuardSuiteRunner;
  workstream?: string;
  /**
   * Crash-resume journal (chunk 4). When true, rollbackTier2 reads this phase's
   * step flags from `.planning/ROLLBACK.json` at entry, SKIPS any step already
   * flagged done, and persists each flag IMMEDIATELY after the step succeeds. A
   * fresh (no prior flags) run journals all five steps from scratch; a resume
   * after a crash replays only the remaining steps idempotently. Absent/false →
   * legacy behaviour (no journal; chunk-3 callers stay valid).
   */
  journal?: boolean;
  /**
   * Test-only fault hook (chunk 4). Invoked AFTER a named step's flag is
   * persisted; throwing simulates a crash at that point so the journal is left
   * with steps 1..N flagged and N+1.. unflagged. Never set in production.
   */
  faultAfterStep?: (step: keyof RollbackStepFlags) => void;
}

export type RollbackTier2Status = 'reverted' | 'halted';

export interface RollbackTier2Result {
  status: RollbackTier2Status;
  /** Protected HEAD after the revert commit (when status === 'reverted'). */
  protectedSha?: string;
  /** The single revert commit sha (when status === 'reverted'). */
  revertCommit?: string;
  /** Quarantined doc basenames moved under `.planning/.rollback-quarantine/phase-M/`. */
  quarantined: string[];
  /** Requirement IDs marked incomplete. */
  requirementsMarkedIncomplete: string[];
  /** Reason the unwind HALTed (status === 'halted'). */
  haltReason?: string;
}

/** `.planning/.rollback-quarantine/phase-<N>` — where reverted summaries move. */
function quarantineDirFor(projectDir: string, phaseNumber: string): string {
  const safe = String(phaseNumber).replace(/[^A-Za-z0-9._-]/g, '-');
  return join(projectDir, '.planning', '.rollback-quarantine', `phase-${safe}`);
}

/**
 * Tier-2 cascade revert of ONE already-promoted phase, in the FORCED restore
 * order (ADR 0013 option 4, chunk 3, step 8). The caller drives the cascade set
 * in REVERSE promotion order, calling this once per reverted phase, snapshotting
 * the protected tip before each call.
 *
 * Forced restore order (each is fail-closed; a conflict or a missing snapshot
 * HALTs with a CLEAN tree — never a half-reverted protected branch):
 *
 *   1. GIT: `git revert --no-commit` over the phase's manifest commits
 *      (history-preserving — NEVER reset-hard on protected, reverse order so a
 *      later commit reverts before the earlier it built on), run the guard suite
 *      over the revert delta (`protectedTipBeforeRevert..HEAD`), then commit ONE
 *      `revert(phase-M): autonomous unwind`. ON CONFLICT with a kept later
 *      phase: `git revert --abort` + `git reset HEAD` + `git restore .` FIRST
 *      (leave a clean tree), THEN return status:'halted' (judge-defect #1).
 *   2. QUARANTINE (move, NOT delete): the phase's `*-SUMMARY.md` /
 *      `VERIFICATION.md` / `UAT.md` move to `.planning/.rollback-quarantine/
 *      phase-M/` so disk_status reverts complete→planned and `has_summary` flips.
 *   3. ROADMAP: `phase.uncomplete` for M (ROADMAP-complete is trusted over disk).
 *   4. REQUIREMENTS: `requirements.mark-incomplete` for M's requirements.
 *   5. STATE: restore STATE.md from the phase-M checkpoint snapshot (preserves
 *      cumulative counters disk-rederive can't reconstruct). Missing/corrupt
 *      snapshot → HALT (do NOT produce an inconsistent STATE).
 *
 * This function does NOT write ROLLBACK.json or re-derive the loop's halt state;
 * the caller writes the Tier-2 ledger after the cascade completes. A HALT here
 * returns status:'halted' with a clean tree so the caller stops the cascade.
 */
export async function rollbackTier2(input: RollbackTier2Input): Promise<RollbackTier2Result> {
  const {
    projectDir,
    protectedBranch,
    protectedTipBeforeRevert,
    phaseNumber,
    manifest,
    serializer,
    workstream,
    journal,
    faultAfterStep,
  } = input;
  const git = (args: string[]) => execFileAsync('git', args, { cwd: projectDir });

  const result: RollbackTier2Result = {
    status: 'reverted',
    quarantined: [],
    requirementsMarkedIncomplete: [],
  };

  const entry = manifest[String(phaseNumber)];
  if (!entry) {
    return { ...result, status: 'halted', haltReason: `no manifest entry for phase ${phaseNumber}` };
  }

  // ── Crash-resume journal (chunk 4) ──
  // Read this phase's step flags from ROLLBACK.json at entry. A done flag means
  // the step already landed (revert commit already on protected, summary already
  // moved, ROADMAP/REQ/STATE idempotently applied) and MUST be skipped so a
  // restart never double-reverts. After each step succeeds we persist its flag
  // IMMEDIATELY, so a crash after step N leaves flags 1..N set. Absent journal →
  // legacy path: nothing read, nothing persisted (chunk-3 callers unchanged).
  const flags = journal ? await readStepFlags(projectDir, String(phaseNumber)) : freshFlags();
  const persist = async (step: keyof RollbackStepFlags): Promise<void> => {
    flags[step] = true;
    if (journal) await persistStepFlag(projectDir, String(phaseNumber), step);
    faultAfterStep?.(step);
  };

  // ── 1. GIT revert (history-preserving) ──
  // SKIP when git_done: the revert commit is already on protected; re-reverting
  // would double-revert. Adopt the current HEAD as the (already-applied) revert.
  if (flags.git_done) {
    result.revertCommit = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    result.protectedSha = result.revertCommit;
  } else {
    // Be on protected before reverting (the revert commit lands here). protected
    // is at protectedTipBeforeRevert.

    // The phase manifest (`.planning/.phase-manifest.json`) is a derived ledger
    // written AFTER each promote, so it can be dirty in the working tree when
    // Tier-2 runs. `git revert` refuses on a dirty tracked file ("local changes
    // would be overwritten"), so checkpoint any pending manifest write into a
    // commit first — keeps the tree clean for the revert WITHOUT discarding the
    // ledger. Best-effort: a no-op when the manifest is unchanged/absent.
    await stageAndCommitManifestIfDirty(git);

    // Revert the phase's commits NEWEST-first so a later commit's revert applies
    // cleanly over the earlier ones still present. --no-commit accumulates the
    // combined inverse into the index/worktree for a SINGLE revert commit.
    //
    // The integration spine promotes a phase with `merge --no-ff`, so the
    // manifest range (base..head) contains BOTH the merge commit AND the work
    // commits brought in through its second parent. Reverting a `-m 1` merge
    // already undoes that whole merged subtree, so separately reverting the work
    // commits would DOUBLE-revert and spuriously conflict. We therefore skip any
    // commit reachable through a reverted merge's second parent (it is already
    // covered). Merge commits are reverted with `--mainline 1`; plain commits
    // plainly.
    const commits = [...(entry.commits ?? [])].reverse(); // newest-first
    const covered = new Set<string>();
    let conflicted = false;
    let conflictDetail = '';
    for (const commit of commits) {
      if (covered.has(commit)) continue;
      const parents = await commitParents(projectDir, commit);
      const isMerge = parents.length > 1;
      try {
        if (isMerge) {
          await git(['revert', '--no-commit', '--mainline', '1', commit]);
          // Mark the second-parent subtree (the merged work) as covered so we do
          // not double-revert those commits.
          for (const c of await secondParentSubtree(projectDir, commit, entry.base_sha)) {
            covered.add(c);
          }
        } else {
          await git(['revert', '--no-commit', commit]);
        }
      } catch (e) {
        conflicted = true;
        conflictDetail = (e as { stderr?: string })?.stderr ?? (e instanceof Error ? e.message : String(e));
        break;
      }
    }

    if (conflicted) {
      // ON CONFLICT: leave a CLEAN tree FIRST (judge-defect #1), THEN halt.
      await git(['revert', '--abort']).catch(() => {});
      await git(['reset', 'HEAD']).catch(() => {});
      await git(['restore', '.']).catch(() => {});
      // Also drop any untracked residue the partial revert may have produced.
      await git(['clean', '-fd']).catch(() => {});
      return {
        ...result,
        status: 'halted',
        haltReason: `git revert of phase ${phaseNumber} conflicts with a kept later phase — clean tree restored, no half-revert${conflictDetail ? ` [${conflictDetail.trim()}]` : ''}`,
      };
    }

    // Guard suite over the revert delta (protectedTipBeforeRevert..HEAD): the
    // revert may have dropped files a kept later phase relies on, so the same
    // bulk-delete / STATE-restore / resurrection guards apply. The revert is still
    // staged (--no-commit) so the guard suite sees it as the working delta once we
    // commit; run it AFTER committing so HEAD reflects the revert.
    let revertCommit: string;
    try {
      await git(['commit', '--no-verify', '-m', `revert(phase-${phaseNumber}): autonomous unwind`]);
      revertCommit = (await git(['rev-parse', 'HEAD'])).stdout.trim();
      await serializer.runGuardSuite(protectedTipBeforeRevert);
      // The guard suite may have added its own restore commit; re-read HEAD.
      revertCommit = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    } catch (err) {
      // Commit failed (e.g. nothing to revert / empty) — clean up and halt rather
      // than leave a partial state.
      await git(['reset', '--hard', protectedTipBeforeRevert]).catch(() => {});
      return {
        ...result,
        status: 'halted',
        haltReason: `revert commit/guard failed for phase ${phaseNumber}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    result.revertCommit = revertCommit;
    result.protectedSha = revertCommit;
    // The revert commit is now durably on protected — flag git_done so a restart
    // never re-reverts.
    await persist('git_done');
  }

  // ── 2. QUARANTINE (move, NOT delete) the phase's summaries/verification/UAT ──
  // Locate the phase directory under .planning/phases and move its lifecycle
  // artifacts so disk_status reverts complete→planned and has_summary flips.
  // SKIP-safe: on resume the summaries are already under .rollback-quarantine, so
  // quarantinePhaseArtifacts finds nothing to move (returns []) — idempotent.
  if (!flags.quarantine_done) {
    const quarantined = await quarantinePhaseArtifacts(projectDir, phaseNumber, workstream);
    result.quarantined = quarantined;
    await persist('quarantine_done');
  }

  // ── 3. ROADMAP: phase.uncomplete (MANDATORY — ROADMAP-complete > disk) ──
  // SKIP-safe: phaseUncomplete on an already-unchecked phase is a no-op.
  if (!flags.roadmap_done) {
    await phaseUncomplete([String(phaseNumber)], projectDir, workstream);
    await persist('roadmap_done');
  }

  // ── 4. REQUIREMENTS: mark the phase's requirements incomplete ──
  // SKIP-safe: requirementsMarkIncomplete on already-incomplete reqs is a no-op.
  if (!flags.requirements_done) {
    const reqIds = await readPhaseRequirements(projectDir, String(phaseNumber), workstream);
    if (reqIds.length > 0) {
      await requirementsMarkIncomplete(reqIds, projectDir, workstream);
      result.requirementsMarkedIncomplete = reqIds;
    }
    await persist('requirements_done');
  }

  // ── 5. STATE: restore from the phase-M checkpoint snapshot ──
  // Preserves the cumulative Performance-Metrics counter + archived decisions a
  // disk-rederive can't reconstruct. Missing/corrupt → HALT (never an
  // inconsistent STATE). SKIP-safe: copyFile of the same snapshot is idempotent.
  if (!flags.state_done) {
    const snapshotState = join(checkpointDirFor(projectDir, String(phaseNumber)), 'STATE.md');
    let stateBody: string;
    try {
      stateBody = await readFile(snapshotState, 'utf-8');
      if (!stateBody || stateBody.trim().length === 0) {
        throw new Error('empty STATE.md snapshot');
      }
    } catch (err) {
      return {
        ...result,
        status: 'halted',
        haltReason: `phase ${phaseNumber} checkpoint STATE.md snapshot missing/corrupt — refusing to produce an inconsistent STATE: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    // Restore the snapshotted STATE.md body onto the working copy.
    await copyFile(snapshotState, join(projectDir, '.planning', 'STATE.md'));
    await persist('state_done');
  }

  return result;
}

/** All-false step flags (a fresh Tier-2 unwind for this phase). */
function freshFlags(): RollbackStepFlags {
  return {
    git_done: false,
    quarantine_done: false,
    roadmap_done: false,
    requirements_done: false,
    state_done: false,
  };
}

/**
 * Read a phase's Tier-2 step flags from `.planning/ROLLBACK.json`. Returns
 * all-false when the ledger is absent or carries no journal for this phase (a
 * fresh unwind). Read-modify-write is safe: the orchestrator is the single
 * sequential writer.
 */
async function readStepFlags(projectDir: string, phaseNumber: string): Promise<RollbackStepFlags> {
  const ledger = await readRollbackLedger(projectDir);
  const existing = ledger?.steps?.[phaseNumber];
  return existing ? { ...freshFlags(), ...existing } : freshFlags();
}

/**
 * Persist a single step flag for a phase into `.planning/ROLLBACK.json`,
 * IMMEDIATELY (so a crash after this returns leaves the flag set). Merges into
 * the existing ledger rather than replacing it — preserves failed_phase /
 * attempt_count / failure_context the chunk-2/3 driver wrote. When no ledger
 * exists yet, seeds a minimal retrying ledger keyed on the reverted phase.
 */
async function persistStepFlag(
  projectDir: string,
  phaseNumber: string,
  step: keyof RollbackStepFlags,
): Promise<void> {
  const ledger: RollbackLedger =
    (await readRollbackLedger(projectDir)) ?? {
      failed_phase: phaseNumber,
      attempt_count: 1,
      failure_context: [],
      status: 'retrying',
    };
  const steps = { ...(ledger.steps ?? {}) };
  const phaseFlags: RollbackStepFlags = { ...freshFlags(), ...steps[phaseNumber] };
  phaseFlags[step] = true;
  steps[phaseNumber] = phaseFlags;
  await writeRollbackLedger(projectDir, { ...ledger, steps });
}

export interface CascadeRollbackTier2Input {
  projectDir: string;
  protectedBranch: string;
  /** Cascade set in REVERSE promotion order (newest-promoted first). */
  cascadeSet: string[];
  manifest: PhaseManifest;
  serializer: GuardSuiteRunner;
  workstream?: string;
}

export interface CascadeRollbackTier2Result {
  /** 'reverted' = whole cascade unwound cleanly; 'halted' = stopped on a
   * conflict / missing snapshot with a CLEAN tree (no half-revert). Either way
   * the autonomous driver HALTs (reverting promoted work is halt-worthy). */
  status: RollbackTier2Status;
  /** Per-phase results, in the order attempted (reverse promotion order). */
  perPhase: Array<{ phase: string } & RollbackTier2Result>;
  /** Phases whose revert commit actually landed on protected. */
  revertedPhases: string[];
  haltReason?: string;
}

/**
 * Drive a Tier-2 cascade over the classifier's cascade set, in REVERSE
 * promotion order, snapshotting the protected tip before each phase's revert so
 * the guard suite diffs exactly that phase's revert delta. Stops at the FIRST
 * phase that HALTs (a conflict / missing snapshot leaves a clean tree), so a
 * later phase in the set is never half-reverted.
 *
 * Does NOT write ROLLBACK.json — the caller persists the Tier-2 ledger
 * ({tier:2, cascade_set, status:'halted'}) once the cascade settles, because
 * reverting promoted work unattended is itself a halt-worthy event under the
 * conservative posture (the driver never auto-retries/advances after Tier-2).
 */
export async function cascadeRollbackTier2(
  input: CascadeRollbackTier2Input,
): Promise<CascadeRollbackTier2Result> {
  const { projectDir, protectedBranch, cascadeSet, manifest, serializer, workstream } = input;
  const git = (args: string[]) => execFileAsync('git', args, { cwd: projectDir });

  const perPhase: Array<{ phase: string } & RollbackTier2Result> = [];
  const revertedPhases: string[] = [];

  for (const phase of cascadeSet) {
    // Snapshot the protected tip BEFORE this phase's revert (the guard-suite
    // baseTip — exactly this revert's single delta).
    const protectedTipBeforeRevert = (await git(['rev-parse', protectedBranch])).stdout.trim();
    const r = await rollbackTier2({
      projectDir,
      protectedBranch,
      protectedTipBeforeRevert,
      phaseNumber: phase,
      manifest,
      serializer,
      workstream,
      // Journal each phase's steps so a crash mid-cascade replays only the
      // remaining steps on restart (chunk 4 crash-resume).
      journal: true,
    });
    perPhase.push({ phase, ...r });
    if (r.status === 'halted') {
      return {
        status: 'halted',
        perPhase,
        revertedPhases,
        haltReason: `cascade halted at phase ${phase}: ${r.haltReason ?? 'unknown'}`,
      };
    }
    revertedPhases.push(phase);
  }

  return { status: 'reverted', perPhase, revertedPhases };
}

export interface ResumeIncompleteRollbackInput {
  projectDir: string;
  protectedBranch: string;
  serializer: GuardSuiteRunner;
  manifest: PhaseManifest;
  workstream?: string;
}

export interface ResumeIncompleteRollbackResult {
  /** True when an incomplete Tier-2 journal was found and replayed. */
  resumed: boolean;
  /** The phase whose journal was replayed (when resumed). */
  phase?: string;
  /** The Tier-2 result of the replay (when resumed). */
  result?: RollbackTier2Result;
}

/**
 * Crash-resume entry point (ADR 0013 option 4, chunk 4). Called at the TOP of
 * the autonomous loop, BEFORE selecting/running the next phase. Reads
 * `.planning/ROLLBACK.json`; if it carries a Tier-2 journal whose steps are NOT
 * all done, replays rollbackTier2 for that phase (the journal's skip-done logic
 * finishes the REMAINING steps idempotently — it never re-reverts), then settles
 * the ledger to halted (the unchanged Tier-2 posture: reverting promoted work is
 * halt-worthy). A complete (all-steps-done) or absent journal → no-op.
 *
 * A SECOND resume is a no-op: once the prior pass set all five flags, every step
 * is skipped and the ledger is already halted.
 */
export async function resumeIncompleteRollback(
  input: ResumeIncompleteRollbackInput,
): Promise<ResumeIncompleteRollbackResult> {
  const { projectDir, protectedBranch, serializer, manifest, workstream } = input;
  const ledger = await readRollbackLedger(projectDir);
  const steps = ledger?.steps;
  if (!ledger || !steps) return { resumed: false };

  // Find the first phase whose journal is incomplete (not all five flags set).
  const incomplete = Object.entries(steps).find(([, f]) => !allStepsDone(f));
  if (!incomplete) return { resumed: false };
  const [phase] = incomplete;

  const git = (args: string[]) => execFileAsync('git', args, { cwd: projectDir });
  await git(['checkout', protectedBranch]).catch(() => {});
  // On resume the revert commit is (almost always) already on protected, so
  // protectedTipBeforeRevert is unused for a new revert; current HEAD is the
  // safe baseTip if the GIT step still has to run.
  const protectedTipBeforeRevert = (await git(['rev-parse', protectedBranch])).stdout.trim();

  const result = await rollbackTier2({
    projectDir,
    protectedBranch,
    protectedTipBeforeRevert,
    phaseNumber: phase,
    manifest,
    serializer,
    workstream,
    journal: true,
  });

  // Settle the ledger to halted (the unchanged Tier-2 posture). Preserve the
  // journal + the chunk-2/3 fields; stamp tier:2 + status:'halted'.
  const finalLedger = await readRollbackLedger(projectDir);
  if (finalLedger) {
    await writeRollbackLedger(projectDir, {
      ...finalLedger,
      tier: 2,
      status: 'halted',
    });
  }

  return { resumed: true, phase, result };
}

/** True when every Tier-2 step flag for a phase is set. */
function allStepsDone(f: RollbackStepFlags): boolean {
  return (
    f.git_done &&
    f.quarantine_done &&
    f.roadmap_done &&
    f.requirements_done &&
    f.state_done
  );
}

/**
 * Commit a pending `.planning/.phase-manifest.json` change so the working tree
 * is clean before a `git revert`. The manifest is a derived ledger (not a
 * source of truth), so checkpointing it into its own commit is benign and never
 * loses information. No-op when nothing is staged. Best-effort throughout.
 */
async function stageAndCommitManifestIfDirty(
  git: (args: string[]) => Promise<{ stdout: string }>,
): Promise<void> {
  try {
    const { stdout } = await git(['status', '--porcelain', '--', '.planning/.phase-manifest.json']);
    if (stdout.trim().length === 0) return;
    await git(['add', '.planning/.phase-manifest.json']);
    await git(['commit', '--no-verify', '-m', 'chore(rollback): checkpoint phase manifest before Tier-2 revert']).catch(() => {});
  } catch {
    /* non-fatal — the revert will surface any real dirtiness */
  }
}

/** Parent shas of a commit (≥2 ⇒ a merge commit). */
async function commitParents(projectDir: string, commit: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    'git',
    ['rev-list', '--parents', '-n', '1', commit],
    { cwd: projectDir },
  );
  // `<commit> <parent1> [<parent2> ...]` — drop the commit itself.
  return stdout.trim().split(/\s+/).slice(1).filter(Boolean);
}

/**
 * Commits brought in through a merge commit's SECOND parent but not present on
 * the first-parent (mainline) side — i.e. the merged-in work a `-m 1` revert
 * already undoes. Bounded below by `base` so we never walk past the phase's own
 * fork point. Returns [] when the commit is not a merge or the walk fails.
 */
async function secondParentSubtree(
  projectDir: string,
  mergeCommit: string,
  base: string,
): Promise<string[]> {
  try {
    // `merge^2 --not merge^1 base` = commits reachable from the second parent
    // that are NOT reachable from the first parent nor from base.
    const { stdout } = await execFileAsync(
      'git',
      ['rev-list', `${mergeCommit}^2`, '--not', `${mergeCommit}^1`, base],
      { cwd: projectDir },
    );
    return stdout.split('\n').map(l => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Move a reverted phase's lifecycle artifacts (`*-SUMMARY.md`, `SUMMARY.md`,
 * `VERIFICATION.md`/`*-VERIFICATION.md`, `UAT.md`/`*-UAT.md`) out of the phase
 * directory into `.planning/.rollback-quarantine/phase-M/`. MOVE, never delete —
 * the work is recoverable for a human. The quarantine dir is already gitignored
 * by chunk 1's ensureCheckpointGitignore. Returns the moved basenames.
 */
async function quarantinePhaseArtifacts(
  projectDir: string,
  phaseNumber: string,
  workstream?: string,
): Promise<string[]> {
  // Resolve the phase directory under .planning[/<workstream>]/phases.
  const phasesDir = planningPaths(projectDir, workstream).phases;
  let dirs: string[];
  try {
    const entries = await readdir(phasesDir, { withFileTypes: true });
    dirs = entries.filter(e => e.isDirectory()).map(e => e.name);
  } catch {
    return [];
  }
  const normalized = normalizePhaseName(String(phaseNumber));
  const match = dirs.find(d => phaseTokenMatches(d, normalized));
  if (!match) return [];

  const phaseDir = join(phasesDir, match);
  let files: string[];
  try {
    files = await readdir(phaseDir);
  } catch {
    return [];
  }

  const isArtifact = (f: string): boolean =>
    f.endsWith('-SUMMARY.md') ||
    f === 'SUMMARY.md' ||
    f.endsWith('-VERIFICATION.md') ||
    f === 'VERIFICATION.md' ||
    f.endsWith('-UAT.md') ||
    f === 'UAT.md';

  const toMove = files.filter(isArtifact);
  if (toMove.length === 0) return [];

  const quarantineDir = quarantineDirFor(projectDir, phaseNumber);
  await mkdir(quarantineDir, { recursive: true });

  const moved: string[] = [];
  for (const f of toMove) {
    try {
      await rename(join(phaseDir, f), join(quarantineDir, f));
      moved.push(f);
    } catch {
      // best-effort per file; a failure to move one artifact must not abort the
      // unwind (the ROADMAP uncomplete + STATE restore are the trusted signals).
    }
  }
  return moved;
}

/**
 * Reap the per-plan worktrees + branches for a phase. For every linked worktree
 * whose checked-out branch is `worktree-agent-<phase>-*`, force-remove the
 * worktree then force-delete the branch. Also force-deletes any matching branch
 * with no live worktree (a worktree that was already cleaned up by the engine's
 * own per-plan cleanup, leaving the branch behind for the integration merge).
 *
 * Force (`worktree remove --force`, `branch -D`) is required: the failed phase's
 * work is being DISCARDED, so these branches are unmerged by design.
 */
async function reapPhaseWorktrees(
  git: (args: string[], cwd?: string) => Promise<{ stdout: string }>,
  projectDir: string,
  phaseNumber: string,
): Promise<string[]> {
  // Deterministic prefix for this phase's per-plan branches. The prefix MUST be
  // derived the SAME way chunk 1 creates the branches, or a decimal phase reaps
  // nothing: phase-runner.ts forks per-plan branches with
  // `phaseTag = Number.parseInt(phaseNumber, 10)` (the `Number.isFinite ? : 0`
  // fallback for a non-numeric phase). A naive `Number("5.1")` here would yield
  // `worktree-agent-5.1-` and MISS the real `worktree-agent-5-*` branches that
  // `parseInt("5.1", 10) === 5` created. Match branch creation exactly.
  const phaseLevel = Number.parseInt(phaseNumber, 10);
  const phaseTag = Number.isFinite(phaseLevel) ? phaseLevel : 0;
  const prefix = branchNameFor(phaseTag, '').replace(/-$/, ''); // worktree-agent-<phaseTag>
  const branchPrefix = `${prefix}-`;

  const reaped: string[] = [];

  // First pass: worktrees whose branch matches the prefix → remove the worktree.
  let porcelain = '';
  try {
    porcelain = (await git(['worktree', 'list', '--porcelain'])).stdout;
  } catch {
    porcelain = '';
  }
  // Parse `git worktree list --porcelain` blocks: each block has a `worktree
  // <path>` line and (for attached worktrees) a `branch refs/heads/<name>` line.
  for (const block of porcelain.replace(/\r\n/g, '\n').split('\n\n')) {
    const lines = block.split('\n');
    const wtLine = lines.find((l) => l.startsWith('worktree '));
    const brLine = lines.find((l) => l.startsWith('branch '));
    if (!wtLine || !brLine) continue;
    const wtPath = wtLine.slice('worktree '.length).trim();
    const branch = brLine.slice('branch refs/heads/'.length).trim();
    if (!branch.startsWith(branchPrefix)) continue;
    // Discard the worktree (force — it has uncommitted/committed failed work).
    try {
      await git(['worktree', 'remove', '--force', wtPath]);
    } catch {
      // best-effort; the branch -D pass below still discards the branch
    }
  }

  // Prune any stale worktree admin metadata left by force-removes.
  try {
    await git(['worktree', 'prune']);
  } catch {
    /* non-fatal */
  }

  // Second pass: force-delete every branch under the prefix (worktree-backed or
  // not — e.g. branches left behind for the integration merge after per-plan
  // cleanup already removed the worktree dir).
  let branchList = '';
  try {
    branchList = (
      await git(['for-each-ref', '--format=%(refname:short)', `refs/heads/${branchPrefix}*`])
    ).stdout;
  } catch {
    branchList = '';
  }
  const branches = branchList
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((b) => b.trim())
    .filter(Boolean)
    .sort();
  for (const branch of branches) {
    try {
      await git(['branch', '-D', branch]);
      reaped.push(branch);
    } catch {
      // A branch still backing a live worktree we failed to remove cannot be
      // deleted; leave it rather than corrupt state. The final protected-HEAD
      // assert is the real safety gate.
    }
  }

  return reaped;
}

async function branchExists(
  git: (args: string[]) => Promise<{ stdout: string }>,
  branch: string,
): Promise<boolean> {
  try {
    await git(['rev-parse', '--verify', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

async function tagExists(
  git: (args: string[]) => Promise<{ stdout: string }>,
  tag: string,
): Promise<boolean> {
  try {
    await git(['rev-parse', '--verify', `refs/tags/${tag}`]);
    return true;
  } catch {
    return false;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}
