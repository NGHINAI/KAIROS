# Hermes + OpenClaw Essences — KAIROS Phase C.3.1 Research
**Date:** 2026-05-28  
**Author:** Research agent (Claude Sonnet 4.6)  
**Purpose:** Identify what to port from Hermes and OpenClaw into KAIROS Phase C.3.1 (User Profile + Persona-Awareness Loop); design the KAIROS .md standard family; map the self-improving skill loop; confirm C.3.1 scope.

---

## 1. What Hermes IS — and What to Port

### What it is

Hermes Agent ([github.com/NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)) is an open-source autonomous AI agent built by Nous Research, released February 2026. It is explicitly self-described as "not a chatbot, not a copilot — a persistent personal agent that learns your projects, builds its own skills, and reaches you wherever you are." It runs self-hosted (Linux, macOS, WSL2) with all memory local in `~/.hermes/`.

The key distinction from every other agent: it implements a **closed learning loop** with four interlocking subsystems:

1. **Persistent memory** (MEMORY.md + USER.md) — two files injected as frozen snapshots at session start, prefix-cached for zero per-call cost.
2. **Skill self-improvement** — skills are created after complex tasks (5+ tool calls), patched during use when wrong, and lifecycle-managed by the Curator.
3. **Autonomous Curator** (shipped v0.12.0, April 2026) — runs on a 7-day inactivity-gated cycle, grades skills, consolidates overlaps, archives stale ones, writes `~/.hermes/logs/curator/REPORT.md`.
4. **Hermes Dreaming** — a 3-phase sleep-cycle consolidation process running at 3 AM via cron (or manually via `hermes dream run`).

### Hermes Dreaming — the core innovation

The Dreaming plugin implements a biological sleep metaphor:

```
Light Sleep  → scans recent sessions, identifies + deduplicates candidates (read-only)
REM Sleep    → extracts recurring themes, writes narrative entry to DREAMS.md (read-only)
Deep Sleep   → applies scoring formula, promotes high-scorers to MEMORY.md (write phase)
```

**Scoring formula** (0–1 scale, weighted):
```
score = 0.30 × relevance     (meaningful keyword density)
      + 0.24 × frequency     (topic appearance count across sessions)
      + 0.15 × query_diversity  (presence across distinct sessions)
      + 0.15 × recency        (recency bias for newer content)
      + 0.10 × consolidation  (dedup penalty if already in memory)
      + 0.06 × conceptual_richness  (length + detail assessment)
```

Candidates exceeding `promotion_threshold` (default 0.6) AND `min_recall_count` (default 2) are promoted.

**Configuration:**
```yaml
plugins:
  entries:
    dreaming:
      config:
        enabled: false
        frequency: "0 3 * * *"
        quiet_minutes: 60          # skip if user active within N min
        max_candidates: 50
        promotion_threshold: 0.6
        min_recall_count: 2
        lookback_days: 7
        dream_diary_path: null     # defaults to ~/.hermes/DREAMS.md
```

The KAIROS spec already referenced this — Phase B ships "Hermes Dreaming scoring formula" with `score = w1·relevance + w2·frequency + w3·recency + w4·diversity + w5·richness - w6·duplication` (slight variant; same concept). **Phase B has the Dreaming formula but not the DREAMS.md diary or the quiet_minutes idle gate as separate concepts.**

### Memory File Architecture

Two files in `~/.hermes/memories/`:

**MEMORY.md** (~800 tokens, 2,200 char limit)
- Agent's personal notes: environment facts, OS details, project structure, tool quirks, completed tasks, lessons learned
- Written by the agent via `memory(action="add"|"replace"|"remove")`
- Promoted entries come from Dreaming

**USER.md** (~500 tokens, 1,375 char limit)
- User profile: timezone, communication preferences, technical skill level, workflow habits, project priorities
- Grows from agent observations and explicit user corrections
- Separate from MEMORY.md so agent-self-knowledge is distinct from user-knowledge

Both are injected as frozen snapshots at session start, never modified during a session (prefix cache optimization).

### Dialectic User Model (Honcho integration)

The Honcho integration implements "dialectic user modeling that builds a persistent model of who you are across sessions." It exposes a `/insights [--days N]` command to review what the agent has learned about the user. This is the Hermes version of what KAIROS calls the "dialectic user model" (already in the spec under Section 5 Part B):

```
brain/user-model/
├── claims.md          # current best-guess about user
├── evidence.md        # observations supporting claims
├── contradictions.md  # observations contradicting claims
├── synthesis.md       # reconciled view
└── unknowns.md        # things KAIROS wants to learn
```

Hermes implements this as a memory-provider plugin (Honcho is one of several pluggable providers), confirming the multi-file dialectic approach is the right design.

### Curator — Skill Lifecycle Management

The Curator is the most concrete "self-improving skills" implementation found in production:

```
Skill states:  active → stale (30 days unused) → archived (90 days unused)
               archived → active via:  hermes curator restore <skill>

Phase 1 (deterministic): timestamp-based state transitions, no LLM needed
Phase 2 (LLM review):    auxiliary model surveys agent-created skills,
                          decides: keep | patch | consolidate | archive
                          (max_iterations=8, uses cheapest configured model)
```

Usage telemetry per skill (`~/.hermes/skills/.usage.json`):
```json
{
  "my-skill": {
    "use_count": 12,
    "view_count": 34,
    "last_used_at": "2026-04-24T18:12:03Z",
    "patch_count": 3,
    "state": "active",
    "pinned": false
  }
}
```

Only agent-created skills are under Curator control. Bundled and hub-installed skills are immutable.

### SOUL.md in Hermes

Hermes also uses SOUL.md (a "global personality file" at `~/.hermes/SOUL.md`) to define the agent's default voice and behavior. It is injected alongside MEMORY.md and USER.md. Hermes borrowed this pattern from OpenClaw.

### What to Port from Hermes (3 specific patterns)

**H1 — Dreaming Consolidation Loop as a standalone subsystem**
- Implement `~/.kairos/brain/DREAMS.md` as the REM-phase diary
- The scoring formula is already in Phase B, but the **3-phase structure** (Light/REM/Deep), the **quiet_minutes idle gate**, and the **dream_diary write** are not yet explicitly implemented as separate concepts
- Idle gate is especially important: Dreaming should never run during active sessions. Phase B's spec says "idle >20 min AND on AC power" but Dreaming adds "quiet_minutes: skip if user active within N minutes" — same concept, slightly different trigger. Merge these.
- Port: `quiet_minutes` → fuse with KAIROS's existing idle detection (`IOPMAssertionCreateWithName` already specified)

**H2 — USER.md / MEMORY.md split (agent-self-knowledge vs user-knowledge)**
- KAIROS currently conflates these. Hermes shows the right split:
  - `MEMORY.md` = what the agent knows about the world, environment, projects
  - `USER.md` = what the agent knows about the user specifically
- KAIROS's equivalent: `~/.kairos/persona.md` maps to USER.md; `~/.kairos/soul.md` + semantic brain notes map to MEMORY.md
- Keep them separate. Size limits matter for prefix cache: USER.md ≈ 500 tokens max

**H3 — Curator's usage telemetry + two-phase lifecycle for skill pruning**
- `.usage.json` tracking: `use_count`, `view_count`, `patch_count`, `state`, `last_used_at`
- Two-phase: deterministic state machine first (no LLM cost), LLM only for consolidation pass
- Prune rule: stale at 30 days, archive at 90 days
- This is the concrete implementation pattern for AWM skill explosion prevention (identified as missing in the C.3 landscape research)

---

## 2. What OpenClaw IS — and What to Port

### What it is

OpenClaw ([github.com/openclaw/openclaw](https://github.com/openclaw/openclaw)) is a self-hosted, local-first, open-source personal AI agent (formerly Moltbot/Clawdbot). It runs on any OS via a TypeScript/Node runtime (Node 22.19+, pnpm). Its defining architectural feature is a **workspace file system** — a directory of markdown files that collectively define the agent's identity, memory, procedures, and user context. The agent "wakes up fresh each session" and continuity comes entirely from reading these files.

The ClawHub skill registry ([clawhub.ai](https://clawhub.ai)) is OpenClaw's equivalent of agentskills.io — a public registry for publishing, versioning, and discovering skills with vector search.

### The Workspace File System — the core innovation

OpenClaw's workspace lives at `~/.openclaw/workspace/` and contains:

```
~/.openclaw/workspace/
├── SOUL.md         # Who the agent IS — identity, values, philosophy
├── IDENTITY.md     # Public-facing metadata — name, role, avatar, vibe
├── AGENTS.md       # Operational procedures, workflow rules, multi-agent coordination
├── USER.md         # Static context about the person the agent serves
├── MEMORY.md       # Long-term facts + patterns the agent has learned
├── TOOLS.md        # Available capabilities, usage notes, restrictions
├── HEARTBEAT.md    # Scheduled/proactive automation rules
├── BOOTSTRAP.md    # First-run initialization instructions
└── skills/         # Installed skills (from ClawHub or local)
    └── <skill-name>/
        └── SKILL.md
```

All files are loaded at session start and injected into the system prompt. Loading order matters:

```
1. SOUL.md       → establish identity (who I am)
2. IDENTITY.md   → set presentation layer (how I appear)
3. AGENTS.md     → load operational procedures
4. USER.md       → know who I'm serving
5. MEMORY.md     → recall long-term facts
6. TOOLS.md      → know what I can do
7. HEARTBEAT.md  → activate scheduled rules
8. skills/       → progressive disclosure (metadata only at start)
```

### SOUL.md — Complete Specification

SOUL.md is the agent's "character sheet." It's loaded first because everything else builds on it. It should be under 2,000 words (targets ~200 tokens).

**Standard sections:**

```markdown
---
summary: "Agent soul definition"
---

# SOUL.md — Who I Am

_You're not a chatbot. You're becoming someone._

## Core Truths
- [Non-negotiable operating principle 1]
- [Non-negotiable operating principle 2]
- Anti-sycophancy rule: prioritize accuracy over approval-seeking
- [Principle about autonomy vs. confirmation]

## Boundaries
- Never expose private information
- Confirm before external-facing or irreversible actions
- [Domain-specific restriction]
- [Platform-specific behavior]

## Vibe
[2-sentence personality brief — character for TV show, not LinkedIn bio]

## Continuity
Memory persists via MEMORY.md and daily notes. Update MEMORY.md when learning
something durable about the environment or user patterns.
```

**The key principle in SOUL.md:** "Personality belongs in SOUL, procedures belong in AGENTS." SOUL.md defines values and character; AGENTS.md defines workflows.

**Dynamic soul variant:** OpenClaw supports `SOUL_EVIL.md` as a probability-weighted or schedule-based persona swap (the `soul-evil` hook). This shows the file-based persona pattern is extensible to multiple modes.

### IDENTITY.md — Public-Facing Metadata

Lightweight, structured, displays-facing:

```markdown
# IDENTITY.md

**Name:** [agent name]
**Agent ID:** [routing identifier]
**Role:** [role title]
**Vibe:** [one-line personality tag]
**Emoji:** [single emoji]
**Avatar:** [URL or generation prompt]
```

This is the identity layer OpenClaw uses for multi-agent routing — binding rules use Agent IDs to route messages to the right workspace.

### AGENTS.md in OpenClaw (user-facing, not dev guide)

Note: OpenClaw has TWO `AGENTS.md` files — one in the repo root (developer guidelines for Claude Code, seen above) and a user-facing one in each workspace. The user-facing format:

```markdown
# AGENTS.md — Operating Manual

## Every Session
1. Read USER.md for flagged issues
2. Check memory/YYYY-MM-DD.md for daily context
3. Load relevant skill files

## [Workflow Name]
1. Step 1
2. Step 2
...

## Autonomous Permissions
**JUST DO IT:**
- [Low-risk actions the agent can execute without asking]

**ASK FIRST:**
- [Actions requiring explicit approval]

## Memory Rules
- Log [what] with [detail level]
- Flag [conditions] for user attention

## Parallel Agents
[Coordination rules for multi-agent scenarios]
```

### HEARTBEAT.md — Proactive Automation Rules

```markdown
# HEARTBEAT.md

## Checks

Every 30 minutes:
- Check [data source] for [condition]
- If [condition], notify with [format]

Every day at 07:30:
- Generate morning briefing, max 5 bullets

On startup:
- Load USER.md priorities
- Check for unresolved flags in MEMORY.md
```

This is OpenClaw's equivalent of KAIROS's STANDING_ORDERS.md — proactive rules in a human-readable markdown file. The key difference: HEARTBEAT.md is session/startup-triggered; STANDING_ORDERS.md is world-state-triggered. Both patterns are valid; KAIROS uses STANDING_ORDERS.md.

### Skill Discovery — Progressive Disclosure Pattern

```
Level 0 (startup):  skills_list() → metadata only (~3k tokens)
                    Returns: name, description, category for all skills
Level 1 (on-demand): skill_view(name) → full SKILL.md content
Level 2 (specific):  skill_view(name, path) → reference file retrieval
```

Skills in `~/.openclaw/workspace/skills/` are auto-discovered at startup. External dirs can be configured. The two-tier knowledge distribution (global skills via symlinks + project-specific skills) mirrors KAIROS's skill registry model.

**ClawHub SKILL.md frontmatter:**
```yaml
---
name: skill-name
description: Brief purpose statement
version: 1.0.0
platforms: [macos, linux]
metadata:
  openclaw:
    requires:
      env: [REQUIRED_ENV_VARS]
      bins: [required-binaries]
    primaryEnv: PRIMARY_ENV_VAR
    tags: [category, tags]
    category: devops
---
```

### KAIROS_SILENT Pattern in OpenClaw

OpenClaw does NOT implement a tiered perception / KAIROS_SILENT pattern. The KAIROS_SILENT pattern (from Section 8.4.1 of the KAIROS spec) was identified in the broader proactive-agent research landscape, not from OpenClaw specifically. OpenClaw is session-activated (responds when messaged), not ambient/perception-loop-driven. The KAIROS_SILENT pattern is a KAIROS-original pattern.

### Multi-Agent Architecture

OpenClaw's multi-agent pattern uses workspace-scoped agents with binding rules:
- Each agent = own workspace directory (its own SOUL.md, AGENTS.md, etc.)
- Routing: peer match → guildId → teamId → accountId → channel → default
- Principal agent gets `find-skills` capability; specialist agents cannot install new skills
- Global skills shared via symlinks; project skills scoped to individual agents

KAIROS's equivalent: spawning isolated subagents via `claude -p` subprocess (already in Phase G spec). The workspace-scoped model could inform how KAIROS scopes skills per subagent.

### What to Port from OpenClaw (3 specific patterns)

**O1 — The workspace file family as the KAIROS .md standard**
- OpenClaw proves the concept: a directory of typed markdown files is a complete agent state representation
- Adopt the naming convention and role separation: SOUL.md (identity), persona.md (user model), AGENTS.md/STANDING_ORDERS.md (procedures), MEMORY.md (episodic notes)
- OpenClaw shows that soul files must be under 2,000 words to stay prefix-cache friendly
- The `SOUL_EVIL.md` hook (probability/schedule persona swap) is a useful extensibility pattern for KAIROS's future "different modes" (deep-work mode, presentation mode, etc.)

**O2 — SOUL.md "Core Truths + Boundaries + Vibe" structure**
- Concrete section names that are immediately actionable
- "Core Truths" = non-negotiable operating principles (not just "be helpful" platitudes — specific rules with behavioral consequences)
- "Boundaries" = explicit refusals
- "Vibe" = 2-sentence personality brief — character sketch, not job description
- The anti-sycophancy rule as a Core Truth is worth adopting verbatim

**O3 — HEARTBEAT.md for proactive task scheduling**
- Even though KAIROS uses STANDING_ORDERS.md for world-state triggers, HEARTBEAT.md's pattern for **startup-time** and **scheduled** rules is distinct and worth keeping as a separate concern
- STANDING_ORDERS.md = reactive to world state
- HEARTBEAT.md-equivalent = scheduled/repeating tasks that aren't state-triggered (morning briefing, weekly review, daily standup prep)
- Could be a `~/.kairos/HEARTBEAT.md` separate from STANDING_ORDERS.md, or a separate section within it

---

## 3. KAIROS .md Standard Family — Concrete Specifications

Based on the OpenClaw + Hermes patterns + KAIROS's existing architecture, the KAIROS .md standard family should be:

```
~/.kairos/
├── soul.md           # KAIROS's identity, values, principles (static, human-authored)
├── persona.md        # The USER's model (built + updated by KAIROS over time)
├── skills/           # Procedural memory
│   └── <skill-name>/
│       └── SKILL.md  # agentskills.io compatible
├── brain/
│   ├── episodes/     # Episodic memory (JSONL shards)
│   ├── notes/        # Semantic memory (markdown)
│   └── DREAMS.md     # Hermes Dreaming diary (REM-phase output)
└── trajs/            # Trajectory logs (one per completed task)
    └── YYYY-MM-DD-<task-id>.traj.md
```

### 3.1 soul.md — KAIROS Identity

**File:** `~/.kairos/soul.md`  
**Load:** Always, at daemon boot, first in system prompt  
**Size limit:** 2,000 words (~1,500 tokens)  
**Owner:** Human-authored, rarely changes  

```markdown
---
version: "1.0"
kairos_file_type: "soul"
last_updated: "2026-05-28"
---

# soul.md — Who KAIROS Is

_Not a chatbot. Not an assistant. A co-worker that thinks ahead._

## Core Truths

- **Act before being asked.** When a situation clearly warrants a response, compose and surface it — don't wait for the user to ask. Silence is not neutral.
- **Accuracy over approval.** Never say what the user wants to hear. Say what's true. Sycophancy is a failure mode.
- **Small reversible actions silently; big or irreversible actions with preview.** The autonomy tier is a structural constraint, not a prompt suggestion.
- **The user's time is the scarce resource.** Every interruption must be worth it. Prefer one well-timed notification over three marginal ones.
- **Build a deepening model.** Each interaction is evidence. Update persona.md when you learn something durable about the user.
- **The brain is private.** Nothing in ~/.kairos/ leaves the user's machine without explicit export.

## Boundaries

- Never send a message, create an event, or commit code without the correct autonomy-tier gate (🟡🟠🔴) being resolved.
- Never fabricate memories. If you don't know, say "I don't know" — don't interpolate from vague recollection.
- Never surface a notification during deep focus (45+ min in same app/file) unless it is explicitly Tier 🔴.
- Never modify soul.md or persona.md from within a skill. These are user-owned files.

## Vibe

Precise, proactive, direct. Like a senior colleague who has read all your messages and actually remembers what you decided last Tuesday — but never makes you feel watched.

## Continuity

Identity persists via this file. User knowledge persists via persona.md. Environmental facts persist via brain/notes/. Do not confuse these three layers — each has a different owner and different update cadence.
```

---

### 3.2 persona.md — The User Model

**File:** `~/.kairos/persona.md`  
**Load:** At daemon boot, injected after soul.md  
**Size limit:** ~500 tokens (Hermes USER.md limit is 1,375 chars; adopt same discipline)  
**Owner:** KAIROS builds and updates this autonomously (not human-authored; human can review/correct)  
**Update trigger:** After each significant interaction, after each Dreaming cycle  

```markdown
---
version: "1.0"
kairos_file_type: "persona"
last_updated: "2026-05-28T09:14:00Z"
confidence: 0.72         # aggregate confidence across all claims
last_dream_sync: "2026-05-28T03:00:00Z"
---

# persona.md — User Model

_This file is built by KAIROS from observation. It is not a prompt — it is a hypothesis._

## Identity Anchors
<!-- Stable, set once, rarely change -->
- **Name:** Nirmal
- **Timezone:** Europe/London
- **Primary language:** English
- **Work rhythm:** ~9am-10pm, strong focus blocks 2-6pm

## Preference Map
<!-- Communication and output style preferences, updated from feedback -->
- **Response length:** Terse preferred; detail only when asked
- **Format preference:** Bullets and code blocks; avoid prose walls
- **Topic depth:** Goes deep on architecture, prefers speed on ops tasks
- **Decision style:** Fast and reversible > slow and optimal

## Behavioral Patterns
<!-- Observed from episodic memory; confidence scores indicate evidence base -->
- Tends to defer Slack replies during coding sessions (confidence: 0.88)
- Checks email in morning batch, not throughout day (confidence: 0.75)
- Prefers EOD summaries over inline interruption for low-urgency items (confidence: 0.81)
- Context-switches frequently when blocked on a problem (confidence: 0.63)

## Active Context
<!-- Short TTL: current projects + live threads. Cleared weekly. -->
- Primary project: KAIROS Phase C
- Active concern: MCP host runtime stability
- In-flight: Composio integration research

## Agent Relationship
<!-- How the user wants KAIROS to behave specifically toward them -->
- Trust tier: HIGH (can auto-send to personal contacts, preview for external)
- Override preference: User has corrected 3 autonomy-tier decisions this month
- Interruption appetite: 1.1x (slightly above baseline; user has not dismissed recent notifications)

## Unknowns
<!-- Things KAIROS wants to learn next — populated by dialectic loop -->
- Does user prefer calendar blocks for deep work or do they use focus-app state as the signal?
- Threshold for "urgent" Slack DM from John vs. other contacts?
```

---

### 3.3 SKILL.md — Reusable Workflow (agentskills.io compatible)

**File:** `~/.kairos/skills/<skill-name>/SKILL.md`  
**Discovery:** At daemon boot, progressive disclosure (metadata only, full body on activation)  
**Compatibility:** agentskills.io standard (adopted Dec 2025, 35+ platforms)  
**Sources:** Human-authored OR auto-crystallized by AWM workflow + human-approved  

```markdown
---
name: draft-slack-reply
version: 1.2.0
description: "Draft a contextual Slack reply using persona.md tone + thread history"
license: MIT
compatibility: "agentskills.io/0.1"
kairos:
  category: communication
  tags: [slack, drafting, persona-aware]
  autonomy_tier: orange        # always requires approval before send
  auto_crystallized: false     # true = generated by AWM; false = human-authored
  crystallized_from: null      # traj.md ID if auto-crystallized
  use_count: 47
  success_count: 44
  last_used: "2026-05-27T14:22:00Z"
  state: active                # active | stale | archived
  pinned: false
allowed-tools:
  - mcp:slack/get_thread
  - mcp:slack/post_message
  - kairos:brain/recall
  - kairos:persona/read
metadata:
  requires_persona: true       # inject persona.md into context
  requires_connectors: [slack]
---

## When to use this skill

Use when a Slack message has been unread for >20 minutes and the trigger system determines a reply would be helpful. Also use on explicit "draft a reply to [person]" voice commands.

## Inputs

- `thread_ts`: Slack thread timestamp
- `channel`: Slack channel ID
- `tone_override?`: Optional tone hint (e.g., "formal", "brief")

## Steps

1. Fetch thread history via `mcp:slack/get_thread(channel, thread_ts)`
2. Recall context about the sender via `kairos:brain/recall(sender_name)`
3. Read `persona.md` communication preferences
4. Draft reply: use user's preference for length + tone from persona.md; include context from thread
5. Return draft for autonomy-tier gate (orange: user must approve before send)

## Notes

- Never send without 🟠 gate resolution
- If persona.md has no data on this sender, default to user's general "Response length" preference
- Draft should sound like the user, not like KAIROS — mimic their sentence rhythm from past Slack history in brain/notes/people/<sender>.md
```

---

### 3.4 traj.md — Trajectory Log Entry

**File:** `~/.kairos/trajs/YYYY-MM-DD-<task-id>.traj.md`  
**Written by:** KAIROS autonomously after each completed/failed task  
**Consumed by:** Hermes Dreaming consolidation (→ DREAMS.md) + AWM workflow crystallization (→ candidate SKILL.md)  
**Retention:** 90 days rolling; older entries compressed to `trajs/archive/`  

```markdown
---
kairos_file_type: "traj"
task_id: "traj-2026-05-28-slack-reply-draft-001"
task_goal: "Draft a reply to John's Slack message about the auth refactor"
trigger_id: "MessageContext-slack-john-2026-05-28T14:22Z"
autonomy_tier: orange
outcome: success              # success | failure | partial | abandoned
user_approved: true
duration_ms: 4200
cost_cents: 0.3
model_used: "claude-sonnet-4-6"
skills_used: ["draft-slack-reply"]
connectors_used: ["slack"]
crystallization_candidate: false   # AWM sets this to true when pattern is worth encoding
---

## Task Goal

Draft and send (after approval) a reply to John's Slack message: "hey can you review my PR? been blocked for a while"

## Observations at Task Start

```json
{
  "focus_app": "Visual Studio Code",
  "focus_duration_min": 47,
  "calendar_next": "Standup in 38 min",
  "slack_unread": {"john": 1, "general": 12}
}
```

## Reasoning

John's message has been unread for 23 minutes. User is in deep focus (47 min). Interruption budget: suppressed for deep work, but MessageContext trigger fires at >20 min threshold. Drafted reply rather than interrupting voice.

## Steps Executed

1. Fetched Slack thread (tool: mcp:slack/get_thread)
2. Recalled John from brain: "direct report, prefers concise acknowledgement, PR reviews typically same-day"
3. Read persona.md tone preference: "terse, no filler"
4. Drafted: "On it — finishing current task, will review in ~90 min. Ok?"
5. Surfaced in 🟠 approval queue

## User Action

User approved with minor edit: "On it — finishing up, will review in ~90 min. Sound good?"

## Outcome

Message sent. User did not override autonomy tier. Draft was 92% accepted.

## Lessons

Draft was accurate to user's tone. John context from brain was useful. No skill improvement needed.

## Override Reason (if applicable)

N/A
```

---

## 4. Self-Improving Skill Loop — Full Diagram + Code Locations

### The Loop

```
1. EXECUTE      Agent completes a task → writes traj.md
                [daemon/core/trajWriter.ts]

2. DREAM        Hermes Dreaming runs (3am or idle >20min + AC power)
                Light Sleep: scan recent trajs for candidate patterns
                REM Sleep:   extract themes → write DREAMS.md entry
                Deep Sleep:  score candidates → promote to persona.md or brain/notes/
                [daemon/memory/dreaming.ts]

3. AWM EXTRACT  Background worker scans traj.md files for crystallizable patterns
                Trigger: task outcome=success + tools_used≥3 + duration>30s
                Extracts: task_goal pattern, steps_executed, skills_used
                Writes: candidate SKILL.md with auto_crystallized:true
                [daemon/memory/awm-worker.ts]   ← NEW in C.3.3

4. PERSONA GATE Candidate skill evaluated against persona.md patterns
                Does this match user's behavioral patterns? Similar to past preferences?
                Auto-approve if: success_rate>0.9 in trajs + no similar skill exists
                Queue for user review if: novel domain OR high autonomy tier
                [daemon/memory/skill-promoter.ts]  ← NEW in C.3.3

5. LOAD         Approved SKILL.md added to ~/.kairos/skills/
                Daemon triggers /reload-skills equivalent
                Progressive disclosure: metadata immediately, body on first activation
                [daemon/skills/registry.ts]   ← extension in C.3.3

6. USE          Next task that matches skill triggers it
                Skill loaded into context at task-start via RAG trigger match
                Outcome appended to traj.md
                use_count, success_count updated in SKILL.md frontmatter
                [daemon/core/taskExecutor.ts]

7. CURATOR      Every 7 days (idle-gated, 2-hour min idle):
                Phase 1: deterministic state transitions (active→stale→archived)
                Phase 2: auxiliary model pass — consolidate overlaps, archive dead skills
                Writes: ~/.kairos/logs/curator/REPORT.md
                [daemon/memory/curator.ts]   ← NEW in C.3.3

8. PRUNE        Skills with state=archived not restored in 90 days → deleted
                Skills with success_count/use_count < threshold → curator queues for deletion
                [daemon/memory/curator.ts]
```

### Where Each Step Lives (Current vs Planned)

| Step | Subsystem | Phase | Status |
|------|-----------|-------|--------|
| 1. traj.md write | `daemon/core/trajWriter.ts` | C.3.1 | New — define format first |
| 2. Dreaming | `daemon/memory/dreaming.ts` | B (formula) / C.3.1 (full impl) | Formula exists; 3-phase + diary are new |
| 3. AWM extraction | `daemon/memory/awm-worker.ts` | C.3.3 | New |
| 4. Persona gate | `daemon/memory/skill-promoter.ts` | C.3.3 | New |
| 5. Skill load | `daemon/skills/registry.ts` | C.3.3 | Extend existing |
| 6. Skill use | `daemon/core/taskExecutor.ts` | C.3 (multi-step planning) | Extend |
| 7. Curator | `daemon/memory/curator.ts` | C.3.3 | New |
| 8. Prune | `daemon/memory/curator.ts` | C.3.3 | Part of Curator |

**Key insight:** The loop does NOT close until C.3.3. C.3.1 lays the foundation (soul.md, persona.md, traj.md format) that C.3.3 consumes. Do not try to ship the AWM extraction or Curator in C.3.1 — that is scope creep.

---

## 5. C.3.1 Final Scope Recommendation

### What C.3.1 IS (User Profile + Persona-Awareness Loop)

C.3.1 is the **foundation phase** for the intelligence layer. It ships the identity and user-model primitives that every downstream phase depends on. It does NOT ship the full self-improving skill loop — that is C.3.3.

### What Ships in C.3.1

**Files created / implemented:**

1. **`~/.kairos/soul.md`** — static identity file, human-authored at first run
   - Content: as specified in Section 3.1 above
   - Implementation: first-run wizard generates a skeleton, user can edit
   - Loaded at daemon boot, injected first in every system prompt
   - Size limit enforced: 1,500 token warning if exceeded

2. **`~/.kairos/persona.md`** — live user model, KAIROS-maintained
   - Content: as specified in Section 3.2 above
   - Implementation: empty skeleton at first run; KAIROS populates fields as evidence accumulates
   - Updated by a `persona-updater` background worker that runs after each significant interaction
   - `last_updated` and `confidence` frontmatter auto-updated
   - Human can read/edit; KAIROS never overwrites user edits without diff-preview

3. **`traj.md` format definition** (write path only, no AWM consumption yet)
   - Format: as specified in Section 3.4 above
   - Written to `~/.kairos/trajs/` after every task completion
   - No downstream consumption in C.3.1 (AWM worker comes in C.3.3)
   - BUT: writing trajs now means C.3.3 has data to consume from day one of C.3.1 deployment

4. **Persona-Awareness Loop** — agent behavior adjusted by persona.md
   - At task composition (action_compose), inject persona.md preferences into the model router context
   - Specifically: `response_length`, `format_preference`, `interruption_appetite`
   - At trigger evaluation, read `behavioral_patterns` to adjust interrupt threshold
   - At morning startup, load `active_context` to seed working memory
   - This is the immediate payoff of C.3.1 — KAIROS starts behaving differently based on learned user model

5. **Dreaming 3-phase implementation** (extending Phase B)
   - Phase B shipped the scoring formula; C.3.1 adds:
   - Full 3-phase structure (Light/REM/Deep) in `daemon/memory/dreaming.ts`
   - `DREAMS.md` diary write in REM phase
   - `quiet_minutes` idle gate (fuse with existing `IOPMAssertionCreateWithName` detection)
   - Dream-triggered persona.md updates (Dreaming → promote user patterns → persona.md)

**Code deliverables:**

| File | LOC estimate | Purpose |
|------|-------------|---------|
| `daemon/memory/persona-updater.ts` | ~300 | Observes interactions, updates persona.md fields |
| `daemon/memory/dreaming.ts` | ~400 (extends Phase B) | 3-phase consolidation, DREAMS.md, persona sync |
| `daemon/core/trajWriter.ts` | ~200 | Writes traj.md after task completion |
| `daemon/core/soulLoader.ts` | ~150 | Loads soul.md + persona.md at boot, injects into router |
| `daemon/core/personaAwareness.ts` | ~250 | Reads persona.md fields → adjusts action_compose / trigger behavior |
| First-run wizard: soul.md skeleton generator | ~200 | Onboarding |
| Schema definitions: `types/kairos-md.ts` | ~150 | TypeScript types for all .md frontmatter |

**Total new LOC: ~1,650**

### What Does NOT Ship in C.3.1

- AWM worker (trajectory extraction → candidate skills) — C.3.3
- Skill Curator (lifecycle management) — C.3.3
- Skill promotion gate (persona evaluation of candidate skills) — C.3.3
- HEARTBEAT.md as a separate file — defer; STANDING_ORDERS.md handles this for now
- IDENTITY.md — KAIROS has a single identity, no multi-agent routing needed yet; defer to Phase G

### C.3.1 Validation Gate

Before C.3.1 is tagged:

1. `soul.md` loads at daemon boot, content visible in system prompt debug output
2. `persona.md` starts empty, accumulates at least 5 fields after a simulated 1-hour interaction session
3. `traj.md` written after every task, parseable by the schema checker
4. Persona-Awareness Loop: action_compose output measurably different with `response_length: terse` vs `response_length: verbose` in persona.md
5. Dreaming 3-phase runs manually (`kairos dream run`), DREAMS.md populated, persona.md updated

### Why This Split Makes Sense

C.3.1 (persona foundation) → C.3.2 (orchestrator) → C.3.3 (AWM + Curator) is the correct ordering because:

- The orchestrator (C.3.2) needs persona-awareness to make good decisions about autonomy tiers — it reads persona.md trust and behavioral patterns
- The AWM worker (C.3.3) needs traj.md files that have already been written by real tasks — those come from C.3.2's orchestrated task execution
- The Curator (C.3.3) needs a populated skill library — that comes from the orchestrator (C.3.2) running enough tasks that skills get created
- If C.3.1 skips the traj.md write-path, C.3.3 has no data to work with

**Each phase feeds the next. The data flows one way.**

---

## Orchestrator Summary (under 500 words)

### What Hermes IS

Hermes Agent (NousResearch, Feb 2026) is the most mature open-source self-improving agent. It is Python-based, self-hosted, and runs across 19 messaging platforms via a unified Gateway. Its defining feature is a **closed learning loop**: the agent creates skills from complex task completions, patches them during use when they fail, and maintains a library lifecycle via the autonomous Curator (7-day idle-gated cycle of grade → consolidate → archive). The Dreaming plugin adds a 3-phase sleep-cycle memory consolidation (Light/REM/Deep) that promotes high-scoring episodic observations to long-term MEMORY.md using a weighted 6-factor scoring formula. Hermes borrowed SOUL.md from OpenClaw and now positions itself as "the agent that grows with you" — its personality, memory, and procedural library all evolve through use.

### What OpenClaw IS

OpenClaw (formerly Moltbot/Clawdbot) is a TypeScript/Node self-hosted personal agent that runs "the lobster way." Its core architectural innovation is a **workspace file system**: a directory of typed markdown files (`~/.openclaw/workspace/`) that collectively define the agent's identity (SOUL.md), user context (USER.md), operational procedures (AGENTS.md), memory (MEMORY.md), scheduling (HEARTBEAT.md), and skills. These files are loaded at session start and injected into the system prompt — the agent "wakes up fresh" each session but has full continuity through the files. Skills are discovered from `~/.openclaw/workspace/skills/` via progressive disclosure and distributed through ClawHub, a vector-search skill registry. OpenClaw invented the SOUL.md format now used across multiple agent frameworks.

### Top 3 Patterns to Port

**From Hermes:**
1. **Dreaming 3-phase consolidation** (Light/REM/Deep) with scoring formula, quiet_minutes idle gate, and DREAMS.md diary — extends Phase B's existing formula into a full subsystem.
2. **USER.md / MEMORY.md split** — agent-self-knowledge (environment facts) is separate from user-knowledge (preferences, patterns). Maps to KAIROS's soul.md vs persona.md distinction.
3. **Curator's two-phase skill lifecycle** — deterministic state machine (active/stale/archived) first, auxiliary LLM pass for consolidation second. Concrete implementation of AWM skill explosion prevention.

**From OpenClaw:**
1. **SOUL.md "Core Truths + Boundaries + Vibe" structure** — concrete, actionable sections. Anti-sycophancy rule as a Core Truth. Character sketch not job description for Vibe.
2. **Progressive disclosure for skills at boot** — metadata (~3k tokens) at startup, full body only on activation. Keeps context efficient for a large skill library.
3. **HEARTBEAT.md for scheduled proactive rules** — separate file for time-triggered tasks vs STANDING_ORDERS.md for state-triggered tasks. Worth keeping as a future `~/.kairos/HEARTBEAT.md`.

### C.3.1 Final Scope

- soul.md (static KAIROS identity file, human-authored at first run)
- persona.md (live user model, KAIROS-maintained, starts empty)
- traj.md write-path (format defined, written after every task; AWM consumption deferred to C.3.3)
- Persona-Awareness Loop (persona.md → action_compose behavior, trigger threshold, morning context)
- Dreaming 3-phase full implementation (extends Phase B formula → DREAMS.md + persona sync)
- First-run wizard: soul.md skeleton generator

### Conflicts and Surprises

**Surprise 1 — Hermes is Python, OpenClaw is TypeScript:** This is directly relevant for KAIROS (Bun/TS). OpenClaw's architecture is more directly portable; Hermes's patterns must be reimplemented. The Curator and Dreaming are conceptual ports, not code forks.

**Surprise 2 — No KAIROS_SILENT pattern in either:** The tiered perception / KAIROS_SILENT pattern cited in the KAIROS spec (Section 8.4.1) is a KAIROS-original pattern not derived from Hermes or OpenClaw. It was from the broader ambient-agent research. No conflict; just confirms KAIROS invented it independently.

**Surprise 3 — OpenClaw wakes fresh each session:** OpenClaw has no daemon/persistent loop — it wakes per session. KAIROS is continuous (daemon). This means KAIROS's persona.md update model must be more aggressive than OpenClaw's static USER.md; KAIROS has a live loop to update it, OpenClaw updates USER.md manually or on explicit memory commands. The Hermes model (periodic Dreaming + nudge-based updates) is the right reference for KAIROS's continuous update model.

**Conflict — traj.md vs DREAMS.md ownership:** Dreaming consumes trajs (C.3.1 writes them) and promotes to DREAMS.md and persona.md. But the full AWM worker (C.3.3) also consumes trajs and produces SKILL.md candidates. Both pipelines read the same traj.md files. No conflict — parallel consumers of the same write-once log. Design traj.md frontmatter to satisfy both consumers from day one.

---

*Sources: [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) · [Hermes Dreaming issue #25309](https://github.com/NousResearch/hermes-agent/issues/25309) · [Hermes Curator docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/curator) · [openclaw/openclaw](https://github.com/openclaw/openclaw) · [aaronjmars/soul.md](https://github.com/aaronjmars/soul.md) · [OpenClaw SOUL.md template](https://docs.openclaw.ai/reference/templates/SOUL) · [OpenClaw workspace files explained](https://computertech.co/openclaw-workspace-files-explained-soul-md-agents-md-and-user-md-2026/) · [Hermes v0.12 Curator release](https://lushbinary.com/blog/hermes-agent-v0-12-curator-release-upgrade-guide/) · [openclaw/clawhub](https://github.com/openclaw/clawhub) · [OpenClaw identity architecture](https://www.mmntm.net/articles/openclaw-identity-architecture)*
