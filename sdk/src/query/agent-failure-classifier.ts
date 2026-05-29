/**
 * Classify the free-text return body from a dispatched executor subagent into
 * an actionable failure class for the orchestrator's recovery router.
 *
 * Context (#3095): the orchestrator currently treats every non-success agent
 * return as a generic "real failure" except for the Claude Code
 * `classifyHandoffIfNeeded is not defined` runtime bug. Quota / rate-limit
 * terminations look identical to a crashed agent — but the right user
 * response is "wait for reset and resume", not "retry now or abort".
 *
 * Sentinel coverage spans the runtimes GSD supports as executor targets:
 *   - Anthropic / Claude Code  — "usage limit", "rate limit", "quota", "429", "retry-after"
 *   - GitHub Copilot CLI       — "rate limit", "rate_limited", "user_weekly_rate_limited"
 *   - OpenAI Codex CLI         — "429", "usage_limit_reached", "too many requests"
 *   - Google Gemini CLI        — "RESOURCE_EXHAUSTED", "exceeded your", "quota"
 *
 * See docs/research/provider-rate-limit-signals.md for the proactive (header
 * / SDK event) signals the orchestrator could use once the host runtime
 * (Claude Code, Copilot, Codex) exposes them to hooks.
 */

export type AgentFailureClass =
  | 'quota-exceeded'
  | 'classify-handoff-bug'
  | 'unknown-failure';

export interface AgentFailureClassification {
  class: AgentFailureClass;
  /** Lower-cased substring that matched, if any. Useful for log lines. */
  sentinel?: string;
  /** Seconds the runtime asked us to wait, parsed from "retry-after: N". */
  retryAfterSeconds?: number;
}

// Order matters: the first match wins, so list the most specific / most
// actionable sentinels first. "429" beats "too many requests"; "quota" beats
// "RESOURCE_EXHAUSTED" because "quota" is the universal token. All matches
// are case-insensitive (sentinel value below is the lower-cased form).
const QUOTA_SENTINELS: ReadonlyArray<string> = [
  '429',
  'usage_limit_reached',
  'usage limit',
  'rate limit',
  'rate-limited',
  // `rate_limit` (stem) covers `rate_limited`, `rate_limit_error`,
  // `rate_limit_exceeded`, and Copilot's `user_weekly_rate_limited`.
  'rate_limit',
  'resource_exhausted',
  'quota',
  'too many requests',
  'exceeded your',
];

const CLASSIFY_HANDOFF_SENTINEL = 'classifyhandoffifneeded is not defined';

/**
 * SUBSCRIPTION-QUOTA phrasings (R3). A REAL quota/usage-limit pause during
 * EXECUTE does NOT throw — the Agent SDK catches it and the phase returns a
 * FAILED PlanResult, so the driver classifies it on the `gate` path
 * (`fromRuntimeTermination=false`). The common Claude-subscription kill text
 * ("Claude AI usage limit reached. Your limit will reset at 4pm.") carries NONE
 * of the HTTP/runtime markers below, so the GROUP-C content gate would misread
 * it as GENUINE → rollback + burn 5 informed-retry attempts re-hitting the same
 * quota → HALT, instead of a WAITING.json resume (the C-1 HIGH regression).
 *
 * These phrasings are unambiguous human-subscription quota signals: a genuine
 * failing test is vanishingly unlikely to emit "your limit will reset at" or
 * "usage limit reached". They are therefore TRUSTED on the gate path WITHOUT
 * requiring a co-occurring runtime marker — biasing toward RESUME, justified by
 * the cost asymmetry (a real quota pause is common and WAITING.json exists to
 * survive it; a rarer false-positive self-limits at MAX_CONSECUTIVE_TRANSIENT
 * and corrupts nothing). When matched they resolve to quota-exceeded regardless
 * of provenance.
 */
const SUBSCRIPTION_QUOTA_PHRASES: ReadonlyArray<string> = [
  'usage limit reached',
  'usage limit',
  'limit will reset',
  'limit reached',
  'limit resets at',
];

/**
 * HTTP / runtime-transport context tokens. When the body to classify is NOT a
 * runtime-termination cause (i.e. it is gate/verify CONTENT — test output, a
 * build log, a verifier finding), a bare quota sentinel like "429" or "rate
 * limit" is NOT trusted on its own: a failing test *named* about rate-limiting
 * ("test_rate_limit_handling failed") is a GENUINE failure, not a transient
 * quota event (the GROUP-C footgun — a genuine failure burned up to 50 identical
 * re-runs). For content bodies the sentinel must CO-OCCUR with one of these
 * transport markers to be read as quota.
 *
 * R3/C-2: bare `http` and bare `anthropic` were over-broad — a genuine failing
 * HTTP/rate-limit TEST emitting "http" or naming "anthropic" would re-trigger
 * the very footgun GROUP-C closed. Narrowed to `http status`/`http error`, and
 * `anthropic` dropped (the structured markers below still catch a real API
 * quota body, e.g. `overloaded_error`, `usage_limit_reached`, `x-ratelimit`).
 */
const RUNTIME_CONTEXT_MARKERS: ReadonlyArray<string> = [
  'http status',
  'http error',
  'status code',
  'status:',
  'retry-after',
  'retry_after',
  'x-ratelimit',
  'ratelimit-',
  'api error',
  'overloaded_error',
  'resource_exhausted',
  'usage_limit_reached',
  'user_weekly_rate_limited',
];

function hasRuntimeContext(normalized: string): boolean {
  return RUNTIME_CONTEXT_MARKERS.some((m) => normalized.includes(m));
}

function hasSubscriptionQuotaPhrase(normalized: string): boolean {
  return SUBSCRIPTION_QUOTA_PHRASES.some((p) => normalized.includes(p));
}

function parseRetryAfter(body: string): number | undefined {
  // Match "retry-after: N" or "Retry-After: N" with optional surrounding
  // punctuation. Captures integer seconds only — HTTP-date form is rare in
  // agent return bodies and not worth the surface area.
  const match = body.match(/\bretry[-_ ]after[:\s]+(\d+)\b/i);
  if (!match) return undefined;
  const seconds = Number.parseInt(match[1]!, 10);
  return Number.isFinite(seconds) ? seconds : undefined;
}

/**
 * Options for {@link classifyAgentFailure}.
 */
export interface ClassifyAgentFailureOptions {
  /**
   * Whether `body` is the AGENT RUNTIME's termination cause (a thrown error /
   * session-crash / the dispatched agent's RETURN BODY — the #3095 contract)
   * rather than gate/verify CONTENT (test output, build log, verifier finding).
   *
   * Default TRUE: the function's documented job is classifying a runtime
   * termination cause, and a quota sentinel there is the actionable signal. The
   * recovery router (index.ts) passes `false` for the `gate`/`verify` signals —
   * CONTENT where a quota-looking word can be the GENUINE failure itself (a
   * failing test about rate-limiting). For content, a sentinel is only trusted
   * when it CO-OCCURS with HTTP/runtime context (see {@link
   * RUNTIME_CONTEXT_MARKERS}) — the GROUP-C fix that stops a genuine failure
   * from being misread as transient and burning 50 identical re-runs.
   */
  fromRuntimeTermination?: boolean;
}

/**
 * Query-handler wrapper for `agent.classify-failure`. Reads the body to
 * classify from the joined positional args (typed via `--`) so workflow
 * shell snippets can pass it as `gsd-sdk query agent.classify-failure -- "$BODY"`.
 *
 * The query contract is that the body IS the dispatched agent's return body (a
 * runtime-termination cause), so it classifies with `fromRuntimeTermination`.
 */
export async function agentClassifyFailure(
  args: string[],
): Promise<{ data: AgentFailureClassification }> {
  const body = args.join(' ');
  return { data: classifyAgentFailure(body, { fromRuntimeTermination: true }) };
}

export function classifyAgentFailure(
  body: string,
  options: ClassifyAgentFailureOptions = {},
): AgentFailureClassification {
  const normalized = body.toLowerCase();

  if (normalized.trim() === '') {
    return { class: 'unknown-failure' };
  }

  // Quota sentinels take precedence over the classifyHandoff runtime bug:
  // a quota-kill that *also* crashed the completion handler is still a quota
  // event, and the recovery path differs (wait vs. spot-check-and-treat-as-OK).
  //
  // GROUP-C fix: only TRUST a quota sentinel found in gate/verify CONTENT when
  // it co-occurs with HTTP/runtime transport context. When `body` is the agent
  // runtime's own termination cause (`fromRuntimeTermination`, the DEFAULT), the
  // sentinel is trusted directly — that body IS the quota-kill signal.
  //
  // R3 (C-1): a SUBSCRIPTION-QUOTA phrasing ("usage limit reached", "limit will
  // reset") is so unambiguously a quota pause that it is trusted on the CONTENT
  // path too — a real EXECUTE quota kill returns a failed PlanResult (gate
  // signal, not throw), and that body must RESUME via WAITING.json, not be
  // misread as genuine and burn the retry budget. Biasing to resume (the safe
  // direction given the cost asymmetry).
  const trustContentSentinel =
    options.fromRuntimeTermination !== false || hasSubscriptionQuotaPhrase(normalized);
  for (const sentinel of QUOTA_SENTINELS) {
    if (normalized.includes(sentinel)) {
      if (!trustContentSentinel && !hasRuntimeContext(normalized)) {
        // A quota-looking token in content text WITHOUT runtime context — e.g.
        // a failing test about rate-limiting. Not a transient; keep scanning for
        // a different class, else fall through to unknown-failure (GENUINE).
        continue;
      }
      const retryAfterSeconds = parseRetryAfter(body);
      return retryAfterSeconds === undefined
        ? { class: 'quota-exceeded', sentinel }
        : { class: 'quota-exceeded', sentinel, retryAfterSeconds };
    }
  }

  // R3 (C-1): a standalone subscription-quota phrasing that matched none of the
  // QUOTA_SENTINELS above (e.g. just "your limit will reset at 4pm" with no
  // "usage limit"/"quota"/"429" token) is still a quota pause → resume.
  const subscriptionPhrase = SUBSCRIPTION_QUOTA_PHRASES.find((p) => normalized.includes(p));
  if (subscriptionPhrase) {
    const retryAfterSeconds = parseRetryAfter(body);
    return retryAfterSeconds === undefined
      ? { class: 'quota-exceeded', sentinel: subscriptionPhrase }
      : { class: 'quota-exceeded', sentinel: subscriptionPhrase, retryAfterSeconds };
  }

  if (normalized.includes(CLASSIFY_HANDOFF_SENTINEL)) {
    return {
      class: 'classify-handoff-bug',
      sentinel: CLASSIFY_HANDOFF_SENTINEL,
    };
  }

  return { class: 'unknown-failure' };
}
