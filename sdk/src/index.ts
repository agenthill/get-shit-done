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

import type { GSDOptions, PlanResult, SessionOptions, GSDEvent, TransportHandler, PhaseRunnerOptions, PhaseRunnerResult, MilestoneRunnerOptions, MilestoneRunnerResult, RoadmapPhaseInfo, PhaseFailureContext } from './types.js';
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
import { detectRuntime } from './query/helpers.js';
import { buildGitExecutionEngineFactory } from './build-execution-engine.js';
import { classifyAgentFailure } from './query/agent-failure-classifier.js';
import { rollbackTier1 } from './query/rollback-engine.js';
import { writeRollbackLedger } from './query/rollback-ledger.js';
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

      // Classify the failure: transient/quota vs genuine.
      const { signal, detail } = this.classifyPhaseFailure(result, threw);
      const classification = classifyAgentFailure(detail);

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
