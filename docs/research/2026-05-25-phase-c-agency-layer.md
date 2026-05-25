# Phase C Agency Layer — Research for KAIROS
Date: 2026-05-25

---

## Executive Summary

**State of the art:** The agency layer — the gap between "perception promoted an event" and "something meaningful happened in the world" — is where nearly every proactive agent project collapses. Three things that now exist in production that did not exist 18 months ago: (1) MCP has become the de-facto connector protocol with 20,000+ indexed servers across mcp.so, Smithery, and the official registry, meaning KAIROS's connector problem is largely solved without writing OAuth flows; (2) LangGraph's "ambient agents" design with first-class persistence, interrupt, and cron primitives gives a reference architecture for event-driven background planning that's production-grade and battle-tested; and (3) the Agent Skills open standard (originated by Anthropic, now adopted by 35+ coding agents including OpenHands, Goose, Letta, Cursor, Gemini CLI) provides a portable, runtime-loadable skill format that KAIROS can adopt verbatim, giving instant access to a growing community skill marketplace.

**What we can steal:** AWM (Agent Workflow Memory, ICML 2025) is the most actionable research for behavior crystallization — it demonstrates that a small LLM can scan past successful trajectories and extract parameterized, reusable workflows with a 51% relative improvement on WebArena. UFO2 (Microsoft Research, April 2025) shows that structured experience logs (task description + action sequence + screenshots + outcome) can be mined offline to produce reusable In-Context Learning examples that improve future task fidelity — this is the "tell me again, crystallize the rule" pattern at production scale. On the multi-step planning side, Magentic-One's dual-ledger orchestrator (task ledger + progress ledger, outer re-plan loop + inner execution loop) is the cleanest published architecture for chaining heterogeneous agents while handling partial failures without halting.

**Biggest "bet big" recommendation:** KAIROS should not build its own connector layer. Instead, Phase C ships an MCP host runtime embedded in the daemon that can dynamically discover, install (via Smithery CLI or `.mcpb` bundle), and invoke any MCP server at runtime. Paired with an AWM-style workflow crystallizer and LangGraph's ambient agent persistence model, KAIROS becomes an agent that connects to everything, composes multi-step plans, and learns from its own history — without hand-coding a single OAuth flow. The ceiling here is genuinely "unlimited connectors"; the floor is shipping faster by reusing 20,000+ community-maintained servers on day one.

---

## 1. MCP Ecosystem as Unlimited Connectors

### Scale of the ecosystem

As of May 2026, three major registries collectively index over 20,000 public MCP servers:

- **mcp.so** — ~20,222 servers, largest by raw count, functions as a general index
- **Smithery** — 7,000+ servers, developer-facing, install-count ranking provides quality signal
- **Official MCP Registry** (registry.modelcontextprotocol.io) — Anthropic-maintained, recently-updated filter, API endpoints for production/staging/local

An analysis in March 2026 counted 2,300 uniquely maintained public servers. The headline categories with production-grade community servers: GitHub (official: `github/github-mcp-server`), Slack, Notion, Linear, PostgreSQL, Stripe, Gmail/Google Workspace, Jira, Confluence, Figma, Airtable, Shopify, HubSpot, Discord, Twilio, Datadog, PagerDuty, and dozens more. The practical implication: any SaaS service KAIROS's user cares about almost certainly already has an MCP server. KAIROS does not need to build OAuth flows for Phase C or D.

### Dynamic discovery and programmatic installation

**Smithery CLI** (`@smithery/cli`, `github.com/smithery-ai/cli`) is the most mature option:

```bash
smithery mcp search "github"           # search registry
smithery mcp add https://server.smithery.ai/github  # install by URL
smithery mcp list                       # enumerate active
smithery auth token --policy '{...}'   # mint scoped service tokens
```

The CLI is designed for human use today, but the command surface is thin enough to shell-invoke from a daemon. KAIROS's MCP host manager can wrap the CLI: on a trigger match that requires a connector not yet loaded, spawn `smithery mcp search` + `smithery mcp add` as a setup sub-flow, then invoke the newly installed server's tools. This is dynamic connector acquisition at runtime.

**Desktop Extensions (`.mcpb` format)** — Anthropic open-sourced the `.mcpb` specification (a ZIP archive: `manifest.json` + `server/` + bundled dependencies + optional icon). The `mcpb` CLI produces installable bundles. This format is already supported by Claude Desktop and is designed for distribution. KAIROS can package its own bespoke connectors (e.g., macOS Contacts, Calendar, Reminders, Apple Notes) as `.mcpb` bundles and hot-install them on first launch alongside community servers for everything else.

### Auth per server

The ecosystem has converged on two models: **API key** (simplest, 53% of servers use static keys) and **OAuth 2.1** (preferred for enterprise, now supports Dynamic Client Registration so agents can register themselves automatically without manual app setup). KAIROS's auth manager needs three primitives: keychain storage (already on macOS via `Security.framework`), env-var injection at MCP server spawn time, and a one-time OAuth flow UX surfaced in the HUD glass panel. After initial setup, all credentials live in the OS keychain — never in plaintext files.

### OSS MCP host libraries

The protocol itself is thin (JSON-RPC 2.0 over stdio/SSE/HTTP). Available host SDKs:

- **`@modelcontextprotocol/sdk`** (TypeScript, official) — the reference implementation; KAIROS's Node daemon can import this directly
- **`mcp` Python SDK** (official) — if KAIROS uses a Python runtime layer
- **fast-agent** (`github.com/evalstate/fast-agent`) — lightweight Python framework that speaks MCP natively, supports composing multi-server workflows in ~10 lines

The recommendation is to build KAIROS's MCP host on top of the official TypeScript SDK rather than forking: Anthropic maintains backward compatibility and the SDK is already used in production by Claude Desktop and Claude Code.

### Production agents already doing "unlimited connectors" via MCP

Claude Code is the best-known example — it wires itself to GitHub, linear, Supabase, and dozens of other services via MCP at the user's discretion. The pattern Claude Code uses (config-file enumeration of MCP servers at startup, lazy invocation when tools are needed) is directly portable to KAIROS. The difference KAIROS needs is *dynamic acquisition* (install-on-need during a triggered action) rather than *static configuration* (user manually lists servers before first use).

---

## 2. Multi-Step Planning Patterns

### Framework landscape (2026 production status)

The three dominant orchestration frameworks have diverged into distinct architectural niches:

| Framework | Stars | Architecture | Failure recovery | Ambient/background fit |
|-----------|-------|-------------|-----------------|----------------------|
| **LangGraph** | ~50k | Directed graph, explicit state machine | Node-level retry, graph checkpointing, human-interrupt at any edge | Excellent — first-class cron, persistence, interrupt primitives |
| **CrewAI** | ~35k | Role-based crew + Flows (event-driven pipeline mode) | `@persist` decorator + manual replay; no auto-recovery | Moderate — Flows handle events but failure detection is manual |
| **AutoGen / AG2** | ~45k | Conversation-driven multi-agent; Magentic-One adds orchestrator layer | Dual-ledger re-plan on failure | Good — Magentic-One's outer loop handles backtracking |

LangGraph reached v1.0 in late 2025 and is the de facto runtime for LangChain's production agents. Benchmark: LangGraph completes 62% of 8+-step complex tasks (vs CrewAI 54%, AutoGen 58%).

### LangGraph ambient agents — the reference architecture

LangChain published an "ambient agents" blog post that defines the pattern KAIROS should build. Key properties:

1. **Event-stream activation** — agent listens to an event bus, fires per event rather than on prompt. No "what do you want to do?" handshake.
2. **Persistent state across events** — LangGraph's persistence layer serializes graph state between runs; agent can "remember" it started a draft reply three events ago
3. **Three human-in-the-loop modes** — Notify (surface info, no action needed), Question (need input before proceeding), Review (require approval before executing). This maps directly onto KAIROS's 🟢/🟡/🟠/🔴 autonomy tiers.
4. **Cron jobs as fallback** — LangGraph Platform includes built-in cron scheduling for sweep tasks (e.g., "check if any standing orders weren't triggered by events this hour")
5. **Long-term memory** — namespaced key-value store with semantic search, persistent across graph executions

The "email ambient agent" reference implementation is the closest published OSS to what KAIROS's Slack/Gmail observer + action composer needs to be: cron-checks inbox, processes events, surfaces items needing human decisions via a ticketing UI, waits for async human response, then continues. KAIROS's glass HUD is that "ticketing UI."

### Magentic-One dual-ledger orchestrator

For complex multi-step plans (e.g., "read Slack DM → check calendar → draft reply → schedule follow-up"), the Magentic-One orchestrator architecture (arXiv:2411.04468, Microsoft Research) is the best published solution:

- **Task ledger** (outer loop): facts, guesses, high-level plan. LLM updates this when the plan needs to change.
- **Progress ledger** (inner loop): current step, which agent is assigned, what happened. Tracks granular execution.
- **Outer loop re-plans** if the inner loop reports failure or unexpected state — no halting on errors.
- **Agents as workers**: WebSurfer, FileSurfer, Coder, Executor are specialist sub-agents dispatched by the orchestrator. KAIROS's equivalents: SlackAgent, CalendarAgent, DraftAgent, MCPAgent (generic tool-caller).

AutoGen v0.4's layered abstraction (core message-passing runtime → AgentChat conversational agents → Magentic-One applications) means KAIROS can use just the core runtime for event dispatching while implementing its own orchestrator logic on top — no need to adopt the full Magentic-One agent definitions.

### smolagents CodeAgent for compact action composition

For single-step and short-chain actions (most of KAIROS's trigger-to-act flows), smolagents' CodeAgent pattern is compelling: the LLM writes Python code snippets that call tools, rather than emitting a JSON tool-call dictionary. This uses 30% fewer LLM steps vs tool-calling because the model can compose tool calls in loops, conditionals, and variable bindings within a single code block. For KAIROS, this means a triggered action like "check if the meeting John mentioned conflicts with my 3pm" can resolve in one LLM turn instead of three.

### Failure and partial completion

The shared pattern across frameworks: **checkpoint before each irreversible action, retry idempotent steps, escalate to human on non-idempotent failure.** KAIROS must track action state in SQLite (`action_log` table: action_id, trigger_id, step_index, status, result, timestamp). On daemon restart, incomplete actions resume from last checkpoint. Irreversible actions that failed (e.g., message send failed mid-flow) surface in the HUD for human resolution rather than silent retry.

---

## 3. Skill Composition + Marketplaces

### agentskills.io — confirmed real, Anthropic-originated

The Agent Skills standard is real, production-deployed, and significant. Key facts:

- **Origin**: Developed by Anthropic, released as an open standard
- **Adoption**: 35+ coding agents as of May 2026, including Cursor, GitHub Copilot, VS Code, Claude Code, OpenHands, Goose (Block), Letta, Gemini CLI, fast-agent, OpenCode (SST), Spring AI, Roo Code, and more
- **Format**: A folder containing `SKILL.md` (required) + optional `scripts/`, `references/`, `assets/` directories. `SKILL.md` has YAML frontmatter (`name`, `description`) and markdown instructions.
- **Progressive disclosure**: Agents load only `name + description` at startup (~minimal context), then load full `SKILL.md` when a task matches, then execute bundled scripts if needed. A large skill library has a near-zero startup context cost.

This format is directly applicable to KAIROS. Each KAIROS capability (draft Slack reply in user voice, check calendar conflict, set reminder, update Linear ticket) becomes a skill folder. The trigger engine pattern (`TRIGGER.md` alongside `SKILL.md` per the existing KAIROS spec) extends the standard cleanly without breaking compatibility.

### Skill marketplace ecosystem (May 2026)

Multiple registries index Agent Skills:

- **SkillsMP** — 800,000+ skills scraped from public GitHub repos (minimal curation)
- **skills.sh** (Vercel-backed, launched Jan 2026) — npm-style versioning, `npx skills add <name>` installation, semver
- **`block/agent-skills`** (`github.com/block/agent-skills`) — Block's curated marketplace, integrates with Goose
- **`skillmatic-ai/awesome-agent-skills`** — community curated list of high-quality skills

The MCP-powered distribution model is particularly useful for KAIROS: a skills marketplace can expose itself as an MCP server, letting KAIROS search the live catalog and download skills on demand — no version pinning, no manual updates.

### Cross-skill composition

The standard allows skills to call other skills (skill A's `SKILL.md` can instruct the agent to load skill B for a sub-step). KAIROS's orchestrator layer handles this naturally: if a triggered action requires a `draft-reply` skill that in turn needs a `fetch-thread-context` skill, the agent loads both progressively. The key requirement is that KAIROS's skill loader resolves dependencies at activation time, not at startup — matching the Agent Skills progressive disclosure model exactly.

### Versioning and sandboxing

- **Versioning**: `SKILL.md` frontmatter supports a `version` field; skills.sh enforces semver. KAIROS's skill manager should store `(name, version, source_url, installed_at, last_used)` in SQLite and auto-upgrade on major-version stability.
- **Sandboxing**: Skills that execute code (`scripts/` subdirectory) need a sandbox boundary. The Agent Skills spec leaves this to the host. KAIROS should use macOS sandbox profiles (`.sb` files) or, for heavier execution, an E2B-style Docker sandbox for risky skill scripts. For KAIROS's most common use (markdown instruction skills that call MCP tools), sandboxing is the MCP server's responsibility — the skill itself is just text.

### Dynamic skill loading at runtime

Goose (`block/goose`) demonstrates runtime skill discovery via `mcp-skillset` (a MCP server that exposes a skill catalog with vector-search): the agent queries it mid-task, gets a skill recommendation, and loads it on the fly. KAIROS should implement the same: a local `kairos-skill-index` MCP server backed by a skills SQLite table with embeddings. When the trigger engine fires and no existing skill exactly matches, the MCP server searches the catalog and proposes installation.

---

## 4. Behavior Cloning from Observation

### The core opportunity

KAIROS observes the user continuously (Phase A + B). Every time the user manually does something that could have been delegated — types a reply in Slack, moves a file, dismisses a notification, creates a calendar event — that is a training signal. The question is how to harvest it.

### Agent Workflow Memory (AWM) — ICML 2025

**Paper**: "Agent Workflow Memory" (arXiv:2409.07429), accepted ICML 2025.
**What it does**: After successful task completions, an LLM scans the action trajectory and induces a parameterized, reusable workflow. Concrete example: the agent completes several "search for a product and add to cart" tasks. AWM extracts a generalized workflow with placeholder variables (`{product-name}`, `{quantity}`) that applies to any future product search. Workflows are stored as (description + trajectory with placeholders) and retrieved by semantic similarity at task time.

**Two modes**:
- *Offline*: mine training examples beforehand, produce a workflow library before deployment
- *Online*: after each successful runtime execution, run induction on the trajectory, add to library immediately

**Results**: 51.1% relative improvement on WebArena, 24.6% on Mind2Web step-success rate. These are not marginal gains.

**For KAIROS**: Every time KAIROS successfully executes a triggered action (and the user confirms or doesn't override), the `action_log` trajectory gets passed to the AWM inducer running in a background worker. If a new reusable workflow is extracted, it's stored in `procedural_memory` (already in KAIROS's Phase B schema) as a new skill candidate. The user sees: "I noticed you do X when Y happens — want me to add this as a standing order?" This is the crystallization UX.

### UFO2 Desktop AgentOS — In-Context Learning from execution history

**Paper**: "UFO2: The Desktop AgentOS" (arXiv:2504.14603, Microsoft Research, April 2025).
**GitHub**: `github.com/microsoft/UFO` (active, 3,000+ stars, now UFO3 in development)

UFO2's "ExperienceFlow" mechanism (as described in the research summary): each automation run produces structured logs — natural language task description + executed action sequence + application screenshots + outcome. A background summarization module mines these offline and distills successful trajectories into reusable Example records. When a similar task is encountered, the AppAgent retrieves relevant demonstrations via In-Context Learning and improves execution fidelity.

The key innovation KAIROS should steal: **structured trajectory format**. Don't just log "user clicked X then Y." Log: `{task_goal: string, steps: [{observation: string, reasoning: string, action: string, result: string}], outcome: "success"|"failure"|"user_override", override_reason?: string}`. This structured log is directly usable by both AWM-style induction and In-Context Learning retrieval.

### "Tell me again, crystallize the rule" UX pattern

No single OSS project ships this UX well, but the pattern exists across three systems:

1. **ProactiveAgent** (thunlp, covered in prior research) — user accept/reject/ignore feeds back to reduce similar suggestions. This is the negative crystallization path.
2. **UFO2 ExperienceFlow** — positive crystallization: successful run → distill → reuse.
3. **LangGraph long-term memory** — namespaced key-value with semantic search; the agent can write `{user: "nirmal", preference: "always defer Slack replies from vendor X until EOD"}` and retrieve it on future triggers.

The KAIROS-specific design: after any action the user confirms or executes manually while KAIROS was watching, KAIROS says (via the HUD or voice): "Want me to do this automatically next time?" Accept → AWM inducer runs → skill candidate created → added to standing orders after user review. This is "crystallization on confirmation."

### Privacy architecture for behavior cloning

The OSS research on privacy here converges on three principles:

1. **On-device only**: trajectory logs and induced workflows never leave the device. No cloud sync of raw behavior logs. KAIROS is already private by architecture.
2. **Explicit opt-in per skill**: each crystallized workflow shows the user what was observed and what the proposed trigger+action is. No silent rule creation.
3. **Retention policy**: raw trajectories age out (e.g., 30-day rolling window); only the abstracted workflow survives. This limits the blast radius of a compromise and reduces storage.

The federated learning / differential privacy literature (2025 papers from MDPI, Nature) applies to cloud-trained models — not relevant for KAIROS's local-only approach. KAIROS's privacy story is simpler and stronger: the crystallizer runs entirely on the device with no telemetry.

---

## Anti-Patterns

### 1. The chat-wrapper: fake event-driven

Many "proactive agents" (Zapier AI, n8n AI nodes, Make.com AI steps) are chat interfaces with a webhook trigger. The event fires, a prompt is constructed, the LLM responds, done. There is no persistent state, no multi-step planning, no memory of the previous 50 triggers. The LLM response is the agent. KAIROS must not become this: every trigger must have access to the full memory stack and prior action log, not just the raw event.

### 2. The cron-loop: fake real-time

Polling every 30 seconds and calling it "monitoring" is not event-driven proactivity. Screenpipe's pipe system and OpenClaw's heartbeat are both technically cron-loops despite having compelling proactivity stories. For KAIROS Phase C, the trigger engine must consume from the event bus in real time, not poll it. The correct primitive: an SQLite `NOTIFY`-equivalent (WAL mode + inotify/FSEvents on the events table) that wakes the trigger evaluator immediately on new rows.

### 3. The hardcoded trigger list: fake intelligence

If Phase C ships a fixed set of 20 trigger rules ("if Slack message arrives AND sender is VIP THEN notify"), KAIROS is a rule engine wearing an LLM costume. Real intelligence means the trigger engine can generalize: the LLM should be able to match a trigger rule written in natural English standing-order language against an arbitrary event schema it has never seen before. This is the STANDING_ORDERS.md compiler from Phase B — it must remain the primary trigger mechanism in Phase C, not a static ruleset.

### 4. All-or-nothing autonomy: the runaway loop problem

From Allen Chan's 2025 anti-pattern analysis: agents that either act completely autonomously (running up costs, executing harmful sequences) or confirm every single decision (becoming slow chatbots) both fail. KAIROS's 🟢/🟡/🟠/🔴 autonomy tier system is the right architecture — but Phase C must enforce it structurally, not just in prompts. Each MCP tool invocation should carry a risk tag, and the orchestrator should halt and surface a 🟠/🔴 action for human review rather than auto-executing it. The tag is assigned at skill authoring time and cannot be overridden by the LLM at runtime.

### 5. Invisible state: the memory illusion

Passing conversation history to the LLM and calling it "memory" leads to repeated steps, contradicting actions, and hallucinated state as the context window fills. KAIROS's Phase B 4-tier memory exists precisely to avoid this — but Phase C must actually use it. Every trigger evaluation should pass the relevant working memory snapshot, not the full raw conversation. The orchestrator's state object must be explicit (SQLite row), not implicit (LLM context).

### 6. Research-paper chasing: the topology trap

From Chan's analysis: reaching for Swarm, CodeAct, debate loops, or LLM-as-Judge to fix failures that actually stem from task scoping, context management, and tool design. For KAIROS Phase C, the architecture is already sound (observe → trigger → plan → act). The risk is adding a second orchestrator layer or a complex graph topology when the actual problem is a badly scoped skill or missing context. Start with the simplest orchestrator (Magentic-One dual-ledger) before layering additional complexity.

---

## Recommended Phase C Scope (the "Bet Big" Version)

Beyond the baseline trigger engine (which fires one action per standing-order match), Phase C should ship these 7 capabilities:

### C1 — Embedded MCP Host Runtime

Ship a full MCP host inside the KAIROS daemon. On startup, enumerate configured MCP servers. At trigger time, invoke any tool on any connected server. Add `kairos mcp add <server-url>` CLI command and a HUD panel for server management. Use the official `@modelcontextprotocol/sdk` TypeScript host. Day-one connectors: GitHub, Slack (community servers), Google Calendar (`.mcpb` bundle), macOS Contacts/Reminders/Notes (bespoke `.mcpb`). Everything else: Smithery search + install on demand.

### C2 — Magentic-One Style Multi-Step Orchestrator

Implement a lightweight dual-ledger orchestrator (task ledger + progress ledger) that can chain 2-8 steps across multiple MCP tools. Each step is: (skill instruction or raw tool call) → (result observation) → (continue or re-plan). Store the ledger as a SQLite row in `action_plans`. On daemon restart, incomplete plans resume from last checkpoint. LangGraph is the reference architecture but KAIROS should implement the orchestrator natively (it's ~400 lines of Python/TypeScript) rather than taking a LangGraph dependency, which brings significant overhead.

### C3 — AWM-Style Workflow Crystallizer

After each successful multi-step action (user confirmed or allowed without override), run the AWM induction loop: pass the structured trajectory log to a cheap LLM call (Haiku is sufficient) and ask it to generalize the workflow into a parameterized template. Store the result in `procedural_memory` as a skill candidate. Surface to user: "I learned a new pattern — review and add to standing orders?" Accept → new `STANDING_ORDERS.md` entry is drafted for user approval. Reject → trajectory still stored for future induction; skill candidate marked `dismissed`.

### C4 — Smithery-Backed Dynamic Connector Acquisition

When a triggered standing order requires a connector not yet installed, the orchestrator's first step is connector acquisition: shell `smithery mcp search "{required capability}"`, present the top 3 results in the HUD, user confirms, `smithery mcp add` installs it, skill invokes it. This makes KAIROS extensible to any new SaaS service without a code release. Build the Smithery CLI invocation into a reusable `connector-acquire` skill that any other skill can call.

### C5 — Structured Trajectory Logging for Future Learning

Every action the orchestrator takes (triggered or user-manual-while-observed) writes a structured log row: `{trigger_id, task_goal, steps: [{obs, reasoning, action, result}], outcome, user_override, override_reason}`. This is the raw material for C3's crystallizer and for KAIROS's future self-training. Without this, behavior cloning from observation is impossible. The schema is cheap to add now and expensive to retrofit later.

### C6 — Autonomy Tier Enforcement at Tool Invocation

Each MCP tool and each skill is tagged at authoring time with a risk tier: `GREEN` (reversible, silent), `YELLOW` (reversible, notify after), `ORANGE` (semi-reversible, confirm before), `RED` (irreversible, full preview + explicit confirm). The orchestrator checks the tier before each tool invocation and cannot proceed with ORANGE/RED without receiving an `approved` signal from the HUD. The tier tag is stored in the skill/tool manifest — the LLM cannot override it at runtime. This prevents the runaway autonomy anti-pattern structurally.

### C7 — Standing Orders Compiler v2: Conditional + Time-Scoped Rules

Upgrade the STANDING_ORDERS.md compiler from Phase B to support: (a) conditional branches ("if context includes keyword X, use reply style Y"); (b) time-of-day scoping ("only fire during work hours 9am-6pm"); (c) cooldown periods ("don't fire the same trigger more than once per 30 min"); (d) cross-rule chaining ("after standing order A completes, evaluate standing order B"). These extensions make the natural-language trigger language expressive enough to encode most behavioral preferences without any code. The compiler produces a structured JSON trigger manifest that the trigger engine evaluates against the event stream — the LLM is only involved in compilation, not in every evaluation pass.

---

*Sources consulted: LangChain ambient agents blog, Smithery CLI docs and GitHub, MCP official registry, agentskills.io specification, AWM arXiv:2409.07429 (ICML 2025), UFO2 arXiv:2504.14603 (Microsoft Research April 2025), Magentic-One arXiv:2411.04468, Allen Chan AI agent anti-patterns (Medium 2025), Anthropic desktop extensions engineering blog, block/agent-skills GitHub, skillmatic-ai/awesome-agent-skills, mcp.so and roxyapi.com registry counts.*
