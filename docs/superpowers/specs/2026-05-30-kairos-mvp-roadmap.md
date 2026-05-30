# KAIROS MVP Roadmap — Phases E.2 through I

> **Status:** Design lock 2026-05-30. Path to v1.0.0 public release.
> **Author:** brainstormed with the user during voice end-to-end session.
> **Supersedes:** the earlier Phase E.2 design doc (self-healing Composio, deferred).

## North star

KAIROS is a **proactive personal AI co-worker for macOS**. The MVP must demonstrate three woven capabilities:

1. **Voice agent that does real things** — say "summarize my emails from today", KAIROS fetches via Composio, speaks the summary while narrating progress.
2. **Proactive triggers** — KAIROS watches Composio events (Calendar, Gmail, Linear, WhatsApp) and speaks unprompted at the right time, persona-aware.
3. **Screen guidance (Clicky-style)** — "Where do I find Export in Figma?" → KAIROS captures the screen, points cursor at the right UI element.

All three available in one app, polished UI (Living Oval HUD), shipped as a code-signed `.dmg` with auto-update, backed by **KAIROS Cloud** (server-side LLM/Composio key custody, per-user subscription).

## Explicit non-goals (out of scope for MVP)

- ❌ Not a coding agent (Cursor/Claude Code occupy that space)
- ❌ Not Windows/Linux (macOS 14.2+ only)
- ❌ Not a web UI (native NSPanel + Electron only)
- ❌ Not bring-your-own-key in v1.0.0 (Cloud only; BYOK can come in v1.1)
- ❌ No multi-user accounts in v1.0.0 (single-user per install)

## Architecture lock

```
┌──────────────────────────────────────────────────────────────────┐
│                       USER'S MAC                                  │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Electron app (KAIROS.app)                                │   │
│  │   • Living Oval HUD (transparent NSPanel via tiny Swift) │   │
│  │   • Settings / activity feed / persona editor (React)    │   │
│  │   • Hotkey (globalShortcut)                              │   │
│  │   • WS client → ws://127.0.0.1:9876/v1/voice/events      │   │
│  └────────────────────────┬─────────────────────────────────┘   │
│                           │                                       │
│  ┌────────────────────────▼─────────────────────────────────┐   │
│  │  Bun daemon (kairosd)                                     │   │
│  │   • Hosts wrap-API (HTTP + WebSocket)                    │   │
│  │   • Multi-agent orchestrator (Planner/Executor/Vision)   │   │
│  │   • Standing-orders DSL + reactive evaluator             │   │
│  │   • SQLite memory + soul.md persona                      │   │
│  │   • Authenticates with KAIROS Cloud (per-user session)   │   │
│  │   • Spawns Swift helpers (voice + screenshot + pointer)  │   │
│  └────┬───────────────────────────────────┬─────────────────┘   │
│       │                                   │                       │
│  ┌────▼───────────┐              ┌────────▼─────────────┐       │
│  │ KairosVoiceHlpr│              │ KairosScreenHelper   │       │
│  │  AVAudioEngine │              │  ScreenCaptureKit    │       │
│  │  SFSpeechRecog │              │  Pointer overlay     │       │
│  │  AVSpeechSynth │              │  (NSPanel + bezier)  │       │
│  │  CGEventTap    │              └──────────────────────┘       │
│  └────────────────┘                                              │
└──────────────────────────────────────────────────────────────────┘
                            ▲ HTTPS, per-user JWT
┌───────────────────────────┼──────────────────────────────────────┐
│  KAIROS CLOUD (Phase I.5) │                                       │
│                                                                   │
│  • Stripe subscription billing                                    │
│  • OAuth (Apple / Google sign-in)                                 │
│  • Server-side key vault (OpenRouter, Composio)                   │
│  • Proxy: /v1/llm/complete → OpenRouter (with org's keys)         │
│  • Proxy: /v1/composio/* → Composio (per-user OAuth tokens)       │
│  • Usage metering + rate limits per subscription tier             │
└───────────────────────────────────────────────────────────────────┘
```

## Model strategy (3-tier orchestrator)

All names are env vars — swap by editing `.env`, no code change.

| Tier | Purpose | Default model | Env var | Cost ($/M in / out) | TTFT |
|---|---|---|---|---|---|
| **1 — Fast/narration** | Acks ("on it"), status updates, chat-only turns, simple summarization | `openai/gpt-4o-mini` | `KAIROS_FAST_MODEL` | $0.15 / $0.60 | ~250ms |
| **2 — Smart planning** | Multi-step tool chains, parameter filling, decision-making | `moonshotai/kimi-k2` | `KAIROS_SMART_MODEL` | $0.57 / $2.30 | ~500ms |
| **3 — Deep reasoning** | Rare: "think hard", multi-day planning, debugging | `moonshotai/kimi-k2-thinking` | `KAIROS_DEEP_MODEL` | $0.60 / $2.50 (+ thinking tax) | ~1500ms |
| **Vision** (Phase H) | Screen pointing — only on "look at my screen" intents | `openai/gpt-4o` | `KAIROS_VISION_MODEL` | $2.50 / $10 | ~500ms |

**Per-turn routing logic** (Phase E.2.1 — orchestrator):
1. Tier 1 classifier asks: "is this chat, simple tool call, or multi-step plan?"
2. **Chat / simple tool** → Tier 1 handles end-to-end
3. **Multi-step or unclear plan** → Tier 2 plans, Tier 1 narrates between calls
4. **Explicit "think hard about this" or repeated failures** → Tier 3
5. **Vision intent ("look at screen", "show me", "where is")** → Vision model

**Fallback ladder via OpenRouter `provider.order`:**
- Tier 2 primary: Kimi K2 → fallback DeepSeek V3.1 → fallback GLM-4.6
- Tier 1 primary: gpt-4o-mini → fallback Llama 3.3 70B (Cerebras)

**Dev-only Anthropic fallback:** Claude Code subprocess kept as Tier 4 dev fallback (uses user's local Claude Code subscription, no API key needed). Never exposed in KAIROS Cloud.

**Annual cost projections:**
- Personal use (50 turns/day): ~$15-30/year self-pay or covered by subscription
- KAIROS Cloud at 1K active users: ~$25K/year LLM spend → easily covered by $10-15/mo subscription

## Concrete example mapping (user's use cases)

| User intent | Tier path | Cost per call |
|---|---|---|
| "Summarize emails from today" | Tier 1: gmail.list_messages → summarize | $0.001 |
| "What meetings did I have yesterday?" | Tier 1: gcalendar.list_events → summarize | $0.001 |
| "Pull all WhatsApp chats → extract meetings → add to calendar → notify organizers" | Tier 2: plans 5-step chain, Tier 1 narrates each step | $0.005-0.010 |
| "Hey, you have stand-up in 5 min" (proactive) | Tier 1: just speak from trigger event | $0.0002 |
| "Where do I click to export from Figma?" | Vision: gpt-4o screen+text → POINT tags | $0.015 |
| "Think hard about how to restructure my week" | Tier 3: kimi-k2-thinking deep reasoning | $0.05 |

## Phase breakdown

---

### Phase E.2 / E.3 / E.4 — Three-tag voice → full KAIROS interface

Split into three shippable phases:

| Phase | Tag | Duration | Scope |
|---|---|---|---|
| **E.2 — Core agentic voice** | `v0.7.0` | ~2-3 weeks | Daemon unification + orchestrator + tool-calling + basic context + speak-while-acting + dynamic Composio + barge-in |
| **E.3 — KAIROS-aware voice** | `v0.7.1` | ~1 week | Proactive observers + perception narrator + IntentRegistry + MCP tools in voice context |
| **E.4 — Restraint + reliability** | `v0.7.2` | ~1 week | Restraint pipeline + Discord errors + PromptCache + DryRunMode (cost tracking stays internal-only, not surfaced) |

**Critical architectural decision (E.2.0):** Unify the two daemons. `scripts/voice-live.ts` is rewritten to invoke the **full daemon bootstrap from `src/daemon/index.ts`** + attach voice on top. No more parallel daemon.

---

### Phase E.2 — Core agentic voice

**Full mapping — ALL 14 subsystems to E.2 wiring:**

| Subsystem | What it does | E.2 connection point |
|---|---|---|
| **agency** (IntentRegistry, ActionExecutor, TrajectoryLog) | Internal intent dispatch | Voice planner can invoke KAIROS intents as first-class tools (alongside Composio + skills) |
| **mcp** (McpHost, ToolToIntent) | External MCP server loading | MCP tools auto-registered as voice-callable |
| **memory** (L1-L4, MemoryInjector, Dreamer) | 4-tier cognitive memory + hybrid recall | MemoryInjector feeds Planner context. Conductor writes L2 episodes. Dreamer runs on idle. |
| **persona** (Soul, Updater, Awareness, TrajWriter) | Personality + traj log | Soul digest in system prompt. TrajWriter logs every turn. PersonaUpdater observes outcomes. |
| **proactive** (EventBus, 6 observers) | Sees what user is doing RIGHT NOW | FocusApp / BrowserTabs / Clipboard / FileEvents / Calendar / ActivityWatch state injected into Planner context per turn |
| **perception** (Tier1/Tier2 + narrator) | State summarization | Tier1 narrator output added to system prompt; Tier2 summaries feed memory |
| **orders v2** (Reactive, Schedule, ApprovalPrompt) | Rules + crons + approval flow | Active orders summarized in prompt; ApprovalPrompt usable from voice |
| **skills** (Registry, Dispatcher, AWM, Curator) | Crystallized workflows | Skills as tools. Voice turns feed AwmWorker for new crystallization. |
| **connectors** (Composio sessions + triggers + ConnectGuard) | Toolkit OAuth + triggers | Self-heal connect flow (E.2.5). Triggers feed proactive (Phase F). |
| **restraint** (DryRun, Karma, Focus, Cooldown, Delivery, Digest) | "Don't be annoying" gate | OUTGOING voice (esp. proactive in F) passes restraint. Karma updates from user feedback. |
| **llm/router + costTracker + promptCache** | Multi-provider routing + cost + cache | ModelRouter replaces direct OpenRouterAdapter calls. CostTracker logs every turn. PromptCache marks long-context blocks. |
| **onboarding** (SetupFlowRuntime, OAuth handler) | Setup wizards | Voice-driven setup. "Connect Gmail" → SetupFlowRuntime drives OAuth via browser. |
| **discord** | Error / progress posting | Background voice agent errors → Discord. Optional. |
| **voice** (Conductor, Sidecar, StreamingSpeaker) | STT/TTS pipeline | Existing E.1 layer — unchanged interface, becomes one of many interfaces |

#### E.2.0 — Unify daemons (2 days, BLOCKING)

**The fix for the "voice is blind" problem.** Today `scripts/voice-live.ts` is a parallel 260-line mini-daemon with only voice + LLM + stubbed adapters. The full 1223-line `src/daemon/index.ts` (with proactive observers, memory dreamer, perception, restraint, AWM clustering, agency, MCP, etc.) **never runs when you launch voice**.

**Action:**
- Rewrite `scripts/voice-live.ts` to import + invoke `src/daemon/index.ts` bootstrap
- Replace stub adapters with real subsystem references obtained from the main daemon
- Add `KAIROS_WITH_VOICE=true` env flag in `src/daemon/index.ts` that brings up voice subsystem
- `./scripts/voice-electron.sh` becomes: full daemon + voice flag + Electron UI client

After E.2.0: one daemon, full subsystem stack, voice as one of many interaction layers.

**Tests:**
- Integration: launch via voice-live.ts → verify EventBus + ObserverRegistry + Memory + Restraint + Skills all booted
- Voice loop still works end-to-end as before (regression)

#### E.2.1 — Orchestrator scaffolding via @openai/agents-js (3-4 days)

**Decision locked:** use `@openai/agents-js` SDK (Vercel-backed, TS-native). Saves ~150 LoC, gives us proper handoff/guardrail primitives, lets us evolve into multi-agent swarms later.

**New code:** `src/daemon/agents/`
- `conductor.ts` — entry point, replaces today's `handleUserSpeechStreaming`
- `agents.ts` — defines IntentClassifierAgent, PlannerAgent, ExecutorAgent via SDK
- `runtime.ts` — wires agents to wrap-API, model selection, tool definitions

**Env vars added** to `.env`:
```
KAIROS_FAST_MODEL=openai/gpt-4o-mini      # Tier 1
KAIROS_SMART_MODEL=moonshotai/kimi-k2     # Tier 2
KAIROS_DEEP_MODEL=moonshotai/kimi-k2-thinking  # Tier 3
KAIROS_VISION_MODEL=openai/gpt-4o          # Phase H
```

**Tests:**
- Unit: classifier returns correct tier for 20 sample intents (mocked LLM)
- Integration: 3-step tool chain end-to-end with mocked Composio
- E2E (one real-LLM test): "What's on my plate?" → real Linear → speaks summary

#### E.2.2 — Tool-calling in OpenRouter adapter (2 days)

**Modify:** `src/daemon/wrapApi/adapters/openRouterAdapter.ts`

- Add `tools` parameter to `stream()` body
- Parse `tool_calls` deltas in SSE stream (OpenAI-compat shape)
- Emit `{ kind: 'tool_use', name, args, id }` events alongside `delta`/`done`/`error`

**Tool schema source:** Composio TS SDK gives OpenAI-compatible defs; SkillRegistry gives KAIROS skills as defs.

#### E.2.3 — KAIROS context layer + introspection tools (THE BIG ONE, 3-4 days)

**Voice is THE point of contact.** Every existing KAIROS system has to be reachable via voice in two ways: (a) as CONTEXT injected into agent prompts, (b) as TOOLS the user can voice-invoke for introspection / self-management.

**The system prompt assembly module:** `src/daemon/agents/contextBuilder.ts`

For every Planner call, build a layered context:
```
SYSTEM:
  <persona digest from soul.md>                        ← 200 tokens
  <active standing orders summary>                     ← 100 tokens
  <PROACTIVE STATE — what user is doing RIGHT NOW>     ← 200 tokens
   • Focused app: <FocusApp observer>
   • Recent browser tabs: <BrowserTabs top 3>
   • Clipboard preview: <Clipboard observer last text>
   • Recent files: <FileEvents last 5>
   • Calendar: <next meeting + DND status>
   • Activity: <ActivityWatch idle/active state>
  <PERCEPTION digest from Tier1 narrator>              ← 100 tokens
   • "User has been writing in Linear for 20 min, no
     calendar events for 45 min, normal focus mode"
  <recent conversation (last 5 turns + tool calls)>    ← 500 tokens
  <currently-connected Composio toolkits>              ← 50 tokens
  <connected MCP servers>                              ← 50 tokens

TOOLS:                                     // FIVE tool families:
  ## 1. KAIROS introspection (always loaded, native)
  kairos_skills_list, kairos_skills_describe(slug)
  kairos_soul_read, kairos_soul_update_proposal(patch)
  kairos_orders_list, kairos_orders_add(yaml), kairos_orders_remove(id)
  kairos_dreams_last, kairos_dreams_search(query)
  kairos_traj_recent(N), kairos_traj_search(query)
  kairos_memory_search(query), kairos_remember(text)
  kairos_composio_status, kairos_mcp_status, kairos_help
  kairos_focus_state, kairos_recent_apps, kairos_clipboard

  ## 2. KAIROS internal intents (from IntentRegistry)
  <every intent registered via agency/IntentRegistry — typically dozens>
  e.g. observe_calendar, watch_email, propose_break, etc.

  ## 3. KAIROS crystallized skills (always loaded, AWM)
  <5 active skills from SkillRegistry — disk-space, gmail, etc.>
  (Grows over time as AWM crystallizes more workflows.)

  ## 4. External MCP tools (from McpHost — all loaded servers)
  <tools from every MCP server user has connected>
  e.g. notion_*, filesystem_*, postgres_*, custom_*

  ## 5. Composio toolkits (lazy + searchable, ~300 toolkits)
  composio_search_tools(query, limit=10)   ← meta-tool: returns top-N tool defs
  <recently-used Composio tools (LRU cache)>
  // When Planner needs a new toolkit, it calls composio_search_tools first.
  // Avoids loading all 5000+ tools into context.

MESSAGES:
  <last turn>
  <current turn>
```

**Cache hints (existing `llm/cache/cacheHints.ts`):** persona digest + active orders + L4 skills get `cache_hint: 'long'`. Recent conversation + current turn get `cache_hint: 'short'`. Anthropic/OpenAI provider caching gives ~30-90% cost reduction on long-prefix turns.

**Session-level injection (adopted from Hermes Agent pattern):**

Per-turn injection (the naive approach) is expensive. Instead:

```
SESSION START (once per voice session):
  Inject prefix-cached layer:
    <persona digest from soul.md>            ← 200t, cached
    <MEMORY.md content (capped at 800t)>     ← 800t, cached
    <active standing orders summary>         ← 100t, cached
    <L4 skills as tool defs>                 ← 500t, cached
    <KAIROS introspection tool defs>         ← 800t, cached
  Total: ~2400t prefix, cached at provider — virtually free on subsequent turns

PER TURN (every user utterance):
  Inject only:
    <current turn>                           ← ~50t
    <last 3 turns conversation>              ← ~300t
    <prefetched L2/L3 hits via MemoryInjector>  ← ~600t
    <proactive state delta since last turn>  ← ~100t (in E.3)
  Total: ~1050t per turn (small) + cached prefix (free)
```

This is the difference between $0.005/turn and $0.0005/turn at scale. Use existing `cacheHints.ts` to mark the session-prefix blocks.

**Memory write tools — surgical substring matching (adopted from Hermes):**

```ts
kairos_remember({ subject, body })           // add new L3 fact
kairos_memory_replace({ old_text, new_text }) // surgical edit
kairos_memory_remove({ contains })           // delete by substring
```

LLM uses substring match instead of rewriting the whole file. Faster + safer.

**Retention decision framework (adopted from Hermes):**

`kairos_remember` is gated by these rules before write:
1. User correction or explicit "remember that..." → save with importance 0.8
2. Preference / habit observed → save to persona via PersonaUpdater (not L3)
3. Env / project fact → save to L3 with importance 0.6
4. Easily re-discoverable (e.g., "today is Saturday") → skip
5. Session-specific (e.g., "I'm debugging X") → L2 only, not L3
6. Anything else → save with importance 0.4

**Bounded memory + consolidation (Hermes pattern):**

- `MEMORY.md` capped at 800 tokens hard. If new content would exceed → trigger Dreamer-light: a fast LLM call consolidates the file in place
- L3 facts decay automatically (importance × frequency × recency). Decayed facts removed at >5000 active facts
- L2 episodes pruned at >30 days unless `importance > 0.7`

**Each system gets a loader fn AND a tool implementation:**

| Context loader (read-only) | Tool (invokable by Planner) | Backing source |
|---|---|---|
| `loadSoulDigest()` (200t cache) | `kairos_soul_read`, `kairos_soul_update_proposal` (proposes patch, voice confirm before write) | `soul.md` via SoulLoader |
| `loadStandingOrdersSummary()` | `kairos_orders_list`, `kairos_orders_add`, `kairos_orders_remove` | OrdersStore (C.4.1) |
| `MemoryInjector.inject(query)` → L2+L3+L4 blocks | `kairos_memory_search(query)` (L3 hybrid recall) | `memory/recall.ts` Recall.hybrid() |
| (auto every turn) | `kairos_traj_recent(N)`, `kairos_traj_search(query)` | `mem_l2_episodes` table (EpisodicMemory) |
| `loadKairosSkills()` → tool defs (L4) | `kairos_skills_list`, `kairos_skills_describe(slug)` | SkillRegistry (C.3.3) |
| `loadRecentToolkits()` (LRU) | `kairos_composio_status`, `composio_search_tools`, `composio_disconnect(toolkit)` | Composio TS SDK + ConnectionStore |
| (no loader, on-demand) | `kairos_remember(text)` — writes L3 fact directly (with confirm) | `semanticMemory.ts` SemanticMemory.add() + embeddings |
| (no loader, on-demand) | `kairos_dreams_last`, `kairos_dreams_search(query)` | `MEMORY.md` + `mem_dream_log` |
| (no loader, on-demand) | `kairos_memory_overview` — reads top-level MEMORY.md | `memory.ts` MemoryStore.read() |
| (no loader) | `kairos_help` (meta-description of capabilities, tailored to which toolkits connected) | computed live |

**Memory tier integration (using existing `MemoryInjector`):**

```ts
// In Conductor.handleTurn(utterance):
const ctx = await memoryInjector.inject(utterance, {
  max_l2: 5,       // 5 most relevant recent episodes
  max_l3: 8,       // 8 most relevant semantic facts (hybrid: vector + FTS5)
  include_l4: true // all active skills as tool defs
})
// ctx is ContextBlock[] with cache hints (long/short)
// → ordered into system prompt with proper provider cache markers
```

**After every agent turn, write L2 episode + bump L4 stats:**

```ts
await episodicMemory.add({
  started_at: turn.t0,
  ended_at: turn.t1,
  episode_type: 'voice_turn',
  title: utterance.slice(0, 120),
  summary: agentOutput,
  event_ids: [...toolCallIds],
  importance: computeImportance(toolCalls, errors),
})
for (const skillId of usedSkills) {
  await proceduralMemory.recordInvocation(skillId, success=true)
}
```

**Voice writes to L3 (the user can teach KAIROS facts):**

User: "Remember that my manager is Sarah."
→ Tier 2 emits `kairos_remember({ subject: "manager", body: "Sarah is the user's manager" })`
→ Tier 1 narrator speaks back: "Got it — I'll remember Sarah is your manager. Confirm?"
→ User: "Yes" → `semanticMemory.add()` → embeds → stores in L3 with importance 0.8
→ Future Planner calls retrieve this when relevant ("email Sarah" → L3 hit "Sarah is manager")

**Decay + dreaming (Phase F + autonomous):**
- L2 episodes older than 30 days with low importance get pruned
- L3 facts decay via `decayed_at` timestamp (importance × frequency × recency)
- Dreamer (existing `memory/dreamer.ts`) runs on idle, consolidates L2 clusters into L3 facts, updates MEMORY.md
- Phase F adds the idle-trigger hook into the dreamer

**What we do NOT have (and don't need for v1.0.0):**
- ❌ True knowledge graph (entity-relationship triples like Neo4j). The L2→L3 source_episodes link is sufficient for v1; consider Phase J if needed.
- ❌ Cross-session multi-user memory sharing. v1 is single-user per install.
- ❌ External vector DB (Pinecone/Weaviate). Pure-TS cosine over BLOB embeddings is sub-10ms at our scale (~10k facts max).

**Voice-invokable examples** (must work end-to-end at v0.7.0):

- "What skills do you have?" → `kairos_skills_list` → "I have five crystallized workflows: disk-space, gmail, recent-git-activity, system-info, user-process-summary."
- "What's in my soul?" → `kairos_soul_read` → speaks 2-3-sentence summary
- "Add a standing order: summarize my inbox every weekday at 9am" → Tier 2 plans → `kairos_orders_add` with parsed DSL → reads back to user for confirm → writes on confirm
- "What did you dream about last night?" → `kairos_dreams_last` → speaks Dreams summary
- "Forget the last thing I said" → Planner uses `kairos_memory_search` to find turn, marks it ignored
- "What toolkits am I connected to?" → `kairos_composio_status` → "You're connected to Linear. Want to connect more?"
- "What can you do?" → `kairos_help` → speaks capability overview tailored to which toolkits are connected

**Two-step confirm pattern for mutations** (soul / orders / memory edits):
- Tier 2 Planner proposes the change via tool call
- Tier 1 narrator speaks the proposed change: "I'll add a rule: every weekday at 9am, summarize your inbox. Confirm?"
- User: "yes" → tool executes; "no" → aborted
- Avoids accidental destructive edits via voice

**TrajWriter hook:**
- After every agent turn (success or failure), write entry: `{ user_input, intent_tier, plan, tool_calls, tool_results, agent_output, latency_ms, tokens_used, cost_usd }`
- This feeds Dreams reflection later

**Implementation files:**
```
src/daemon/agents/
  contextBuilder.ts      ← assembles system prompt + tool registry
  introspectionTools.ts  ← implements all kairos_* tools (calls existing systems)
  conductor.ts           ← uses contextBuilder per turn
```

#### E.2.4 — Speak-while-acting narration (3 days)

**New code:** `src/daemon/agents/narrator.ts`

Synchronous narration pattern:
- On Tier 2 emitting `tool_use`: Conductor pauses Tier 2 stream
- Conductor asks Tier 1 (fast model) to generate ack ("checking your calendar…")
- StreamingSpeaker speaks the ack
- ActionDispatcher executes the tool
- On result: Tier 1 generates short transition ("found 3 events…")
- Resume Tier 2 stream with tool result appended to messages
- Every 5s during long tool execution: Tier 1 emits filler ("still working on it…")
- Final summary: Tier 2 wraps up after all tools complete

**WS events added** for UI rendering:
```
agent_ack         { text, tier: 1 }
agent_planning    { tier: 2 }
agent_tool_call   { name, args }
agent_tool_done   { name, result_summary }
agent_tool_failed { name, error }
agent_done        { text }
```

#### E.2.5 — Dynamic Composio access + self-healing connect (3-4 days)

**The user-vision flow:** KAIROS has access to ALL ~300 Composio toolkits. When LLM calls a tool whose toolkit isn't connected, KAIROS triggers a voice-guided OAuth flow.

**New code:** `src/daemon/agents/composioToolProvider.ts` + extend `connectGuard.ts`

**Tool discovery (avoid context bloat from 300+ toolkits):**
- Don't load all 5000+ tools into Planner's context (would blow context window + cost)
- Provide a meta-tool: `composio_search_tools({ query, limit: 10 })` → returns top relevant tool defs
- Planner calls search → gets back ~10 candidates → picks one to invoke
- Cache: once Planner uses a toolkit, its tools stay in context for subsequent turns

**Self-heal connection flow:**
```
1. Planner emits tool_use for, say, gmail.search_messages
2. ActionDispatcher checks ConnectGuard → returns { connected: false, toolkit: 'gmail' }
3. Conductor catches → pauses agent run
4. Tier 1 narrator speaks: "I need to connect Gmail for that — opening your browser."
5. Daemon: composio.initiateConnection({ toolkit: 'gmail', user_id })
   → returns { redirect_url, connection_id }
6. Daemon: spawn('open', [redirect_url]) — macOS opens default browser
7. Daemon polls composio.getConnection(connection_id) every 2s, max 120s
8. On status === 'ACTIVE':
   - Narrator speaks: "Connected. Now fetching your emails..."
   - Conductor retries the original tool call
9. On timeout / user cancel:
   - Narrator speaks: "Looks like you didn't complete the connection. Try again whenever."
   - Agent run aborts gracefully
```

**WS events:**
```
toolkit_connecting    { toolkit, redirect_url }
toolkit_connected     { toolkit }
toolkit_connect_failed { toolkit, reason }
```

UI can show a connection-in-progress card with browser link.

#### E.2.6 — Restraint + cost tracking + Discord error reporting (2 days)

**Outgoing voice gates through Restraint pipeline.** This becomes essential in Phase F (proactive voice), but should be wired in E.2 because the same path applies to slow-running tool chains — we don't want KAIROS interrupting itself if user is in focus mode.

- **Restraint:** before any voice-out (especially `agent_ack` / `agent_status` / proactive), check `FocusDetector` (is user in DND / focus mode), `CooldownTracker` (have we spoken recently), `Karma` (has this kind of message been annoying lately)
- **DryRunMode:** env flag `KAIROS_DRY_RUN=true` runs full agent but doesn't speak / execute tools. Logs intended actions. Useful for testing.
- **CostTracker:** every LLM call (Tier 1, 2, 3, vision) logs to `llm_call_log` table with tokens + cost. New voice WS event `cost_update` lets HUD show per-session spend.
- **PromptCache:** use existing `cacheHints.ts` to mark long-context blocks (persona, orders, memory) for Anthropic/OpenAI prompt caching — 90%+ cost reduction on cached prefix
- **Discord:** errors during agent run (tool failure, LLM timeout, OAuth abandoned) post to Discord channel via existing `discord.ts`. Optional, controlled by `KAIROS_DISCORD_WEBHOOK_URL` env

**Why this matters for "extremely smart":** an agent that talks over you during focus mode is dumb. An agent that costs $50/day in token spend without you knowing is dumb. An agent that fails silently is dumb.

**WS events added:**
```
cost_update     { session_cost_usd, daily_cost_usd, tokens_in, tokens_out, model }
restraint_block { reason: 'focus' | 'cooldown' | 'karma' | 'dryrun', what: 'speak' | 'tool' }
```

#### E.2.7 — Cancel / barge-in (1 day)

- Detect user voice (mic amplitude > threshold via existing `BargeInDetector.swift`) while KAIROS is speaking
- Helper emits `barge_in` event
- Conductor: abort current Tier 2 stream, cancel in-flight tool call (if cancelable), call `stop_speaking` on helper
- Resume listening immediately
- Existing `BargeInDetector.swift` handles audio side; we wire the abort signal in Conductor

#### E.2.8 — Validation gate + tag v0.7.0 (1 day)

End-to-end demos that must pass:

**Composio actions:**
1. **"What's on my plate from Linear?"** → list issues → speak summary
2. **"Summarize my emails from this morning"** → triggers Gmail connect flow → completes OAuth → fetches → summarizes
3. **"Add a high-priority Linear ticket for the auth bug"** → creates issue → confirms with ID
4. **"Block 30 min on my calendar tomorrow at 2pm"** → calendar.create_event → confirms

**KAIROS introspection (voice = THE interface):**
5. **"What skills do you have?"** → reads SkillRegistry → speaks list
6. **"What did I do yesterday?"** → reads `mem_l2_episodes` for prior day → summarizes
7. **"Remember that my manager is Sarah"** → writes L3 fact (with confirm) → next "email my manager" call resolves Sarah
8. **"Add a standing order to summarize my inbox every weekday at 9am"** → uses OrdersAuthor → reads back rule → confirms on "yes"

**Smart-agent behaviors (the 14-subsystem integration):**
9. **Proactive context:** user asks "what was that file I just had open?" → answers without tool call (uses FileEvents observer state)
10. **Persona influence:** soul.md tone="casual" → ack speech "got it" vs tone="formal" → "of course"
11. **Restraint:** Focus mode on → KAIROS suppresses non-urgent proactive speech, queues for later
12. **MCP tool:** user asks something requiring a connected MCP server's tool → KAIROS uses it transparently
13. **Internal intent:** user says "tell me about my recent activity" → KAIROS invokes a registered IntentRegistry intent
14. **Self-improvement:** after 5 successful "summarize emails" turns, AwmWorker crystallizes a new skill → next call uses crystallized skill instead of raw chain

**Reliability:**
15. **Cancel during agent run:** user speaks while KAIROS is speaking → KAIROS stops mid-sentence, listens
16. **Failure path:** simulate Composio 500 → KAIROS reports failure via Discord + speaks graceful retry
17. **Cost cap:** typical 10-turn session under $0.05 on the locked 3-tier strategy; CostTracker shows totals via WS

When all 17 pass: tag `v0.7.0`.

---

### Phase F — Proactive triggers

**Goal:** KAIROS speaks unprompted at the right moment.
**Duration:** ~1 week.
**Tag:** `v0.8.0` — Proactive co-worker.

#### F.1 — Voice-out path (2 days)

- Daemon emits `proactive_speak` event when reactive evaluator fires an action with `kind: speak`.
- Tier 1 generates the spoken sentence from event context.
- StreamingSpeaker plays it.
- Electron HUD pulses to draw user attention.

#### F.2 — Interruption gate (2 days)

**New code:** `src/daemon/persona/interruptionGate.ts`

- Reads `soul.md` `do_not_disturb` schedule + focus-mode signals (macOS Focus status via swift helper).
- Priority levels: urgent / important / nice-to-have.
- Returns: speak now / queue for later / suppress.

#### F.3 — Standing-orders DSL extension (2 days)

- Add `speak_voice` action type to `src/daemon/orders/v2/actionDispatcher.ts`.
- Example DSL:
  ```yaml
  on: googlecalendar.event_starting
  when: minutes_until_start == 5
  do: speak_voice("You have ${event.title} in 5 minutes")
  priority: important
  ```
- Author UI: persona editor lets user add/edit voice-rules in plain English (Tier 1 compiles to DSL).

#### F.4 — Phase D events → voice (1 day)

- Wire existing Phase D event types (calendar_event_created, gmail_new_message, linear_issue_assigned, etc.) into reactive evaluator.
- Default ruleset bundled in app: calendar 5-min warning, urgent emails, P0 tickets assigned.

#### F Validation gate

- KAIROS speaks unprompted for at least 3 trigger types.
- Interruption gate respects Focus mode (test by enabling Do Not Disturb).
- User can author a new voice-rule via UI within 30 seconds.
- Tag `v0.8.0`.

---

### Phase G — Living Oval HUD

**Goal:** beautiful native UI that makes the app feel alive.
**Duration:** ~2 weeks.
**Tag:** `v0.9.0` — Visual polish.

#### G.1 — Swift `KairosHUD` helper (5 days)

**New folder:** `apps/macos/KairosHUD/`

- Tiny Swift binary (~300 LoC), spawned by Electron, controlled over stdio.
- Owns a transparent `NSPanel` that floats over all apps, joins all Spaces, non-activating.
- SwiftUI view inside renders the **Living Oval**:
  - Idle: subtle ambient glow
  - Listening: ripple animation tracking mic amplitude
  - Thinking: pulsing
  - Speaking: waveform synced to TTS audio
  - Error: red glow + message
- Liquid Glass (NSVisualEffectView + custom CALayers).
- Position: bottom-center by default; user-draggable.

#### G.2 — Electron full UI (5 days)

**New React routes:**
- `/` — main dashboard: conversation timeline + activity feed
- `/persona` — soul.md editor (rich text, autosaves)
- `/integrations` — Composio toolkit connection manager
- `/standing-orders` — visual rule editor (toggles + plain-English authoring via Tier 1)
- `/settings` — model/voice/hotkey/account

#### G.3 — First-run onboarding wizard (3 days)

Sequence:
1. Welcome + privacy
2. Mic + Speech Recognition + Accessibility + Screen Recording permission prompts (Swift-driven)
3. Sign in to KAIROS Cloud (Apple / Google OAuth)
4. Connect Composio integrations (Calendar required, others optional)
5. Persona setup (3 questions → seed soul.md)
6. First conversation: KAIROS introduces itself

#### G Validation gate

- HUD renders with Liquid Glass on a Mac 14.2+ with all 5 visual states.
- Settings UI lets user change model/voice/hotkey without restart.
- Onboarding completes successfully from fresh install in under 3 minutes.
- Tag `v0.9.0`.

---

### Phase H — Clicky-style screen guidance

**Goal:** "show me how" / "where do I click" intents render a pointer overlay.
**Duration:** ~1 week.
**Tag:** `v0.9.5` — Screen-aware co-worker.

#### H.1 — `KairosScreenHelper` Swift binary (2 days)

**New folder:** `apps/macos/KairosScreenHelper/`

- Uses `ScreenCaptureKit` (macOS 14.2+).
- Command `capture_screen` → returns base64 PNG of focused display.
- Multi-monitor: returns labeled array.

#### H.2 — Vision LLM adapter (1 day)

- New `src/daemon/voice/visionAdapter.ts`.
- POSTs screenshot + prompt to `openai/gpt-4o` (configurable via `KAIROS_VISION_MODEL`).
- System prompt: "When the user asks where to click or what to do, embed `[POINT:x,y:label:screenN]` tags for each target you reference."

#### H.3 — Pointer overlay (2 days)

- Extend `KairosHUD` with a `point_at(x, y, label)` command.
- SwiftUI bezier-arc animation: cursor flies from current position to (x,y) over ~600ms.
- Optional pulse + label callout.

#### H.4 — Voice intents (1 day)

- Tier 1 classifier learns: "show me", "where do I click", "guide me through", "look at my screen".
- On detect: orchestrator routes to vision flow (capture → vision LLM → parse POINT tags → HUD animates).

#### H Validation gate

- 5 real apps (Figma, Cursor, Slack, Mail, Calendar): "how do I X" successfully points at the right UI.
- Multi-monitor works (point lands on correct screen).
- No CGEvent click synthesis in v1.0 — pointing only.
- Tag `v0.9.5`.

---

### Phase I — Production hardening + KAIROS Cloud

**Goal:** v1.0.0 public release.
**Duration:** ~2-3 weeks.
**Tag:** `v1.0.0`.

#### I.1 — KAIROS Cloud (8-10 days)

**Stack:**
- **Runtime:** Cloudflare Workers + D1 (low cost, global edge) — same pattern Clicky uses.
- **Auth:** Apple Sign In + Google OAuth via WorkOS or Clerk.
- **Billing:** Stripe subscriptions, $X/mo tier.
- **Routes:**
  - `POST /auth/login` → session JWT
  - `POST /v1/llm/complete` → proxies to OpenRouter with KAIROS's server-side key
  - `POST /v1/composio/connect` → server-side OAuth dance, stores per-user tokens
  - `GET /v1/usage` → per-user token + tool-call counters
- **Cost guardrails:** per-user daily token caps, rate limits.

**Daemon-side changes:**
- `wrapApi/adapters/*` get a `KAIROS_CLOUD_URL` mode; when set, requests proxy through Cloud instead of OpenRouter directly.
- One-line flip in `voice-live.ts`.

#### I.2 — Code signing + notarization (3 days)

- Apple Developer Program enrollment ($99/year).
- Sign all Swift helpers + Electron app + electron-builder pipeline.
- Notarize via `notarytool` CLI.
- Hardened runtime entitlements:
  - `com.apple.security.device.audio-input` (mic)
  - `com.apple.security.device.camera` (screen — yes, ScreenCaptureKit needs this slot)
  - `com.apple.security.cs.allow-jit` (Electron V8)
- Strip ad-hoc signing from dev scripts.

#### I.3 — Auto-update (2 days)

- `electron-updater` for the Electron app (configured with GitHub Releases or own S3 bucket).
- Sparkle for Swift helpers (separate update channel — only when helpers change).
- Stagger: 10% → 50% → 100% rollout.

#### I.4 — Telemetry + crash reporting (2 days)

- Sentry for crashes (Electron + Swift).
- PostHog for opt-in usage telemetry (which tools used, which models, p50/p95 latency).
- Strict privacy: NO transcripts, NO message content. Just event names and timings.

#### I.5 — Distribution (2 days)

- DMG installer with branded background.
- Privacy policy + terms hosted on docs site (Vercel).
- Landing page (kairos.local → kairos.ai eventually).
- Download tracking via PostHog.
- TestFlight optional for beta channel.

#### I Validation gate

- 5 friends install from DMG with no manual steps.
- Crash → Sentry receives it → developer notified.
- Auto-update from `v1.0.0-rc.1` → `v1.0.0` succeeds without user action.
- Stripe subscription flow works end-to-end.
- Tag `v1.0.0` — public launch.

---

## Cross-cutting concerns

### Error recovery
- Every LLM call wrapped in retry-with-backoff (3 attempts, exponential).
- Composio failures route to Phase E.2's "self-healing" subagent (deferred design [[kairos-phase-e2-self-healing]] — bring back into scope here).
- Network drops handled in WS client: reconnect with backoff.

### Logging
- Structured logs (Pino) in daemon, written to `~/Library/Logs/KAIROS/daemon.log`.
- Helper NSLog goes to Console.app under `KairosVoiceHelper` subsystem.
- Sentry forwards errors only.

### Cost tracking (per-user, server-side)
- Cloud meters tokens + tool calls.
- Soft cap: warn at 80% of daily quota.
- Hard cap: switch to read-only mode if exceeded (no new actions, just chat).

### Privacy
- soul.md and conversation history stay on user's machine.
- Cloud sees: token counts, tool names + categories (not arguments), latencies.
- Composio OAuth tokens stored server-side encrypted; revocable via integrations UI.

## Open questions to revisit per phase

These are noted but not yet decided. Re-open per phase:

1. **E.2:** Use `@openai/agents` SDK or build minimal orchestrator? Decide after spike.
2. **E.2:** Synchronous voice during 30s tool chains — does it feel slow or comforting? UX test.
3. **F:** How do we let user voice-edit standing-orders? "Don't bother me with Linear updates" → ruleset diff.
4. **G:** Does the HUD position float automatically based on active app, or always bottom-center?
5. **H:** Do we ship click synthesis in v1.0 (Accessibility API), or pointing-only? Pointing is safer.
6. **I:** Cloudflare D1 vs Supabase vs Neon for Cloud datastore? Probably D1 (no separate vendor).
7. **I:** Distribute via DMG only, or Mac App Store too? App Store adds review friction; start with DMG.

## Dependency graph

```
E.1 ✅ ──┬─→ E.2 (voice agent) ──┐
         │                       ├─→ F (proactive) ──┐
         │                       │                   ├─→ I (production)
         │                       └─→ G (HUD) ────────┤
         │                              ↑            │
         └─→ ... ── H (Clicky) ─────────┘            │
                          ↑                          │
                          └──── needs HUD overlay ───┘

Critical path: E.1 → E.2 → F → G → I (~7 weeks)
H runs parallel to F if extra capacity.
```

## Decisions locked 2026-05-30

| Decision | Choice |
|---|---|
| Architecture | Daemon-client (Arch A) — confirmed; matches Clicky pattern |
| MVP scope | All three (voice agent + proactive + Clicky) woven |
| Audience | Public release, code-signed + Cloud-backed |
| Timeline | Open-ended, ship-when-ready |
| Voice UX during actions | Synchronous narration (Tier 1 between Tier 2 tool calls) |
| KAIROS Cloud | Build first, ship cloud-only in v1.0.0 |
| Multi-agent orchestrator | Build in E.2 (now), not deferred |
| LLM stack | gpt-4o-mini (Tier 1) + Kimi K2 (Tier 2) + Kimi K2 Thinking (Tier 3 rare) + gpt-4o vision |
| Anthropic | Removed from Cloud; Claude Code kept as dev-only fallback |
| All config | env vars only (`KAIROS_*`), never touch user's shell config |

## Next concrete action

Start **Phase E.2.1 — Orchestrator scaffolding**.

Begin by:
1. Adding placeholder env vars to `.env` (`KAIROS_FAST_MODEL`, `KAIROS_SMART_MODEL`, `KAIROS_DEEP_MODEL`)
2. Writing `docs/superpowers/plans/2026-XX-XX-phase-e2-orchestrator.md` with task-level breakdown via writing-plans skill
3. Executing the plan via subagent-driven-development with **always Opus** (per [[feedback-subagent-model-opus]])
