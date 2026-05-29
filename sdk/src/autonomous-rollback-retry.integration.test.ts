/**
 * Autonomous rollback + informed-retry driver — FALSIFIER (ADR 0013 option 4,
 * chunk 2 step 7).
 *
 * Drives GSD.run's per-phase rollback/retry loop against a REAL temp git repo
 * (so rollbackTier1 runs for real), with PhaseRunner.run stubbed at the unit
 * boundary to emit controlled PhaseRunnerResults. Falsifies the three resolved
 * user decisions:
 *
 *  (a) A GENUINE gate failure → Tier-1 rollback fires (integration branch gone,
 *      protected at LAST_GOOD), the retry re-runs WITH the prior-failure context
 *      present in the executor's options, and after 5 attempts the loop HALTs
 *      with ROLLBACK.json status:'halted'.
 *  (b) A TRANSIENT/quota failure resumes the SAME phase via WAITING.json WITHOUT
 *      consuming an attempt or rolling back; a later green attempt advances.
 *  (c) A green phase advances normally — no rollback, no ROLLBACK.json.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GSD } from './index.js';
import {
  createPhaseCheckpoint,
  ensureCheckpointGitignore,
  integrationBranchFor,
} from './query/phase-checkpoint.js';
import { branchNameFor } from './execution-engine.js';
import { PhaseStepType } from './types.js';
import type {
  PhaseRunnerResult,
  PhaseRunnerOptions,
  RoadmapAnalysis,
  PhaseRollbackContext,
} from './types.js';

const execFileAsync = promisify(execFile);
const gitIn = (dir: string) => (args: string[]) => execFileAsync('git', args, { cwd: dir });

async function refExists(dir: string, ref: string): Promise<boolean> {
  try {
    await gitIn(dir)(['rev-parse', '--verify', `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** A repo with planning docs in their PLANNED state + a checkpoint/integration
 * branch staged for phase `phaseNumber` (as the spine would leave a failed
 * phase). Returns LAST_GOOD + the rollback context the driver expects. */
async function setupFailedPhaseRepo(
  phaseNumber: string,
): Promise<{ dir: string; lastGoodSha: string; rollbackContext: PhaseRollbackContext }> {
  const dir = await mkdtemp(join(tmpdir(), 'gsd-arr-'));
  const git = gitIn(dir);
  await git(['init', '-q', '-b', 'main']);
  await git(['config', 'user.email', 't@t.t']);
  await git(['config', 'user.name', 'T']);
  await git(['config', 'commit.gpgsign', 'false']);
  await mkdir(join(dir, '.planning'), { recursive: true });
  await writeFile(join(dir, '.planning', 'STATE.md'), 'status: ready_to_plan\n');
  await writeFile(join(dir, '.planning', 'ROADMAP.md'), '- [ ] Phase 1: Thing\n');
  await writeFile(join(dir, '.planning', 'REQUIREMENTS.md'), '- [ ] **REQ-01** thing\n');
  await ensureCheckpointGitignore(dir);
  await git(['add', '-A']);
  await git(['commit', '-q', '--no-verify', '-m', 'base']);
  const lastGoodSha = (await git(['rev-parse', 'HEAD'])).stdout.trim();

  const checkpoint = await createPhaseCheckpoint({ projectDir: dir, phaseNumber, protectedBranch: 'main' });
  const intBranch = integrationBranchFor(phaseNumber);
  await git(['checkout', '-q', '-B', intBranch, lastGoodSha]);
  await writeFile(join(dir, 'failed.txt'), 'failed work\n');
  await git(['add', '-A']);
  await git(['commit', '-q', '--no-verify', '-m', 'failed phase work']);
  await git(['checkout', '-q', 'main']);

  return {
    dir,
    lastGoodSha,
    rollbackContext: {
      phaseNumber,
      protectedBranch: 'main',
      lastGoodSha,
      snapshotDir: checkpoint.snapshotDir,
      integrationBranch: intBranch,
    },
  };
}

/** Re-stage the checkpoint + integration branch (each retry attempt re-runs the
 * phase, which would re-create them; the stub does not, so we re-stage before
 * each attempt's rollback so rollbackTier1 has something to tear down). */
async function restageIntegration(dir: string, phaseNumber: string, lastGoodSha: string): Promise<void> {
  const git = gitIn(dir);
  await createPhaseCheckpoint({ projectDir: dir, phaseNumber, protectedBranch: 'main' });
  const intBranch = integrationBranchFor(phaseNumber);
  await git(['checkout', '-q', '-B', intBranch, lastGoodSha]);
  await writeFile(join(dir, 'failed.txt'), 'failed work\n');
  await git(['add', '-A']);
  await git(['commit', '-q', '--no-verify', '-m', 'failed phase work']);
  await git(['checkout', '-q', 'main']);
}

function phaseInfo(number: string): RoadmapAnalysis {
  return { phases: [{ number, disk_status: 'planned', roadmap_complete: false, phase_name: 'Thing' }] };
}
function emptyRoadmap(): RoadmapAnalysis {
  return { phases: [] };
}

function failResult(phaseNumber: string, rollbackContext: PhaseRollbackContext, detail: string): PhaseRunnerResult {
  return {
    phaseNumber,
    phaseName: 'Thing',
    steps: [{ step: PhaseStepType.Execute, success: false, durationMs: 1, error: detail }],
    success: false,
    totalCostUsd: 0,
    totalDurationMs: 1,
    rollbackContext,
  };
}
function greenResult(phaseNumber: string): PhaseRunnerResult {
  return {
    phaseNumber,
    phaseName: 'Thing',
    steps: [{ step: PhaseStepType.Execute, success: true, durationMs: 1 }],
    success: true,
    totalCostUsd: 0,
    totalDurationMs: 1,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('(a) genuine gate failure → rollback + informed retry → halt at cap', () => {
  it('rolls back each attempt, injects prior-failure context into the retry, and halts after 5 attempts with ROLLBACK.json status:halted', async () => {
    const { dir, lastGoodSha, rollbackContext } = await setupFailedPhaseRepo('1');
    try {
      const gsd = new GSD({ projectDir: dir });

      // Phase discovery: phase 1 is incomplete until... it never completes here
      // (always fails), so roadmapAnalyze keeps returning it. The loop stops via
      // the halt path, not via re-discovery.
      vi.spyOn(gsd, 'createTools').mockReturnValue({
        roadmapAnalyze: vi.fn().mockResolvedValue(phaseInfo('1')),
      } as never);

      // Capture the priorFailureContext seen on each attempt to prove the
      // informed-retry context reaches the executor options.
      const seenPriorContext: Array<PhaseRunnerOptions['priorFailureContext']> = [];
      let attemptNo = 0;
      vi.spyOn(gsd, 'runPhase').mockImplementation((async (_num: string, opts?: PhaseRunnerOptions) => {
        attemptNo += 1;
        seenPriorContext.push(opts?.priorFailureContext);
        // Re-stage the integration branch the prior attempt's rollback tore down
        // so this attempt's rollback has something to clean (the real runPhase
        // would re-create it; the stub stands in for that).
        await restageIntegration(dir, '1', lastGoodSha);
        return failResult('1', rollbackContext, `gate exit 1 on attempt ${attemptNo}`);
      }) as never);

      const result = await gsd.run('build the thing');

      // Loop halted, not green.
      expect(result.success).toBe(false);

      // Exactly 5 attempts were made (the cap).
      expect(attemptNo).toBe(5);

      // Attempt 1 had NO prior context; every later attempt had the accumulated
      // prior-failure context injected — the whole point of the override.
      expect(seenPriorContext[0]).toBeUndefined();
      for (let i = 1; i < 5; i++) {
        const ctx = seenPriorContext[i];
        expect(ctx, `attempt ${i + 1} should carry prior-failure context`).toBeTruthy();
        expect(ctx!.length).toBe(i); // i prior failures accumulated
        expect(ctx![0].detail).toContain('gate exit 1 on attempt 1');
        expect(ctx![0].signal).toBe('gate');
        expect(ctx![0].attempt).toBe(1);
      }

      // Tier-1 ran: protected still at LAST_GOOD, integration branch gone.
      const mainSha = (await gitIn(dir)(['rev-parse', 'main'])).stdout.trim();
      expect(mainSha).toBe(lastGoodSha);
      expect(await refExists(dir, integrationBranchFor('1'))).toBe(false);

      // ROLLBACK.json persisted as halted with 5 attempts of failure context.
      const ledger = JSON.parse(await readFile(join(dir, '.planning', 'ROLLBACK.json'), 'utf-8'));
      expect(ledger.status).toBe('halted');
      expect(ledger.failed_phase).toBe('1');
      expect(ledger.attempt_count).toBe(5);
      expect(ledger.failure_context.length).toBe(5);
      expect(ledger.failure_context[4].attempt).toBe(5);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('(b) transient/quota failure → WAITING.json resume, no attempt consumed, no rollback', () => {
  it('resumes the same phase via WAITING.json without rolling back, then advances when the retry goes green', async () => {
    const { dir, lastGoodSha, rollbackContext } = await setupFailedPhaseRepo('1');
    try {
      const gsd = new GSD({ projectDir: dir });
      vi.spyOn(gsd, 'createTools').mockReturnValue({
        roadmapAnalyze: vi
          .fn()
          // First analyze: phase 1 incomplete. After it goes green, re-discovery
          // returns empty so the loop ends.
          .mockResolvedValueOnce(phaseInfo('1'))
          .mockResolvedValue(emptyRoadmap()),
      } as never);

      let call = 0;
      vi.spyOn(gsd, 'runPhase').mockImplementation((async () => {
        call += 1;
        if (call === 1) {
          // Transient: a rate-limit detail → classified quota-exceeded.
          return failResult('1', rollbackContext, 'HTTP 429 Too Many Requests; retry-after: 30');
        }
        // Second call: green (the quota reset, phase succeeds).
        return greenResult('1');
      }) as never);

      const result = await gsd.run('build the thing');

      // The phase ultimately advanced (green on the resume).
      expect(result.success).toBe(true);
      expect(call).toBe(2);

      // No rollback happened on the transient failure: the integration branch
      // staged in the repo is UNTOUCHED (still present), and protected is at
      // LAST_GOOD (it never moved).
      expect(await refExists(dir, integrationBranchFor('1'))).toBe(true);
      const mainSha = (await gitIn(dir)(['rev-parse', 'main'])).stdout.trim();
      expect(mainSha).toBe(lastGoodSha);

      // No retry ledger was written (transient does not consume an attempt /
      // roll back, so ROLLBACK.json is never created).
      expect(existsSync(join(dir, '.planning', 'ROLLBACK.json'))).toBe(false);

      // WAITING.json was cleared on the successful resume (signal-resume runs on
      // green).
      expect(existsSync(join(dir, '.planning', 'WAITING.json'))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('(GROUP-C) a GENUINE gate failure whose detail contains "rate limit"/"429" is NOT misread as transient', () => {
  it('a failing rate-limit TEST (gate signal, no HTTP/runtime context) → Tier-1 rollback + informed retry (consumes attempts), not a WAITING.json resume', async () => {
    // Reproduces-then-kills genuine-failure-misclassified-transient-via-quota-
    // sentinel: the gate detail names a failing test ABOUT rate-limiting. Pre-fix
    // classifyAgentFailure substring-matched "rate limit"/"429" in the gate
    // CONTENT → quota-exceeded → WAITING.json resume, no rollback, burning up to
    // 50 identical re-runs. Post-fix the gate signal is content (not a runtime
    // termination), the sentinel has no HTTP/runtime co-occurrence → GENUINE →
    // Tier-1 rollback fires and attempts are consumed to the cap.
    const { dir, lastGoodSha, rollbackContext } = await setupFailedPhaseRepo('1');
    try {
      const gsd = new GSD({ projectDir: dir });
      vi.spyOn(gsd, 'createTools').mockReturnValue({
        roadmapAnalyze: vi.fn().mockResolvedValue(phaseInfo('1')),
      } as never);

      let attemptNo = 0;
      vi.spyOn(gsd, 'runPhase').mockImplementation((async () => {
        attemptNo += 1;
        await restageIntegration(dir, '1', lastGoodSha);
        // Gate failure naming a failing rate-limit test — the quota words are
        // CONTENT, not a runtime quota-kill, and carry no HTTP/runtime context.
        return failResult('1', rollbackContext, 'FAIL test/rate-limit.spec.ts > should enforce rate limit: expected 429 got 200');
      }) as never);

      const result = await gsd.run('build the thing');

      // GENUINE path: halted at the cap (NOT spinning on transient resumes).
      expect(result.success).toBe(false);
      expect(attemptNo).toBe(5); // attempts CONSUMED — proves genuine, not transient

      // Tier-1 rollback fired each attempt: protected at LAST_GOOD, no WAITING.json.
      const mainSha = (await gitIn(dir)(['rev-parse', 'main'])).stdout.trim();
      expect(mainSha).toBe(lastGoodSha);
      expect(existsSync(join(dir, '.planning', 'WAITING.json'))).toBe(false);

      // ROLLBACK.json halted at 5 genuine attempts.
      const ledger = JSON.parse(await readFile(join(dir, '.planning', 'ROLLBACK.json'), 'utf-8'));
      expect(ledger.status).toBe('halted');
      expect(ledger.attempt_count).toBe(5);
      expect(ledger.failure_context.length).toBe(5);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('(R3 C-1) a Claude-subscription quota kill on the GATE path resumes via WAITING.json', () => {
  it('a gate-signal failure naming "usage limit reached / limit will reset" → quota → WAITING.json resume, NO rollback, NO attempt consumed', async () => {
    // Reproduces-then-kills C-1 (gate-path quota kill misread as genuine): a REAL
    // quota/usage-limit kill during EXECUTE does NOT throw — the SDK catches it
    // and runPhase returns a FAILED PlanResult → signal='gate' → the GROUP-C
    // content gate (which needs an HTTP/runtime marker) would misread the human
    // Claude-subscription text as GENUINE → Tier-1 rollback + burn the 5 retry
    // attempts re-hitting the same quota → HALT (NOT a WAITING.json resume). R3
    // trusts the unambiguous subscription phrasing on the gate path → resume.
    const { dir, lastGoodSha, rollbackContext } = await setupFailedPhaseRepo('1');
    try {
      const gsd = new GSD({ projectDir: dir });
      vi.spyOn(gsd, 'createTools').mockReturnValue({
        roadmapAnalyze: vi
          .fn()
          .mockResolvedValueOnce(phaseInfo('1'))
          .mockResolvedValue(emptyRoadmap()),
      } as never);

      let call = 0;
      vi.spyOn(gsd, 'runPhase').mockImplementation((async () => {
        call += 1;
        if (call === 1) {
          // The common Claude-subscription kill text, surfaced as a GATE failure
          // (no throw, no HTTP/runtime marker).
          return failResult('1', rollbackContext, 'Claude AI usage limit reached. Your limit will reset at 4pm.');
        }
        return greenResult('1');
      }) as never);

      const result = await gsd.run('build the thing');

      // Resumed (no attempt consumed) and then advanced green on the second call.
      expect(result.success).toBe(true);
      expect(call).toBe(2);

      // NO rollback on the quota kill: integration branch untouched, protected at
      // LAST_GOOD.
      expect(await refExists(dir, integrationBranchFor('1'))).toBe(true);
      const mainSha = (await gitIn(dir)(['rev-parse', 'main'])).stdout.trim();
      expect(mainSha).toBe(lastGoodSha);

      // No retry ledger (quota does not consume an attempt / roll back).
      expect(existsSync(join(dir, '.planning', 'ROLLBACK.json'))).toBe(false);
      // WAITING.json cleared on the green resume.
      expect(existsSync(join(dir, '.planning', 'WAITING.json'))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('(c) green phase advances normally — no rollback, no ROLLBACK.json', () => {
  it('a phase that succeeds advances without any rollback or ledger', async () => {
    const { dir } = await setupFailedPhaseRepo('1');
    try {
      const gsd = new GSD({ projectDir: dir });
      vi.spyOn(gsd, 'createTools').mockReturnValue({
        roadmapAnalyze: vi
          .fn()
          .mockResolvedValueOnce(phaseInfo('1'))
          .mockResolvedValue(emptyRoadmap()),
      } as never);

      const runSpy = vi
        .spyOn(gsd, 'runPhase')
        .mockImplementation((async () => greenResult('1')) as never);

      const result = await gsd.run('build the thing');

      expect(result.success).toBe(true);
      expect(runSpy).toHaveBeenCalledTimes(1);
      // The green runPhase was called WITHOUT priorFailureContext.
      const firstCallOpts = runSpy.mock.calls[0][1] as PhaseRunnerOptions | undefined;
      expect(firstCallOpts?.priorFailureContext).toBeUndefined();
      // No ledger written.
      expect(existsSync(join(dir, '.planning', 'ROLLBACK.json'))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
