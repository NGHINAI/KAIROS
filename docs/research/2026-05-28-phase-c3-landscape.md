# Phase C.3 Agent Intelligence Layer — Landscape Check
**Date:** 2026-05-28  
**Author:** Research agent (Claude Sonnet 4.6)  
**Purpose:** Verify the four research artifacts cited in the C.3 spec, audit the orchestrator landscape, and settle the code-execution sandbox decision.

---

## Q1: Are the Four Original Frameworks Still Current?

### 1. Magentic-One (arXiv:2411.04468, Microsoft, Nov 2024)

**Status: Active — but significantly superseded by its own successors.**

Development has not stalled; it has bifurcated. The original `autogen-magentic-one` Python package has been ported from `autogen-core` to `autogen-agentchat` (the higher-level interface in AutoGen v0.4+), making it more modular. More importantly, Microsoft shipped two follow-on projects:

- **Magentic-UI** (May 2025) — an experimental human-in-the-loop web agent built on top of the Magentic-One orchestration pattern. Available on PyPI as `magentic_ui>=0.2.0`. Python 3.12, uses a Quicksand VM for browser isolation.
- **MagenticLite + MagenticBrain + Fara1.5** (May 22, 2026) — the production-grade rewrite. MagenticBrain is an 8B–14B parameter orchestrator (fine-tuned from Qwen 3) that handles planning and delegation. Fara1.5 is a specialized browser-use model family (4B, 9B, 27B on Qwen 3.5). The whole stack runs in Quicksand (lightweight VM sandbox) for isolation.

**Architecture change since the paper:** Dual-ledger (task ledger + progress ledger) remains, but the orchestrator is now a fine-tuned small model rather than a frontier LLM making raw tool calls. The "400 LOC native" claim from the original spec is plausible for the Python orchestrator core (MagenticOneGroupChat + Orchestrator agent), but this number does not reflect the agent's dependencies on AutoGen's agentchat runtime.

**No TypeScript port exists.** The entire lineage is Python-only.

**Latest stable:** autogen-magentic-one ships within `autogen-agentchat`; Magentic-UI v0.2.x on PyPI (May 2025). MagenticLite announced May 22, 2026 — no public package yet.

---

### 2. smolagents CodeAgent (HuggingFace, ICML 2025)

**Status: Actively maintained, ~1,000 LOC core, Python only.**

Released December 2024, presented at ICML 2025. GitHub shows commits as recently as March 2026. The library remains Python-exclusive — no official TypeScript port exists, and no community port was found in public search results.

**Current sandbox integrations** (built-in, via `executor_type=`):
- `e2b` — E2B Firecracker microVM
- `modal` — Modal gVisor container
- `blaxel` — Blaxel (~25ms cold start)
- `docker` — local Docker
- `pyodide+deno` — WASM Python in Deno

**Key caveat for multi-agent setups:** The E2B integration does not work with complex multi-agent topologies; the entire agent system must run inside the sandbox rather than individual tool executions being isolated. This is a real limitation for KAIROS's orchestrator-subagent model.

**Architecture change since the paper:** None major. The CodeAgent / ToolCallingAgent split remains the core abstraction. The ICML paper formalized the code-as-action thesis; the implementation predates it.

---

### 3. Agent Workflow Memory (AWM) (ICML 2025)

**Status: Research published, no standalone production library, but patterns are being absorbed into memory platforms.**

AWM was presented at ICML 2025 (poster, May 1, 2025). The reference implementation is at [github.com/zorazrw/agent-workflow-memory](https://github.com/zorazrw/agent-workflow-memory) — a research repo, not a production SDK.

**Key results:** +24.6% relative success on Mind2Web, +51.1% on WebArena vs. baseline, with fewer steps.

**Production absorption:** The AWM pattern (extract reusable routines from trajectories → store → inject at task-start) is now visible inside:
- Mem0's `session → episodic → semantic` consolidation pipeline
- Letta's archival memory + tools-to-write-memory model
- LangMem SDK (LangChain's own memory layer, open source)
- Enterprise agents' WM–EM–SM cycle pattern (Working Memory → Episodic Memory → Semantic Memory)

**Skill explosion:** AWM's online mode gates new routine induction on successful task completion only. Enterprises add explicit scoring/pruning/deduplication layers on top. No canonical "anti-explosion" library exists — it is implemented per system.

**Storage format:** No emerging standard beyond SQLite rows or vector-DB entries with a `routine_id`, `trigger_description`, `steps[]`, `success_count`, `last_used` schema. The SKILL.md format (agentskills.io) covers agent instructions (human-authored) not auto-crystallized routines from trajectories — do not conflate them.

**AWM + Composio CustomTools:** No published integration. Theoretically compatible — a crystallized workflow could be registered as a Composio CustomTool with a function signature and description. No production example found.

---

### 4. UFO2 ExperienceFlow (arXiv:2504.14603, April 2025)

**Status: Active — project renamed to UFO³.**

The Microsoft UFO project is live at [github.com/microsoft/UFO](https://github.com/microsoft/UFO). The paper (submitted April 20, revised April 25, 2025) covers UFO2. The documentation site now references UFO³, indicating continued evolution.

**ExperienceFlow format (from paper + repo):** Each automation run produces structured logs containing:
- Natural language task description
- Executed action sequences
- Application screenshots at each step
- Final outcome (success/failure)

A summarization module mines successful trajectories offline → distills into `Example` records containing a **task signature** + **step-by-step plan**, stored in an application-specific example database. At runtime, RAG retrieves up to 3 relevant past execution logs to guide planning.

**Architecture change since paper:** UFO2 → UFO³ branding, continuous knowledge substrate (blending documentation, search results, demonstrations, and execution traces into one RAG layer). Windows-only. Not portable to TypeScript/Bun.

---

## Q2: TypeScript/Bun Ports of smolagents

### a) TS-Native smolagents Port

**None exists.** HuggingFace has not shipped a TS port and no serious community port was found in public repositories. The ICML 2025 paper and all documentation are Python-centric.

### b) Code Execution Sandbox Alternatives in TS/Bun

| Option | Cold Start | Isolation | TS-Native | Production-Grade | Notes |
|---|---|---|---|---|---|
| **Bun Worker + node:vm** | <1ms | Weak (same process, soft boundary) | Yes | No | `vm.SourceTextModule` added in Bun v1.2.15; GitHub issue #25929 explicitly flagged that Bun's vm is NOT a security boundary for agent code |
| **Pyodide via Bun** | ~2–5s (WASM load) | Medium (WASM sandbox) | Partial | No | smolagents ships `pyodide+deno`; Bun integration is untested; LangChain uses `pyodide+deno` (not Bun) for their sandbox |
| **E2B** | ~150ms | High (Firecracker microVM) | SDK exists (TS) | Yes | $150/mo Pro tier; Python-first but TS SDK available; most mature catalog |
| **Daytona** | ~27–90ms | Medium (Docker container) | SDK exists (TS) | Yes | Usage-based pricing only; fastest cold start among cloud options |
| **Blaxel** | ~25ms | Medium (container) | SDK exists | Yes | Fastest cold start; $0.0828/hr; TS support confirmed |
| **Modal** | <1s (gVisor) | High (gVisor kernel) | TS beta | Yes (GPU only workloads) | Only option if GPU is needed inside sandbox; 3x CPU cost |
| **Vercel Sandbox** | Fast (unspecified) | Medium | Native | Yes (Vercel ecosystem) | Ideal if already on Vercel AI SDK; $0.1492/hr |
| **Composio Workbench** | Persistent | Medium (Docker) | Via Composio SDK | Beta | Persistent Python sandbox per session; pre-installed: pandas, numpy, PyTorch; state persists across calls; COMPOSIO_REMOTE_WORKBENCH meta-tool |
| **Pydantic sandbox (MCP)** | Unknown | Medium (Pyodide+Deno) | Via MCP | Beta | Released April 2025; MCP server for sandboxed Python; interesting for MCP-native KAIROS |

### c) Minimal Python Install on Mac (Shell-out)

If the decision is shell-out to Python:
- macOS ships Python 3.x (varies by version; not guaranteed to have pip packages)
- **Recommended minimal install:** `uv` (Astral) — installs in one curl, manages Python versions and venvs without polluting system Python. `uv python install 3.12 && uv pip install smolagents` is the minimal path.
- Shell-out via Bun's `child_process.spawn` or `Bun.spawn` is straightforward and lower-latency than a cloud sandbox for local dev.
- **Risk:** Assumes Python is available on the end-user's machine. Not portable for cloud/server KAIROS deployments.

---

## Q3: Magentic-One Alternatives — May 2026 Landscape

### OpenAI Swarm

**Archived and deprecated.** OpenAI archived the Swarm repository in March 2025 when they shipped the Agents SDK. Bug reports and PRs are not being triaged. Do not use for new work.

**Replacement:** OpenAI Agents SDK (`@openai/agents` in TypeScript, `openai-agents-python` in Python). v0.17.1 as of May 2026. TypeScript-first, provider-agnostic, lightweight. Core primitives: Agents, Handoffs (transfer control agent-to-agent), Agents-as-Tools (call a subagent as a function), Sessions (persistent in-loop memory), Guardrails. This is the most directly relevant alternative for KAIROS — it is TypeScript-native, has a minimal abstraction surface, and has a production-ready handoff pattern that maps cleanly to the Coordinator Mode described in the KAIROS leak.

### LangGraph

**Still complex, still worth avoiding for KAIROS's scope.** LangGraph's state-machine graph abstraction is powerful for deterministic stateful pipelines but adds significant overhead: steep learning curve, complex graph settings, concurrency limits in busy workflows, five layers of abstraction for behavior customization. LangChain 1.0 (2026) is positioned as simpler, but still carries LangGraph's dependency weight. Recommendation: still avoid.

### AutoGen v2/v3

**Fragmented into three paths as of March 2026:**
1. **Microsoft Agent Framework (MAF)** — the official production line, unifying AutoGen + Semantic Kernel into one SDK. Python-only.
2. **AutoGen v0.7.x** — "stable" async actor-model maintenance line, good for research/prototyping.
3. **AG2** — community fork.

MAF is heavy and enterprise-focused. Not a fit for KAIROS's lean TypeScript codebase. AutoGen carries substantial dependency weight vs. a native implementation.

### CrewAI

**Production-grade but wrong fit for KAIROS.** CrewAI's role-based metaphor (role, goal, backstory per agent) is excellent for structured team-like workflows (research → analyze → write → review). It's Python-only, 14,800 monthly searches, used by Fortune 500s. For KAIROS, which needs a minimal daemon-mode orchestrator, CrewAI's abstraction is too opinionated and its Python requirement conflicts with the Bun/TS stack.

### Anthropic MCP-Native Orchestration

**Emerging as a credible pattern.** MCP was donated to the Linux Foundation (Agentic AI Foundation, AAIF) in December 2025. OpenAI, Google, Microsoft, AWS, Apple (Xcode 26.3) all support it. The pattern: orchestrator spawns subagents each configured with their own MCP server connections; results reported via XML notifications. The KAIROS leak describes exactly this — Coordinator Mode uses this pattern. Self-hosted sandboxes + MCP tunnels are now in public beta on the Anthropic platform. This is the native pattern for KAIROS as a Claude Code plugin.

### Post-Magentic-One Microsoft Output

**MagenticLite (May 22, 2026)** is the most interesting: a small-model orchestrator (MagenticBrain, 8–14B params) paired with a specialized browser-use model (Fara1.5). The Quicksand VM sandbox is notable — it's a lightweight VM that isolates both browser sessions and code execution. This is the direction Microsoft is taking for "on-device" agent deployments. Not directly usable for KAIROS (Python stack, fine-tuned models), but validates the pattern of separating orchestration from execution with a small dedicated model.

### Verdict on Magentic-One

The "simplest orchestrator first" recommendation remains valid, but the implementation target has shifted. **The OpenAI Agents SDK (TypeScript)** is now a better "simplest viable orchestrator" than a native Magentic-One port because:
1. It's TypeScript-native — no language boundary
2. Handoff + Agents-as-Tools covers the dual-ledger insight without reimplementing it
3. Provider-agnostic — works with Claude models via the API
4. v0.17.1 is production-stable

A native ~400 LOC Magentic-One-style orchestrator is still viable if you want zero external dep, but the OpenAI Agents SDK is ~`npm install @openai/agents zod` and provides the same orchestration pattern at no extra implementation cost.

---

## Q4: AWM 2026 State

### Production AWM-Like Systems

No company has publicly shipped a product explicitly branded "AWM." However, the pattern is implemented inside:
- **Letta (MemGPT)** — agents write to archival memory using explicit tools; memory is retrievable via vector search
- **Mem0** — two-phase pipeline: LLM extraction → conflict detection + graph update → three-scope hierarchy (user/session/agent)
- **LangMem SDK** — open source, LangChain's native memory layer with namespace isolation per user/tenant
- **Zep** — temporal knowledge graph (Graphiti engine), strong on entity relationship tracking over time

### Workflow Storage Format

No single canonical format has emerged. The dominant patterns in production are:

1. **SQLite rows** with schema: `(routine_id TEXT PRIMARY KEY, trigger_description TEXT, steps JSON, success_count INT, last_used TIMESTAMP, embedding BLOB)` — retrieved by embedding similarity at task start.
2. **Vector DB entries** (Pinecone, pgvector) — same fields but with external vector index.
3. **SKILL.md files** — the agentskills.io open standard (Anthropic released Dec 18, 2025, adopted by 26+ platforms). This is for human-authored skills, not auto-crystallized trajectories. The format is: directory named `skill-name/` containing a `SKILL.md` with YAML frontmatter (`name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`) followed by Markdown instruction body. Progressive disclosure: metadata (~100 tokens) loaded at startup, full body loaded only on activation.

**SKILL.md is the right format for KAIROS crystallized workflows** if they are human-reviewed before promotion. For raw auto-crystallized routines (true AWM), SQLite rows are simpler and don't need the filesystem overhead.

### Skill Explosion Prevention

AWM's online mode gates induction on successful completion only. Production systems add:
- **Deduplication:** cosine similarity check before insert; if >0.9 similar to existing routine, update `success_count` instead of creating new entry
- **Scoring and pruning:** entries with `success_count < threshold` after N days are archived or deleted
- **Periodic consolidation:** LLM-based merge of semantically overlapping routines (analogous to Mem0's conflict detection phase)

No production library handles all three automatically — this is typically custom code.

### AWM + Composio CustomTools Compatibility

No published integration found. Theoretically: a crystallized workflow stored as a SQLite row could be promoted to a Composio CustomTool by:
1. Generating a function signature from the `trigger_description`
2. Implementing the `steps[]` as a Composio action handler
3. Registering via Composio's CustomTools API

This is an original KAIROS-specific design decision, not a documented pattern anywhere in the public literature.

---

## Q5: Persona-Awareness — References and Patterns

### Key Papers

**arXiv:2510.07925** — "Enabling Personalized Long-term Interactions in LLM-based Agents through Persistent Memory and User Profiles" (Westhäußer et al., October 2025). The user profile is a **structured JSON object with predefined but initially empty fields** covering:
- Demographic data (name, age)
- Preferences and interests
- Personality traits (stable characteristics)
- Conversational patterns (tone, communication style)

The profile is dynamically updated by an LLM-based agent that receives the current conversation context and fills/updates fields incrementally. The Response Generator uses the profile to adapt outputs. This is the closest academic reference to what KAIROS needs.

**arXiv:2604.27882** — "Building Persona-Based Agents On-Demand" (April 2026). Proposes runtime persona generation where each persona is a structured specification containing: agent role, domain competencies, communication style, owned capabilities. Complements the user profile pattern — the agent persona adapts to the user profile.

**Anthropic Persona Selection Model** (research, 2026) — Anthropic's own framing: post-training refines the Assistant persona; persona effects are prompt-sensitive; changes in persona description substantially alter both outputs and capability selection. Relevant for understanding how KAIROS should inject user context into Claude's system prompt.

### LangChain Ambient Agent / LangMem

LangMem SDK (open source) provides:
- Long-term memory store with namespace isolation per user
- Mechanics to store, update, retrieve knowledge throughout agent experiences
- Integration with LangGraph's persistent state checkpointing

The `user_id` namespace pattern (all writes tagged with user identity) is the recommended architectural primitive for multi-user always-on agents.

### Anthropic/OpenAI Guidance

- **Anthropic** (August 2025): Persistent memory vault in Claude — teams can enable memory of users, projects, preferences across sessions. No public SDK for programmatic control yet; available via Claude.ai UI.
- **OpenAI Agents SDK**: `Sessions` primitive provides persistent memory within an agent loop. Scoped per session, not per user across sessions.
- **Mem0's four-scope model** (`user_id`, `agent_id`, `run_id`, `app_id`) is the most complete published architecture for multi-tenant user state.

### Recommended Framing for "Good Persona Model"

Based on the literature, a good persona model for KAIROS tracks:
1. **Identity anchors** — name, timezone, primary language (stable, set once)
2. **Preference map** — communication style (verbose/terse), preferred response format (prose/bullets/code), topic depth preference
3. **Behavioral patterns** — observed work rhythms, frequent task types, tool preferences
4. **Episodic context** — recent goals, active projects, in-flight tasks (short TTL, session-scoped)
5. **Relationship to agent** — trust level, override preferences, boundaries

The profile should be a structured JSON document, updated by the agent after each significant interaction, stored in SQLite or Supabase with versioning. Never store it only in context — it must persist across process restarts.

---

## Q6: Code Execution Sandbox Decision

### Options Compared for KAIROS

| Option | Cold Start | Security | TS-Native | Cost | Mac Dev | Prod-Grade |
|---|---|---|---|---|---|---|
| **a) Bun Worker + node:vm** | <1ms | Weak | Yes | Free | Yes | No |
| **b) Pyodide via Bun** | ~2–5s | Medium | Partial | Free | Yes | No |
| **c) Python spawn (child_process)** | ~50–200ms | Weak | Via spawn | Free | Yes (if Python installed) | Dev only |
| **d) E2B** | ~150ms | High | TS SDK | $0.0828/hr + $150/mo Pro | Network required | Yes |
| **d) Daytona** | ~27–90ms | Medium | TS SDK | $0.0828/hr, usage-only | Network required | Yes |
| **d) Blaxel** | ~25ms | Medium | TS SDK | $0.0828/hr | Network required | Yes |
| **d) Modal** | <1s | High | TS beta | $0.1193/hr | Network required | Yes (GPU) |
| **e) Composio Workbench** | Persistent | Medium | Via SDK | Composio plan pricing | Network required | Beta |

### Analysis

**Option a (Bun Worker + vm):** Explicitly flagged by the Bun community (GitHub issue #25929) as NOT a security boundary for agent-generated code. `vm.SourceTextModule` was added in Bun v1.2.15 for ES module evaluation but the sandbox is soft — malicious code can escape. Suitable only for trusted code (KAIROS's own crystallized workflows, not user-supplied arbitrary code).

**Option b (Pyodide via Bun):** The smolagents team uses `pyodide+deno` (not Bun) for their WASM sandbox. Bun+Pyodide is untested in production. The LangChain sandbox also uses Deno as the host runtime for Pyodide. The 2–5s WASM init time is acceptable for first-call if the instance is reused. Memory is bounded by WASM heap (~2GB max). Missing packages require WASM compilation.

**Option c (Python spawn):** Zero additional dep for Mac dev. Not viable for cloud/server KAIROS because it assumes Python is installed. Good for local testing of smolagents patterns.

**Option d (Cloud sandboxes):** E2B is the most mature ecosystem (largest template catalog, Firecracker microVM isolation). Daytona/Blaxel are faster and cheaper for high-frequency use but offer weaker isolation (Docker vs. microVM). For an always-on daemon with occasional code execution bursts, the per-call cost is negligible.

**Option e (Composio Workbench):** A persistent Python sandbox where variables and files persist across calls within a session. Packages pre-installed include pandas, numpy, matplotlib, PyTorch. The `COMPOSIO_REMOTE_WORKBENCH` meta-tool is available inside the Composio ecosystem. Since KAIROS already uses Composio for tool integrations, this is the lowest-friction path if code execution is Composio-session-scoped.

### Recommendation: Tiered Approach

**Phase C.3 recommendation: Composio Workbench for Python code execution, Bun Worker for trusted TS execution.**

Rationale:
1. KAIROS already has a Composio session per user. The Workbench reuses that session — no new billing relationship, no new auth flow.
2. Workbench state persistence (variables, files) is essential for multi-step agent code execution where intermediate results are reused.
3. Bun Worker (with `node:vm`) is safe for KAIROS's own crystallized workflow execution because that code is authored/reviewed by the system, not user-supplied.
4. E2B is the production fallback if KAIROS needs stronger isolation (e.g., user-supplied code, multi-tenant environments). Add E2B only when Composio Workbench's Beta status becomes a blocker.

If Composio Workbench exits Beta too slowly: **Daytona** is the next choice — fastest cold start (27–90ms), usage-only pricing, TS SDK available, strong enough isolation for most agent code.

---

## Summary Table: Framework Status

| Framework | Still Relevant? | Use in C.3? | Reason |
|---|---|---|---|
| Magentic-One | Partial | Reference only | Python-only; pattern is valid but OpenAI Agents SDK (TS) covers it natively |
| smolagents CodeAgent | Partial | Inspiration | Python-only; sandbox options are excellent reference; no direct TS usage |
| AWM | Yes | Pattern, not library | No production library; implement pattern natively in SQLite; SKILL.md for human-reviewed skills |
| UFO2 ExperienceFlow | Partial | Reference only | Windows-only; trajectory log format is the useful takeaway; implement own version |

---

## New Developments Since Original Spec (2026-05-24)

1. **MagenticLite/MagenticBrain/Fara1.5 announced May 22, 2026** — the day before the spec was written. The small-model orchestrator pattern (8–14B fine-tuned model as the orchestrator brain) is now validated by Microsoft. KAIROS's use of Claude as orchestrator is the cloud-hosted equivalent.

2. **OpenAI Agents SDK v0.17.1 (May 2026)** — TypeScript-native, provider-agnostic, production-stable. This is now the simplest viable orchestrator for a TS/Bun stack, simpler than implementing Magentic-One natively.

3. **SKILL.md became an open standard (December 18, 2025)** — adopted by 26+ platforms. KAIROS's crystallized workflow format should align with SKILL.md for portability.

4. **Blaxel emerged as fastest cloud sandbox** (25ms cold start, $0.0828/hr) — not mentioned in any 2024 literature; now a serious alternative to E2B.

5. **Composio Workbench is Beta** — persistent Python sandbox with pre-installed ML packages. Status may affect C.3 scheduling.

---

## Open Questions (Couldn't Resolve from Public Research)

1. **Composio Workbench production SLA:** Is it Beta-stable enough for C.3? What are the session timeout limits? Does state persist across Composio SDK reinitializations?
2. **KAIROS's multi-tenancy model for user profiles:** Does each KAIROS user get an isolated Supabase row, or is there a shared agent-state table? The Mem0 four-scope model assumes `user_id` isolation at the DB level — is this already in the KAIROS schema?
3. **Code execution threat model:** Is KAIROS executing user-supplied arbitrary code, or only KAIROS-authored crystallized workflows? The answer changes the sandbox security requirement from "soft boundary acceptable" to "microVM required."
4. **OpenAI Agents SDK provider-agnosticism in practice:** It claims to be provider-agnostic but was optimized for OpenAI models. What is the real latency/reliability penalty when routing to Claude via the Agents SDK vs. calling the Anthropic API directly?
5. **AWM induction trigger in KAIROS:** What constitutes a "successful trajectory" worth crystallizing? Is this user-confirmed, auto-detected by outcome metrics, or heuristic (task completed without errors)?

---

*Sources consulted: arXiv:2411.04468, arXiv:2504.14603, arXiv:2510.07925, arXiv:2604.27882, github.com/huggingface/smolagents, github.com/zorazrw/agent-workflow-memory, github.com/microsoft/UFO, github.com/microsoft/autogen, github.com/openai/openai-agents-js, agentskills.io/specification, mem0.ai/blog/state-of-ai-agent-memory-2026, superagent.sh/blog/ai-code-sandbox-benchmark-2026, microsoft.com MagenticLite announcement (May 22 2026), kingy.ai KAIROS daemon analysis*
