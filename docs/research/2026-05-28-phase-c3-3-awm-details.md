# Phase C.3.3 AWM Workflow Crystallization — Implementation Details
**Date:** 2026-05-28  
**Author:** Research agent (Claude Sonnet 4.6)  
**Purpose:** Four targeted answers for Phase C.3.3 (AWM workflow crystallization): canonical SKILL.md spec, Hermes Curator state machine, Composio Workbench API, Bun Worker sandboxing verdict.

---

## Q1: Canonical SKILL.md Specification (agentskills.io, December 2025)

### Origin and Adoption

The Agent Skills open standard was published by Anthropic in late 2025 (Q4, confirmed December 2025 by Simon Willison's documentation of OpenAI's adoption). Within two months of release, it was adopted by: Claude Code, ChatGPT, Codex CLI, Cursor, GitHub Copilot, Goose, Gemini CLI, Roo Code, Trae, Windsurf, Amp, Factory — 12+ named platforms as of March 2026, with "35+" total cited in other sources. The reference specification lives at `agentskills.io/specification` and `github.com/agentskills/agentskills`.

### File Naming and Directory Convention

A skill is **a directory** named with the skill's slug, containing at minimum a `SKILL.md` file. The directory name must exactly match the `name` field in the frontmatter.

```
skill-name/               ← directory name = name field value
├── SKILL.md              ← REQUIRED: metadata + instructions
├── scripts/              ← OPTIONAL: executable code (.py, .sh, .js)
├── references/           ← OPTIONAL: detailed documentation (.md files)
│   ├── REFERENCE.md
│   └── domain-specific.md
└── assets/               ← OPTIONAL: templates, configs, data files
```

Skills are installed into:
- `~/.claude/skills/<skill-name>/` — personal/global (Claude Code)
- `.claude/skills/<skill-name>/` — project-scoped (Claude Code)
- `~/.openclaw/workspace/skills/<skill-name>/` — OpenClaw
- `~/.hermes/skills/<skill-name>/` — Hermes

### Frontmatter Field Specification

| Field | Required | Type | Constraints | Purpose |
|-------|----------|------|-------------|---------|
| `name` | **YES** | string | 1–64 chars; lowercase `a-z`, digits `0-9`, hyphens only; no leading/trailing/consecutive hyphens; must exactly match parent directory name | Skill identifier; used for routing and registry |
| `description` | **YES** | string | 1–1,024 chars; non-empty; should state WHAT the skill does AND WHEN to use it | Primary activation signal; loaded into every system prompt at startup (~100 tokens) |
| `license` | no | string | Free-form; e.g. `MIT`, `Apache-2.0`, or path to bundled `LICENSE.txt` | Attribution and legal terms |
| `compatibility` | no | string | 1–500 chars if provided | Environment requirements: which product it targets, system packages needed, network access requirements |
| `metadata` | no | object | Map from string keys to string values; keys should be namespaced to avoid collisions | Client/platform extensions; arbitrary key-value for anything not in the base spec |
| `allowed-tools` | no | string | Space-separated tool identifiers; **experimental** — support varies by platform | Pre-approved tools the skill may invoke without additional gate; reduces permission prompts |

**Additional fields surfaced by agensi.io (platform extensions via `metadata` OR as top-level fields in some implementations):**

| Field | Platforms | Purpose |
|-------|-----------|---------|
| `when_to_use` | Claude Code, OpenClaw, Codex CLI | Extended trigger guidance beyond description |
| `argument-hint` | Most agents | Input specification for invocation hints |
| `arguments` | Most agents | Structured parameter definitions |
| `context: fork` | Claude Code only | Run skill in isolated subagent context |
| `model` | Claude Code only | Model specification for forked context |
| `effort` | Most agents | Reasoning depth: `low` / `medium` / `high` |
| `disable-model-invocation` | Most agents | Manual-only activation; never auto-triggered |
| `hooks` | Claude Code only | Event-driven automation (pre/post-execution) |

For maximum cross-platform portability, use only `name`, `description`, and `when_to_use`. Anything else risks incompatibility on non-extending platforms.

### Body Section Conventions

The Markdown body after the frontmatter contains skill instructions. **No structural format is mandated by the spec.** Recommended sections (from official docs + community practice):

- Step-by-step instructions (numbered list, one action per step)
- Input/output examples
- Edge cases and error handling
- "What NOT to do" boundary definitions
- Common gotchas

Anthropic's official guidance (from Claude Code docs): "Focus on what the agent lacks (project-specific conventions, workflow details), omit what it knows (general HTTP/PDF/GitHub knowledge)."

Body size limit: under 500 lines recommended; under 5,000 tokens for the full SKILL.md body (Level 2 load budget).

### Progressive Disclosure Mechanism — Exact Loading Sequence

Skills load in three phases. Platforms that implement progressive disclosure correctly follow this sequence:

```
Phase 1 — DISCOVERY (always, at startup):
  • Reads: name + description from YAML frontmatter only
  • Cost: ~100 tokens per skill
  • Trigger: daemon boot / session start
  • Effect: agent knows the skill exists and when to use it

Phase 2 — ACTIVATION (on-demand, when skill is selected):
  • Reads: full SKILL.md body (everything after the frontmatter)
  • Budget: <5,000 tokens recommended
  • Trigger: agent determines skill is relevant to current task
  • Claude Code mechanism: agent issues bash `read <skill-name>/SKILL.md` command
  • Effect: procedural instructions enter context window

Phase 3 — EXECUTION (as needed):
  • Reads: files in scripts/, references/, assets/ — one file at a time
  • Budget: effectively unlimited (files don't enter context until accessed)
  • Trigger: SKILL.md body references a specific file
  • Claude Code mechanism: additional bash reads, or script execution (script code never enters context — only stdout)
  • Effect: specific reference material or script output enters context
```

This design allows "dozens or even hundreds of skills installed without context penalty." At Phase 1, every skill costs ~100 tokens regardless of how large the full skill package is.

### Complete Annotated Example

This is a canonical SKILL.md with every documented field, annotated. Safe to paste into KAIROS's plan verbatim:

```yaml
---
# REQUIRED: Skill identifier.
# Rules: 1-64 chars, lowercase a-z + 0-9 + hyphens only.
# No leading/trailing/consecutive hyphens.
# Must exactly match the parent directory name.
name: draft-slack-reply

# REQUIRED: Activation signal. Loaded at startup into every system prompt.
# Rule: 1-1024 chars. Must include WHAT it does AND WHEN to use it.
# Good: specific keywords that match how users will phrase requests.
description: >
  Draft a context-aware Slack reply using the user's communication style
  and thread history. Use when a Slack message has been unread >20 minutes,
  or when the user says "draft a reply to [person]" or "respond to [thread]".

# OPTIONAL: License terms.
license: MIT

# OPTIONAL: Environment requirements (product, packages, network, OS).
# Only include if the skill requires something non-standard.
compatibility: Requires Slack MCP connector; designed for KAIROS daemon on macOS.

# OPTIONAL: Arbitrary key-value map for client-specific extensions.
# Namespace your keys to avoid collisions.
metadata:
  author: kairos-awm             # set to "kairos-awm" for auto-crystallized skills
  version: "1.2.0"
  kairos:category: communication
  kairos:tags: "slack drafting persona-aware"
  kairos:autonomy_tier: orange   # orange = requires approval before send
  kairos:auto_crystallized: "false"  # "true" = AWM-generated; "false" = human-authored
  kairos:crystallized_from: ""   # traj.md task_id if auto-crystallized
  kairos:state: active           # active | stale | archived

# OPTIONAL (experimental): Pre-approved tools this skill may invoke.
# Format: space-separated tool identifiers.
# Support varies by platform — Claude Code and OpenClaw honor this field.
allowed-tools: Bash(git:*) Read mcp__slack__get_thread mcp__slack__post_message
---

## When to use this skill

Use when a Slack message has been unread for >20 minutes AND the trigger
system classifies it as action-required (not FYI/announcement). Also invoke
on explicit user commands: "draft a reply to [person]" or "respond to [thread]".

Do NOT use for: channel announcements, bot messages, or threads the user
has already read (read_status = true in Slack metadata).

## Inputs

- `thread_ts` (string): Slack thread timestamp
- `channel` (string): Slack channel ID  
- `tone_override` (string, optional): Tone hint — "formal", "brief", "casual"

## Steps

1. Fetch thread history:
   `mcp__slack__get_thread(channel, thread_ts)` → returns message array

2. Recall context about the sender:
   Read `~/.kairos/brain/notes/people/<sender>.md` if it exists.
   If not: use only thread content.

3. Read persona.md communication preferences:
   `response_length`, `format_preference`, `tone_preference`

4. Draft reply following these rules:
   - Match user's sentence rhythm from past messages in thread
   - Apply `response_length` preference (terse = max 2 sentences unless content demands more)
   - If `tone_override` is provided, apply it; otherwise use persona preference
   - Sound like the user, not like an assistant

5. Return draft to the 🟠 approval queue (never send without gate resolution).

## Examples

**Input:** "Reply to John's message: 'hey can you review my PR? been blocked for a while'"  
**Draft output:** "On it — finishing current task, reviewing in ~90 min."

**Input (formal override):** Same message, `tone_override: "formal"`  
**Draft output:** "Understood. I will review your pull request within the next 90 minutes."

## Notes

- Never send directly — always surface in approval queue (🟠 gate)
- If persona.md has no entry for this sender, default to general `response_length`
- Draft should pass the "does this sound like the user?" test
- For threads with >10 messages, summarize context rather than reading all messages

## Edge cases

- Thread deleted since fetch: log warning, return error to caller
- Sender is external (email address not Slack user): treat as formal tone
- tone_override conflicts with persona preference: tone_override wins
```

### Security Note (from Anthropic's official docs)

Skills are the **moral equivalent of installing software**. From Anthropic's platform docs: "a malicious Skill can direct Claude to invoke tools or execute code in ways that don't match the Skill's stated purpose." Only install skills from trusted sources. Auto-crystallized KAIROS skills should be human-reviewed before promotion precisely for this reason.

---

## Q2: Hermes Curator — State Machine, Scoring, and .usage.json

### The Curator State Machine

The Curator is an autonomous background maintenance agent for the skill library. It shipped in Hermes v0.12.0 (April 30, 2026). Shipped as a standalone pass (not part of Dreaming).

**Skill lifecycle states:**

```
active
  │
  │  30 days without use (stale_after_days: 30)
  │  [deterministic, no LLM]
  ▼
stale
  │
  │  60 more days without use (archive_after_days: 90 from last use total)
  │  [deterministic, no LLM]
  ▼
archived  ────────────────────────────────────────────────────────────────
  │                                                                       │
  │  Manual restore:                                              Skills physically moved to:
  │  hermes curator restore <skill>                              ~/.hermes/skills/.archive/
  ▼                                                              (not deleted — recoverable)
active
```

**Trigger conditions (both must be true):**

1. `interval_hours` have elapsed since last Curator run (default: **168 hours = 7 days**)
2. Agent has been idle for at least `min_idle_hours` (default: **2 hours**)

The 2-hour idle gate prevents the Curator from running mid-session. It is NOT based on calendar scheduling (no cron) — it fires on the gateway's event loop when both conditions are satisfied.

### The Two-Phase Execution Model

**Phase 1 — Deterministic state transitions (no LLM):**

```
FOR each skill in ~/.hermes/skills/:
  last_used = .usage.json[skill].last_used_at
  days_since_use = now - last_used

  IF days_since_use >= archive_after_days (90):
    mv ~/.hermes/skills/<skill>/ ~/.hermes/skills/.archive/<skill>/
    .usage.json[skill].state = "archived"
    .usage.json[skill].archived_at = now

  ELIF days_since_use >= stale_after_days (30):
    .usage.json[skill].state = "stale"

SKIP if: skill.pinned == true
SKIP if: skill is bundled or hub-installed (defense-in-depth gate)
SKIP if: skill age < min_skill_age_days (3) — new skills protected
```

**Phase 2 — Auxiliary LLM review (consolidation pass):**

```
model = cheapest configured model (NOT the primary agent model)
max_iterations = 8

FOR each skill (focused on stale ones, but reviews all):
  skill_view(<skill>) → read full skill content
  
  DECIDE per-skill one of:
    keep        → no action
    patch       → skill_manage(action="patch", ...)  [targeted fix; preferred]
    consolidate → merge overlapping skills into one
    archive     → move to .archive/ early

  IF consolidate:
    - Must treat skill as full package (SKILL.md + scripts/ + references/ + assets/)
    - Options: (a) keep standalone, (b) re-home support files + rewrite paths, (c) archive entire package unchanged
    - NEVER flatten only SKILL.md into another skill's references/
```

The LLM phase is described as having "a known weakness: the agent tends toward self-congratulation — almost always thinks it performed well, even when it didn't" (GitHub issue #25833). This is an acknowledged open problem as of May 2026. The proposed fix (not yet shipped) involves `success_rate` and `consistency_score` metadata tracked at execution time.

### The .usage.json Schema — Complete

File path: `~/.hermes/skills/.usage.json`  
Format: single JSON object keyed by skill name.

```json
{
  "my-skill": {
    "use_count": 12,          // INT: total number of times skill was invoked
    "view_count": 34,         // INT: total number of times skill was read (metadata OR body)
    "last_used_at": "2026-04-24T18:12:03Z",   // ISO-8601: last invocation
    "last_viewed_at": "2026-04-23T09:44:17Z", // ISO-8601: last time skill body was read
    "patch_count": 3,         // INT: number of times skill was patched by curator or agent
    "last_patched_at": "2026-04-20T22:01:55Z", // ISO-8601: last patch timestamp
    "created_at": "2026-03-01T14:20:00Z",      // ISO-8601: when skill was created
    "state": "active",        // ENUM: "active" | "stale" | "archived"
    "pinned": false,          // BOOL: if true, curator NEVER touches this skill
    "archived_at": null       // ISO-8601 or null: when skill was archived
  }
}
```

**Fields NOT in the current schema but proposed in issue #25833 (not yet shipped):**
- `success_rate` — percentage of recent runs completing without error
- `consistency_score` — similarity between multiple execution runs
- `model_version` — model version that created/last-patched the skill
- `verification_timestamp` — when the skill was last verified in isolated context

### Grading — What "Grade" Actually Means

The Curator documentation does NOT describe a numeric grading formula for skills. The word "grades" in the documentation means: **determines the current lifecycle state (active / stale / archived) based on usage telemetry**. The grading is heuristic, time-based, and binary per state boundary — not a continuous numeric score.

The **6-factor scoring formula** (relevance 30% / frequency 24% / diversity 15% / recency 15% / consolidation 10% / richness 6%) is the **Dreaming formula** for promoting episodic observations to long-term memory (MEMORY.md). It applies to **observations / episodic memory candidates — NOT to skills**. Skills and memories use entirely separate lifecycle systems.

Key distinction:
- **Dreaming formula** → applies to: episodic session observations → decides what gets promoted to MEMORY.md
- **Curator** → applies to: skills → decides active/stale/archived/consolidate/patch via usage time + LLM review
- These are **parallel, independent subsystems** that do not share scoring logic

### In-Flight Patching — What Actually Happens

Hermes does NOT implement autonomous real-time self-repair during a skill's execution (i.e., there is no middleware that catches a failure mid-execution and rewrites the skill before retrying). 

What does exist:

1. **Strategy Mutation (v0.13, "Tenacity" mechanism):** When a plan fails, the agent mutates its approach — swapping tools, adjusting parameters, reordering steps — before retrying. This is execution-level adaptation, not skill file rewriting. Code pattern: `step["tool"] = step.get("fallback_tool", step["tool"])`.

2. **Post-execution skill patching:** After a task completes (whether successfully or not), the agent can call `skill_manage(action="patch")` to fix the skill body. The `patch` action is "preferred for updates — token-efficient." This requires the agent to recognize the failure and decide to patch.

3. **Curator-initiated patching:** During the weekly Curator pass, the LLM reviewer can issue patch actions on skills it judges to be drifted, incorrect, or suboptimal.

4. **Acknowledged weakness:** Issue #25833 explicitly flags that the current system "cannot prevent the agent from encoding suboptimal approaches, incorrect workflows, or session-specific lucky paths" because the agent is simultaneously author, executor, and quality inspector of its own skills. Proposed solution: automated verification in an isolated context on skill creation (not yet shipped).

**For KAIROS's port:** The patching mechanism should be: (a) at task completion, if `outcome == failure` in traj.md and `skills_used` is non-empty, flag those skills for Curator review; (b) Curator's LLM pass decides whether to patch. Do not attempt real-time mid-execution rewrites — Hermes doesn't do it either.

### Configuration Reference

```yaml
curator:
  enabled: true
  interval_hours: 168          # 7 days between runs
  min_idle_hours: 2            # minimum idle time before run triggers
  stale_after_days: 30         # days until active → stale
  archive_after_days: 90       # days until stale → archived
  min_skill_age_days: 3        # protect newly-created skills from pruning
  max_llm_iterations: 8        # cap on LLM review pass iterations
```

---

## Q3: Composio Workbench Programmatic API

### The Workbench in Context

The Composio Workbench is a persistent Python sandbox (described internally as "a persistent Jupyter notebook") that runs inside a Composio session. It provides `COMPOSIO_REMOTE_WORKBENCH` (Python execution) and `COMPOSIO_REMOTE_BASH_TOOL` (shell execution) as tools available to the AI agent.

**Critical architecture note:** The Workbench is session-scoped. Sessions "do not expire" and persist indefinitely on the Composio server. Variables, imports, files, and in-memory state persist across multiple calls within the same session.

### Creating a Workbench-Enabled Session

**KAIROS's current C.2.7 session has `workbench: { enable: false }`.** For a separate skill-execution session, use `workbench: { enable: true }` (TypeScript) or the equivalent:

**Python:**
```python
from composio import Composio

composio = Composio(api_key="COMPOSIO_API_KEY")

# Create a new session with workbench enabled
# Simple form (workbench is ON by default in newer SDK versions)
session = composio.create(user_id="kairos-skill-executor")

# Explicit workbench configuration with compute tier
session = composio.create(
    user_id="kairos-skill-executor",
    workbench_sandbox_size="medium"   # standard | medium | large | xlarge
)

# Disable workbench explicitly (for sessions that don't need it)
session = composio.create(
    user_id="kairos-main",
    workbench={"enable": False}        # removes COMPOSIO_REMOTE_WORKBENCH from tool list
)

# Get tools for the agent
tools = session.tools()
```

**TypeScript:**
```typescript
import { Composio } from "@composio/core";

const composio = new Composio({ apiKey: process.env.COMPOSIO_API_KEY });

// Create session with explicit workbench config
const session = await composio.create("kairos-skill-executor", {
  workbench: {
    enable: true,
    sandboxSize: "medium"    // standard | medium | large | xlarge
  }
});

const tools = await session.tools();
// tools now includes COMPOSIO_REMOTE_WORKBENCH and COMPOSIO_REMOTE_BASH_TOOL
```

**Compute tiers:**

| Tier | vCPU | RAM | Notes |
|------|------|-----|-------|
| `standard` | 1 | 1 GB | Default |
| `medium` | 2 | 2 GB | Recommended for data-heavy skills |
| `large` | 4 | 4 GB | Heavy computation |
| `xlarge` | 8 | 8 GB | ML/PyTorch workloads |

Changing tier recreates the sandbox. The `/mnt/files/` persistent mount survives tier changes, but all in-memory state is lost.

### The COMPOSIO_REMOTE_WORKBENCH Tool — Complete Spec

When the agent invokes `COMPOSIO_REMOTE_WORKBENCH`, it sends Python code to the sandbox. Here is the exact tool interface:

**Input parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `code_to_execute` | string | YES | Python code to run in the persistent Jupyter sandbox |
| `thought` | string | NO | Brief objective for the current step (for logging) |
| `current_step` | string | NO | Workflow phase identifier (e.g., `FETCHING_DATA`, `PROCESSING`) |
| `current_step_metric` | string | NO | Progress tracker: `"done/total units"` format |
| `session_id` | string | NO | Session identifier from prior `COMPOSIO_SEARCH_TOOLS` calls |

**Output structure:**

```json
{
  "successful": true,
  "data": { /* execution result — the `output` variable from the Python code */ },
  "error": null  /* or error message string if execution failed */
}
```

**Critical output convention:** The Python code must assign a variable named `output` at the end. Do NOT use `print()` or `return`. The sandbox captures `output` as the return value.

**Hard timeout: 3 minutes (180 seconds) per cell execution.**

### Minimal Working Code Snippet

This is the minimal end-to-end pattern for KAIROS to "create a Workbench session + execute a Python script + capture stdout/stderr/return value":

**Python (KAIROS daemon side — session setup):**

```python
from composio import Composio
import os

composio = Composio(api_key=os.environ["COMPOSIO_API_KEY"])

# Create or reuse the skill-execution session
# Store session_id in KAIROS's local state; reuse across skill executions
SKILL_SESSION_USER_ID = "kairos-skill-executor"

session = composio.create(user_id=SKILL_SESSION_USER_ID)
tools = session.tools()

# tools now contains COMPOSIO_REMOTE_WORKBENCH
# Pass tools to your Claude API call as normal tool_use tools
```

**How the AI agent calls COMPOSIO_REMOTE_WORKBENCH (the agent generates this tool call):**

```python
# The LLM generates a tool_use block like:
{
  "type": "tool_use",
  "name": "COMPOSIO_REMOTE_WORKBENCH",
  "input": {
    "code_to_execute": """
import json

# Your Python skill logic here
def process_data(items):
    results = []
    for item in items:
        results.append({"processed": item, "status": "ok"})
    return results

data = [1, 2, 3, 4, 5]
result = process_data(data)

# MUST assign to `output` — this is what gets returned
output = {
    "status": "success",
    "count": len(result),
    "results": result
}
""",
    "thought": "Processing skill data",
    "current_step": "SKILL_EXECUTION"
  }
}
```

**Capturing the result (KAIROS processes the tool_result):**

```python
# After the Claude API returns with a tool_use for COMPOSIO_REMOTE_WORKBENCH:
# Composio SDK handles execution and returns:
tool_result = {
    "successful": True,
    "data": {
        "status": "success",
        "count": 5,
        "results": [...]
    },
    "error": None
}

# For failures:
tool_result = {
    "successful": False,
    "data": {},
    "error": "NameError: name 'undefined_var' is not defined on line 7"
}

# Error handling pattern:
if not tool_result["successful"]:
    error_msg = tool_result.get("error", "Unknown execution error")
    # Log to traj.md, flag skill for Curator review
    log_skill_failure(skill_name, error_msg)
else:
    result_data = tool_result["data"]
    # Process result_data
```

**TypeScript variant (KAIROS daemon):**

```typescript
import { Composio } from "@composio/core";

const composio = new Composio({ apiKey: process.env.COMPOSIO_API_KEY! });

// Create skill-execution session (do this once; reuse session_id)
const session = await composio.create("kairos-skill-executor", {
  workbench: { enable: true, sandboxSize: "standard" }
});

// session.id is your persistent handle — store it
const sessionId = session.id;

// Reuse existing session:
const existingSession = await composio.use(sessionId);
const tools = await existingSession.tools();

// Tools include COMPOSIO_REMOTE_WORKBENCH
// Pass to Anthropic SDK tool_choice parameter
```

**Helper functions pre-loaded in every Workbench sandbox (no imports needed):**

```python
# Call any Composio tool from inside the sandbox
result_dict, error_string = run_composio_tool("GMAIL_SEND_EMAIL", {
    "to": "user@example.com",
    "subject": "Hello",
    "body": "World"
})

# Call an LLM for analysis/summarization
response_text, error_string = invoke_llm("Summarize this data: ...")

# Upload generated files to cloud storage
metadata_dict, error_string = upload_local_file("/home/user/output.csv")

# Direct API proxy call
response_data, error_string = proxy_execute("GET", "/api/endpoint", "github_toolkit")
```

### Session Lifecycle — Create-on-Demand vs Permanent

**Recommended for KAIROS:** Create a **dedicated skill-execution session** and keep it alive permanently. Do NOT create-on-demand per skill execution.

Rationale:
- Sessions "do not expire" on Composio's server
- State (variables, imports, intermediate files) persists across calls within a session
- Re-using a session for a series of related skill executions preserves context (e.g., auth state from a prior skill call)
- The `composio.use(sessionId)` pattern is explicitly designed for multi-turn reuse

**KAIROS architecture:** Maintain two sessions:
- `kairos-{userId}-main` — the existing session (workbench: false) for orchestrated tool calls
- `kairos-{userId}-skills` — NEW session (workbench: true) for Python skill execution

The skills session should be created on first use and its `sessionId` stored in KAIROS's local state (e.g., `~/.kairos/state/composio-skill-session.json`). On daemon restart, call `composio.use(storedSessionId)` to reconnect — do not create a new session.

### File Persistence and Upload

Files written to `/mnt/files/` inside the sandbox persist across calls within the session and survive compute tier changes.

```python
# Inside workbench code: write persistent output
import json
with open("/mnt/files/skill_output.json", "w") as f:
    json.dump(results, f)
output = {"file_path": "/mnt/files/skill_output.json"}

# Upload to cloud storage for retrieval by KAIROS daemon
metadata_dict, error = upload_local_file("/mnt/files/skill_output.json")
# metadata_dict contains URL for KAIROS to download the file
```

### Critical API Gotchas

**Gotcha 1 — `workbench: false` blocks COMPOSIO_REMOTE_WORKBENCH entirely.** When disabled, the tool is removed from the session's tool list. KAIROS's existing C.2.7 session has workbench disabled. You cannot add it later with `session.update()` without recreating the sandbox. The cleanest approach is a separate skills session from day one.

**Gotcha 2 — Output must be assigned to `output`, not printed.** If Python code uses `print()` instead of `output = ...`, the `data` field in the result will be empty. This is the single most common failure mode. The sandbox captures the named variable `output`; it does not capture stdout as a string. For debugging stdout, write to a file and read it back, or include captured output in the `output` dict explicitly:

```python
import io, sys
captured_stdout = io.StringIO()
sys.stdout = captured_stdout
# ... your code with prints ...
sys.stdout = sys.__stdout__
output = {
    "result": your_result,
    "stdout": captured_stdout.getvalue()  # explicit stdout capture
}
```

**Gotcha 3 — 3-minute hard timeout.** The 180-second limit is fixed and not configurable. Long-running operations must be chunked. For skill execution, this is generally not a concern (skills should complete in <10 seconds), but data-heavy skills need to be aware.

**Gotcha 4 — Pricing: workbench is currently free but will be metered.** From official docs: "Sandboxes are not billed today. Composio plans to begin billing for sandbox usage soon (metered by tier and runtime)." There is no current billing for workbench usage — it does not count as tool calls. This will change. When billing begins, it will be metered by compute tier × runtime duration. Design skills to minimize time in the sandbox; do computation efficiently.

**Gotcha 5 — MCP mode does not integrate with the Workbench.** If KAIROS uses Composio via MCP (`session.mcp.url`), COMPOSIO_REMOTE_WORKBENCH is not available in that path. The workbench is only accessible through the native SDK tool-use pattern (passing `session.tools()` to the Anthropic SDK). Maintain a hybrid: MCP for live tool calls, native SDK tool-use for skill execution.

---

## Q4: Bun Worker Sandboxing for TypeScript Skills

### The Definitive Security Verdict

**Bun Workers are NOT a real security sandbox for untrusted code.** This is the official position, confirmed by:

1. **Bun's own documentation** for `node:vm`: "The `node:vm` module is not a security mechanism and should not be used to run untrusted code." Bun implements Node.js compatibility for `node:vm` — this same disclaimer applies.

2. **GitHub issue #25929** ("Bun as a secure sandbox runtime for AI agent code execution"): The issue was filed precisely because Bun LACKS a sandbox. The proposer requests a "Deno-compatible permissions model" (`bun --secure generated-code.js` with `--allow-net`, `--allow-read` flags). As of May 2026, this feature does not exist in Bun. PR #25911 is referenced as implementing it, but it has not shipped.

3. **vm2 vulnerabilities (2026):** The `vm2` Node.js library (which attempts sandbox-in-process isolation similar to what `node:vm` provides) has suffered multiple critical sandbox escapes in 2026 (CVE-2026-22709 and others), confirming that JavaScript-in-JavaScript sandboxing is fundamentally fragile. Bun's `vm.SourceTextModule` (added in Bun v1.2.15) provides module-scoped evaluation but carries the same "not a security boundary" caveat.

4. **Anthropic's acquisition of Bun (December 2025)** did not change the security model. Bun is deployed as Claude Code infrastructure but the permission model for Workers remains unimplemented.

### What Bun Workers Actually Are

Bun Workers are **process-isolation primitives, not security sandboxes**:

- A Worker runs on a **separate thread** in the same process
- The Worker **shares I/O resources** with the main thread (filesystem, network, process memory)
- Workers can access the **filesystem** without restriction
- Workers can make **network calls** without restriction
- Workers **cannot be restricted** on which `import` statements work (no module whitelist)
- Workers **share the same process memory** in the sense that they can both read/write the filesystem and interact with the host OS

A Worker that escapes (malicious code, or buggy AWM-crystallized code) can: read `~/.kairos/`, read env vars, make network calls, spawn processes.

### When Bun Workers ARE Safe to Use

Bun Workers are appropriate for KAIROS's crystallized TypeScript skills **if and only if** the code is trusted. The threat model is:

| Scenario | Bun Worker OK? | Reason |
|----------|----------------|--------|
| KAIROS's own hand-authored TS skills | YES | Code is authored/audited by the system; equivalent to running any KAIROS module |
| AWM auto-crystallized skills, human-reviewed before promotion | YES | Human review is the security gate; Bun Worker is process isolation (not security) |
| AWM auto-crystallized skills, NOT human-reviewed | NO | Untrusted LLM-generated code; use cloud sandbox (E2B or Composio Workbench) |
| User-supplied arbitrary TS code | NO | External code; must use microVM isolation (E2B) |

KAIROS's current design (human approval gate before skill promotion — the "persona gate" in C.3.3) means Bun Worker is safe for the common case. The human review step IS the security check.

### Bun Worker API — Complete Reference

**Spawning a Worker:**
```typescript
// main.ts — spawn a skill in a worker
const worker = new Worker(new URL("./skill-runner.ts", import.meta.url));
// OR from a string URL:
const worker = new Worker("./skill-runner.ts");
```

**Worker lifecycle options:**
```typescript
const worker = new Worker("./skill-runner.ts", {
  preload: ["./kairos-skill-globals.ts"],  // Load shared globals before worker starts
  ref: false,                               // Don't keep main process alive for this worker
  smol: true,                               // Reduce memory usage (useful for short-lived skills)
  // No built-in timeout option — must implement manually
});
```

**Message passing (main → worker and back):**
```typescript
// main.ts
worker.postMessage({
  type: "execute",
  skill: "draft-slack-reply",
  args: { thread_ts: "xxx", channel: "yyy" }
});

worker.onmessage = (event: MessageEvent) => {
  const result = event.data;  // { success: true, output: {...} }
  console.log("Skill result:", result);
};

worker.onerror = (event: ErrorEvent) => {
  console.error("Worker error:", event.message);
};
```

```typescript
// skill-runner.ts (worker thread)
declare var self: Worker;

self.onmessage = async (event: MessageEvent) => {
  const { type, skill, args } = event.data;

  if (type === "execute") {
    try {
      // Load and execute the skill
      const skillModule = await import(`~/.kairos/skills/${skill}/runner.ts`);
      const result = await skillModule.execute(args);
      self.postMessage({ success: true, output: result });
    } catch (error: any) {
      self.postMessage({ success: false, error: error.message, stack: error.stack });
    }
  }
};
```

**Lifecycle events (Bun-specific):**
```typescript
worker.addEventListener("open", () => {
  console.log("Worker ready");  // Bun-specific — fires when worker thread is up
});

worker.addEventListener("close", (event: CloseEvent) => {
  console.log("Worker closed, exit code:", event.code);
});
```

**Termination:**
```typescript
worker.terminate();  // Forceful termination — Worker API is still experimental for termination
```

**CRITICAL: The Worker termination API is explicitly marked experimental in Bun's documentation.** Termination may not be immediate or reliable in all Bun versions.

### 30-Second Hard Timeout Implementation

Bun has **no built-in timeout enforcement** for Workers. You must implement it with `setTimeout` + `worker.terminate()`:

```typescript
// skill-executor.ts — KAIROS skill execution with 30s hard timeout
export async function executeSkillInWorker(
  skillName: string,
  args: Record<string, unknown>,
  timeoutMs = 30_000
): Promise<{ success: boolean; output?: unknown; error?: string; timedOut?: boolean }> {
  
  return new Promise((resolve) => {
    const worker = new Worker(
      new URL("./skill-runner.ts", import.meta.url),
      { ref: false, smol: true }
    );

    let settled = false;
    
    // Hard timeout enforcement
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        worker.terminate();
        resolve({
          success: false,
          timedOut: true,
          error: `Skill '${skillName}' exceeded 30s execution limit`
        });
      }
    }, timeoutMs);

    // Success handler
    worker.onmessage = (event: MessageEvent) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        worker.terminate();
        resolve({ success: true, output: event.data.output });
      }
    };

    // Error handler
    worker.onerror = (event: ErrorEvent) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        worker.terminate();
        resolve({
          success: false,
          error: event.message
        });
      }
    };

    // Worker closed unexpectedly
    worker.addEventListener("close", (event: CloseEvent) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({
          success: false,
          error: `Worker closed unexpectedly (exit code: ${(event as any).code})`
        });
      }
    });

    // Send execution request
    worker.addEventListener("open", () => {
      worker.postMessage({ type: "execute", skill: skillName, args });
    });
  });
}
```

**Usage:**
```typescript
const result = await executeSkillInWorker("draft-slack-reply", {
  thread_ts: "1234567890.123",
  channel: "C0123456789"
});

if (result.timedOut) {
  // Flag skill in Curator for review — may need optimization
  flagSkillForCuratorReview(skillName, "execution_timeout");
} else if (!result.success) {
  flagSkillForCuratorReview(skillName, result.error);
} else {
  // Process result.output
}
```

### Module Import Restrictions — Not Possible in Bun

Bun Workers do NOT support restricting `import` statements within the worker. There is no whitelist/allowlist mechanism for modules available inside a Worker. The worker can import any module accessible on the filesystem or network.

**Implication for KAIROS:** The module restriction requirement must be met by the human-review gate on skill promotion, not by runtime enforcement. The approved skill is trusted; don't run unapproved skills in a Bun Worker.

If you need runtime import restriction, the only current option is a cloud sandbox (E2B, Composio Workbench) where the module environment is controlled.

### Memory Sharing

Bun Workers do **not** share heap memory with the parent (each Worker has its own V8 heap). However, `SharedArrayBuffer` and `Atomics` work for explicit shared memory — but this requires opt-in from both sides.

Workers run on separate threads but within the same OS process. This means they share the OS-level resources: filesystem, network, environment variables, and host process privileges. The distinction: heap isolation = yes; OS-level sandbox = no.

### The Production Recommendation for KAIROS C.3.3

**Tiered approach based on skill origin:**

```
Skill origin                         Execution environment
─────────────────────────────────────────────────────────
Human-authored TS skill              → Bun Worker (30s timeout, post-review trust)
AWM-crystallized TS skill            → Bun Worker (after human approval gate)
  (human-reviewed before promotion)
AWM-crystallized Python skill        → Composio Workbench (COMPOSIO_REMOTE_WORKBENCH)
  (any origin)
User-supplied arbitrary code         → E2B (Firecracker microVM, if ever needed)
  (not in scope for C.3.3)
```

TS skills run in Bun Workers for <1ms spawn time and zero cloud cost. Python skills always run in Composio Workbench because the TS runtime is not a Python environment and spawning a child_process for each skill invocation is both slower and more fragile.

---

## Orchestrator Summary (under 400 words)

### 1. Canonical SKILL.md Format

The agentskills.io standard (December 2025) requires exactly **two fields**: `name` (1–64 chars, lowercase alphanumeric + hyphens, must match directory name) and `description` (1–1,024 chars, must state both what and when). Optional fields are `license`, `compatibility` (max 500 chars), `metadata` (arbitrary key-value map used for client extensions), and `allowed-tools` (experimental, space-separated tool identifiers). The directory structure is `skill-name/SKILL.md` (plus optional `scripts/`, `references/`, `assets/`). Progressive disclosure: name + description load as ~100 tokens at startup; full SKILL.md body loads on activation; scripts/references load on-demand. For KAIROS's KAIROS-specific fields (autonomy_tier, auto_crystallized, state, crystallized_from), use the `metadata` map with namespaced keys.

### 2. Hermes Curator State Machine

Skills transition deterministically: **active → stale at 30 days unused → archived at 90 days unused**. Archive = physical file move to `~/.hermes/skills/.archive/`. The Curator fires when (a) 7 days have elapsed since the last run AND (b) the agent has been idle for ≥2 hours. Phase 1 is timestamp-based (no LLM). Phase 2 is an LLM review pass (cheapest model, max 8 iterations) that can keep, patch, consolidate, or archive skills. The **6-factor scoring formula is Dreaming-only** — it applies to episodic memory candidates, not to skills. Skills have no numeric score; they are graded by time-since-use against thresholds.

### 3. Critical Composio Workbench Gotchas

**Gotcha 1:** `workbench: { enable: false }` removes `COMPOSIO_REMOTE_WORKBENCH` from the tool list entirely. KAIROS's main session has this disabled — create a separate `kairos-{userId}-skills` session with workbench enabled and store its `sessionId` for reuse. **Gotcha 2:** Python code must assign `output = {...}` at the end — the sandbox captures this named variable, NOT stdout. Code that uses `print()` returns empty `data`. All stdout must be explicitly captured into the `output` dict.

### 4. Bun Worker Security Verdict

**Not a real sandbox — just process isolation.** Workers share OS-level resources (filesystem, network, env vars). Bun's `node:vm` carries the explicit disclaimer "not a security mechanism for untrusted code." Issue #25929 confirms no permission model exists. Workers are safe **only for trusted code** (human-reviewed skills). AWM-crystallized TS skills are safe in Bun Workers because the human approval gate is the security check. Python skills always go to Composio Workbench. If user-supplied arbitrary code ever enters scope, use E2B.

### 5. Recommended C.3.3 Task Structure

1. **Define traj.md → AWM extraction schema** — specify the trigger criteria (success + ≥3 tools + >30s) and the fields to extract from traj.md for skill candidate generation
2. **Implement AWM worker** (`daemon/memory/awm-worker.ts`) — background file watcher on `~/.kairos/trajs/`; applies trigger criteria; generates candidate SKILL.md with `auto_crystallized: true`
3. **Implement persona gate** (`daemon/memory/skill-promoter.ts`) — evaluates candidate against existing skills (cosine similarity dedup ≥0.9), autonomy tier, persona.md behavioral patterns; queues for human review or auto-approves
4. **Implement skill-execution session** — create dedicated `kairos-{userId}-skills` Composio session (workbench: true, standard tier); store sessionId; implement `composio.use(sessionId)` reconnect on restart
5. **Implement Python skill executor** (`daemon/skills/pythonRunner.ts`) — wraps COMPOSIO_REMOTE_WORKBENCH tool call; handles `output` capture pattern; 180s timeout awareness; error → traj.md logging
6. **Implement Bun Worker skill executor** (`daemon/skills/tsRunner.ts`) — `executeSkillInWorker()` with 30s hard timeout; handles `settled` pattern to prevent double-resolve; error → Curator flag
7. **Implement SKILL.md writer** (`daemon/skills/skillWriter.ts`) — writes valid agentskills.io-compatible SKILL.md with KAIROS metadata extensions; validates `name` matches directory
8. **Implement skill registry hot-reload** (extend `daemon/skills/registry.ts`) — watch `~/.kairos/skills/` for new directories; reload metadata index without daemon restart; trigger progressive disclosure update
9. **Implement .usage.json tracker** (`daemon/skills/usageTracker.ts`) — port Hermes schema exactly (use_count, view_count, last_used_at, last_viewed_at, patch_count, last_patched_at, created_at, state, pinned, archived_at)
10. **Implement Curator Phase 1** (`daemon/memory/curator.ts`) — deterministic state transitions; respect min_skill_age_days (3), stale_after_days (30), archive_after_days (90); mv to `.archive/`
11. **Implement Curator Phase 2** (`daemon/memory/curator.ts`) — auxiliary LLM pass (cheapest model); skills_list → skill_view → decide keep/patch/consolidate/archive; write `~/.kairos/logs/curator/REPORT.md`
12. **Implement Curator idle-gate trigger** — fires when: last_run + 7 days elapsed AND idle ≥ 2 hours (integrate with existing IOPMAssertionCreateWithName idle detection from Phase B)
13. **Implement skill failure → Curator flag pipeline** — in traj.md write-path: if outcome == failure and skills_used is non-empty, increment failure count in .usage.json and set `curator_review_flag: true`
14. **Integration test: full AWM loop** — seed 3 identical successful trajs; verify AWM worker generates candidate; verify persona gate queues it; verify human approval promotes it; verify it appears in skill registry; verify it executes via tsRunner/pythonRunner; verify Curator respects it after 30 idle days

---

*Sources consulted: [agentskills.io/specification](https://agentskills.io/specification) · [Anthropic Agent Skills docs](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview) · [DeepWiki SKILL.md spec](https://deepwiki.com/agentskills/agentskills/2.2-skill.md-specification) · [agensi.io SKILL.md reference](https://www.agensi.io/learn/skill-md-format-reference) · [inference.sh Agent Skills overview](https://inference.sh/blog/skills/agent-skills-overview) · [Hermes Curator docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/curator) · [Hermes v0.12.0 release](https://github.com/NousResearch/hermes-agent/blob/main/RELEASE_v0.12.0.md) · [Hermes RFC issue #16077](https://github.com/NousResearch/hermes-agent/issues/16077) · [Hermes issue #25833](https://github.com/NousResearch/hermes-agent/issues/25833) · [Hermes issue #7816](https://github.com/NousResearch/hermes-agent/issues/7816) · [lushbinary Curator upgrade guide](https://lushbinary.com/blog/hermes-agent-v0-12-curator-release-upgrade-guide/) · [Composio Workbench docs](https://docs.composio.dev/docs/workbench) · [Composio session docs](https://docs.composio.dev/docs/how-composio-works) · [Composio configuring sessions](https://docs.composio.dev/docs/configuring-sessions) · [Composio toolkits (REMOTE_WORKBENCH spec)](https://docs.composio.dev/toolkits/composio) · [Bun Workers docs](https://bun.com/docs/runtime/workers) · [Bun issue #25929](https://github.com/oven-sh/bun/issues/25929) · [Bun v1.2.15 release](https://bun.com/blog/bun-v1.2.15) · [vm2 sandbox escapes 2026](https://thehackernews.com/2026/05/vm2-nodejs-library-vulnerabilities.html)*
