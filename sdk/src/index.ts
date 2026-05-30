/**
 * GSD SDK — Public API for running GSD plans programmatically.
 *
 * The GSD class composes plan parsing, config loading, prompt building,
 * and session running into a single `executePlan()` call.
 *
 * @example
 * ```typescript
 * import { GSD } from '@gsd-build/sdk';
 *
 * const gsd = new GSD({ projectDir: '/path/to/project' });
 * const result = await gsd.executePlan('.planning/phases/01-auth/01-auth-01-PLAN.md');
 *
 * if (result.success) {
 *   console.log(`Plan completed in ${result.durationMs}ms, cost: $${result.totalCostUsd}`);
 * } else {
 *   console.error(`Plan failed: ${result.error?.messages.join(', ')}`);
 * }
 * ```
 */

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

import type { GSDOptions, PlanResult, SessionOptions, GSDEvent, TransportHandler, PhaseRunnerOptions, PhaseRunnerResult, MilestoneRunnerOptions, MilestoneRunnerResult, RoadmapPhaseInfo, PhaseFailureContext, ParallelRunnerOptions, ParallelRunnerResult } from './types.js';
import { GSDEventType, PhaseStepType } from './types.js';
import { parsePlan, parsePlanFile } from './plan-parser.js';
import { loadConfig } from './config.js';
import { GSDTools, resolveGsdToolsPath } from './gsd-tools.js';
import { runPlanSession } from './session-runner.js';
import { buildExecutorPrompt, parseAgentTools } from './prompt-builder.js';
import { GSDEventStream } from './event-stream.js';
import { PhaseRunner } from './phase-runner.js';
import type { ExecutionEngineFactory } from './phase-runner.js';
import { ContextEngine } from './context-engine.js';
import { PromptFactory } from './phase-prompt.js';
import { detectRuntime, normalizePhaseName } from './query/helpers.js';
import { runParallelWaves } from './parallel-runner.js';
import { buildGitExecutionEngineFactory } from './build-execution-engine.js';
import { classifyAgentFailure } from './query/agent-failure-classifier.js';
import { rollbackTier1, cascadeRollbackTier2, resumeIncompleteRollback } from './query/rollback-engine.js';
import { readRollbackLedger, writeRollbackLedger } from './query/rollback-ledger.js';
import { readPhaseManifest } from './query/phase-manifest.js';
import { classifyCascade } from './query/tier2-cascade-classifier.js';
import { readPhaseDependsOn } from './query/phase-depends-on.js';
import { GitMergeSerializer } from './execution-engine.js';
import { stateSignalWaiting, stateSignalResume } from './query/state-mutation.js';

export { PlanningJournal } from './planning-journal.js';
export type { PlanningEvent, PlanningEventActor, PlanningJournalAppendInput } from './planning-journal.js';
export { PlanningRuntime } from './planning-runtime.js';

// ─── GSD class ───────────────────────────────────────────────────────────────

export class GSD {
  private readonly projectDir: string;
  private readonly gsdToolsPath: string;
  private readonly sessionId?: string;
  private readonly defaultModel?: string;
  private readonly defaultMaxBudgetUsd: number;
  private readonly defaultMaxTurns: number;
  private readonly autoMode: boolean;
  private readonly workstream?: string;
  private readonly strictSdk?: boolean;
  private readonly allowFallbackToSubprocess?: boolean;
  readonly eventStream: GSDEventStream;

  constructor(options: GSDOptions) {
    this.projectDir = resolve(options.projectDir);
    this.gsdToolsPath =
      options.gsdToolsPath ?? resolveGsdToolsPath(this.projectDir);
    this.sessionId = options.sessionId;
    this.defaultModel = options.model;
    this.defaultMaxBudgetUsd = options.maxBudgetUsd ?? 5.0;
    this.defaultMaxTurns = options.maxTurns ?? 50;
    this.autoMode = options.autoMode ?? false;
    this.workstream = options.workstream;
    this.strictSdk = options.strictSdk;
    this.allowFallbackToSubprocess = options.allowFallbackToSubprocess;
    this.eventStream = new GSDEventStream();
  }

  /**
   * Execute a single GSD plan file.
   *
   * Reads the plan from disk, parses it, loads project config,
   * optionally reads the agent definition, then runs a query() session.
   *
   * @param planPath - Path to the PLAN.md file (absolute or relative to projectDir)
   * @param options - Per-execution overrides
   * @returns PlanResult with cost, duration, success/error status
   */
  async executePlan(planPath: string, options?: SessionOptions): Promise<PlanResult> {
    // Resolve plan path relative to project dir
    const absolutePlanPath = resolve(this.projectDir, planPath);

    // Parse the plan
    const plan = await parsePlanFile(absolutePlanPath);

    // Load project config
    const config = await loadConfig(this.projectDir, this.workstream);

    // Try to load agent definition for tool restrictions
    const agentDef = await this.loadAgentDefinition();

    // Merge defaults with per-call options
    const sessionOptions: SessionOptions = {
      maxTurns: options?.maxTurns ?? this.defaultMaxTurns,
      maxBudgetUsd: options?.maxBudgetUsd ?? this.defaultMaxBudgetUsd,
      model: options?.model ?? this.defaultModel,
      cwd: options?.cwd ?? this.projectDir,
      allowedTools: options?.allowedTools,
    };

    return runPlanSession(plan, config, sessionOptions, agentDef, this.eventStream, {
      phase: undefined, // Phase context set by higher-level orchestrators
      planName: plan.frontmatter.plan,
    });
  }

  /**
   * Subscribe a simple handler to receive all GSD events.
   */
  onEvent(handler: (event: GSDEvent) => void): void {
    this.eventStream.on('event', handler);
  }

  /**
   * Subscribe a transport handler to receive all GSD events.
   * Transports provide structured onEvent/close lifecycle.
   */
  addTransport(handler: TransportHandler): void {
    this.eventStream.addTransport(handler);
  }

  /**
   * Create a GSDTools instance for state management operations.
   */
  createTools(): GSDTools {
    return new GSDTools({
      projectDir: this.projectDir,
      gsdToolsPath: this.gsdToolsPath,
      workstream: this.workstream,
      eventStream: this.eventStream,
      sessionId: this.sessionId,
      strictSdk: this.strictSdk,
      allowFallbackToSubprocess: this.allowFallbackToSubprocess,
      onDispatchEvent: (event) => {
        this.eventStream.emitEvent({
          type: GSDEventType.StreamEvent,
          timestamp: new Date().toISOString(),
          sessionId: this.sessionId ?? '',
          event,
        });
      },
    });
  }

  /**
   * Run a full phase lifecycle: discuss → research → plan → execute → verify → advance.
   *
   * Creates the necessary collaborators (GSDTools, PromptFactory, ContextEngine),
   * loads project config, instantiates a PhaseRunner, and delegates to `runner.run()`.
   *
   * @param phaseNumber - The phase number to execute (e.g. "01", "02")
   * @param options - Per-phase overrides for budget, turns, model, and callbacks
   * @returns PhaseRunnerResult with per-step results, overall success, cost, and timing
   */
  async runPhase(phaseNumber: string, options?: PhaseRunnerOptions): Promise<PhaseRunnerResult> {
    const tools = this.createTools();
    const promptFactory = new PromptFactory({ projectDir: this.projectDir });
    const contextEngine = new ContextEngine(this.projectDir, undefined, undefined, this.workstream);
    const config = await loadConfig(this.projectDir, this.workstream);

    // Auto mode: force auto_advance on and skip_discuss off so self-discuss kicks in
    if (this.autoMode) {
      config.workflow.auto_advance = true;
      config.workflow.skip_discuss = false;
    }

    // ADR 0013 option 3: opt-in, Claude-runtime-only git-backed execution engine.
    // Off/absent (or non-Claude runtime, inv-12) → no factory key → the runner
    // takes the unchanged shared-cwd no-op path. Building the factory runs the
    // FAIL-CLOSED worktree-capability probe and resolves the real build+test gate
    // BEFORE any plan dispatch; a probe failure throws here and aborts the phase.
    const useEngine =
      config.git?.sdk_worktree_execution === true &&
      detectRuntime({ runtime: config.runtime }) === 'claude';
    let executionEngineFactory: ExecutionEngineFactory | undefined;
    if (useEngine) {
      executionEngineFactory = await buildGitExecutionEngineFactory(config, this.projectDir);
    }

    const runner = new PhaseRunner({
      projectDir: this.projectDir,
      tools,
      promptFactory,
      contextEngine,
      eventStream: this.eventStream,
      config,
      ...(executionEngineFactory && { executionEngineFactory }),
    });

    return runner.run(phaseNumber, options);
  }

  /**
   * Run a full milestone: discover phases, execute each incomplete one in order,
   * re-discover after each completion to catch dynamically inserted phases.
   *
   * @param prompt - The user prompt describing the milestone goal
   * @param options - Per-milestone overrides for budget, turns, model, and callbacks
   * @returns MilestoneRunnerResult with per-phase results, overall success, cost, and timing
   */
  async run(prompt: string, options?: MilestoneRunnerOptions): Promise<MilestoneRunnerResult> {
    const tools = this.createTools();
    const startTime = Date.now();
    const phaseResults: PhaseRunnerResult[] = [];
    let success = true;

    // Discover initial phases
    const initialAnalysis = await tools.roadmapAnalyze();
    const incompletePhases = this.filterAndSortPhases(initialAnalysis.phases);

    // Emit MilestoneStart
    this.eventStream.emitEvent({
      type: GSDEventType.MilestoneStart,
      timestamp: new Date().toISOString(),
      sessionId: `milestone-${Date.now()}`,
      phaseCount: incompletePhases.length,
      prompt,
    });

    // Loop through phases, re-discovering after each completion
    let currentPhases = incompletePhases;

    // ADR 0013 option 4 (chunk 2): cap on total attempts per phase before
    // halting for a human. Absent/null → 5. Read once per milestone run.
    const config = await loadConfig(this.projectDir, this.workstream);
    const maxPhaseAttempts = config.git?.sdk_max_phase_attempts ?? 5;

    // ADR 0013 option 4 (chunk 4): crash-resume. If a prior run crashed mid
    // Tier-2 unwind, ROLLBACK.json carries an incomplete per-step journal.
    // Replay the REMAINING steps idempotently BEFORE selecting/running the next
    // phase (the journal's skip-done logic finishes them; it never re-reverts),
    // then settle to halted. A complete/absent journal → no-op. Reconstruct
    // protectedBranch + serializer + manifest the same way maybeCascadeTier2
    // does.
    let haltedByResume = false;
    try {
      // GROUP-E fix: detect a PRESENT-but-CORRUPT ROLLBACK.json BEFORE the
      // manifest gate. A truncated ledger means a possibly half-unwound tree;
      // the driver must HALT regardless of whether a manifest exists (the
      // resume-replay below only runs with a manifest, but the corruption HALT
      // is independent of it). readRollbackLedger throws on corrupt, returns null
      // on absent. An absent/valid ledger proceeds.
      const existingLedger = await readRollbackLedger(this.projectDir);

      // E-2 fix: a CLEAN Tier-2 cascade settles ROLLBACK.json to
      // `{status:'halted', tier:2, cascade_set:[...]}` with NO `steps` journal
      // (the cascade completed in one pass, nothing to crash-resume).
      // resumeIncompleteRollback only acts on an INCOMPLETE steps journal, so on a
      // fresh GSD.run that ledger yields halt:false and the phase loop would
      // AUTO-ADVANCE past a Tier-2 halt — violating "never auto-advance after
      // Tier-2". Gate on the SETTLED Tier-2 HALT directly: a present ledger whose
      // tier===2 HALTS regardless of the steps journal.
      //
      // J2: gate on `tier === 2` ONLY — do NOT also catch `status === 'halted'`.
      // A Tier-2 cascade reverted PROMOTED predecessor work and is halt-worthy
      // until a human reviews + clears the ledger (sticky). A bare Tier-1 cap-halt
      // (`{status:'halted'}`, NO `tier`, written at the cap-reached branch below)
      // and the R4 promote-recovery-halt both leave protected at LAST_GOOD with
      // nothing promoted-then-reverted, so a deliberate fresh GSD.run may
      // re-attempt (the pre-E-2 Tier-1 behavior) rather than refusing until
      // ROLLBACK.json is manually cleared. An ABSENT ledger (null) proceeds; a
      // 'retrying' ledger is NOT a halt (the crash-resume replay / informed-retry
      // path below handles it).
      if (existingLedger && existingLedger.tier === 2) {
        haltedByResume = true;
      }

      // Still run the crash-resume replay when a manifest exists: an INCOMPLETE
      // steps journal (a crash mid-cascade) must be finished idempotently even if
      // the settled-halt gate above already fired (a 'halted' ledger could in
      // principle co-exist with an unfinished journal). The replay's skip-done
      // logic only finishes remaining steps; a complete/absent journal → no-op.
      const resumeManifest = await readPhaseManifest(this.projectDir);
      if (Object.keys(resumeManifest).length > 0) {
        const protectedBranch = await this.resolveProtectedBranch(config);
        const serializer = new GitMergeSerializer(this.projectDir, protectedBranch, async () => 0);
        const resume = await resumeIncompleteRollback({
          projectDir: this.projectDir,
          protectedBranch,
          serializer,
          manifest: resumeManifest,
          ...(this.workstream && { workstream: this.workstream }),
        });
        // The driver MUST HALT when `resume.halt` is set — either because a
        // Tier-2 unwind was completed on restart (NEVER auto-advance after
        // Tier-2; consistent with the clean maybeCascadeTier2 halt path) OR
        // because ROLLBACK.json is PRESENT-but-CORRUPT (GROUP-E fix: a truncated
        // ledger means a possibly half-unwound tree — advancing would corrupt
        // protected; a corrupt ledger is no longer silently read as absent and
        // skipped). An ABSENT ledger leaves `halt` false → normal run. OR with the
        // E-2 settled-halt gate above (a clean no-journal Tier-2 halt).
        haltedByResume = haltedByResume || resume.halt;
      }
    } catch {
      // An errored resume could not safely complete the unwind; the driver must
      // not run new phases on a half-unwound tree — treat an errored resume as a
      // halt too (the same conservative posture, surfaced via ROLLBACK.json).
      // The resume only does git surgery when an incomplete journal exists, so
      // halting on its error is the safe choice.
      haltedByResume = true;
    }

    if (haltedByResume) {
      // Never auto-advance after a (crash-resumed) Tier-2 cascade: skip the
      // phase loop entirely. MilestoneComplete derives success below → false.
      success = false;
    } else {
      while (currentPhases.length > 0) {
        const phase = currentPhases[0];

        // Run the phase through the autonomous rollback + informed-retry driver:
        // a GENUINE failure rolls the phase back (Tier-1) and re-runs it with the
        // accumulated prior-failure context, up to maxPhaseAttempts, then HALTs;
        // a transient/quota failure resumes the SAME phase via WAITING.json
        // without consuming an attempt or rolling back; a green phase advances.
        const outcome = await this.runPhaseWithRollbackRetry(phase, options, maxPhaseAttempts);
        phaseResults.push(outcome.result);

        if (!outcome.result.success) {
          // Either the phase threw / failed beyond recovery, or the driver halted
          // after exhausting attempts. Stop the autonomous loop for a human.
          success = false;
          break;
        }

        // Notify callback if present; stop if requested
        if (options?.onPhaseComplete) {
          const verdict = await options.onPhaseComplete(outcome.result, phase);
          if (verdict === 'stop') {
            break;
          }
        }

        // Re-discover phases to catch dynamically inserted ones
        const updatedAnalysis = await tools.roadmapAnalyze();
        currentPhases = this.filterAndSortPhases(updatedAnalysis.phases);
      }
    }

    const totalCostUsd = phaseResults.reduce((sum, r) => sum + r.totalCostUsd, 0);
    const totalDurationMs = Date.now() - startTime;

    // Emit MilestoneComplete
    this.eventStream.emitEvent({
      type: GSDEventType.MilestoneComplete,
      timestamp: new Date().toISOString(),
      sessionId: `milestone-${Date.now()}`,
      success,
      totalCostUsd,
      totalDurationMs,
      phasesCompleted: phaseResults.filter(r => r.success).length,
    });

    return {
      success,
      phases: phaseResults,
      totalCostUsd,
      totalDurationMs,
    };
  }

  /**
   * Run N independent backlog phases in concurrency waves (ADR 0014). Schedules
   * the phases via `conflict-graph` (hard-disjoint within a wave) and fans out
   * one phase-agent per wave member through the SAME per-phase rollback/retry
   * driver `run()` uses — reusing checkpoint + Tier-1/Tier-2 + promote-on-green.
   * Parallel within a wave, sequential across waves.
   */
  async runParallel(
    phaseNumbers: string[],
    options?: ParallelRunnerOptions,
  ): Promise<ParallelRunnerResult> {
    const tools = this.createTools();
    const config = await loadConfig(this.projectDir, this.workstream);
    const maxPhaseAttempts = config.git?.sdk_max_phase_attempts ?? 5;

    // Resolve roadmap metadata once; the wave loop looks phases up by token. The
    // conflict-graph waves carry NORMALIZED tokens (`'1'` → `'01'`), so index the
    // roadmap by normalized number to reconcile against the wave member token.
    const analysis = await tools.roadmapAnalyze();
    const byNormalized = new Map(
      analysis.phases.map((p) => [normalizePhaseName(p.number), p] as const),
    );

    return runParallelWaves(phaseNumbers, options, {
      projectDir: this.projectDir,
      ...(this.workstream && { workstream: this.workstream }),
      parallelization: config.parallelization !== false,
      resolvePhase: async (waveToken) => {
        const found = byNormalized.get(normalizePhaseName(waveToken));
        if (!found) {
          throw new Error(`Phase ${waveToken} not found in ROADMAP for parallel run`);
        }
        return found;
      },
      runPhase: (phase) => this.runPhaseWithRollbackRetry(phase, options, maxPhaseAttempts),
    });
  }

  /**
   * Run a phase through the autonomous rollback + informed-retry driver (ADR
   * 0013 option 4, chunk 2). Returns the final PhaseRunnerResult (success or the
   * terminal failure that halted the loop) and whether the driver halted.
   *
   * Routing per attempt:
   *   - Phase threw → treat as a GENUINE failure (signal 'throw').
   *   - Phase succeeded (green) → return immediately; no rollback, no ledger.
   *   - Phase failed but the failure classifies as TRANSIENT/quota → write a
   *     WAITING.json signal and re-run the SAME phase WITHOUT consuming an
   *     attempt or rolling back; clear the signal on the next pass.
   *   - Phase failed GENUINELY (gate/verify) → rollback Tier-1, accumulate the
   *     attempt's failure context, persist ROLLBACK.json, and either re-run with
   *     the context injected (attempt < cap) or HALT (attempt == cap).
   */
  private async runPhaseWithRollbackRetry(
    phase: RoadmapPhaseInfo,
    options: MilestoneRunnerOptions | undefined,
    maxPhaseAttempts: number,
  ): Promise<{ result: PhaseRunnerResult; halted: boolean }> {
    const failureContext: PhaseFailureContext[] = [];
    let attempt = 1;
    // Bound the loop hard: at most maxPhaseAttempts genuine attempts, plus a
    // generous allowance for transient resumes (which do not consume attempts).
    // The transient guard below caps consecutive transient resumes so a runtime
    // stuck in a quota loop cannot spin forever.
    let consecutiveTransient = 0;
    const MAX_CONSECUTIVE_TRANSIENT = 50;

    for (;;) {
      let result: PhaseRunnerResult;
      let threw = false;
      try {
        result = await this.runPhase(phase.number, {
          ...options,
          // Pass a SNAPSHOT copy, not the live array — the driver mutates
          // failureContext across attempts; the executor must see only the
          // failures known at THIS attempt's start.
          ...(failureContext.length > 0 && { priorFailureContext: [...failureContext] }),
        });
      } catch (err) {
        threw = true;
        result = {
          phaseNumber: phase.number,
          phaseName: phase.phase_name,
          steps: [],
          success: false,
          totalCostUsd: 0,
          totalDurationMs: 0,
        };
        // Stamp the thrown error as the failure detail for classification below.
        (result as PhaseRunnerResult & { _throwDetail?: string })._throwDetail =
          err instanceof Error ? err.message : String(err);
      }

      // Green: clear any stale WAITING.json and return.
      if (result.success) {
        await stateSignalResume([], this.projectDir, this.workstream);
        return { result, halted: false };
      }

      // R4 (GH-1): a promote that MOVED protected then failed post-merge (guard-
      // suite / manifest-write failure). The phase-runner ALREADY recovered a
      // clean, consistent state (protected reset to LAST_GOOD, integration branch
      // preserved). Do NOT run Tier-1 (its branch-delete + LAST_GOOD assert would
      // destroy the recoverable work and throw on the moved tree). HALT directly
      // for recovery: clear any transient signal, persist a halted ledger, stop.
      if (result.promoteRecoveryHalt) {
        await stateSignalResume([], this.projectDir, this.workstream);
        await writeRollbackLedger(this.projectDir, {
          failed_phase: phase.number,
          attempt_count: attempt,
          failure_context: [
            ...failureContext,
            {
              attempt,
              signal: 'gate',
              detail: `promote moved protected then failed post-merge — recovered to LAST_GOOD, integration branch ${result.promoteRecoveryHalt.integrationBranch} preserved; recovery required: ${result.promoteRecoveryHalt.detail}`,
            },
          ],
          status: 'halted',
        });
        return { result, halted: true };
      }

      // Classify the failure: transient/quota vs genuine.
      const { signal, detail } = this.classifyPhaseFailure(result, threw);
      // GROUP-C fix: a quota sentinel is only trusted as transient when it comes
      // from the agent RUNTIME's termination cause. The `throw` signal IS that
      // cause (the SDK/session crashed); `gate`/`verify` are CONTENT (test/build
      // output, verifier findings) where a quota-looking word can be the GENUINE
      // failure itself (a failing test about rate-limiting). For content, the
      // classifier additionally requires the sentinel to co-occur with HTTP/
      // runtime context before reading it as transient — EXCEPT an unambiguous
      // Claude-subscription quota phrasing ("usage limit reached", "limit will
      // reset"), which the classifier trusts on the gate path directly (R3 C-1):
      // a real EXECUTE quota kill does not throw — it returns a failed PlanResult
      // (signal='gate') — and must RESUME via WAITING.json, not burn the retry
      // budget re-hitting the same quota.
      const classification = classifyAgentFailure(detail, {
        fromRuntimeTermination: signal === 'throw',
      });

      if (classification.class === 'quota-exceeded') {
        // Transient: resume the SAME phase via the existing WAITING.json
        // mechanism. Do NOT roll back and do NOT consume an attempt.
        consecutiveTransient += 1;
        if (consecutiveTransient > MAX_CONSECUTIVE_TRANSIENT) {
          // Runtime stuck in a quota loop — halt rather than spin forever.
          return { result, halted: true };
        }
        const waitingArgs = ['--type', 'quota_wait', '--phase', phase.number];
        if (classification.retryAfterSeconds !== undefined) {
          waitingArgs.push('--question', `Quota exceeded; retry after ${classification.retryAfterSeconds}s`);
        }
        await stateSignalWaiting(waitingArgs, this.projectDir, this.workstream);
        // Loop again on the SAME phase without touching attempt/failureContext.
        continue;
      }

      // Genuine failure: clear any transient signal, roll back Tier-1, record.
      consecutiveTransient = 0;
      await stateSignalResume([], this.projectDir, this.workstream);

      if (result.rollbackContext) {
        try {
          await rollbackTier1({
            projectDir: this.projectDir,
            phaseNumber: result.rollbackContext.phaseNumber,
            protectedBranch: result.rollbackContext.protectedBranch,
            lastGoodSha: result.rollbackContext.lastGoodSha,
            snapshotDir: result.rollbackContext.snapshotDir,
            integrationBranch: result.rollbackContext.integrationBranch,
          });
        } catch (rbErr) {
          // A rollback that cannot reach a clean LAST_GOOD is itself a halt
          // condition (fail-closed): record it and stop rather than retry into a
          // dirty tree. The rollback failure detail is preserved in the ledger.
          const rbDetail = rbErr instanceof Error ? rbErr.message : String(rbErr);
          await writeRollbackLedger(this.projectDir, {
            failed_phase: phase.number,
            attempt_count: attempt,
            failure_context: [...failureContext, { attempt, signal, detail: `${detail} | rollback failed: ${rbDetail}` }],
            status: 'halted',
          });
          return { result, halted: true };
        }

        // ── Tier-2 cascade attribution (ADR 0013 option 4, chunk 3) ──
        // After phase N's clean Tier-1, BEFORE deciding to informed-retry, ask
        // whether the failure implicates an ALREADY-PROMOTED predecessor.
        // ATTRIBUTABLE-ONLY else HALT:
        //   - revert-confident  → cascade-revert the attributable depends_on-
        //                         linked predecessors, then HALT for a human
        //                         (reverting promoted work unattended is
        //                         halt-worthy; never auto-retry after Tier-2).
        //   - cannot-classify   → HALT with a clean tree (an inability to decide
        //                         must NEVER masquerade as no-cascade).
        //   - no-cascade-confident → fall through to chunk-2's informed retry.
        const cascadeHalt = await this.maybeCascadeTier2(
          phase,
          result.rollbackContext,
          { attempt, signal, detail },
          failureContext,
        );
        if (cascadeHalt) {
          return { result, halted: true };
        }
      }

      // Accumulate this attempt's failure context.
      failureContext.push({ attempt, signal, detail });

      if (attempt >= maxPhaseAttempts) {
        // Cap reached: persist halted ledger and stop. Do NOT advance / skip.
        await writeRollbackLedger(this.projectDir, {
          failed_phase: phase.number,
          attempt_count: attempt,
          failure_context: failureContext,
          status: 'halted',
        });
        return { result, halted: true };
      }

      // Attempts remain: persist the retrying ledger and re-run with the
      // accumulated context injected (the next loop iteration threads it in).
      attempt += 1;
      await writeRollbackLedger(this.projectDir, {
        failed_phase: phase.number,
        attempt_count: attempt,
        failure_context: failureContext,
        status: 'retrying',
      });
    }
  }

  /**
   * Derive the failure signal + detail from a non-green PhaseRunnerResult (ADR
   * 0013 option 4, chunk 2). The detail string is what gets classified
   * (transient vs genuine) and recorded into ROLLBACK.json + the executor
   * context on the next attempt.
   */
  private classifyPhaseFailure(
    result: PhaseRunnerResult,
    threw: boolean,
  ): { signal: PhaseFailureContext['signal']; detail: string } {
    if (threw) {
      const detail = (result as PhaseRunnerResult & { _throwDetail?: string })._throwDetail
        ?? 'phase threw an unexpected error';
      return { signal: 'throw', detail };
    }
    // Prefer the execute step's failure (gate / plan error) over verify, since a
    // failed execute is the gate signal; fall back to verify gaps.
    const execStep = result.steps.find(s => s.step === PhaseStepType.Execute && !s.success);
    if (execStep) {
      const planErrs = (execStep.planResults ?? [])
        .filter(p => !p.success)
        .map(p => p.error?.messages?.join('; '))
        .filter((m): m is string => !!m);
      const detail = execStep.error
        ?? (planErrs.length > 0 ? planErrs.join(' | ') : 'gate failed (test exit != 0 or plan execution failed)');
      return { signal: 'gate', detail };
    }
    const verifyStep = result.steps.find(s => s.step === PhaseStepType.Verify && !s.success);
    if (verifyStep) {
      return { signal: 'verify', detail: verifyStep.error ?? 'verification found gaps' };
    }
    // No specific failed step found — generic detail.
    return { signal: 'gate', detail: 'phase did not reach green (no specific failed step)' };
  }

  /**
   * Tier-2 cascade decision (ADR 0013 option 4, chunk 3). Run AFTER phase N's
   * clean Tier-1 rollback, BEFORE the informed-retry decision. Reads the phase
   * manifest + the failure's implicated files and classifies whether a promoted
   * predecessor should be cascade-reverted:
   *
   *   - `revert-confident`     → run the Tier-2 cascade over the attributable
   *                              set, persist a {tier:2, cascade_set,
   *                              status:'halted'} ledger, and return true (HALT).
   *   - `cannot-classify`      → persist a halted ledger and return true (HALT
   *                              clean — never cascade on a guess).
   *   - `no-cascade-confident` → return false (fall through to informed retry).
   *
   * Returns true when the caller must HALT the autonomous loop.
   */
  private async maybeCascadeTier2(
    phase: RoadmapPhaseInfo,
    rollbackContext: NonNullable<PhaseRunnerResult['rollbackContext']>,
    thisAttempt: PhaseFailureContext,
    failureContext: PhaseFailureContext[],
  ): Promise<boolean> {
    const manifest = await readPhaseManifest(this.projectDir);
    // No promoted predecessor at all → there is nothing to cascade onto; skip
    // the classifier entirely and let the informed-retry path handle phase N.
    if (Object.keys(manifest).length === 0) return false;

    const implicatedFiles = extractImplicatedFiles(thisAttempt.detail);
    // A genuine failure whose detail names no files cannot be ATTRIBUTED. When a
    // depends_on-linked promoted predecessor is a cascade candidate, that
    // inability-to-decide must HALT (cannot-classify), never silently retry past
    // a predecessor the failure might have broken. The classifier only applies
    // this gate once a candidate exists (no candidate ⇒ confident no-cascade).
    const implicatedFilesUncertain = implicatedFiles.length === 0;

    // The failing phase has not promoted, so its phase-level depends_on lives
    // only in the ROADMAP. Read it so the classifier's closure walk starts from
    // the failing phase's real dependency edges.
    let failingPhaseDependsOn: string[] = [];
    try {
      failingPhaseDependsOn = await readPhaseDependsOn(this.projectDir, phase.number, this.workstream);
    } catch {
      failingPhaseDependsOn = [];
    }

    let cls;
    try {
      cls = await classifyCascade({
        projectDir: this.projectDir,
        failingPhase: phase.number,
        manifest,
        implicatedFiles,
        implicatedFilesUncertain,
        failingPhaseDependsOn,
      });
    } catch (err) {
      // The classifier itself failing is an inability to decide → HALT clean.
      const clsDetail = err instanceof Error ? err.message : String(err);
      await writeRollbackLedger(this.projectDir, {
        failed_phase: phase.number,
        attempt_count: thisAttempt.attempt,
        failure_context: [
          ...failureContext,
          { ...thisAttempt, detail: `${thisAttempt.detail} | Tier-2 classifier error: ${clsDetail}` },
        ],
        status: 'halted',
        tier: 2,
        cascade_set: [],
      });
      return true;
    }

    if (cls.verdict === 'no-cascade-confident') {
      return false; // fall through to chunk-2's informed retry
    }

    if (cls.verdict === 'cannot-classify') {
      // HALT clean — inability to decide must never be downgraded to no-cascade.
      await writeRollbackLedger(this.projectDir, {
        failed_phase: phase.number,
        attempt_count: thisAttempt.attempt,
        failure_context: [...failureContext, thisAttempt],
        status: 'halted',
        tier: 2,
        cascade_set: [],
      });
      return true;
    }

    // revert-confident: cascade-revert the attributable set, then HALT.
    const serializer = new GitMergeSerializer(
      this.projectDir,
      rollbackContext.protectedBranch,
      async () => 0, // the revert's guard suite never runs the build gate
    );
    // An UNEXPECTED throw out of the rollback engine (e.g. commitParents on a
    // GC'd manifest sha, or a `git rev-parse` failure) must NOT escape GSD.run
    // with a dirty tree. The engine's own conflict path already restores a clean
    // tree before halting; this catch is the fail-closed backstop for a throw
    // that bypasses it — best-effort clean the tree, settle a halted Tier-2
    // ledger, and HALT (GROUP-B fix).
    let casc: Awaited<ReturnType<typeof cascadeRollbackTier2>>;
    try {
      casc = await cascadeRollbackTier2({
        projectDir: this.projectDir,
        protectedBranch: rollbackContext.protectedBranch,
        cascadeSet: cls.cascadeSet,
        manifest,
        serializer,
        ...(this.workstream && { workstream: this.workstream }),
      });
    } catch (cascErr) {
      await this.cleanWorkingTree(rollbackContext.protectedBranch);
      const cascDetail = cascErr instanceof Error ? cascErr.message : String(cascErr);
      await writeRollbackLedger(this.projectDir, {
        failed_phase: phase.number,
        attempt_count: thisAttempt.attempt,
        failure_context: [
          ...failureContext,
          { ...thisAttempt, detail: `${thisAttempt.detail} | Tier-2 cascade threw: ${cascDetail}` },
        ],
        status: 'halted',
        tier: 2,
        cascade_set: cls.cascadeSet,
      });
      return true;
    }

    await writeRollbackLedger(this.projectDir, {
      failed_phase: phase.number,
      attempt_count: thisAttempt.attempt,
      failure_context: [
        ...failureContext,
        {
          ...thisAttempt,
          detail: `${thisAttempt.detail} | Tier-2 ${casc.status}: reverted [${casc.revertedPhases.join(', ')}]${casc.haltReason ? ` (${casc.haltReason})` : ''}`,
        },
      ],
      status: 'halted',
      tier: 2,
      cascade_set: cls.cascadeSet,
    });
    return true;
  }

  /**
   * Best-effort restore a clean working tree on the protected branch after an
   * unexpected throw out of the rollback engine (GROUP-B fail-closed backstop):
   * abort any in-flight revert, unstage, restore tracked files, and drop
   * untracked residue. Every step swallows its own error — this runs in a
   * catch handler and must never throw.
   */
  private async cleanWorkingTree(protectedBranch: string): Promise<void> {
    const git = (args: string[]) =>
      execFileAsync('git', args, { cwd: this.projectDir }).catch(() => undefined);
    await git(['revert', '--abort']);
    await git(['reset', 'HEAD']);
    await git(['checkout', protectedBranch]);
    await git(['restore', '.']);
    await git(['clean', '-fd']);
  }

  /**
   * Resolve the protected branch for crash-resume (chunk 4), mirroring
   * build-execution-engine.resolveProtectedBranch: honor `git.base_branch`, else
   * try `main`, then `master`, then the current branch. Kept private/local so the
   * resume path does not depend on building the (probe-gated) execution engine.
   */
  private async resolveProtectedBranch(config: Awaited<ReturnType<typeof loadConfig>>): Promise<string> {
    const configured = config.git?.base_branch;
    if (typeof configured === 'string' && configured.trim().length > 0) {
      return configured.trim();
    }
    const exists = async (ref: string): Promise<boolean> => {
      try {
        await execFileAsync('git', ['rev-parse', '--verify', ref], { cwd: this.projectDir });
        return true;
      } catch {
        return false;
      }
    };
    if (await exists('main')) return 'main';
    if (await exists('master')) return 'master';
    const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: this.projectDir });
    return stdout.trim();
  }

  /**
   * Filter to incomplete phases and sort numerically.
   * Uses parseFloat to handle decimal phase numbers (e.g. '5.1').
   */
  private filterAndSortPhases(phases: RoadmapPhaseInfo[]): RoadmapPhaseInfo[] {
    return phases
      .filter(p => !p.roadmap_complete)
      .sort((a, b) => parseFloat(a.number) - parseFloat(b.number));
  }

  /**
   * Load the gsd-executor agent definition if available.
   * Falls back gracefully — returns undefined if not found.
   */
  private async loadAgentDefinition(): Promise<string | undefined> {
    const paths = [
      // Repo-local GSD installation
      join(this.projectDir, '.claude', 'get-shit-done', 'agents', 'gsd-executor.md'),
      // Repo-local agents directory
      join(this.projectDir, '.claude', 'agents', 'gsd-executor.md'),
      // Global home directory
      join(homedir(), '.claude', 'agents', 'gsd-executor.md'),
      join(this.projectDir, 'agents', 'gsd-executor.md'),
    ];

    for (const p of paths) {
      try {
        return await readFile(p, 'utf-8');
      } catch {
        // Not found at this path, try next
      }
    }

    return undefined;
  }
}

/**
 * Extract repo-relative file paths a failure detail implicates (ADR 0013 option
 * 4, chunk 3). The Tier-2 classifier intersects these with a promoted
 * predecessor's touched paths to decide attribution. Conservative: matches
 * path-like tokens with a slash-or-known-source-extension, strips surrounding
 * punctuation, dedupes. An EMPTY result is a confident "no files named" for a
 * gate/verify failure (→ no-cascade); for a throw it is treated as uncertain by
 * the caller. We do NOT invent attributions — only tokens that clearly look
 * like file paths are returned.
 */
export function extractImplicatedFiles(detail: string): string[] {
  if (!detail) return [];
  const out = new Set<string>();
  // Path-like tokens: a run of path chars containing a slash OR ending in a
  // recognized source/test/doc extension. Anchored on whitespace, quotes,
  // parens, and common list punctuation so we trim delimiters.
  const tokenRe = /[A-Za-z0-9_.\-/]+/g;
  const sourceExt =
    /\.(ts|tsx|js|jsx|mjs|cjs|json|md|py|rs|go|java|rb|sh|yml|yaml|toml|css|scss|html|sql)$/i;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(detail)) !== null) {
    let tok = m[0];
    // Strip trailing sentence punctuation a token may have captured.
    tok = tok.replace(/[.,;:)]+$/, '');
    if (tok.length < 3) continue;
    // Drop a trailing `:line` / `:line:col` location suffix so the path matches
    // a predecessor's touched-path exactly (e.g. `lib/bar.js:12` → `lib/bar.js`).
    tok = tok.replace(/(:\d+){1,2}$/, '');
    const looksLikePath = tok.includes('/') || sourceExt.test(tok);
    if (!looksLikePath) continue;
    // Normalize a leading `./`.
    out.add(tok.replace(/^\.\//, ''));
  }
  return [...out];
}

// ─── Re-exports for advanced usage ──────────────────────────────────────────

export { parsePlan, parsePlanFile } from './plan-parser.js';
export { loadConfig } from './config.js';
export type { GSDConfig } from './config.js';
export { GSDTools, GSDToolsError, resolveGsdToolsPath } from './gsd-tools.js';
export { runPlanSession, runPhaseStepSession } from './session-runner.js';
export { buildExecutorPrompt, parseAgentTools } from './prompt-builder.js';
export type { ExecutorPromptOptions } from './prompt-builder.js';
export * from './types.js';

// S02: Event stream, context, prompt, and logging modules
export { GSDEventStream } from './event-stream.js';
export type { EventStreamContext } from './event-stream.js';
export { ContextEngine, PHASE_FILE_MANIFEST } from './context-engine.js';
export type { FileSpec } from './context-engine.js';
export { truncateMarkdown, extractCurrentMilestone, DEFAULT_TRUNCATION_OPTIONS } from './context-truncation.js';
export type { TruncationOptions } from './context-truncation.js';
export { getToolsForPhase, PHASE_AGENT_MAP, PHASE_DEFAULT_TOOLS } from './tool-scoping.js';
export { checkResearchGate } from './research-gate.js';
export type { ResearchGateResult } from './research-gate.js';
export { PromptFactory, extractBlock, extractSteps, PHASE_WORKFLOW_MAP } from './phase-prompt.js';
export { GSDLogger } from './logger.js';
export type { LogLevel, LogEntry, GSDLoggerOptions } from './logger.js';

// S03: Phase lifecycle state machine
export { PhaseRunner, PhaseRunnerError } from './phase-runner.js';
export type { PhaseRunnerDeps, VerificationOutcome } from './phase-runner.js';

// ADR 0014: parallel multi-phase execution
export { runParallelWaves } from './parallel-runner.js';
export type { ParallelDriverContext } from './parallel-runner.js';

// S05: Transports
export { CLITransport } from './cli-transport.js';
export { WSTransport } from './ws-transport.js';
export type { WSTransportOptions } from './ws-transport.js';

// Query registry argv normalization (matches `gsd-sdk query` and `GSDTools` hot path)
export { createRegistry, normalizeQueryCommand } from './query/index.js';

// Workstream utilities
export { validateWorkstreamName, relPlanningPath } from './workstream-utils.js';

// Init workflow
export { InitRunner } from './init-runner.js';
export type { InitRunnerDeps } from './init-runner.js';
export type { InitConfig, InitResult, InitStepResult, InitStepName } from './types.js';
