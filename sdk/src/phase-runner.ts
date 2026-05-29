/**
 * Phase Runner — core state machine driving the full phase lifecycle.
 *
 * Orchestrates: discuss → research → plan → execute → verify → advance
 * with config-driven step skipping, human gate callbacks, event emission,
 * and structured error handling per step.
 */

import type {
  PhaseOpInfo,
  PhaseStepResult,
  PhaseRunnerResult,
  HumanGateCallbacks,
  PhaseRunnerOptions,
  PlanResult,
  SessionOptions,
  ParsedPlan,
  PhasePlanIndex,
  PlanDisposition,
} from './types.js';
import { PhaseStepType, PhaseType, GSDEventType } from './types.js';
import type { GSDConfig } from './config.js';
import type { GSDTools } from './gsd-tools.js';
import type { GSDEventStream } from './event-stream.js';
import type { PromptFactory } from './phase-prompt.js';
import type { ContextEngine } from './context-engine.js';
import type { GSDLogger } from './logger.js';
import { runPhaseStepSession, runPlanSession } from './session-runner.js';
import { parsePlanFile } from './plan-parser.js';
import { realpathSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { checkResearchGate } from './research-gate.js';
import { buildPlanDag, type PlanDag, type DagNode } from './plan-dag.js';
import {
  Semaphore,
  resolveConcurrencyCap,
  SharedCwdWorktreeManager,
  NoopMergeSerializer,
  type WorktreeManager,
  type MergeSerializer,
} from './execution-engine.js';

// ─── Wave tracker ──────────────────────────────────────────────────────────────

/**
 * Emits synthetic WaveStart/WaveComplete at topological-level transitions so the
 * event-stream cardinality stays byte-compatible with the old wave-barrier model
 * (one WaveStart + one WaveComplete per level, planIds in declaration order,
 * aggregated success/failure counts). Unlike the old hard barrier, the engine
 * itself does not block on these — they are observational markers fired as a
 * level's first plan starts and as its last plan settles.
 *
 * When parallelization is disabled, no wave events are emitted (matching the
 * prior sequential path).
 */
class WaveTracker {
  private readonly planIdsByLevel = new Map<number, string[]>();
  private readonly remaining = new Map<number, number>();
  private readonly started = new Set<number>();
  private readonly waveStart = new Map<number, number>();
  private readonly success = new Map<number, number>();
  private readonly failure = new Map<number, number>();

  constructor(
    private readonly eventStream: GSDEventStream,
    private readonly phaseNumber: string,
    private readonly enabled: boolean,
  ) {}

  /** Register the plan ids per level (in declaration order) before execution. */
  plan(levelGroups: Map<number, string[]>): void {
    for (const [level, ids] of levelGroups) {
      this.planIdsByLevel.set(level, ids);
      this.remaining.set(level, ids.length);
      this.success.set(level, 0);
      this.failure.set(level, 0);
    }
  }

  /** Mark a plan at `level` as started; emit WaveStart on the level's first start. */
  start(level: number): void {
    if (!this.enabled) return;
    if (this.started.has(level)) return;
    this.started.add(level);
    this.waveStart.set(level, Date.now());
    const ids = this.planIdsByLevel.get(level) ?? [];
    this.eventStream.emitEvent({
      type: GSDEventType.WaveStart,
      timestamp: new Date().toISOString(),
      sessionId: '',
      phaseNumber: this.phaseNumber,
      waveNumber: level,
      planCount: ids.length,
      planIds: ids,
    });
  }

  /** Mark a plan at `level` settled; emit WaveComplete once all settle. */
  settle(level: number, ok: boolean): void {
    if (!this.enabled) return;
    // A plan can settle without starting (blocked-by-ancestor never dispatched).
    // Ensure WaveStart fired so the start/complete pair stays balanced.
    this.start(level);
    if (ok) this.success.set(level, (this.success.get(level) ?? 0) + 1);
    else this.failure.set(level, (this.failure.get(level) ?? 0) + 1);
    const left = (this.remaining.get(level) ?? 0) - 1;
    this.remaining.set(level, left);
    if (left <= 0) {
      this.eventStream.emitEvent({
        type: GSDEventType.WaveComplete,
        timestamp: new Date().toISOString(),
        sessionId: '',
        phaseNumber: this.phaseNumber,
        waveNumber: level,
        successCount: this.success.get(level) ?? 0,
        failureCount: this.failure.get(level) ?? 0,
        durationMs: Date.now() - (this.waveStart.get(level) ?? Date.now()),
      });
    }
  }
}

/**
 * Thin wrapper over a MergeSerializer that records per-plan merge outcomes. The
 * serializer is itself the single-writer mutex; this just adapts the call site.
 */
class MergeSerializerCoordinator {
  constructor(private readonly serializer: MergeSerializer) {}
  merge(planId: string, branch: string) {
    return this.serializer.merge(planId, branch);
  }
}

// ─── Error type ──────────────────────────────────────────────────────────────

export class PhaseRunnerError extends Error {
  constructor(
    message: string,
    public readonly phaseNumber: string,
    public readonly step: PhaseStepType,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = 'PhaseRunnerError';
  }
}

// ─── Verification result enum ────────────────────────────────────────────────

export type VerificationOutcome = 'passed' | 'human_needed' | 'gaps_found' | 'architectural_debt' | 'status_unreadable';

interface ArchitecturalDebtFinding {
  file: string;
  line: number;
  marker: string;
  text: string;
}

type ArchitecturalDebtCheckReason = 'markers_found' | 'scan_error';

interface ArchitecturalDebtCheck {
  pass: boolean;
  findings: ArchitecturalDebtFinding[];
  reason?: ArchitecturalDebtCheckReason;
}

// ─── Execution engine factory (injectable for git-direct isolation/tests) ─────

/**
 * Builds the per-run worktree manager + merge serializer. When omitted, the
 * runner uses no-op collaborators that preserve today's in-process, shared-cwd,
 * no-merge-gate SDK behaviour. Falsifier/integration tests inject git-backed
 * implementations against a real temp repository.
 */
export interface ExecutionEngineFactory {
  (ctx: { projectDir: string; phaseNumber: string }): {
    worktrees: WorktreeManager;
    serializer: MergeSerializer;
    /** Base commit roots fork off (current protected HEAD). '' for the no-op path. */
    baseSha: string;
    /**
     * True for the REAL git-backed engine (per-plan worktree isolation enforced).
     * When true, a `worktrees.create()` failure is FATAL — the plan is marked
     * failed rather than silently degrading to shared cwd (which would bypass
     * invariant 3 and run concurrent shared-tree mutation). Absent/false for the
     * no-op (shared-cwd) engine, whose create() never throws.
     */
    isolated?: boolean;
  };
}

// ─── PhaseRunner deps interface ──────────────────────────────────────────────

export interface PhaseRunnerDeps {
  projectDir: string;
  tools: GSDTools;
  promptFactory: PromptFactory;
  contextEngine: ContextEngine;
  eventStream: GSDEventStream;
  config: GSDConfig;
  logger?: GSDLogger;
  /** Optional git-direct execution engine. Default: shared-cwd no-op. */
  executionEngineFactory?: ExecutionEngineFactory;
}

// ─── PhaseRunner ─────────────────────────────────────────────────────────────

export class PhaseRunner {
  private readonly projectDir: string;
  private readonly tools: GSDTools;
  private readonly promptFactory: PromptFactory;
  private readonly contextEngine: ContextEngine;
  private readonly eventStream: GSDEventStream;
  private readonly config: GSDConfig;
  private readonly logger?: GSDLogger;
  private readonly executionEngineFactory?: ExecutionEngineFactory;

  constructor(deps: PhaseRunnerDeps) {
    this.projectDir = deps.projectDir;
    this.tools = deps.tools;
    this.promptFactory = deps.promptFactory;
    this.contextEngine = deps.contextEngine;
    this.eventStream = deps.eventStream;
    this.config = deps.config;
    this.logger = deps.logger;
    this.executionEngineFactory = deps.executionEngineFactory;
  }

  /**
   * Run a full phase lifecycle: discuss → research → plan → plan-check → execute → verify → advance.
   *
   * Each step is gated by config flags and phase state. Human gate callbacks
   * are invoked at decision points; when not provided, auto-approve is used.
   */
  async run(phaseNumber: string, options?: PhaseRunnerOptions): Promise<PhaseRunnerResult> {
    const startTime = Date.now();
    const steps: PhaseStepResult[] = [];
    const callbacks = options?.callbacks ?? {};

    // ── Init: query phase state ──
    let phaseOp: PhaseOpInfo;
    try {
      phaseOp = await this.tools.initPhaseOp(phaseNumber);
    } catch (err) {
      throw new PhaseRunnerError(
        `Failed to initialize phase ${phaseNumber}: ${err instanceof Error ? err.message : String(err)}`,
        phaseNumber,
        PhaseStepType.Discuss,
        err instanceof Error ? err : undefined,
      );
    }

    // Validate phase exists
    if (!phaseOp.phase_found) {
      throw new PhaseRunnerError(
        `Phase ${phaseNumber} not found on disk`,
        phaseNumber,
        PhaseStepType.Discuss,
      );
    }

    const phaseName = phaseOp.phase_name;

    // Emit phase_start
    this.eventStream.emitEvent({
      type: GSDEventType.PhaseStart,
      timestamp: new Date().toISOString(),
      sessionId: '',
      phaseNumber,
      phaseName,
    });

    const sessionOpts: SessionOptions = {
      maxTurns: options?.maxTurnsPerStep ?? 50,
      maxBudgetUsd: options?.maxBudgetPerStep ?? 5.0,
      model: options?.model,
      cwd: this.projectDir,
    };

    let halted = false;

    // ── Step 1: Discuss ──
    if (!halted) {
      const shouldSkip = phaseOp.has_context || this.config.workflow.skip_discuss;
      if (shouldSkip && !(this.config.workflow.auto_advance && !phaseOp.has_context && !this.config.workflow.skip_discuss)) {
        this.logger?.debug(`Skipping discuss: has_context=${phaseOp.has_context}, skip_discuss=${this.config.workflow.skip_discuss}`);
      } else if (!phaseOp.has_context && !this.config.workflow.skip_discuss && this.config.workflow.auto_advance) {
        // AI self-discuss: auto-mode with no context — run a self-discuss session
        const result = await this.retryOnce('self-discuss', () => this.runSelfDiscussStep(phaseNumber, sessionOpts));
        steps.push(result);

        // Re-query phase state to check if context was created
        try {
          phaseOp = await this.tools.initPhaseOp(phaseNumber);
        } catch {
          // If re-query fails, proceed with original state
        }

        if (!phaseOp.has_context) {
          const decision = await this.invokeBlockerCallback(callbacks, phaseNumber, PhaseStepType.Discuss, 'No context after self-discuss step');
          if (decision === 'stop') {
            halted = true;
          }
        }
      } else if (!shouldSkip) {
        const result = await this.retryOnce('discuss', () => this.runStep(PhaseStepType.Discuss, phaseNumber, sessionOpts));
        steps.push(result);

        // Re-query phase state to check if context was created
        try {
          phaseOp = await this.tools.initPhaseOp(phaseNumber);
        } catch {
          // If re-query fails, proceed with original state
        }

        if (!phaseOp.has_context) {
          // No context after discuss — invoke blocker callback
          const decision = await this.invokeBlockerCallback(callbacks, phaseNumber, PhaseStepType.Discuss, 'No context after discuss step');
          if (decision === 'stop') {
            halted = true;
          }
        }
      }
    }

    // ── Step 2: Research ──
    if (!halted) {
      if (!this.config.workflow.research) {
        this.logger?.debug('Skipping research: config.workflow.research=false');
      } else {
        const result = await this.retryOnce('research', () => this.runStep(PhaseStepType.Research, phaseNumber, sessionOpts));
        steps.push(result);
      }
    }

    // ── Step 2.5: Research gate (#1602) ──
    // Check RESEARCH.md for unresolved open questions before planning
    if (!halted && phaseOp.has_research) {
      const gateResult = await this.checkResearchGate(phaseOp);
      if (!gateResult.pass) {
        const questionList = gateResult.unresolvedQuestions.join(', ');
        const error = `RESEARCH.md has unresolved open questions: ${questionList}`;
        this.logger?.warn(error, { phase: phaseNumber });
        const decision = await this.invokeBlockerCallback(callbacks, phaseNumber, PhaseStepType.Research, error);
        if (decision === 'stop') {
          halted = true;
        }
      }
    }

    // ── Step 3: Plan ──
    if (!halted) {
      const result = await this.retryOnce('plan', () => this.runStep(PhaseStepType.Plan, phaseNumber, sessionOpts));
      steps.push(result);

      // Re-query to check for plans
      try {
        phaseOp = await this.tools.initPhaseOp(phaseNumber);
      } catch {
        // Proceed with prior state
      }

      if (!phaseOp.has_plans || phaseOp.plan_count === 0) {
        const decision = await this.invokeBlockerCallback(callbacks, phaseNumber, PhaseStepType.Plan, 'No plans created after plan step');
        if (decision === 'stop') {
          halted = true;
        }
      }
    }

    // ── Step 3.5: Plan Check ──
    if (!halted && this.config.workflow.plan_check) {
      const planCheckResult = await this.retryOnce('plan-check', () => this.runPlanCheckStep(phaseNumber, sessionOpts));
      steps.push(planCheckResult);

      // If plan-check failed, re-plan once then re-check once (D023)
      if (!planCheckResult.success) {
        this.logger?.info(`Plan check failed for phase ${phaseNumber}, re-planning once (D023)`);

        // Re-run plan step with feedback
        const replanResult = await this.runStep(PhaseStepType.Plan, phaseNumber, sessionOpts);
        steps.push(replanResult);

        // Re-check once
        const recheckResult = await this.runPlanCheckStep(phaseNumber, sessionOpts);
        steps.push(recheckResult);

        if (!recheckResult.success) {
          this.logger?.warn(`Plan check failed again after re-plan for phase ${phaseNumber}. Proceeding with warning (D023).`);
        }
      }
    }

    // ── Step 4: Execute ──
    if (!halted) {
      const executeResult = await this.retryOnce('execute', () => this.runExecuteStep(phaseNumber, sessionOpts));
      steps.push(executeResult);
    }

    // ── Step 5: Verify ──
    if (!halted) {
      if (!this.config.workflow.verifier) {
        this.logger?.debug('Skipping verify: config.workflow.verifier=false');
      } else {
        // Verify has its own internal retry logic (gap closure). retryOnce only
        // retries on unexpected session throws, not on verification outcomes like gaps_found.
        const verifyResult = await this.retryOnce('verify', () => this.runVerifyStep(phaseNumber, sessionOpts, callbacks, options));
        steps.push(verifyResult);

        // Check if verify resulted in a halt
        if (!verifyResult.success && verifyResult.error === 'halted_by_callback') {
          halted = true;
        }
      }
    }

    // ── Step 6: Advance ──
    // Only advance if verify passed — never mark a phase complete when gaps were found.
    const verifyPassed = steps.every(s => s.step !== PhaseStepType.Verify || s.success);
    if (!halted && verifyPassed) {
      const advanceResult = await this.runAdvanceStep(phaseNumber, sessionOpts, callbacks);
      steps.push(advanceResult);
    } else if (!halted && !verifyPassed) {
      this.logger?.warn(`Skipping advance for phase ${phaseNumber}: verification found gaps`);
    }

    const totalDurationMs = Date.now() - startTime;
    const totalCostUsd = steps.reduce((sum, s) => {
      const stepCost = s.planResults?.reduce((c, pr) => c + pr.totalCostUsd, 0) ?? 0;
      return sum + stepCost;
    }, 0);
    const success = !halted && steps.every(s => s.success);

    // Emit phase_complete
    this.eventStream.emitEvent({
      type: GSDEventType.PhaseComplete,
      timestamp: new Date().toISOString(),
      sessionId: '',
      phaseNumber,
      phaseName,
      success,
      totalCostUsd,
      totalDurationMs,
      stepsCompleted: steps.length,
    });

    return {
      phaseNumber,
      phaseName,
      steps,
      success,
      totalCostUsd,
      totalDurationMs,
    };
  }

  // ─── Step runners ──────────────────────────────────────────────────────

  /**
   * Retry a step function once on failure.
   * On first error/failure, logs a warning and calls the function once more.
   * Returns the result from the last attempt.
   */
  private async retryOnce<T extends PhaseStepResult>(label: string, fn: () => Promise<T>): Promise<T> {
    const result = await fn();
    if (result.success) return result;

    // Don't retry verify outcomes (gaps_found, human_needed) — they have their own retry logic.
    if (result.error?.startsWith('verification_')) return result;

    this.logger?.warn(`Step "${label}" failed, retrying once...`);
    return fn();
  }

  /**
   * Run the plan-check step.
   * Loads the gsd-plan-checker agent definition, runs a Verify-scoped session,
   * and parses output for PASS/FAIL signals.
   */
  private async runPlanCheckStep(
    phaseNumber: string,
    sessionOpts: SessionOptions,
  ): Promise<PhaseStepResult> {
    const stepStart = Date.now();

    this.eventStream.emitEvent({
      type: GSDEventType.PhaseStepStart,
      timestamp: new Date().toISOString(),
      sessionId: '',
      phaseNumber,
      step: PhaseStepType.PlanCheck,
    });

    let planResult: PlanResult;
    try {
      // Load plan-checker agent definition (same pattern as PromptFactory.loadAgentDef)
      const agentDef = await this.promptFactory.loadAgentDef(PhaseType.Verify);

      // Build prompt using Verify phase type for context resolution
      const contextFiles = await this.contextEngine.resolveContextFiles(PhaseType.Verify);
      let prompt = await this.promptFactory.buildPrompt(PhaseType.Verify, null, contextFiles);

      // Supplement with plan-checker instructions
      prompt += '\n\n## Plan Checker Instructions\n\nYou are a plan checker. Review the plans for this phase and verify they are well-formed, complete, and achievable. If all plans pass, output "VERIFICATION PASSED". If any issues are found, output "ISSUES FOUND" followed by a description of each issue.';

      planResult = await runPhaseStepSession(
        prompt,
        PhaseStepType.PlanCheck,
        this.config,
        sessionOpts,
        this.eventStream,
        { phase: PhaseType.Verify, planName: undefined },
      );
    } catch (err) {
      const durationMs = Date.now() - stepStart;
      const errorMsg = err instanceof Error ? err.message : String(err);

      this.eventStream.emitEvent({
        type: GSDEventType.PhaseStepComplete,
        timestamp: new Date().toISOString(),
        sessionId: '',
        phaseNumber,
        step: PhaseStepType.PlanCheck,
        success: false,
        durationMs,
        error: errorMsg,
      });

      return {
        step: PhaseStepType.PlanCheck,
        success: false,
        durationMs,
        error: errorMsg,
      };
    }

    const durationMs = Date.now() - stepStart;
    // Parse plan-check outcome: success if the session succeeded (real output parsing would check for VERIFICATION PASSED / ISSUES FOUND)
    const success = planResult.success;

    this.eventStream.emitEvent({
      type: GSDEventType.PhaseStepComplete,
      timestamp: new Date().toISOString(),
      sessionId: planResult.sessionId,
      phaseNumber,
      step: PhaseStepType.PlanCheck,
      success,
      durationMs,
      error: planResult.error?.messages.join('; ') || undefined,
    });

    return {
      step: PhaseStepType.PlanCheck,
      success,
      durationMs,
      error: planResult.error?.messages.join('; ') || undefined,
      planResults: [planResult],
    };
  }

  /**
   * Run the self-discuss step for auto-mode.
   * When auto_advance is true and no context exists, run an AI self-discuss
   * session that identifies gray areas and makes opinionated decisions.
   */
  private async runSelfDiscussStep(
    phaseNumber: string,
    sessionOpts: SessionOptions,
  ): Promise<PhaseStepResult> {
    const stepStart = Date.now();

    this.eventStream.emitEvent({
      type: GSDEventType.PhaseStepStart,
      timestamp: new Date().toISOString(),
      sessionId: '',
      phaseNumber,
      step: PhaseStepType.Discuss,
    });

    let planResult: PlanResult;
    try {
      const contextFiles = await this.contextEngine.resolveContextFiles(PhaseType.Discuss);
      let prompt = await this.promptFactory.buildPrompt(PhaseType.Discuss, null, contextFiles);

      // Prepend self-discuss override BEFORE the workflow prompt.
      // The workflow prompt contains interactive patterns (user questions, area selection)
      // that the agent will follow unless explicitly overridden up front.
      const maxPasses = this.config.workflow.max_discuss_passes ?? 3;
      const selfDiscussOverride = [
        '## HEADLESS MODE — MANDATORY OVERRIDE',
        '',
        '**This session is running headless with no human present.**',
        '',
        'You MUST NOT:',
        '- Use AskUserQuestion or any interactive tools',
        '- Invoke Skill() or SlashCommand()',
        '- Ask the user anything or wait for input',
        '- Use multi-select, checkbox, or prompt UIs',
        '',
        'You MUST:',
        '- Make all decisions autonomously and opinionatedly',
        '- Identify 3-5 gray areas in the project scope',
        '- Reason through each one yourself and pick the best option',
        '- Write CONTEXT.md with your decisions in a single pass',
        `- Complete within ${maxPasses} pass(es) maximum — do not re-read your own output to find gaps`,
        '',
        'Any instructions below about "asking the user", "discussing with the user", or "interactive" should be read as "decide yourself."',
        '',
        '---',
        '',
      ].join('\n');
      prompt = selfDiscussOverride + prompt;

      planResult = await runPhaseStepSession(
        prompt,
        PhaseStepType.Discuss,
        this.config,
        sessionOpts,
        this.eventStream,
        { phase: PhaseType.Discuss, planName: undefined },
      );
    } catch (err) {
      const durationMs = Date.now() - stepStart;
      const errorMsg = err instanceof Error ? err.message : String(err);

      this.eventStream.emitEvent({
        type: GSDEventType.PhaseStepComplete,
        timestamp: new Date().toISOString(),
        sessionId: '',
        phaseNumber,
        step: PhaseStepType.Discuss,
        success: false,
        durationMs,
        error: errorMsg,
      });

      return {
        step: PhaseStepType.Discuss,
        success: false,
        durationMs,
        error: errorMsg,
      };
    }

    const durationMs = Date.now() - stepStart;
    const success = planResult.success;

    this.eventStream.emitEvent({
      type: GSDEventType.PhaseStepComplete,
      timestamp: new Date().toISOString(),
      sessionId: planResult.sessionId,
      phaseNumber,
      step: PhaseStepType.Discuss,
      success,
      durationMs,
      error: planResult.error?.messages.join('; ') || undefined,
    });

    return {
      step: PhaseStepType.Discuss,
      success,
      durationMs,
      error: planResult.error?.messages.join('; ') || undefined,
      planResults: [planResult],
    };
  }

  /**
   * Run a single phase step session (discuss, research, plan).
   * Emits step start/complete events and captures errors.
   */
  private async runStep(
    step: PhaseStepType,
    phaseNumber: string,
    sessionOpts: SessionOptions,
  ): Promise<PhaseStepResult> {
    const stepStart = Date.now();

    this.eventStream.emitEvent({
      type: GSDEventType.PhaseStepStart,
      timestamp: new Date().toISOString(),
      sessionId: '',
      phaseNumber,
      step,
    });

    let planResult: PlanResult;
    try {
      // Map step to PhaseType for prompt/context resolution
      const phaseType = this.stepToPhaseType(step);
      const contextFiles = await this.contextEngine.resolveContextFiles(phaseType);
      const prompt = await this.promptFactory.buildPrompt(phaseType, null, contextFiles);

      planResult = await runPhaseStepSession(
        prompt,
        step,
        this.config,
        sessionOpts,
        this.eventStream,
        { phase: phaseType, planName: undefined },
      );
    } catch (err) {
      const durationMs = Date.now() - stepStart;
      const errorMsg = err instanceof Error ? err.message : String(err);

      this.eventStream.emitEvent({
        type: GSDEventType.PhaseStepComplete,
        timestamp: new Date().toISOString(),
        sessionId: '',
        phaseNumber,
        step,
        success: false,
        durationMs,
        error: errorMsg,
      });

      return {
        step,
        success: false,
        durationMs,
        error: errorMsg,
      };
    }

    const durationMs = Date.now() - stepStart;
    const success = planResult.success;

    this.eventStream.emitEvent({
      type: GSDEventType.PhaseStepComplete,
      timestamp: new Date().toISOString(),
      sessionId: planResult.sessionId,
      phaseNumber,
      step,
      success,
      durationMs,
      error: planResult.error?.messages.join('; ') || undefined,
    });

    return {
      step,
      success,
      durationMs,
      error: planResult.error?.messages.join('; ') || undefined,
      planResults: [planResult],
    };
  }

  /**
   * Run the execute step as a true per-plan dependency DAG (ADR 0013).
   *
   * Each incomplete plan gets one memoized promise gated on its DIRECT
   * predecessors (pruned `depends_on` + `files_modified` serialization edges) —
   * a plan starts the instant ITS predecessors finish, with NO whole-wave
   * barrier, so independent chains overlap. A Semaphore caps in-flight executors
   * (parallelization===false → 1 → strictly sequential topological order).
   *
   * When a git-direct execution engine is injected, each plan runs in its own
   * worktree forked off its predecessor's merged commit; a single-writer
   * MergeSerializer integrates each plan's delta behind the guard suite and the
   * EXPENSIVE build+test gate is BATCHED at level boundaries (decoupled from the
   * cheap per-plan merge — per-plan gating is slower than today under a
   * test-dominated suite). Without an engine, plans run in-process in the shared
   * cwd exactly as before.
   *
   * Synthetic WaveStart/WaveComplete fire at topological-level transitions so
   * event-stream cardinality and PhaseStepResult shape stay byte-compatible.
   * Plans with has_summary:true are filtered out but kept as satisfied
   * predecessors; gap-closure re-seeds the base from current HEAD each call.
   */
  private async runExecuteStep(
    phaseNumber: string,
    sessionOpts: SessionOptions,
  ): Promise<PhaseStepResult> {
    const stepStart = Date.now();

    this.eventStream.emitEvent({
      type: GSDEventType.PhaseStepStart,
      timestamp: new Date().toISOString(),
      sessionId: '',
      phaseNumber,
      step: PhaseStepType.Execute,
    });

    // Get the plan index from gsd-tools
    let planIndex: PhasePlanIndex;
    try {
      planIndex = await this.tools.phasePlanIndex(phaseNumber);
    } catch (err) {
      const durationMs = Date.now() - stepStart;
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.eventStream.emitEvent({
        type: GSDEventType.PhaseStepComplete,
        timestamp: new Date().toISOString(),
        sessionId: '',
        phaseNumber,
        step: PhaseStepType.Execute,
        success: false,
        durationMs,
        error: errorMsg,
      });
      return {
        step: PhaseStepType.Execute,
        success: false,
        durationMs,
        error: errorMsg,
      };
    }

    // Filter to incomplete plans only (has_summary === false)
    const incompletePlans = planIndex.plans.filter(p => !p.has_summary);

    if (incompletePlans.length === 0) {
      const durationMs = Date.now() - stepStart;
      this.eventStream.emitEvent({
        type: GSDEventType.PhaseStepComplete,
        timestamp: new Date().toISOString(),
        sessionId: '',
        phaseNumber,
        step: PhaseStepType.Execute,
        success: true,
        durationMs,
      });
      return {
        step: PhaseStepType.Execute,
        success: true,
        durationMs,
        planResults: [],
      };
    }

    // Build the reduced per-plan DAG over incomplete plans (direct depends_on
    // edges + files_modified serialization edges; has_summary preds are dropped
    // as satisfied). Topological level drives synthetic wave events only.
    const dag = buildPlanDag(planIndex.plans);

    const { planResults, dispositions } = await this.runPlanDag(
      phaseNumber,
      sessionOpts,
      dag,
    );

    const durationMs = Date.now() - stepStart;
    const allSucceeded = planResults.every(r => r.success);

    this.eventStream.emitEvent({
      type: GSDEventType.PhaseStepComplete,
      timestamp: new Date().toISOString(),
      sessionId: '',
      phaseNumber,
      step: PhaseStepType.Execute,
      success: allSucceeded,
      durationMs,
    });

    return {
      step: PhaseStepType.Execute,
      success: allSucceeded,
      durationMs,
      planResults,
      ...(dispositions.length > 0 && { planDispositions: dispositions }),
    };
  }

  /**
   * Drive the per-plan DAG: one memoized promise per plan, gated on its direct
   * predecessors, capped by a Semaphore, with per-plan worktrees, a single-writer
   * MergeSerializer, and a batched per-level build+test gate. Returns the
   * settled PlanResults (allSettled-style failure isolation) and the additive
   * per-plan dispositions.
   */
  private async runPlanDag(
    phaseNumber: string,
    sessionOpts: SessionOptions,
    dag: PlanDag,
  ): Promise<{ planResults: PlanResult[]; dispositions: PlanDisposition[] }> {
    const parallel = this.config.parallelization !== false;
    const cap = resolveConcurrencyCap(this.config.parallelization);
    const semaphore = new Semaphore(cap);

    // Build (or default) the git-direct execution engine. The no-op engine runs
    // every plan in the shared project cwd with no merge step — today's SDK path.
    const engine = this.executionEngineFactory
      ? this.executionEngineFactory({ projectDir: this.projectDir, phaseNumber })
      : {
          worktrees: new SharedCwdWorktreeManager(this.projectDir) as WorktreeManager,
          serializer: new NoopMergeSerializer() as MergeSerializer,
          baseSha: '',
          // No-op engine: create() never throws, so create()-failure is not fatal
          // (a degrade to shared cwd is the today-behaviour). Explicit `false` keeps
          // both union arms structurally aligned for `engine.isolated`.
          isolated: false,
        };

    const phaseLevel = Number.parseInt(phaseNumber, 10);
    const phaseTag = Number.isFinite(phaseLevel) ? phaseLevel : 0;

    // WaveTracker: emit synthetic WaveStart/WaveComplete at level boundaries so
    // event-stream cardinality stays byte-compatible. Only when parallelizing
    // (parallelization===false emits no wave events, matching prior behaviour).
    const tracker = new WaveTracker(this.eventStream, phaseNumber, parallel);
    const levelGroups = new Map<number, string[]>();
    for (const node of dag.nodes) {
      const g = levelGroups.get(node.level) ?? [];
      g.push(node.id);
      levelGroups.set(node.level, g);
    }
    tracker.plan(levelGroups);

    // Per-plan execution outcome carrying the resolved branch + head sha so a
    // dependent forks off its predecessor's merged commit (fork-off-predecessor).
    interface PlanOutcome {
      result: PlanResult;
      branch: string;
      headSha: string;
      ok: boolean;
    }

    const promises = new Map<string, Promise<PlanOutcome>>();
    const dispositionById = new Map<string, PlanDisposition>();
    // Plans whose merge unblocks dependents but whose level gate hasn't run yet,
    // keyed by level — drained at level boundaries (batched gate).
    const mergedByLevel = new Map<number, string[]>();
    const merger = new MergeSerializerCoordinator(engine.serializer);

    // Batched gate scheduling: count plans per level and fire that level's gate
    // the instant its last plan settles. The gate runs CONCURRENTLY with ongoing
    // execution of independent later-level plans (the merge — not the gate —
    // unblocks dependents), so the expensive build+test never serializes the
    // critical path. "Coalesced when the serializer queue drains" (ADR 0013).
    const levelRemaining = new Map<number, number>();
    for (const node of dag.nodes) {
      levelRemaining.set(node.level, (levelRemaining.get(node.level) ?? 0) + 1);
    }
    const gatePromises: Array<Promise<void>> = [];
    const runLevelGate = async (level: number): Promise<void> => {
      const ids = mergedByLevel.get(level) ?? [];
      if (ids.length === 0) return;
      const { testExit } = await engine.serializer.gate(ids);
      for (const id of ids) {
        const d = dispositionById.get(id);
        if (d) d.testExit = testExit;
      }
      // Manifest-scoped cleanup: a plan's worktree is removed after its level's
      // gate runs (successors have already forked off its committed branch).
      for (const id of ids) {
        await engine.worktrees.cleanup(id).catch(() => {});
      }
    };
    const noteLevelSettled = (level: number): void => {
      const left = (levelRemaining.get(level) ?? 1) - 1;
      levelRemaining.set(level, left);
      if (left <= 0) gatePromises.push(runLevelGate(level));
    };

    const runNode = async (node: DagNode): Promise<PlanOutcome> => {
      // Gate on direct predecessors only — NOT a whole-wave barrier.
      const predOutcomes = await Promise.allSettled(
        node.predecessors.map(id => promises.get(id)!),
      );

      // If any predecessor failed, propagate blocked-by-ancestor: do not run.
      const blockedBy = node.predecessors.filter((id, i) => {
        const o = predOutcomes[i];
        return o.status === 'rejected' || (o.status === 'fulfilled' && !o.value.ok);
      });
      if (blockedBy.length > 0) {
        const disposition: PlanDisposition = {
          planId: node.id,
          level: node.level,
          merged: false,
          skippedReason: `blocked-by-ancestor:${blockedBy.join(',')}`,
        };
        dispositionById.set(node.id, disposition);
        tracker.settle(node.level, false);
        noteLevelSettled(node.level);
        return {
          result: this.synthesizeBlockedResult(node.id, blockedBy),
          branch: '',
          headSha: '',
          ok: false,
        };
      }

      // Fork base = the single predecessor's merged commit (chain), or the run
      // base for roots / multi-predecessor (which merge the rest in-worktree).
      const predBase =
        node.predecessors.length > 0
          ? (predOutcomes[0] as PromiseFulfilledResult<PlanOutcome>).value.headSha || engine.baseSha
          : engine.baseSha;

      tracker.start(node.level);

      const outcome = await semaphore.run(async () => {
        let cwd = this.projectDir;
        let branch = '';
        try {
          const wt = await engine.worktrees.create(node.id, phaseTag, predBase);
          cwd = wt.cwd || this.projectDir;
          branch = wt.branch;
        } catch (err) {
          // Under the REAL (isolated) engine a create() failure is FATAL: silently
          // continuing in shared cwd would run concurrent shared-tree mutation and
          // bypass the inv-3 test gate (the executor's commit would not land on an
          // isolated branch, so the dependent could miss it — invariant 4). Propagate
          // so the plan is marked failed. The no-op engine's create() never throws,
          // so this only fires for the git-backed path.
          if (engine.isolated) {
            throw err instanceof Error ? err : new Error(String(err));
          }
          this.logger?.warn(
            `Worktree create failed for plan ${node.id}, running in shared cwd: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        const result = await this.executeSinglePlan(phaseNumber, node.id, {
          ...sessionOpts,
          ...(cwd !== this.projectDir && { cwd }),
        });

        let headSha = '';
        if (result.success) {
          try {
            headSha = await engine.worktrees.headSha(node.id);
          } catch {
            headSha = '';
          }
        }
        return { result, branch, headSha };
      });

      const ok = outcome.result.success;

      // Cheap per-plan merge (unblocks dependents). Decoupled from the gate.
      let merged = false;
      if (ok && outcome.branch !== '') {
        const m = await merger.merge(node.id, outcome.branch);
        merged = m.merged;
      } else if (ok) {
        merged = true; // no-op engine: nothing to merge, treat as integrated
      }

      const disposition: PlanDisposition = {
        planId: node.id,
        level: node.level,
        merged,
      };
      dispositionById.set(node.id, disposition);
      if (ok && merged) {
        const lvl = mergedByLevel.get(node.level) ?? [];
        lvl.push(node.id);
        mergedByLevel.set(node.level, lvl);
      }

      tracker.settle(node.level, ok);
      noteLevelSettled(node.level);

      return { result: outcome.result, branch: outcome.branch, headSha: outcome.headSha, ok };
    };

    // Wire promises before awaiting any (true DAG, no parallel() barrier).
    for (const node of dag.nodes) {
      promises.set(node.id, runNode(node));
    }

    const settled = await Promise.allSettled(dag.nodes.map(n => promises.get(n.id)!));

    // Await the per-level batched gates (each fired as its level drained, so the
    // expensive build+test ran concurrently with later-level execution). A
    // rejected gate must NOT escape runPlanDag (it would skip PhaseStepComplete
    // emission and lose the per-plan results) — gate outcomes are already
    // recorded per-disposition, so swallow rejections here and log a warning.
    const gateSettled = await Promise.allSettled(gatePromises);
    for (const g of gateSettled) {
      if (g.status === 'rejected') {
        this.logger?.warn(
          `Batched level gate rejected (continuing; outcomes recorded per-disposition): ${
            g.reason instanceof Error ? g.reason.message : String(g.reason)
          }`,
        );
      }
    }

    // Collect results in DAG (topological/integration) order, allSettled-style.
    const planResults: PlanResult[] = [];
    const resultById = new Map<string, PlanResult>();
    settled.forEach((s, i) => {
      const node = dag.nodes[i];
      let result: PlanResult;
      if (s.status === 'fulfilled') {
        result = s.value.result;
      } else {
        result = this.synthesizeRejectedResult(s.reason);
        if (!dispositionById.has(node.id)) {
          dispositionById.set(node.id, {
            planId: node.id,
            level: node.level,
            merged: false,
            skippedReason: 'error_during_execution',
          });
        }
      }
      planResults.push(result);
      resultById.set(node.id, result);
    });

    // Gate → success wiring (invariant 3): a plan whose level gate did not PASS
    // (testExit !== 0; 124 = timeout/inconclusive ≠ pass) must NOT be reported as
    // a successful/complete plan, even though its executor succeeded. The batched
    // gate's testExit only lived on the disposition; reflect it in the PlanResult
    // so PhaseStepResult.success (derived from planResults[*].success) is correct.
    for (const node of dag.nodes) {
      const disp = dispositionById.get(node.id);
      const result = resultById.get(node.id);
      if (!disp || !result) continue;
      if (disp.testExit !== undefined && disp.testExit !== 0 && result.success) {
        result.success = false;
        result.error = {
          subtype: 'gate_failed',
          messages: [
            `Plan ${node.id} level ${disp.level} build+test gate did not pass (testExit=${disp.testExit}; 124 = timeout/inconclusive)`,
          ],
        };
        disp.merged = false;
        disp.skippedReason = disp.skippedReason ?? `gate-not-pass:testExit=${disp.testExit}`;
      }
    }

    const dispositions = dag.nodes
      .map(n => dispositionById.get(n.id))
      .filter((d): d is PlanDisposition => d !== undefined);

    return { planResults, dispositions };
  }

  /** Synthesize a failed PlanResult for a plan blocked by a failed ancestor. */
  private synthesizeBlockedResult(planId: string, blockedBy: string[]): PlanResult {
    return {
      success: false,
      sessionId: '',
      totalCostUsd: 0,
      durationMs: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      numTurns: 0,
      error: {
        subtype: 'error_during_execution',
        messages: [`Plan ${planId} blocked by failed ancestor(s): ${blockedBy.join(', ')}`],
      },
    };
  }

  /** Synthesize a failed PlanResult for a rejected plan promise. */
  private synthesizeRejectedResult(reason: unknown): PlanResult {
    return {
      success: false,
      sessionId: '',
      totalCostUsd: 0,
      durationMs: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      numTurns: 0,
      error: {
        subtype: 'error_during_execution',
        messages: [reason instanceof Error ? reason.message : String(reason)],
      },
    };
  }

  /**
   * Execute a single plan by ID within the execute step.
   * Loads the plan file, parses it, and passes the parsed plan to the prompt
   * builder so the executor gets the full plan content (tasks, objectives, etc.).
   */
  private async executeSinglePlan(
    phaseNumber: string,
    planId: string,
    sessionOpts: SessionOptions,
  ): Promise<PlanResult> {
    try {
      // Resolve the plan file path from phase directory + planId
      const phaseOp = await this.tools.initPhaseOp(phaseNumber);
      const planFilename = planId === 'PLAN' ? 'PLAN.md' : `${planId}-PLAN.md`;
      const planPath = join(this.projectDir, phaseOp.phase_dir, planFilename);

      // Parse the plan file so the executor prompt includes the actual tasks
      const parsedPlan = await parsePlanFile(planPath);

      const phaseType = PhaseType.Execute;
      const contextFiles = await this.contextEngine.resolveContextFiles(phaseType);
      const prompt = await this.promptFactory.buildPrompt(phaseType, parsedPlan, contextFiles, phaseOp.phase_dir);

      return await runPhaseStepSession(
        prompt,
        PhaseStepType.Execute,
        this.config,
        sessionOpts,
        this.eventStream,
        { phase: phaseType, planName: planId },
      );
    } catch (err) {
      return {
        success: false,
        sessionId: '',
        totalCostUsd: 0,
        durationMs: 0,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        numTurns: 0,
        error: {
          subtype: 'error_during_execution',
          messages: [err instanceof Error ? err.message : String(err)],
        },
      };
    }
  }

  /**
   * Run the verify step with full gap closure cycle.
   * Verification outcome routing:
   * - passed → proceed to advance
   * - human_needed → invoke onVerificationReview callback
   * - gaps_found → plan (create gap plans) → execute (run gap plans) → re-verify
   * Gap closure retries are capped at configurable maxGapRetries (default 1).
   */
  private async runVerifyStep(
    phaseNumber: string,
    sessionOpts: SessionOptions,
    callbacks: HumanGateCallbacks,
    options?: PhaseRunnerOptions,
  ): Promise<PhaseStepResult> {
    const stepStart = Date.now();

    this.eventStream.emitEvent({
      type: GSDEventType.PhaseStepStart,
      timestamp: new Date().toISOString(),
      sessionId: '',
      phaseNumber,
      step: PhaseStepType.Verify,
    });

    const maxGapRetries = options?.maxGapRetries ?? 1;
    let gapRetryCount = 0;
    let lastResult: PlanResult | undefined;
    let outcome: VerificationOutcome = 'passed';
    const allPlanResults: PlanResult[] = [];

    while (true) {
      try {
        const phaseType = PhaseType.Verify;
        const contextFiles = await this.contextEngine.resolveContextFiles(phaseType);
        const prompt = await this.promptFactory.buildPrompt(phaseType, null, contextFiles);

        lastResult = await runPhaseStepSession(
          prompt,
          PhaseStepType.Verify,
          this.config,
          sessionOpts,
          this.eventStream,
          { phase: phaseType },
        );
        allPlanResults.push(lastResult);
      } catch (err) {
        const durationMs = Date.now() - stepStart;
        const errorMsg = err instanceof Error ? err.message : String(err);

        this.eventStream.emitEvent({
          type: GSDEventType.PhaseStepComplete,
          timestamp: new Date().toISOString(),
          sessionId: '',
          phaseNumber,
          step: PhaseStepType.Verify,
          success: false,
          durationMs,
          error: errorMsg,
        });

        return {
          step: PhaseStepType.Verify,
          success: false,
          durationMs,
          error: errorMsg,
          planResults: allPlanResults.length > 0 ? allPlanResults : undefined,
        };
      }

      // Parse verification outcome from VERIFICATION.md (not just session exit code)
      outcome = await this.parseVerificationOutcome(lastResult, phaseNumber);

      if (outcome === 'passed') {
        const debtCheck = await this.checkArchitecturalDebt(phaseNumber);
        if (!debtCheck.pass) {
          const message =
            debtCheck.reason === 'scan_error'
              ? `Verification blocked because architectural debt scan could not complete for phase ${phaseNumber}`
              : `Verification blocked by unresolved architectural debt markers in phase ${phaseNumber}`;
          this.logger?.warn(message, {
            phase: phaseNumber,
            reason: debtCheck.reason,
            findingCount: debtCheck.findings.length,
            findings: debtCheck.findings.map(({ file, line, marker }) => ({ file, line, marker })),
          });
          outcome = 'architectural_debt';
          break;
        }
        break;
      }

      if (outcome === 'human_needed') {
        // Invoke verification review callback
        const decision = await this.invokeVerificationCallback(callbacks, phaseNumber, {
          step: PhaseStepType.Verify,
          success: lastResult.success,
          durationMs: Date.now() - stepStart,
          planResults: allPlanResults,
        });

        if (decision === 'accept') {
          break; // Acknowledged by caller, but still pending human verification.
        } else if (decision === 'retry' && gapRetryCount < maxGapRetries) {
          gapRetryCount++;
          continue;
        } else {
          // reject or exceeded retries
          const durationMs = Date.now() - stepStart;
          this.eventStream.emitEvent({
            type: GSDEventType.PhaseStepComplete,
            timestamp: new Date().toISOString(),
            sessionId: lastResult.sessionId,
            phaseNumber,
            step: PhaseStepType.Verify,
            success: false,
            durationMs,
            error: 'halted_by_callback',
          });
          return {
            step: PhaseStepType.Verify,
            success: false,
            durationMs,
            error: 'halted_by_callback',
            planResults: allPlanResults,
          };
        }
      }

      if (outcome === 'status_unreadable') {
        break;
      }

      if (outcome === 'gaps_found') {
        if (gapRetryCount < maxGapRetries) {
          gapRetryCount++;
          this.logger?.info(`Gap closure attempt ${gapRetryCount}/${maxGapRetries} for phase ${phaseNumber}`);

          // ── Gap closure cycle: plan → execute → re-verify ──

          // 1. Run a plan step to create gap plans
          try {
            const planResult = await this.runStep(PhaseStepType.Plan, phaseNumber, sessionOpts);
            if (planResult.planResults) {
              allPlanResults.push(...planResult.planResults);
            }
          } catch (err) {
            this.logger?.warn(`Gap closure plan step failed: ${err instanceof Error ? err.message : String(err)}`);
            // Proceed to re-verify anyway
          }

          // 2. Re-query phase state to discover newly created gap plans
          try {
            await this.tools.initPhaseOp(phaseNumber);
          } catch (err) {
            this.logger?.warn(`Gap closure re-query failed, proceeding with stale state: ${err instanceof Error ? err.message : String(err)}`);
          }

          // 3. Execute gap plans via the wave-capable runExecuteStep
          try {
            const executeResult = await this.runExecuteStep(phaseNumber, sessionOpts);
            if (executeResult.planResults) {
              allPlanResults.push(...executeResult.planResults);
            }
          } catch (err) {
            this.logger?.warn(`Gap closure execute step failed: ${err instanceof Error ? err.message : String(err)}`);
            // Proceed to re-verify anyway
          }

          // 4. Continue the loop to re-verify
          continue;
        }
        // Exceeded gap closure retries — proceed
        break;
      }

      break; // Safety: unknown outcome → proceed
    }

    const durationMs = Date.now() - stepStart;
    const verifySuccess = outcome === 'passed';

    this.eventStream.emitEvent({
      type: GSDEventType.PhaseStepComplete,
      timestamp: new Date().toISOString(),
      sessionId: lastResult?.sessionId ?? '',
      phaseNumber,
      step: PhaseStepType.Verify,
      success: verifySuccess,
      durationMs,
      ...(!verifySuccess && { error: this.verificationErrorForOutcome(outcome) }),
    });

    return {
      step: PhaseStepType.Verify,
      success: verifySuccess,
      durationMs,
      planResults: allPlanResults,
      ...(!verifySuccess && { error: this.verificationErrorForOutcome(outcome) }),
    };
  }

  /**
   * Run the advance step — mark phase complete.
   * Gated by config.workflow.auto_advance or callback approval.
   */
  private async runAdvanceStep(
    phaseNumber: string,
    _sessionOpts: SessionOptions,
    callbacks: HumanGateCallbacks,
  ): Promise<PhaseStepResult> {
    const stepStart = Date.now();

    this.eventStream.emitEvent({
      type: GSDEventType.PhaseStepStart,
      timestamp: new Date().toISOString(),
      sessionId: '',
      phaseNumber,
      step: PhaseStepType.Advance,
    });

    // Check if auto_advance or callback approves
    let shouldAdvance = this.config.workflow.auto_advance;

    if (!shouldAdvance && callbacks.onBlockerDecision) {
      try {
        const decision = await callbacks.onBlockerDecision({
          phaseNumber,
          step: PhaseStepType.Advance,
          error: undefined,
        });
        shouldAdvance = decision !== 'stop';
      } catch (err) {
        this.logger?.warn(`Advance callback threw, auto-approving: ${err instanceof Error ? err.message : String(err)}`);
        shouldAdvance = true; // Auto-approve on callback error
      }
    } else if (!shouldAdvance) {
      // No callback, auto-approve
      shouldAdvance = true;
    }

    if (!shouldAdvance) {
      const durationMs = Date.now() - stepStart;
      this.eventStream.emitEvent({
        type: GSDEventType.PhaseStepComplete,
        timestamp: new Date().toISOString(),
        sessionId: '',
        phaseNumber,
        step: PhaseStepType.Advance,
        success: false,
        durationMs,
        error: 'advance_rejected',
      });
      return {
        step: PhaseStepType.Advance,
        success: false,
        durationMs,
        error: 'advance_rejected',
      };
    }

    try {
      await this.tools.phaseComplete(phaseNumber);
    } catch (err) {
      const durationMs = Date.now() - stepStart;
      const errorMsg = err instanceof Error ? err.message : String(err);

      this.eventStream.emitEvent({
        type: GSDEventType.PhaseStepComplete,
        timestamp: new Date().toISOString(),
        sessionId: '',
        phaseNumber,
        step: PhaseStepType.Advance,
        success: false,
        durationMs,
        error: errorMsg,
      });

      return {
        step: PhaseStepType.Advance,
        success: false,
        durationMs,
        error: errorMsg,
      };
    }

    const durationMs = Date.now() - stepStart;

    this.eventStream.emitEvent({
      type: GSDEventType.PhaseStepComplete,
      timestamp: new Date().toISOString(),
      sessionId: '',
      phaseNumber,
      step: PhaseStepType.Advance,
      success: true,
      durationMs,
    });

    return {
      step: PhaseStepType.Advance,
      success: true,
      durationMs,
    };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  /**
   * Map PhaseStepType to PhaseType for prompt/context resolution.
   */
  private stepToPhaseType(step: PhaseStepType): PhaseType {
    const mapping: Record<string, PhaseType> = {
      [PhaseStepType.Discuss]: PhaseType.Discuss,
      [PhaseStepType.Research]: PhaseType.Research,
      [PhaseStepType.Plan]: PhaseType.Plan,
      [PhaseStepType.PlanCheck]: PhaseType.Verify,
      [PhaseStepType.Execute]: PhaseType.Execute,
      [PhaseStepType.Verify]: PhaseType.Verify,
    };
    return mapping[step] ?? PhaseType.Execute;
  }

  /**
   * Parse the verification outcome by checking VERIFICATION.md on disk.
   * The verify session may succeed (no runtime errors) while writing
   * status: gaps_found to VERIFICATION.md — we need to check the file,
   * not just the session exit code.
   *
   * Falls back to session result if VERIFICATION.md can't be parsed.
   */
  private async parseVerificationOutcome(result: PlanResult, phaseNumber: string): Promise<VerificationOutcome> {
    // If the session itself crashed, that's a clear failure
    if (!result.success) {
      if (result.error?.subtype === 'human_review_needed') return 'human_needed';
      return 'gaps_found';
    }

    // Session succeeded — check what the verifier actually wrote to VERIFICATION.md
    try {
      const verStatus = await this.tools.exec('check.verification-status', [phaseNumber]);
      const data = typeof verStatus === 'string' ? JSON.parse(verStatus) : verStatus;
      const status = (data?.status ?? '').toLowerCase();

      if (status === 'pass' || status === 'passed') return 'passed';
      if (status === 'human_needed') return 'human_needed';
      if (status === 'fail' || status === 'gaps_found') return 'gaps_found';
      if (status === 'missing') {
        return 'gaps_found';
      }
      // Unknown status — log and treat as gaps_found to be safe
      this.logger?.warn(`Unknown verification status '${status}' for phase ${phaseNumber}, treating as gaps_found`);
      return 'gaps_found';
    } catch (err) {
      // Can't parse VERIFICATION.md — fail closed so a missing/broken status check never completes the phase.
      this.logger?.warn(`Could not check verification status for phase ${phaseNumber}: ${err instanceof Error ? err.message : String(err)}`);
      return 'status_unreadable';
    }
  }

  private verificationErrorForOutcome(outcome: VerificationOutcome): string {
    if (outcome === 'status_unreadable' || outcome === 'architectural_debt') return 'verification_gaps_found';
    return `verification_${outcome}`;
  }

  /**
   * Block phase completion when source files changed by this phase still contain
   * unresolved TBD/FIXME/XXX comments. Markers are allowed only when the same
   * line references tracked follow-up work (issue/PR number or DEF-* id).
   *
   * The debt scan is intentionally scoped to literal source paths declared in
   * phase plan frontmatter `files_modified` and task `files`. Glob patterns are
   * not expanded, and files modified during execution but omitted from the plan
   * are not scanned; git-diff-based coverage would be a separate enhancement.
   */
  private async checkArchitecturalDebt(phaseNumber: string): Promise<ArchitecturalDebtCheck> {
    let phaseOp: PhaseOpInfo;
    try {
      phaseOp = await this.tools.initPhaseOp(phaseNumber);
    } catch (err) {
      this.logger?.warn(`Could not initialize phase ${phaseNumber} for architectural debt check: ${err instanceof Error ? err.message : String(err)}`);
      return { pass: false, findings: [], reason: 'scan_error' };
    }

    let planPaths: string[];
    try {
      planPaths = await this.listPhasePlanPaths(phaseOp.phase_dir);
    } catch {
      return { pass: false, findings: [], reason: 'scan_error' };
    }
    if (phaseOp.has_plans && planPaths.length === 0) {
      this.logger?.warn(`No phase plans found for architectural debt check in phase ${phaseNumber}`);
      return { pass: false, findings: [], reason: 'scan_error' };
    }
    const filesToScan = new Set<string>();

    for (const planPath of planPaths) {
      try {
        const parsedPlan = await parsePlanFile(planPath);
        for (const file of this.extractPlanFiles(parsedPlan)) {
          if (this.shouldScanForArchitecturalDebt(file)) {
            filesToScan.add(file);
          }
        }
      } catch (err) {
        this.logger?.warn(`Could not parse plan for architectural debt check (${planPath}): ${err instanceof Error ? err.message : String(err)}`);
        return { pass: false, findings: [], reason: 'scan_error' };
      }
    }

    const findings: ArchitecturalDebtFinding[] = [];
    for (const file of filesToScan) {
      const absolutePath = this.resolveProjectPath(file);
      if (!absolutePath) {
        findings.push({ file, line: 0, marker: 'path', text: 'File is outside the project root' });
        continue;
      }

      try {
        const content = await readFile(absolutePath, 'utf-8');
        findings.push(...this.findUnresolvedDebtMarkers(file, content));
      } catch (err) {
        const code = typeof err === 'object' && err !== null && 'code' in err ? (err as { code?: unknown }).code : undefined;
        if (code === 'ENOENT') {
          continue;
        }

        findings.push({
          file,
          line: 0,
          marker: 'read',
          text: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const hasDebtMarkers = findings.some(({ marker }) => marker !== 'path' && marker !== 'read');
    return {
      pass: findings.length === 0,
      findings,
      reason: findings.length === 0 ? undefined : hasDebtMarkers ? 'markers_found' : 'scan_error',
    };
  }

  private async listPhasePlanPaths(phaseDir: string): Promise<string[]> {
    const absolutePhaseDir = this.resolveProjectPath(phaseDir);
    if (!absolutePhaseDir) {
      const err = new Error(`Phase directory is outside the project root: ${phaseDir}`);
      this.logger?.warn(err.message);
      throw err;
    }

    try {
      const entries = await readdir(absolutePhaseDir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && (entry.name === 'PLAN.md' || entry.name.endsWith('-PLAN.md')))
        .map((entry) => join(absolutePhaseDir, entry.name));
    } catch (err) {
      this.logger?.warn(`Could not list phase plans for architectural debt check (${phaseDir}): ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  private extractPlanFiles(parsedPlan: ParsedPlan): string[] {
    const files = new Set<string>();
    for (const file of parsedPlan.frontmatter.files_modified ?? []) {
      files.add(file);
    }
    for (const task of parsedPlan.tasks ?? []) {
      for (const file of task.files ?? []) {
        files.add(file);
      }
    }
    return [...files];
  }

  private shouldScanForArchitecturalDebt(file: string): boolean {
    return !/\.(md|markdown)$/i.test(file);
  }

  private findUnresolvedDebtMarkers(file: string, content: string): ArchitecturalDebtFinding[] {
    const findings: ArchitecturalDebtFinding[] = [];
    const markerPattern = /(?:^|[^\w.])(TBD|FIXME|XXX)(?=\b(?:\.(?:\s|$)|[^\w.]|$))/i;
    const lines = content.split(/\r?\n/);

    lines.forEach((line, index) => {
      const match = markerPattern.exec(line);
      if (match) {
        const markerSegment = line.slice(match.index);
        if (this.hasFormalDebtReference(markerSegment)) return;

        findings.push({
          file,
          line: index + 1,
          marker: match[1].toUpperCase(),
          text: line.trim(),
        });
      }
    });

    return findings;
  }

  private hasFormalDebtReference(line: string): boolean {
    return /\bDEF-[A-Z0-9-]+\b/i.test(line) || /\b(?:issue|issues|pr|pull request)\s+#?\d+\b/i.test(line) || /(?:^|\s)#\d+\b/.test(line);
  }

  private resolveProjectPath(pathValue: string): string | undefined {
    const root = this.realpathForBoundary(resolve(this.projectDir));
    if (!root) return undefined;

    const absolutePath = isAbsolute(pathValue) ? resolve(pathValue) : resolve(this.projectDir, pathValue);
    const canonicalPath = this.realpathForBoundary(absolutePath);
    if (!canonicalPath) return undefined;

    const relativePath = relative(root, canonicalPath);
    if (relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))) {
      return canonicalPath;
    }
    return undefined;
  }

  private realpathForBoundary(pathValue: string): string | undefined {
    const missingSegments: string[] = [];
    let currentPath = pathValue;

    while (true) {
      try {
        return join(realpathSync(currentPath), ...missingSegments.reverse());
      } catch (err) {
        const code = typeof err === 'object' && err !== null && 'code' in err ? (err as { code?: unknown }).code : undefined;
        if (code !== 'ENOENT') return undefined;

        const parent = dirname(currentPath);
        if (parent === currentPath) return undefined;

        missingSegments.push(basename(currentPath));
        currentPath = parent;
      }
    }
  }

  /**
   * Check RESEARCH.md for unresolved open questions (#1602).
   * Returns the gate result — pass means safe to proceed to planning.
   */
  private async checkResearchGate(phaseOp: PhaseOpInfo): Promise<{ pass: boolean; unresolvedQuestions: string[] }> {
    try {
      const researchPath = phaseOp.research_path ||
        join(phaseOp.phase_dir, `${phaseOp.padded_phase}-RESEARCH.md`);
      const content = await readFile(researchPath, 'utf-8');
      return checkResearchGate(content);
    } catch {
      // File doesn't exist or can't be read — pass (nothing to gate on)
      return { pass: true, unresolvedQuestions: [] };
    }
  }

  /**
   * Invoke the onBlockerDecision callback, falling back to auto-approve.
   */
  private async invokeBlockerCallback(
    callbacks: HumanGateCallbacks,
    phaseNumber: string,
    step: PhaseStepType,
    error?: string,
  ): Promise<'retry' | 'skip' | 'stop'> {
    if (!callbacks.onBlockerDecision) {
      return 'skip'; // Auto-approve: skip the blocker
    }

    try {
      const decision = await callbacks.onBlockerDecision({ phaseNumber, step, error });
      // Validate return value
      if (decision === 'retry' || decision === 'skip' || decision === 'stop') {
        return decision;
      }
      this.logger?.warn(`Unexpected blocker callback return value: ${String(decision)}, falling back to skip`);
      return 'skip';
    } catch (err) {
      this.logger?.warn(`Blocker callback threw, auto-approving: ${err instanceof Error ? err.message : String(err)}`);
      return 'skip'; // Auto-approve on error
    }
  }

  /**
   * Invoke the onVerificationReview callback, falling back to auto-accept.
   */
  private async invokeVerificationCallback(
    callbacks: HumanGateCallbacks,
    phaseNumber: string,
    stepResult: PhaseStepResult,
  ): Promise<'accept' | 'reject' | 'retry'> {
    if (!callbacks.onVerificationReview) {
      return 'accept'; // Auto-approve
    }

    try {
      const decision = await callbacks.onVerificationReview({ phaseNumber, stepResult });
      if (decision === 'accept' || decision === 'reject' || decision === 'retry') {
        return decision;
      }
      this.logger?.warn(`Unexpected verification callback return value: ${String(decision)}, falling back to accept`);
      return 'accept';
    } catch (err) {
      this.logger?.warn(`Verification callback threw, keeping human verification pending: ${err instanceof Error ? err.message : String(err)}`);
      return 'accept'; // Treat as acknowledged; caller remains pending.
    }
  }
}
