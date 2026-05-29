<purpose>
Orchestrate parallel codebase mapper agents to analyze codebase and produce structured documents in .planning/codebase/

Each agent has fresh context, explores one of 4 focus areas (tech / arch / quality / concerns), and **writes its own disjoint documents directly**. The orchestrator only receives a per-focus verdict (file + line counts), never document bodies, then verifies, secret-scans, and commits as the single writer.

When the **Workflow tool** is available (Claude Code), the 4 focus-area mappers fan out through the `gsd-map-codebase-fanout` dynamic workflow (ADR 0013 rollout). On non-Claude runtimes (Codex, Gemini CLI, Antigravity) the workflow falls through to the verbatim sequential mapping path.

Output: .planning/codebase/ folder with 7 structured documents about the codebase state.
</purpose>

<available_agent_types>
Valid GSD subagent types (use exact names — do not fall back to 'general-purpose'):
- gsd-codebase-mapper — Maps project structure and dependencies
</available_agent_types>

<philosophy>
**Why dedicated mapper agents:**
- Fresh context per domain (no token contamination)
- Agents write documents directly (no context transfer back to orchestrator)
- Orchestrator only summarizes what was created (minimal context usage)
- Faster execution (agents run simultaneously)

**Document quality over length:**
Include enough detail to be useful as reference. Prioritize practical examples (especially code patterns) over arbitrary brevity.

**Always include file paths:**
Documents are reference material for Claude when planning/executing. Always include actual file paths formatted with backticks: `src/services/user.ts`.
</philosophy>

<process>

<step name="parse_paths_flag" priority="first">
Parse an optional `--paths <p1,p2,...>` argument. When supplied (by the
post-execute codebase-drift gate in `/gsd:execute-phase` or by a user running
`/gsd:map-codebase --paths apps/accounting,packages/ui`), the workflow
operates in **incremental-remap mode**:

- Pass `--paths <p1>,<p2>,...` through to each spawned `gsd-codebase-mapper`
  agent's prompt. Agents scope their Glob/Grep/Bash exploration to the listed
  repo-relative prefixes only — no whole-repo scan.
- Reject path values that contain `..`, start with `/`, or include shell
  metacharacters (`;`, `` ` ``, `$`, `&`, `|`, `<`, `>`). If all provided
  paths are invalid, fall back to a normal whole-repo run.
- On write, each mapper stamps `last_mapped_commit: <HEAD sha>` into the YAML
  frontmatter of every document it produces (see `bin/lib/drift.cjs:writeMappedCommit`).

**Explicit contract — propagate `--paths` through a single normalized
variable.** Downstream steps (`fan_out_mapping` — which passes it as the
workflow's `path_scope` arg — `sequential_mapping`, and any in-context mapping
prompt construction) MUST use `${PATH_SCOPE_HINT}` to ensure every mapper
receives the same deterministic scope. Without this contract incremental-remap
can silently regress to a whole-repo scan.

```bash
# Validated, comma-separated paths (empty if --paths absent or all rejected):
SCOPED_PATHS="<validated paths or empty>"
if [ -n "$SCOPED_PATHS" ]; then
  PATH_SCOPE_HINT="--paths $SCOPED_PATHS"
else
  PATH_SCOPE_HINT=""
fi
```

All mapper prompts built later in this workflow MUST include
`${PATH_SCOPE_HINT}` (expanded to empty when full-repo mode is in effect).

When `--paths` is absent, behave exactly as before: full-repo scan, all 7
documents refreshed.

**Resolve HEAD for the fan-out workflow.** The `gsd-map-codebase-fanout`
dynamic workflow has no git/clock of its own, so the orchestrator resolves HEAD
in pre-flight and passes it as `head_sha`. Mappers stamp
`last_mapped_commit: <head_sha>` into each doc's frontmatter on write (see
`bin/lib/drift.cjs:writeMappedCommit`):

```bash
HEAD_SHA=$(git rev-parse HEAD 2>/dev/null || echo "")
```
</step>

<step name="init_context" priority="first">
Load codebase mapping context:

```bash
INIT=$(gsd-sdk query init.map-codebase)
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
```

Extract from init JSON: `mapper_model`, `commit_docs`, `codebase_dir`, `existing_maps`, `has_maps`, `codebase_dir_exists`, `subagent_timeout`, `date`, `response_language`.

```bash
RESPONSE_LANGUAGE="<response_language from init JSON, empty if absent>"
```
</step>

<step name="check_existing">
Check if .planning/codebase/ already exists using `has_maps` from init context.

If `codebase_dir_exists` is true:
```bash
ls -la .planning/codebase/
```

**If exists:**

```
.planning/codebase/ already exists with these documents:
[List files found]

What's next?
1. Refresh - Delete existing and remap codebase
2. Update - Keep existing, only update specific documents
3. Skip - Use existing codebase map as-is
```

Wait for user response.

If "Refresh": Delete .planning/codebase/, continue to create_structure
If "Update": Ask which documents to update, continue to create_structure (the fan-out / sequential path remaps the focus areas covering those documents)
If "Skip": Exit workflow

**If doesn't exist:**
Continue to create_structure.
</step>

<step name="create_structure">
Create .planning/codebase/ directory:

```bash
mkdir -p .planning/codebase
```

**Expected output files:**
- STACK.md (from tech mapper)
- INTEGRATIONS.md (from tech mapper)
- ARCHITECTURE.md (from arch mapper)
- STRUCTURE.md (from arch mapper)
- CONVENTIONS.md (from quality mapper)
- TESTING.md (from quality mapper)
- CONCERNS.md (from concerns mapper)

Continue to detect_runtime_capabilities.
</step>

<step name="detect_runtime_capabilities">
Before mapping, detect whether the current runtime supports the **Workflow**
tool. The 4 focus-area mappers fan out through the `gsd-map-codebase-fanout`
dynamic workflow, which only runs under the Workflow tool (Claude Code). If the
Workflow tool is unavailable (Codex, Gemini CLI, Antigravity, or any non-Claude
runtime), fall through to the sequential mapping path — identical to today's
behavior.

→ **If the Workflow tool IS available:** run `fan_out_mapping` (the next step).
→ **If the Workflow tool is NOT available:** skip `fan_out_mapping` and run
  `sequential_mapping` instead.

**CRITICAL:** In the sequential path, never use `browser_subagent` or `Explore`
as a substitute. The `browser_subagent` tool is exclusively for web page
interaction and will fail for codebase analysis. When the Workflow tool is
unavailable, perform the mapping sequentially in-context.
</step>

<step name="fan_out_mapping" condition="Workflow tool is available">
Fan the 4 focus-area mappers (tech / arch / quality / concerns) out through the
`gsd-map-codebase-fanout` dynamic workflow.

**Mappers write their own disjoint docs (DELIBERATE — a scoped exception to ADR
0013 D2).** Unlike the code-review / verify fan-outs (whose agents write
nothing), each mapper here WRITES its 1-2 `.planning/codebase/*.md` docs
directly, exactly as today. This is safe because the 4 focus areas map to 7
NON-OVERLAPPING filenames (the disjoint-filename invariant), so even under the
Workflow tool's no-op worktree isolation there is zero file collision and no
branch runs a test process. The benefit preserved: the orchestrator never
ingests doc bodies (only `{file, lines, status}` per focus), avoiding the
context tax. See `docs/adr/0013-dynamic-workflow-parallelization.md` §Rollout
template and the workflow's header.

Invoke the fan-out workflow with the resolved scope and HEAD sha:

```
Workflow({name:'gsd-map-codebase-fanout', args:{
  path_scope: "${PATH_SCOPE_HINT}",
  head_sha: "${HEAD_SHA}",
  response_language: "${RESPONSE_LANGUAGE}"
}})
```

> `path_scope` is the validated `${PATH_SCOPE_HINT}` (e.g. `--paths apps/x`),
> empty in full-repo mode. `head_sha` is the pre-flight `${HEAD_SHA}` the mappers
> stamp into doc frontmatter. `response_language` is from init context (empty
> when unset). `map-codebase` is project-level, so no `phase_number` is passed
> (the workflow reads it defensively).

> **ORCHESTRATOR RULE — stop while subagent active**: After invoking the
> Workflow above, stop working on this task immediately. Do NOT read source
> files, analyze the codebase, or write any mapping documents independently
> while the mapper fan-out is active. Wait for the workflow to return. This
> prevents duplicate work, conflicting edits, and wasted context.

> The per-mapper wait budget is configurable via `workflow.subagent_timeout` in
> `.planning/config.json` (milliseconds; `subagent_timeout` in init context).
> Default: 300000 (5 minutes). Increase for large codebases or slower models.

The workflow returns `{status, per_focus}` where each `per_focus` entry is
`{focus, status:'ok'|'empty'|'error', files:[{file, lines}]}`. **What you
receive: just per-focus file paths and line counts — NOT document contents.**
The mappers have already written the 7 docs to `.planning/codebase/`.

**Fan-out failure handling:**

If the Workflow invocation fails (workflow error, timeout, or exception) OR the
returned `status` is `error` (all 4 focus areas errored), note the failure. The
`verify_output` step below is the backstop — it reads `.planning/codebase/` back
and reports which documents are missing/empty, so a partial fan-out surfaces
there.

Continue to verify_output.
</step>

<step name="sequential_mapping" condition="Workflow tool is NOT available (e.g. Antigravity, Gemini CLI, Codex)">
When the `Workflow` tool is unavailable, perform codebase mapping sequentially in the current context. This replaces `fan_out_mapping`. This is today's behavior preserved verbatim, runtime-gated like code-review.md's `single_agent_review_fallback`.

**IMPORTANT:** Do NOT use `browser_subagent`, `Explore`, or any browser-based tool. Use only file system tools (Read, Bash, Write, Grep, Glob, list_dir, view_file, grep_search, or equivalent tools available in your runtime).

**IMPORTANT:** Use `{date}` from init context for all `[YYYY-MM-DD]` date placeholders in documents. NEVER guess the date.

**SCOPE:** When `${PATH_SCOPE_HINT}` is non-empty (i.e. `--paths` was supplied), restrict every pass below to the validated path prefixes in `${SCOPED_PATHS}`. Do NOT scan files outside those prefixes. When `${PATH_SCOPE_HINT}` is empty, perform a full-repo scan.

Perform all 4 mapping passes sequentially:

**Pass 1: Tech Focus**
- Explore package.json/Cargo.toml/go.mod/requirements.txt, config files, dependency trees
- Write `.planning/codebase/STACK.md` — Languages, runtime, frameworks, dependencies, configuration
- Write `.planning/codebase/INTEGRATIONS.md` — External APIs, databases, auth providers, webhooks

**Pass 2: Architecture Focus**
- Explore directory structure, entry points, module boundaries, data flow
- Write `.planning/codebase/ARCHITECTURE.md` — Pattern, layers, data flow, abstractions, entry points
- Write `.planning/codebase/STRUCTURE.md` — Directory layout, key locations, naming conventions

**Pass 3: Quality Focus**
- Explore code style, error handling patterns, test files, CI config
- Write `.planning/codebase/CONVENTIONS.md` — Code style, naming, patterns, error handling
- Write `.planning/codebase/TESTING.md` — Framework, structure, mocking, coverage

**Pass 4: Concerns Focus**
- Explore TODOs, known issues, fragile areas, security patterns
- Write `.planning/codebase/CONCERNS.md` — Tech debt, bugs, security, performance, fragile areas

Use the same document templates as the `gsd-codebase-mapper` agent. Include actual file paths formatted with backticks.

Continue to verify_output.
</step>

<step name="verify_output">
Verify all documents created successfully:

```bash
ls -la .planning/codebase/
wc -l .planning/codebase/*.md
```

**Verification checklist:**
- All 7 documents exist
- No empty documents (each should have >20 lines)

If any documents missing or empty, note which agents may have failed.

Continue to scan_for_secrets.
</step>

<step name="scan_for_secrets">
**CRITICAL SECURITY CHECK:** Scan output files for accidentally leaked secrets before committing.

Run secret pattern detection:

```bash
# Check for common API key patterns in generated docs
grep -E '(sk-[a-zA-Z0-9]{20,}|sk_live_[a-zA-Z0-9]+|sk_test_[a-zA-Z0-9]+|ghp_[a-zA-Z0-9]{36}|gho_[a-zA-Z0-9]{36}|glpat-[a-zA-Z0-9_-]+|AKIA[A-Z0-9]{16}|xox[baprs]-[a-zA-Z0-9-]+|-----BEGIN.*PRIVATE KEY|eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.)' .planning/codebase/*.md 2>/dev/null && SECRETS_FOUND=true || SECRETS_FOUND=false
```

**If SECRETS_FOUND=true:**

```
⚠️  SECURITY ALERT: Potential secrets detected in codebase documents!

Found patterns that look like API keys or tokens in:
[show grep output]

This would expose credentials if committed.

**Action required:**
1. Review the flagged content above
2. If these are real secrets, they must be removed before committing
3. Consider adding sensitive files to Claude Code "Deny" permissions

Pausing before commit. Reply "safe to proceed" if the flagged content is not actually sensitive, or edit the files first.
```

Wait for user confirmation before continuing to commit_codebase_map.

**If SECRETS_FOUND=false:**

Continue to commit_codebase_map.
</step>

<step name="commit_codebase_map">
Commit the codebase map:

```bash
gsd-sdk query commit "docs: map existing codebase" --files .planning/codebase/*.md
```

Continue to offer_next.
</step>

<step name="offer_next">
Present completion summary and next steps.

**Get line counts:**
```bash
wc -l .planning/codebase/*.md
```

**Output format:**

```
Codebase mapping complete.

Created .planning/codebase/:
- STACK.md ([N] lines) - Technologies and dependencies
- ARCHITECTURE.md ([N] lines) - System design and patterns
- STRUCTURE.md ([N] lines) - Directory layout and organization
- CONVENTIONS.md ([N] lines) - Code style and patterns
- TESTING.md ([N] lines) - Test structure and practices
- INTEGRATIONS.md ([N] lines) - External services and APIs
- CONCERNS.md ([N] lines) - Technical debt and issues


---

## ▶ Next Up — [${PROJECT_CODE}] ${PROJECT_TITLE}

**Initialize project** — use codebase context for planning

`/clear` then:

`/gsd:new-project`

---

**Also available:**
- Re-run mapping: `/gsd:map-codebase`
- Review specific file: `cat .planning/codebase/STACK.md`
- Edit any document before proceeding

---
```

End workflow.
</step>

</process>

<success_criteria>
- .planning/codebase/ directory created
- When Workflow tool available: the 4 focus-area mappers fan out via gsd-map-codebase-fanout; each mapper writes its own disjoint docs; orchestrator receives `{status, per_focus}` (file + line counts), never document bodies
- When Workflow tool NOT available: 4 sequential mapping passes performed inline (never using browser_subagent)
- All 7 codebase documents exist
- No empty documents (each should have >20 lines)
- Orchestrator stays single writer for the commit; interactive gates (check_existing, scan_for_secrets) remain on the orchestrator
- Clear completion summary with line counts
- User offered clear next steps in GSD style
</success_criteria>
