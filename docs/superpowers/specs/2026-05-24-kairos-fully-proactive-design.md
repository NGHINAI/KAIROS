# KAIROS — Fully Proactive AI: Design Specification

> **Date**: 2026-05-24
> **Status**: APPROVED (all 7 sections), ready for implementation planning
> **Owner**: Nirmal Ghinaiya
> **Builds on**: Existing KAIROS sandbox at `~/Desktop/kairos-sandbox/` (L1-L5 self-evolution + B/H + Discord bot already shipped)

---

## Executive summary

KAIROS evolves from a tick-driven background daemon into a **fully proactive AI assistant** that runs natively on macOS. It continuously observes the user's activity across local apps and connected cloud services, maintains a layered memory of what's happening, predicts what matters, and acts before being asked — while staying private (data lives on the user's Mac), self-improving (skills/triggers/prompts/code evolve from experience), and OS-integrated (Liquid Glass UI, voice-first interaction, push-to-talk).

The shift: **"ask → answer" becomes "observe → act."** The model prompts the user, not the other way around.

---

## Vision

A proactive AI assistant that:

- **Lives on your Mac**, not in your browser
- **Observes continuously** across local apps and 4-6 cloud services
- **Maintains layered memory** (working, episodic, semantic, procedural) at the scale of years of use
- **Acts on its own** at the right autonomy tier — small reversible actions silently, moderate actions with one-tap approval, irreversible actions with full preview
- **Talks back** via voice when you press a hotkey (Wispr Flow pattern)
- **Self-improves continuously** — writes new skills from successful workflows (Hermes pattern), iterates skills mid-execution, evolves prompts and source code with user approval
- **Looks like an Apple product** — Liquid Glass HUD, native macOS feel, motion physics
- **Is private by architecture** — data never leaves the user's machine; brain is local markdown + SQLite
- **Scales commercially** with high margins because compute runs on the user's machine

---

## Architecture overview

Five-stage continuous loop running 24/7 in the daemon:

```
1. OBSERVE       Lightweight watchers emit events (local + cloud)
       ↓
2. AGGREGATE     Append-only event stream + live state snapshot
       ↓
3. NARRATE       Every 2-5 min: Haiku summarizes recent state into
                 2-3 sentence "what's happening" narrative
       ↓
4. TRIGGER       Rules + LLM evaluate state changes for "right moments"
                 (built-in catalog + learned from user patterns)
       ↓
5. ACT           Compose action via Sonnet, dispatch via MCP-based
                 connectors at the right autonomy tier (🟢🟡🟠🔴)
       ↑↓
   Loop back to OBSERVE — actions become next-cycle inputs
```

This loop is wrapped by:
- **A 4-layer cognitive memory** (Section 3) that stores everything observed and consulted on every action
- **A self-evolution loop** (Section 5) that improves skills/triggers/prompts/source from experience
- **A triple-surface UI** (Section 6) for menu bar + Liquid Glass HUD + voice

---

## Section 1: The Core Loop

### Five stages

```
1. OBSERVE       ← lightweight watchers emit events
   (focus app, browser tabs, calendar, files, clipboard, mail, messages,
    terminal, idle state — each is a "skill" in the registry, runs forever)
            ↓
2. AGGREGATE     ← all events flow into one append-only event stream,
                   plus a live "current snapshot" of state
            ↓
3. NARRATE       ← every 2-5 min, claude -p Haiku summarizes recent events
                   into a 2-3 sentence "what's happening" narrative
                   (this is KAIROS's working memory)
            ↓
4. TRIGGER       ← rules + LLM evaluate state changes for "moments"
                   (built-in triggers + learned ones from your patterns)
            ↓
5. ACT           ← when a trigger fires, claude -p Sonnet composes the
                   action (notify / draft / execute) at the right autonomy
                   tier (🟢🟡🟠🔴)
```

### Why each stage

- **OBSERVE is plugin-based** — uses the existing skill registry (L1). Adding an observer is dropping a script into `skills/observers/`. Same architecture as L1 but for inputs not invocations.
- **AGGREGATE is a single event bus** — all observations flow into one SQLite table (`world_state_events`). A view computes the "now" snapshot (last event per source). This is KAIROS's *situational awareness*.
- **NARRATE is the cost-control layer** — instead of feeding raw events into every decision, KAIROS maintains a tight 2-3 sentence narrative that's the input for trigger evaluation. Updates every 2-5 min OR on significant state changes (app switch, calendar event approaching, message arrives).
- **TRIGGER is where "now is the right moment" lives** — separate from the narrative. Most triggers say no most of the time. Only when several signals align does a trigger fire.
- **ACT closes the loop** — KAIROS's own actions become observations next cycle. If KAIROS sent a Slack reply, the next narrative includes that.

### "Human-like context-switching"

The **AGGREGATE → NARRATE** pair is how a human colleague stays oriented when you switch contexts:
- You close VS Code, open Slack → focus-app event fires → snapshot updates → narrative regenerates in ~10s
- Narrative becomes: "Nirmal stopped editing auth.ts (was deep, 90 min). Switched to Slack. 3 unread DMs."
- Triggers re-evaluate against new narrative — different triggers become relevant

KAIROS doesn't have to be "told" you switched. It notices, updates its mental model, and re-evaluates what's worth saying.

### Cost reality

Narrative summarization is the only continuous LLM cost. Every 5 min with Haiku 4.5 on ~1500 token input → ~$0.0003/run → **$0.09/hour, $0.72 for an 8-hour day, ~$20/month** continuous. Trigger evaluations are mostly rule-based (free); LLM only when ambiguous. Action composition cost scales with how much KAIROS actually does.

---

## Section 2: The Observer Network

### Tier 1: Local observers (always-on, zero-auth)

| Observer | What it watches | How |
|---|---|---|
| `focus-app` | Frontmost app + window title | macOS Accessibility API (every 2s) |
| `active-document` | Currently-edited file/doc | Heuristic: focus app + last-modified file in cwd |
| `browser-tabs` | Open tabs, current URL, page title | AppleScript on Chrome/Safari/Arc (every 10s) |
| `clipboard` | Recent copies (with redaction) | NSPasteboard polling (every 5s) |
| `file-events` | Saves/creates/deletes in watched dirs | `fs.watch` recursive |
| `terminal-activity` | Recent shell commands | Tail `~/.zsh_history` |
| `calendar-local` | Upcoming events from Mac Calendar.app | `icalBuddy` CLI (every 5 min) |
| `mail-local` | Unread count + recent senders | Mail.app AppleScript (every 2 min) |
| `messages-local` | Unread iMessage threads | Read `~/Library/Messages/chat.db` (SQLite, every 30s) |
| `idle-state` | User active vs away vs in-meeting | `pmset -g` + camera-light detection |
| `system-state` | Battery, network, time-of-day | System APIs |
| `voice-input` | Transcribed user speech (on hotkey) | Whisper.cpp local or Whisper API |

All Tier 1 observers run in the daemon. No auth required.

### Tier 2: Cloud connectors (auth required, opt-in)

| Connector | API | Auth flow | Acts as you |
|---|---|---|---|
| `gmail` | Gmail API v1 | OAuth 2.0 (Google) | ✅ sends from your address |
| `google-calendar` | Calendar API v3 | OAuth 2.0 (Google) | ✅ creates events on your calendar |
| `slack` | Slack Web API + Socket Mode | OAuth (user token) | ✅ sends as @you |
| `github` | GitHub REST + GraphQL | OAuth or PAT | ✅ commits/comments as @you |
| `discord` | Existing implementation | Bot token | bot identity |
| Future | Notion, Linear, Jira | Their OAuth | ✅ |

**Explicitly excluded**: X/Twitter, LinkedIn (API friction too high to be worth it).

### Connector architecture — three surfaces per connector

```
skills/connectors/slack/
├── manifest.json          declares capabilities, auth scopes, observation cadence
├── auth/
│   └── oauth.ts           one-time OAuth flow → tokens in Keychain
├── observer/
│   └── monitor.ts         LONG-RUNNING — WebSocket/poll/webhook → emits to event bus
├── mcp.json               points to MCP server providing the action tools
└── actions/               OR: native action scripts (if no MCP server exists)
    ├── send.ts
    └── react.ts
```

| Surface | Lifecycle | Purpose |
|---|---|---|
| **Observer module** | Long-running (lives in KAIROS daemon) | Continuous monitoring — feeds the world state |
| **MCP action server** | Stdio child, spawned & pooled per service | The tool surface — send, post, query |
| **Auth flow** | One-time setup, refresh on token expiry | Bridge to OAuth, tokens in Keychain |

The observer lives in our daemon (not in the MCP server), so it can use whatever monitoring mechanism is appropriate (WebSocket, webhook, polling). The MCP server provides the action surface.

### OAuth flow (how "act on behalf" actually works)

```
User in KAIROS menu bar: clicks "Connect Slack"
        ↓
KAIROS opens browser to: https://slack.com/oauth/v2/authorize?...
        ↓
User signs in, clicks "Authorize"
        ↓
Slack redirects to localhost:8843/oauth/callback?code=xyz
(KAIROS daemon runs a tiny HTTP server on this port for OAuth callbacks)
        ↓
KAIROS exchanges code → access token + refresh token
        ↓
Tokens stored in macOS Keychain via `security` CLI (encrypted, OS-managed)
        ↓
KAIROS now makes API calls with that token
→ Slack sees the request and says "this is from @nirmal"
```

For the user: click → approve in browser → done. One time per service. Token refresh happens silently.

### Monitoring mechanism per service

| Connector | Best mechanism | Notes |
|---|---|---|
| `slack` | **Socket Mode (WebSocket)** | True real-time push, no polling, no public endpoint |
| `discord` | **Gateway WebSocket** | Already wired ✓ |
| `gmail` | **Push (Pub/Sub)** or polling every 60s | Push needs GCP project setup; polling is simpler |
| `github` | **Webhooks via tunnel** or polling every 2min | Webhooks need public URL via tunnel |
| `google-calendar` | **Push notifications** or polling every 5min | Same as Gmail |
| `notion` | Polling every 2min | No webhooks for personal |
| `linear` | **Webhooks** | First-class support |

Default for shipping: polling everywhere (simplest, works without external infra). Per-connector, KAIROS can self-upgrade to push mechanisms when the user is comfortable.

### Privacy & control

- Each observer is **individually toggleable** in settings
- **Default state at install**: focus-app, browser-tabs, calendar-local — the safe basics
- **Opt-in to expand**: clipboard, messages-local, voice (each one explicit consent)
- **Cloud connectors are all explicit** — you connect Gmail when you want, not auto
- **Per-source rate limits** and **redaction filters** (regex-based, e.g., never log credit-card-shaped strings)
- **"Pause KAIROS"** global hotkey — stops all observers for N min (deep work mode)

---

## Section 3: The Memory System

A **layered cognitive memory architecture** inspired by human memory. Built to scale, designed to compose.

### Four memory layers

```
                       ┌──────────────────────────────────┐
                       │ WORKING MEMORY                    │  hot, ms latency
                       │ current narrative + last 60 min  │  in-memory + SQLite
                       └────────────┬─────────────────────┘
                                    ↓ flush every 5 min
                       ┌──────────────────────────────────┐
                       │ EPISODIC MEMORY                   │  warm, sec latency
                       │ append-only timeline of events    │  SQLite + JSONL
                       │ what happened, when, with whom    │  per-day shards
                       └────────────┬─────────────────────┘
                                    ↓ consolidation (dreams)
                       ┌──────────────────────────────────┐
                       │ SEMANTIC MEMORY                   │  warm, sec latency
                       │ distilled facts, entities,        │  GBrain-pattern
                       │ relationships — "what is true"   │  markdown + pgvector
                       └────────────┬─────────────────────┘
                                    ↓ pattern extraction
                       ┌──────────────────────────────────┐
                       │ PROCEDURAL MEMORY                 │  on-demand
                       │ skills, workflows, learned        │  skills/ + workflows/
                       │ shortcuts                         │
                       └──────────────────────────────────┘
```

### Working memory
- Partial RAM, mirrored to SQLite for crash safety
- Contains current narrative + last 60 min of events
- Updated continuously by AGGREGATE step from Section 1
- Used directly by trigger evaluation — no retrieval needed
- Flushes older entries to Episodic every 5 minutes

### Episodic memory (the timeline of "what happened")
- **The system of record** — every observation, every action, every decision stored
- Format: append-only JSONL files in `~/.kairos/brain/episodes/YYYY-MM-DD.jsonl` + SQLite index for fast queries
- Each entry has: timestamp, source, type, payload, entities mentioned, importance score, related-to (links)
- Per-day shards = naturally bounded files, easy to back up, simple to compress old days
- Queryable by: time range, source, entity, importance threshold, related-to chains
- **Privacy**: episodic memory NEVER leaves the user's machine

### Semantic memory (the "what is true")
- **Use GBrain directly** (MIT-licensed, drop-in)
- Markdown files in `~/.kairos/brain/notes/` organized by entity type:
  ```
  brain/
  ├── notes/
  │   ├── people/
  │   │   ├── nirmal.md
  │   │   └── john-collison.md
  │   ├── projects/
  │   │   ├── certusai.md
  │   │   └── kairos.md
  │   ├── decisions/
  │   │   └── 2026-05-02-use-bun-for-daemon.md
  │   └── topics/
  │       └── auth-refactor.md
  ```
- GBrain handles: auto-linking (`[[nirmal]]` creates an edge), hybrid retrieval (vector + BM25 + RRF), self-wiring graph
- Storage: pgvector for embeddings (or sqlite-vec for solo/local)
- Local embedding model: **nomic-embed-text** via Ollama or fastembed — runs entirely on-device
- Markdown is the source of truth — `git init` your brain and version-control it

### Procedural memory (the "how to do things")
- Already exists as the skill registry (L1-L5)
- Extended to include **workflows** — multi-step plans KAIROS has executed before
- A workflow is itself a skill (composable)
- Learned shortcuts: KAIROS observes a pattern → proposes a skill that automates it

### Key memory operations

| Operation | What it does | Implementation |
|---|---|---|
| **observe(event)** | New event arrives | Append to working + episodic |
| **consolidate()** | Run a "dream" | Read recent episodes → extract entities → update semantic notes |
| **recall(query)** | "What do I know about X?" | Hybrid retrieval across all 4 layers, with provenance |
| **forget(rule)** | Prune by importance/age | `importance × exp(-age_days / half_life)`, threshold-cutoff per layer |
| **introspect()** | Self-query | "What do I know about my own behavior?" |
| **link(a, b, type)** | Build graph edges | Auto via writes, rarely manual |

### Forgetting curve

```
relevance(memory, now) = importance × exp(-age_days / half_life) × log(1 + access_count)
```

- Half-life depends on layer: Working = hours, Episodic = months, Semantic = years
- When relevance drops below threshold:
  - Episodic: archive to compressed cold storage
  - Semantic: archive markdown to `brain/archive/` and remove from active embeddings
- Frequently-accessed memories never decay (the `log(1 + access_count)` term)
- **User can pin** any memory as "never forget" via UI

### Tech stack for memory

| Component | Tech | Why |
|---|---|---|
| Episodic store | SQLite + JSONL shards | Bun-native, append-only is simple |
| Semantic store | Postgres + pgvector (or sqlite-vec for solo) | GBrain works with both |
| Embeddings | nomic-embed-text via fastembed | Local, ~100ms, free, good for English+code |
| Full-text search | SQLite FTS5 + ripgrep for fallback | Built-in, fast BM25 |
| Graph edges | Relational (just rows) | Don't need Neo4j for our scale |
| Markdown layer | Plain files, git-tracked | Human-readable, future-proof |

### Scalability

- **Single-user, 5 years of use**: ~5M episodic events (~5GB), ~10K semantic notes (~50MB), ~100K embeddings. **SQLite handles all of this on a laptop.**
- **Multi-user commercial**: Move semantic + embeddings to Postgres+pgvector per-user or shared workspace. Episodic still per-user local. Brain export/sync via signed delta files (GBrain pattern).

### What changes for existing KAIROS

| Current | Becomes |
|---|---|
| `MEMORY.md` | One of the semantic notes (`brain/notes/people/nirmal.md`) plus other notes |
| `memory_candidates` table | Feeds the consolidation pipeline |
| `tasks`, `messages`, `ticks` tables | Mirrored to episodic memory as events |
| `feedback` table | Feeds importance scoring for memory decay |
| Dream consolidation | Generalized to consolidate episodic → semantic across all categories |

---

## Section 4: The Action Network

### The Action Bus (orchestrator)

A single class that all actions flow through. Sits between the trigger system and the connectors.

```
trigger fires → ActionBus.execute({
  intent: "send Slack message",
  target: "John Smith",
  payload: "drafted text",
  source_trigger: "MessageContext",
  autonomy_required: "yellow",
})
       ↓
ActionBus:
  1. Classify autonomy tier (🟢/🟡/🟠/🔴)
  2. If 🟢: just execute. If 🟡: execute + flag in HUD. If 🟠: queue for approval. If 🔴: full preview UI.
  3. Resolve the right MCP server (slack)
  4. Call the right tool (chat.postMessage)
  5. Capture result, cost, latency
  6. Write to episodic memory (every action recorded)
  7. Update connector health metrics
  8. Fire post-action observation event
```

### Built-in action registry (default tiers)

| Action | Tier | Connector |
|---|---|---|
| Read inbox / list events / fetch repo | 🟢 always | gmail, calendar, github |
| Mark email read / snooze / archive | 🟡 reversible | gmail |
| Add reaction emoji | 🟡 reversible | slack, discord |
| Save draft / create note | 🟢 always | gmail (draft), notion |
| Set calendar to busy | 🟡 reversible | calendar |
| Send Slack DM (1 person) | 🟠 ask first | slack |
| Send email | 🟠 ask first | gmail |
| Comment on PR | 🟠 ask first | github |
| Create calendar event | 🟠 ask first | calendar |
| Post to channel (>1 person) | 🔴 always preview | slack |
| Send email to multiple recipients | 🔴 always preview | gmail |
| Merge PR | 🔴 always preview | github |
| Delete email/event/issue | 🔴 always preview | all |

KAIROS learns from user overrides (L4 evolution): if you keep auto-approving Slack DMs to your team, KAIROS will propose downgrading them from 🟠 → 🟡.

### MCP servers — use the ecosystem

Drop-in MCP servers from the official `@modelcontextprotocol` org or community:

| Service | MCP server |
|---|---|
| Slack | `@modelcontextprotocol/server-slack` |
| GitHub | `@modelcontextprotocol/server-github` |
| Gmail | `mcp-server-gmail` (community) |
| Google Calendar | `mcp-google-calendar` |
| Notion | `@modelcontextprotocol/server-notion` |
| Filesystem | `@modelcontextprotocol/server-filesystem` |
| Memory (our brain) | We build this — exposes the Brain |

**KAIROS daemon embeds an MCP CLIENT** (use the existing SDK from the shim). The daemon calls any MCP server's tools by name. The Action Bus orchestrates this.

MCP server pooling: keep N=5 MCP servers always-warm, scaled up if demand spikes. No per-action spawn cost.

### Webhook receiver

For services where webhooks are first-class:

```
KAIROS daemon runs a tiny webhook server (HTTPS) on localhost
  ↓
For services that need a public URL:
  - Option A: Cloudflare Tunnel (zero-config, free) — KAIROS auto-creates
  - Option B: ngrok (also zero-config)
  - Option C: Tailscale Funnel (if on Tailscale)
KAIROS picks the available option and configures the webhook URL automatically.
  ↓
Incoming webhook → handler validates signature → emits event to bus
```

This means truly push-based monitoring for any service that supports webhooks.

### Innovative aspects

1. **MCP servers shared with other agents** — your Slack MCP server can be used by KAIROS, Claude Code, Cursor, anyone else simultaneously. Connectors aren't locked in.
2. **Action skills are self-improving** — L4 prompt evolution applies to action composition. After 100 Slack messages, KAIROS knows your tone.
3. **Connector skills are self-generating** — L2 means "KAIROS, connect to Linear" → KAIROS writes the Linear connector skill.
4. **Action provenance everywhere** — every action carries `source_trigger`, `composed_from_memories`, `autonomy_tier`, `outcome`. Full audit trail.
5. **Connector marketplace** — same pattern as skills marketplace (future). Signed + sharable.

---

## Section 5: Trigger Engine + Self-Evolution Loop

### Part A: Trigger Engine

A trigger watches state and decides "this is a moment that deserves an action."

#### Trigger taxonomy

| Kind | Fires on | Examples |
|---|---|---|
| **Time triggers** | Clock/calendar conditions | "Standup in 10 min", "End of business day" |
| **State triggers** | World-state thresholds crossed | "Focus session ended after 30+ min deep work" |
| **Pattern triggers** | Recurring signals in episodic memory | "Same SO question 3 times this week" |
| **Signal triggers** | Inbound event of specific type | "New PR review request" |

#### Tiered evaluation (cheap → expensive)

```
On every world-state change OR every 30s:
  Stage 1 (FREE): SQL-based rule matching
    - 50 triggers registered → 2-5 candidates per evaluation
  Stage 2 (CHEAP): Pattern matching + heuristics + confidence scoring
    - Filter to high-confidence candidates (>0.6)
  Stage 3 (LLM, $0.0003): Haiku adjudication for ambiguous cases
    - Output: SHOULD_FIRE | DEFER | DROP
  Stage 4: Hand off to ActionBus with autonomy tier
```

Most triggers decided in Stage 1 or 2 (free). Stage 3 only for genuinely ambiguous moments.

#### Interruption budget

```
allowed_interruptions = base_rate × focus_state_modifier × time_of_day_modifier × historical_appetite

  base_rate = 2/hour
  focus_state_modifier:
    deep focus (45+ min same app/file)    = 0.2x
    light focus (10-45 min)               = 1.0x
    context switching (<5 min per app)    = 1.5x
    idle/away                             = 0.5x
  time_of_day_modifier:
    typical work hours                    = 1.0x
    early morning / late night            = 0.3x
    weekends                              = 0.5x
  historical_appetite:
    learned from acceptance rate          = 0.6x - 1.2x
```

If hourly budget already used, the trigger fires SILENTLY into menu bar (no HUD pop-out).

#### Built-in trigger catalog (ships with KAIROS)

| Trigger | Class | Description |
|---|---|---|
| MeetingPrep | Time | 10-15 min before event → summarize relevant docs/threads |
| MeetingMissed | Time | Event passed without attendance → "Did you skip?" |
| EndOfFocus | State | After deep work, idle 2+ min → suggest commit/save |
| MessageContext | Signal | Inbound Slack/Gmail → prepare drafted reply with context |
| NewCommit | Signal | Git commit detected → ask about PR |
| CIPassed/Failed | Signal | GitHub CI change → prepare next action |
| MentionedAcrossSources | Pattern | Same person 3+ times today → surface their context |
| RepeatedFailure | Pattern | Same task failed 3+ times → propose alternate approach |
| NewContact | Signal | New person in Gmail/Calendar → create semantic note |
| DecisionAnnouncement | Pattern | "Let's go with..." → extract decision into brain |
| MorningStart | Time | First activity after >6hr idle → load yesterday's threads |
| EndOfDay | Time | Winding-down pattern → draft EOD summary |

#### Learned triggers

KAIROS discovers new triggers from episodic memory:

```
Every dream cycle:
  1. Scan episodic for repeated user-initiated patterns
  2. Propose a new trigger to automate the pattern
  3. Add in SUGGEST mode (asks first)
  4. After 5 successful firings + 0 dismissals, upgrade to AUTO mode
```

### Part B: The Self-Evolution Loop (Hermes-inspired)

Eight-cycle continuous loop:

```
OBSERVATION → REFLECTION → HYPOTHESIS → EXPERIMENT
   ↑              ↓
PROPAGATION ← CONSOLIDATION ← INTEGRATION ← MEASUREMENT
```

#### New self-evolution capabilities (beyond L1-L5)

**1. Skill-from-success (Hermes pattern, new)**

```
After every task with status=success:
  If workflow involved 3+ distinct actions across 2+ connectors:
    Spawn claude -p Sonnet:
    "Look at this sequence. Is it general enough to be a reusable skill?
     If yes, write it as a workflow skill."
  → Skill auto-generated and validated (L2 pipeline)
  → Added to library, tagged "auto-extracted from <task_id>"
```

**2. In-use skill iteration (Hermes pattern, new)**

```
Inside any skill execution:
  If skill returns error or low-confidence output:
    Catch result, package as context
    Spawn claude -p Haiku: "This skill just failed. Quick patch?"
    Apply patch IN-MEMORY for current run
    If patch succeeded → save as candidate v2
    If failed → fall back, log
```

Skills heal themselves mid-execution.

**3. Dialectic user model (Hermes pattern, new)**

```
brain/user-model/
├── claims.md          # current best-guess about user
├── evidence.md        # observations supporting claims
├── contradictions.md  # observations contradicting claims
├── synthesis.md       # reconciled view
└── unknowns.md        # things KAIROS wants to learn
```

Every 6 hours: compare new evidence against current claims; if contradiction, regenerate synthesis. Track confidence per claim.

**4. Cross-session FTS5 recall (Hermes pattern, new)**

```
1. Build query embedding + tokenize for BM25
2. Search across:
   - Current session (last hour) — verbatim
   - Past sessions (this week) — FTS5 + RRF
   - Older sessions (>1 week) — LLM-summarized clusters
3. Top-K relevant past exchanges → action composer
```

"Do that thing again" works across days/weeks.

**5. Isolated subagent spawning (Hermes pattern, new)**

```
Main daemon decides: "Need to refactor auth flow"
  → SubagentA: read codebase + propose plan
  → SubagentB: research best practices via web fetch
  → SubagentC: check brain for similar past work

Each subagent runs in its own claude -p subprocess with own context.
Main daemon collects results, synthesizes, presents to user.
```

**6. agentskills.io compatibility (industry standard, new)**

```json
{
  "name": "slack-send",
  "version": "1.2.0",
  "agentskills_compatible": "0.1",
  "description": "...",
  "input_schema": {...},
  "output_schema": {...},
  "dependencies": [...],
  "permissions": [...]
}
```

Skills built for KAIROS can run in Hermes, Cursor, Claude Desktop. Skills from other ecosystems can run in KAIROS.

### Existing self-evolution layers (already shipped)

- **L1: Skill plugin system** — drop scripts as capabilities
- **L2: Self-generated skills** — KAIROS writes new skills via claude -p
- **L3: Skill gap detection** — proposes skills from failure patterns
- **L4: Prompt evolution** — A/B test prompt versions
- **L5: Source self-modification** — proposes patches with user approval
- **L6-B: Self-debugging** — autonomous patches from recurring errors
- **L6-H: Multi-modal** — vision in Discord and skills

---

## Section 6: The UI

Three surfaces: Menu bar + Liquid Glass Floating HUD + Voice hotkey.

### Tech stack

**Primary: SwiftUI shell on macOS**
- Full access to Liquid Glass (`.glassEffect()`, `.glassBackgroundEffect()`, NSVisualEffectView materials, vibrancy)
- True Apple-native feel
- Smallest binary (~10MB)
- Daemon stays Bun/TypeScript; UI is separate Swift app talking via WebSocket
- Best for v1 polish

**Alternative: Tauri + macOS plugins**
- Rust shell + web frontend (React + Tailwind + Framer Motion)
- `tauri-plugin-macos-blur` for vibrancy injection behind web view
- ~80% Apple feel, ~30% of build cost
- Best if cross-platform matters

**Backup: Electron**
- `backdrop-filter: blur()` for visual approximation only
- Fastest path, 70% as good
- Skip unless time-critical

### Surface 1: Menu bar app

```
Menu bar icon: small KAIROS mark (⚡)
   States:
     · gray = idle, healthy
     · blue pulse = thinking
     · amber dot = pending action
     · red = error / disconnected

Click → dropdown (380px wide):

┌─────────────────────────────────────────────┐
│ ⚡ KAIROS — watching                          │
│ "Nirmal in VS Code, auth.ts, 8 min deep.    │
│  Standup in 23 min. 3 unread Slack DMs."    │
│                                              │
│ ─────────────────────────────────────────── │
│ Pending (2)                                  │
│ ┌─────────────────────────────────────────┐ │
│ │ 🟠 Reply to John in Slack                │ │
│ │ Draft: "Working on it — about 90 min in.│ │
│ │ Should be ready EOD."                    │ │
│ │ [⏎ Send] [✎ Edit] [✕ Dismiss]            │ │
│ └─────────────────────────────────────────┘ │
│                                              │
│ ─────────────────────────────────────────── │
│ Recent (5)                                   │
│ 9:02 ⏰ Pulled main + ran tests (passed)     │
│ ...                                          │
│ ─────────────────────────────────────────── │
│ Connectors                                   │
│ ✓ Slack    ✓ Gmail    ✓ GitHub   ⚠ Linear   │
│                                              │
│ ⚙ Settings · 🌙 Pause 1hr · 📖 Brain         │
└─────────────────────────────────────────────┘
```

Stable, scannable, always there. Cards color-coded by autonomy tier.

### Surface 2: Liquid Glass Floating HUD — Wispr-Flow-style oval

The "alive" surface — floats on top of all windows. **This is what makes KAIROS feel different.**

The default footprint is a **small horizontal oval pinned to the bottom-center of the screen**, ~240×40px, matching Wispr Flow's minimal visual footprint. It expands only when KAIROS speaks, listens, or surfaces an action card — otherwise it's a quiet pill showing one-line state. The user can drag to reposition; it remembers per-display location.

```
Idle state (~240×40 px oval, pinned bottom-center):
        ╭───────────────────────────────────╮
        │ ⚡  VS Code · auth.ts · standup 23m │  ← Liquid Glass oval
        ╰───────────────────────────────────╯       glass blur + refraction

Compact mode (when nothing notable — minimum footprint):
        ╭──────╮
        │  ⚡  │       ← collapses to a single glass dot
        ╰──────╯

Trigger fires (expands ~360×220 with spring animation):
┌──────────────────────────────────────────────┐
│ ⚡ John just DM'd you about auth refactor    │
│                                              │
│ ┌──────────────────────────────────────────┐ │
│ │ Draft reply:                              │ │
│ │ "Working on it — about 90 min in.        │ │
│ │  Restructured session middleware.        │ │
│ │  3 files left. ~EOD."                    │ │
│ └──────────────────────────────────────────┘ │
│                                              │
│   [⏎  Send]  [✎  Edit]  [✕  Dismiss]         │
│                                              │
│ Composed from: 90min of auth.ts edits,       │
│ semantic note about John's preferences       │
└──────────────────────────────────────────────┘

Listening state (during voice capture):
┌──────────────────────────────────────┐
│ ⚡ ▓▓▓▓▓▓▓▓░░░░░░░░░░░░  listening  │
│   "Schedule lunch tomorrow at..."    │
└──────────────────────────────────────┘
```

**HUD behavior**:
- Stays on top via `NSWindowLevel.floating`
- Draggable, snaps to screen edges
- Liquid Glass material (NSVisualEffectView with `.hudWindow` material in SwiftUI)
- Auto-hides during fullscreen video/presentations
- Right-click → preferences
- Animations via SwiftUI spring physics

### Surface 3: Voice + Global Hotkey — Wispr-style hold + hands-free toggle

Two hotkey modes matching Wispr Flow's interaction model — every binding is user-configurable in Settings.

```
Mode 1 — HOLD-TO-SPEAK (default: ⌃⇧4 / Control+Shift+4)
  Press and hold → audio capture starts (oval pulses, glass shimmer)
  Speak naturally → live transcript scrolls inside oval
  Release → transcription finalizes → routed to KAIROS

Mode 2 — DOUBLE-TAP HANDS-FREE (default: tap Control twice quickly)
  Double-tap Control → enters hands-free conversation mode (oval stays expanded)
  Speak whenever → VAD detects utterance boundaries
  KAIROS responds via TTS through the oval
  Double-tap Control again → exits hands-free mode

Mode 3 — PAUSE everything (default: ⌃⌥⌘Space)
  Instant freeze of all observers + collapse HUD to invisible
```

**KAIROS responds**:
- **Always** through the oval (text + animation)
- **By default** via TTS so the response is hands-free
- If an action is included → action card expands, awaits confirmation
- **Critically, KAIROS can also initiate** — proactive triggers cause the oval to chime + expand + speak ("Heads up, your standup starts in 2 minutes") without the user pressing anything. This is the "AI comes with you" behavior.

**Transcription**:
- **Local Whisper.cpp** — runs on-device, free, ~500ms latency
- **OpenAI Whisper API** — ~200ms, $0.006/min
- **Default**: local Whisper with API fallback if slow

**TTS** (when KAIROS speaks back):
- macOS native `say` — free, fast, slightly robotic
- ElevenLabs API — best quality, $5-22/month
- OpenAI TTS — middle ground, $0.015/1k chars
- **Default**: macOS `say` for short utterances (chimes, confirmations), ElevenLabs for proactive speech if user subscribes

**Voice Activity Detection** (for hands-free mode):
- `webrtcvad` or Silero VAD (both local, free)
- Endpoints utterances when ~800ms of silence detected
- Skip if last utterance was KAIROS's own TTS (so it doesn't loop on itself)

### Notifications

```
macOS native UNUserNotification for:
  - urgent triggers, scheduled task results
  - Sound configurable per tier
  - Action buttons inline (Approve / Dismiss / Snooze)
  - Respects Focus / Do Not Disturb
```

### Settings UI

Separate window, tabbed (~800×600):

| Tab | What's there |
|---|---|
| **Connectors** | List, status, OAuth re-auth, scope view |
| **Observers** | Toggle each. Observation count per source per day. |
| **Triggers** | Built-in + learned. Firing history, accept rate, tune. |
| **Memory** | Browse brain (markdown viewer + search). Pin/unpin. Manual prune. |
| **Skills** | Browse registry. Self-generated. Edit, version history. |
| **Voice** | Hotkey config. STT/TTS provider. Conversation mode. |
| **Preferences** | Interruption budget. Quiet hours. HUD position/opacity. |
| **Privacy** | Redaction rules. Pause schedule. Export brain. Delete all. |

### Daemon ↔ UI Communication

```
Daemon (Bun + TS) exposes:
  - HTTP REST: /tool/*, /status, /events (existing)
  - WebSocket: /ws/live  (NEW)
      - Pushes: narrative_update, new_card, card_resolved, observer_status
      - Receives: hotkey_pressed, action_confirmed, action_dismissed

UI (Swift or Tauri):
  - On launch: connects to ws://localhost:<port>/ws/live
  - Subscribes to narrative + cards stream
  - On user action: POSTs to daemon API
  - State is purely reflective — never owns truth
```

Multiple UIs can connect simultaneously (multi-monitor, multi-device via Tailscale).

### Innovative bits

1. **Live narrative pill** in HUD — always shows current awareness. **No other AI does this.**
2. **Cards with spring physics** — Framer Motion / SwiftUI. Cards fly in from edge, settle gently, flick-to-dismiss.
3. **Voice-first interaction** — never switch apps. Hold key, speak, KAIROS hears + responds.
4. **Glance + interact in 1 second** — <1s for most interactions.
5. **Connector-aware status** — HUD pill changes subtly based on what KAIROS is doing.
6. **Action composition transparency** — every card shows "composed from" provenance.
7. **Apple Intelligence-style** — Lock Screen widgets, optional Live Activity.

### Privacy + safety

- **Pause hotkey** (⌃⌥⌘Space) — instant freeze on all observers
- **Privacy mode HUD** — HUD goes blank
- **Voice-input confirmation** — short audio clip preserved per command
- **Per-app blocklist** — exclude observers from specific apps

---

## Section 7: Commercial Hosting & Distribution

### Distribution

**Two channels**:
- **Direct download from website** — full control, all APIs, ~$15/year domain + $99/year Apple Developer ID. Primary channel.
- **Mac App Store** — discoverability, but sandboxing prevents deep observers. Ships as "Lite" version. Secondary.

Infrastructure:
- Landing page: Cloudflare Pages (free)
- Binary hosting: GitHub Releases (free, signed via Developer ID)
- Auto-updater: Sparkle framework (free)
- Install flow: Download → drag-to-Applications → first-launch wizard

### Pricing tiers

| Tier | Price | What you get |
|---|---|---|
| **FREE** | $0/mo | 1 connector, 5 local observers, reactive only, local memory |
| **PRO** | $20/mo | All connectors, all observers, self-evolve, triggers, voice, BYOK |
| **PRO+** | $40/mo | Pro + hosted LLM (no API key needed), higher rate limits |
| **TEAM** | $50/user/mo | Pro+ + shared brain, skill sharing, team triggers, SSO, audit logs |

### LLM cost model

**Three options for users**:

| Option | Tier | How |
|---|---|---|
| **Anthropic subscription pass-through** | FREE | Uses Claude Pro via `claude -p` CLI. $0 incremental cost to user. |
| **BYOK (Bring Your Own Key)** | PRO | User provides Anthropic API key. KAIROS makes calls directly. $0 LLM cost to us. |
| **Hosted LLM proxy** | PRO+/TEAM | User pays $40/mo, no key needed. KAIROS proxies via our server with ~30% markup. |

**The crucial insight**: KAIROS's compute happens on the USER's machine. Server costs are tiny. High-margin business.

### Minimal backend infrastructure

| Service | Purpose | Cost |
|---|---|---|
| `kairos.dev` static site | Marketing, downloads | $0 (Cloudflare Pages) |
| `auth.kairos.dev` | OAuth flow helpers | $0 (Cloudflare Worker) |
| `updates.kairos.dev` | Sparkle update feed | $0 (Cloudflare Pages / GitHub Releases) |
| `api.kairos.dev` | License validation, billing | ~$20/mo (Hetzner VPS or Fly.io) |
| `proxy.kairos.dev` | Hosted LLM proxy (Pro+ only) | Variable, scales with users |
| `skills.kairos.dev` | Skill marketplace registry | $0 (Cloudflare Pages + R2) |
| `telemetry.kairos.dev` | Opt-in usage analytics | $0 (Cloudflare D1) |

**Total fixed cost: ~$25/month for first 1000 users.**

Auth/billing:
- Stripe for subscriptions (~3% of revenue)
- Stack Auth or Clerk free tier
- License = signed JWT, daemon verifies + caches locally
- 30-day offline-friendly

### OAuth client app management

For each service, register **one OAuth client app as KAIROS**:
- Slack: ~1 week verification
- Google: ~2-4 weeks verification
- GitHub: instant
- Notion: instant
- Linear: instant

- Redirect URI: `http://localhost:8843/oauth/callback` (each daemon runs this locally)
- Client ID + secret embedded in app binary (Google supports this for installed apps)

### Privacy positioning

> **KAIROS runs on your Mac. Your data never leaves it.**
> Your brain (memory, observations, history) is stored locally in Postgres + markdown files you own. You can export it as a git repo. We don't see your screen, your messages, or your work.

A massive competitive moat vs cloud-first assistants.

What we collect (opt-in only):
- Anonymous version + OS + crash reports (default ON, easy off)
- Aggregate skill usage stats (anonymized, default OFF)

### Auto-update strategy

```
Sparkle framework:
  - Daemon checks update feed daily
  - Background download, prompt user to restart
  - Updates signed with Apple Developer ID
  - Delta updates (only shipping changed bits)
```

### First-run onboarding (must be <90s)

```
1. Splash: "KAIROS — your proactive Mac AI" (3s with live HUD demo)
2. Permissions wizard (one at a time, explain WHY):
   - Accessibility, Microphone, Notifications, Calendar/Contacts
3. Choose tier (Free / Pro / Pro+ / Team)
4. Connect first service (recommend Calendar — safest, immediate value)
5. Voice greeting + first observation:
   "Hi Nirmal — I see [Project Plan.docx] open and a call at 3pm. 
    Starting to watch. Hit ⌃⌥Space anytime to talk."
6. HUD pill appears in corner.
```

### Marketing positioning

**One sentence**:
> "KAIROS is a proactive AI for your Mac. It watches what you're working on across all your tools, learns your patterns, and starts doing things before you ask."

**Three differentiators**:
1. **Proactive**, not reactive — KAIROS speaks first
2. **Private** — runs on your Mac, your data stays yours
3. **Self-evolving** — gets smarter the longer you use it

### Launch sequence

```
Week 1-2 (private beta): 10 users from network, fix top friction
Week 3-6 (public beta, waitlist): drip 50 users/week, Discord community
Month 3 (launch): Product Hunt + HN, press, free tier opens
Month 4-6: More connectors, Team tier, App Store version
Year 2: iPad companion, Linux + Windows shells
```

### Financial picture

```
Year 1 (conservative):
  5,000 free, 500 Pro @$20 = $10K/mo, 100 Pro+ @$40 = $4K/mo
  Total: ~$14K MRR = $168K ARR
  Costs: ~$2.2K/mo (backend + LLM proxy + Stripe)
  Gross margin: ~85%

Year 2 (aggressive):
  50,000 free, 5,000 paid → ~$130K MRR
  50 Team accounts × 5 seats × $50 = $12.5K/mo
  ~$142K MRR = $1.7M ARR
```

### Realistic effort

| Component | Lines | Notes |
|---|---|---|
| Stripe + license system | 800 | |
| Onboarding wizard | 600 | Swift if native UI |
| Update infrastructure | 300 | + Sparkle config |
| OAuth client registrations | — | ~2 weeks paperwork per service |
| Landing page | — | ~1 week |
| App Store Lite version | — | ~3 weeks (sandboxing rewrite) |
| Legal (privacy + ToS) | — | ~$3K |
| Apple Developer Program | — | $99/year |

---

## Section 8: Multi-LLM Provider Architecture

KAIROS must NOT be locked to Anthropic. Every LLM call goes through a single **ModelRouter** that abstracts providers and picks the right model per task based on complexity, cost, and latency.

### Supported providers

| Provider | Models | Auth | Pricing |
|---|---|---|---|
| **Anthropic** (subscription) | Claude Haiku/Sonnet/Opus via `claude -p` CLI | Pro/Max subscription | $0 incremental (subscription) |
| **Anthropic** (API) | Same models via API | API key | Pay-per-token |
| **OpenAI Codex** (subscription) | GPT-5-Codex / o-series via `codex exec` CLI | ChatGPT Plus/Pro subscription | $0 incremental (subscription) |
| **OpenAI** (API) | GPT-4o, GPT-4o-mini, GPT-5, o-series | API key | Pay-per-token |
| **Google Gemini** | Gemini 2.5 Flash Lite, Flash, Pro | API key | Pay-per-token (Flash Lite is cheapest viable model) |
| **Moonshot (Kimi)** | Kimi K2, K2 Turbo | API key (OpenAI-compatible) | Very cheap |
| **Local (Ollama)** | Qwen3, Llama-3.3, Mistral, any local | None (localhost) | $0 |
| **OpenRouter** (optional) | Any model on OpenRouter | API key | Marked up but unified |

**Subscription-first principle:** the two $0-incremental paths (Anthropic CLI via Pro/Max, OpenAI Codex CLI via ChatGPT Plus/Pro) are the cheapest tier of all when configured. They route ahead of paid APIs for any task the subscription model can handle. This is the highest-leverage cost optimization in the system.

### Task-type → model tier mapping (default policy)

| Task type | Tier | Default model preference (cheap → expensive fallback) |
|---|---|---|
| `narrative` (summarize state every 5min) | ultra-cheap | Gemini 2.5 Flash Lite → Haiku 4.5 → GPT-4o-mini → local Qwen3 |
| `trigger_eval` (should this fire?) | ultra-cheap | Gemini 2.5 Flash Lite → Haiku 4.5 |
| `action_compose` (draft a message) | mid | Sonnet 4.6 → Gemini 2.5 Flash → GPT-4o |
| `skill_generate` (write new bash script) | heavy | Sonnet 4.7 → Gemini 2.5 Pro → GPT-5 |
| `source_patch` (modify own code) | heavy | Sonnet 4.7 → GPT-5 → Gemini 2.5 Pro |
| `dream` (consolidate memories) | mid | Sonnet 4.6 → Gemini 2.5 Flash |
| `voice_transcribe` | special | Whisper.cpp local → Whisper API fallback |
| `embed` (memory embeddings) | special | nomic-embed-text local (always) |

### ModelRouter interface

```typescript
interface ModelRouter {
  complete(req: CompletionRequest): Promise<CompletionResult>
}

type CompletionRequest = {
  task_type: TaskType                // determines tier
  prompt: string
  system?: string
  max_cost_cents?: number            // refuse if all providers exceed
  latency_target?: 'realtime' | 'standard' | 'background'
  fallback_chain?: ProviderId[]      // optional override
  structured?: boolean               // require JSON output
}

type CompletionResult = {
  text: string
  parsed?: unknown                   // if structured
  provider: ProviderId               // who answered
  model: string                      // exact model name
  cost_cents: number
  latency_ms: number
  fallback_count: number             // how many providers tried before this
}
```

### Routing logic

```
1. Look up policy for task_type → ordered list of (provider, model) candidates
2. Filter by: configured providers + available auth + cost budget
3. Pick first candidate
4. Try call
5. On failure (rate limit, error, timeout): fallback to next candidate
6. Track cost + log + emit telemetry
7. Return result with provider/cost/latency
```

### Cost-efficiency strategies

- **Prompt caching** — exploit Anthropic prompt cache (5-min TTL) by reusing identical system prompts
- **Local-first** — for embeddings and voice transcription, always prefer local (free, fast)
- **Subscription pass-through** — if user has Anthropic Pro/Max, `claude -p` CLI usage is $0 incremental
- **Budget enforcement** — per-task budget; refuse if cheapest option exceeds
- **Rolling cost window** — daily/hourly cost caps (existing budget tracker, extended to provider dimension)
- **Aggressive cheap-tier defaults** — most KAIROS work (narration, triggers) is ultra-cheap; expensive only for skill/code generation

### Provider configuration

User configures providers in settings UI OR via `~/.kairos/providers.json`:

```json
{
  "providers": {
    "anthropic_cli": { "enabled": true, "priority": 1 },
    "codex_cli":     { "enabled": true, "priority": 1 },
    "anthropic_api": { "enabled": false },
    "openai":        { "enabled": true, "api_key_env": "OPENAI_API_KEY", "priority": 3 },
    "gemini":        { "enabled": true, "api_key_env": "GEMINI_API_KEY", "priority": 4 },
    "kimi":          { "enabled": false },
    "ollama":        { "enabled": true, "base_url": "http://localhost:11434", "priority": 5 }
  },
  "default_policy": "cost_optimized",  // or "quality_optimized" or "latency_optimized"
  "monthly_budget_usd": 50
}
```

### Implementation

- Custom thin router using each provider's official SDK (no Vercel AI SDK dependency)
- Anthropic: existing `claude -p` subprocess for CLI mode, `@anthropic-ai/sdk` for API mode
- **Codex CLI: `codex exec "<prompt>" -m <model>` subprocess** (similar wrapper pattern to `claude -p`); detects installation via `which codex`; degrades to disabled if absent
- OpenAI: `openai` package
- Gemini: `@google/genai`
- Kimi: `openai` package with `baseURL` override (OpenAI-compatible API)
- Ollama: `openai` package with `baseURL: http://localhost:11434/v1` (also OpenAI-compatible)

~700 lines total. One file per provider adapter, one router orchestrator.

---

## Section 8.5: Per-Phase Validation Gate (NEW)

**Every phase ships with explicit validation BEFORE its tag is cut.** No phase is "done" merely because its tests pass — each must demonstrate the user-visible capability working in the real environment.

### Validation requirements per phase

| Phase | Validation type | What "validated" looks like |
|---|---|---|
| **A** (Local observers + router) | Smoke test script + manual app/tab switch | `bun run scripts/smoke-proactive.ts` runs 5 min; observed events for every observer; ≥1 narrative produced; cost stays under 1¢ |
| **B** (Memory layers) | Replay test + LLM-judged recall quality | Replay 7 days of events; verify episodic→semantic consolidation; ask 5 recall questions, judge accuracy |
| **C** (Trigger Engine + Autonomy) | Trigger catalog walkthrough | Each built-in trigger fires correctly in a scripted scenario; autonomy gates approve/deny correctly per tier |
| **D** (OAuth connectors) | Live round-trip on each connector | Send + receive on Gmail/Slack/GitHub/Calendar with real OAuth tokens; verify rate limits respected |
| **E** (Voice — Wispr-style) | Hands-on hotkey test | Hold-to-speak transcribes; double-tap toggles hands-free; AI speaks back via TTS; oval HUD shows recording state |
| **F** (Liquid Glass UI) | Visual review on real macOS | Menu bar item + floating HUD render with glass blur; matches Wispr Flow's minimal footprint; hotkey overlay summons HUD |
| **G** (Self-evolution Hermes-style) | 24h autonomous run | Daemon runs unattended; produces ≥1 self-generated skill; gap detector flags ≥1 missing capability; no cost overruns |
| **H** (Multi-modal vision) | Screen-shot interpretation test | Capture screenshots from 5 apps; vision model produces accurate descriptions; integrates with narrator |
| **I** (Commercial packaging) | Install on clean Mac | Pkg installs via Sparkle; provider config wizard works; Stripe sign-up + tier gating verified |

### Validation gate enforcement

1. Validation script lives in `scripts/validate-phase-<X>.sh` (or `.ts`)
2. Validation runs at the END of each phase plan as its FINAL task
3. If validation fails: the phase is NOT tagged. We diagnose, fix, re-validate.
4. Validation results are recorded in `CHANGELOG.md` under the phase entry — what was tested, observed numbers, any caveats
5. UI phases (F, parts of E) require a **manual visual review** that the user signs off on. Other phases can be fully automated.

### Why this matters

Tests prove code correctness. Validation proves **feature correctness**. KAIROS is a user-facing AI companion; "55 tests pass" doesn't prove a user can actually talk to it. Every phase ends with "demo it to yourself before declaring victory."

This rule applies retroactively: Phase A's tag (`v0.1.0-phase-a`) is provisional until the user runs `scripts/smoke-proactive.ts` and the CHANGELOG is updated with observed event counts + narratives. Phase A is "code-complete" but not "validated-complete" until that runs.

---

## Tech stack summary

| Layer | Tech | Reason |
|---|---|---|
| **Daemon** | Bun + TypeScript | Already in production for L1-L5 |
| **UI shell** | SwiftUI (primary) or Tauri (alternative) | True Liquid Glass support |
| **UI frontend (if Tauri)** | React + Tailwind + Framer Motion + shadcn/ui | Modern, flexible |
| **Memory: Episodic** | SQLite + JSONL shards | Bun-native, simple |
| **Memory: Semantic** | GBrain on Postgres+pgvector (or sqlite-vec solo) | Drop-in MIT |
| **Memory: Embeddings** | nomic-embed-text via fastembed | Local, free, ~100ms |
| **Memory: Full-text** | SQLite FTS5 + ripgrep fallback | Built-in |
| **MCP client** | `@modelcontextprotocol/sdk` | Already used in shim |
| **Voice STT** | Whisper.cpp (local) + OpenAI Whisper API fallback | Privacy first |
| **Voice TTS** | macOS `say` + ElevenLabs/OpenAI optional | Tier choice |
| **Auto-updater** | Sparkle | Mac de facto standard |
| **Billing** | Stripe | Standard |
| **Auth (license)** | Signed JWT, cached locally | Offline-friendly |
| **Backend** | Cloudflare Pages + Workers + small VPS | <$30/mo at scale |

---

## Effort estimate (total build)

| Section | Lines | Time (single dev) |
|---|---|---|
| Section 1 — Core loop | ~1500 | 1 week |
| Section 2 — Observer Network (local + cloud connectors) | ~3000 | 2-3 weeks |
| Section 3 — Memory System (4 layers + GBrain integration) | ~2500 | 2 weeks |
| Section 4 — Action Network + MCP pool | ~3000 | 2-3 weeks |
| Section 5 — Trigger Engine + Self-Evolution Loop | ~5000 | 3-4 weeks |
| Section 6 — UI (SwiftUI + voice + WebSocket sync) | ~4500 | 4-6 weeks |
| Section 7 — Commercial infra (Stripe, OAuth client apps, onboarding) | ~2500 | 2-3 weeks |
| **Total** | **~22,000 lines** | **~3-4 months for a 2-person team** |

Plus: design work for icons, animations, marketing copy, legal.

---

## Build phases (incremental shipping)

### Phase A — Local Observer Network (Week 1-2)
- Implement Tier 1 observers (focus-app, browser-tabs, files, clipboard, calendar)
- World state aggregator + narrative summarizer
- Foundation for everything else

### Phase B — First UI Surface (Week 3-4)
- SwiftUI menu bar app + dropdown
- WebSocket connection to daemon
- Cards rendering, basic interaction
- First visible "KAIROS is alive" demo

### Phase C — Memory System (Week 5-6)
- Episodic + semantic stores
- GBrain integration
- Dream consolidation
- Replaces MEMORY.md with proper brain

### Phase D — First Cloud Connector + Voice (Week 7-8)
- Gmail OAuth flow + observer + actions
- Global hotkey + Whisper integration
- Action Bus + autonomy tiers
- First real proactive demo (drafted email replies)

### Phase E — Trigger Engine (Week 9-10)
- Built-in trigger catalog
- Interruption budget
- Learned trigger discovery
- "Right moment" intelligence

### Phase F — Floating HUD with Liquid Glass (Week 11-12)
- The visual centerpiece
- Spring physics animations
- Live narrative pill
- The unique-feeling surface

### Phase G — Self-Evolution Loop (Week 13-14)
- Skill-from-success
- In-use skill iteration
- Dialectic user model
- Subagent spawning

### Phase H — Remaining Connectors (Week 15-16)
- Slack, GitHub, Google Calendar
- Notion, Linear (if needed)
- MCP server integration

### Phase I — Commercial Polish (Week 17-20)
- Stripe billing
- Onboarding wizard
- Auto-updater
- App Store submission
- Marketing site

---

## Open questions for implementation

These don't block the design but need answers during build:

1. **macOS Accessibility API permissions** — how to handle the one-time prompt gracefully?
2. **Whisper.cpp distribution** — bundle model file (~150MB) or download on first use?
3. **Webhook tunnel choice** — Cloudflare Tunnel vs ngrok vs Tailscale (auto-detect what user has)?
4. **GBrain language compatibility** — confirm GBrain works with Bun runtime; otherwise wrap as separate service.
5. **MCP server pool sizing** — start with N=5 per service, tune based on telemetry.
6. **Brain export format** — git repo of markdown + SQLite dumps? Single zip? User preference.
7. **Voice activation latency target** — <500ms from hotkey to listening; achievable with local Whisper?
8. **First-run permission ordering** — which permission do we ask for first? (Accessibility is most invasive; might be better last after demo creates trust.)

---

## Success criteria

KAIROS v1 ships successfully when:

- [ ] User installs → first-run wizard < 90s → KAIROS is active
- [ ] Tier 1 local observers running continuously, cost < $1/day per user
- [ ] At least 3 cloud connectors (Gmail, Slack, Calendar) working with OAuth
- [ ] HUD with Liquid Glass renders properly on macOS 15+
- [ ] Voice hotkey: hold → speak → response in HUD (<3s end-to-end)
- [ ] At least 5 built-in triggers fire correctly with high precision (<5% false positive)
- [ ] Skill-from-success generates at least one useful skill per week of active use
- [ ] Dialectic user model accumulates 20+ claims per month of use
- [ ] Memory scales to 100K episodic events without slowdown
- [ ] Privacy: no user data leaves the machine (audit confirmed)
- [ ] Auto-updater works seamlessly
- [ ] Stripe integration handles all 4 tiers correctly
- [ ] App Store Lite version passes review

---

## End of design

This document is the source of truth for KAIROS Fully Proactive v1.0.

Implementation should start with Phase A (Local Observer Network) and proceed sequentially. Each phase is independently shippable as a checkpoint.

Existing KAIROS code at `~/Desktop/kairos-sandbox/` continues to work in parallel; the new architecture absorbs and extends it rather than replacing.
