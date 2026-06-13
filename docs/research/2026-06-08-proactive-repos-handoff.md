# Proactive Chief-of-Staff — Repo Research Handoff (for the coding agent)

**Date:** 2026-06-08 · **Status:** research complete, design locked, build pending
**Audience:** the agent implementing the KAIROS proactive engine. This doc is self-contained:
the locked design, what each reference repo does and how (implementation level), what we
adopt from each, and where it wires into this codebase.

---

## 1. What we are building (locked design)

KAIROS becomes a **proactive chief of staff**: it holds the user's goals + timeline, runs
"given where the user is trying to get, and what just happened — or didn't — what's the ONE
thing I should do or tee up, and is now the moment?", drafts the action itself, and brings
it well-timed. Identity: clearly *the assistant*, never impersonating the user.

**Two core loops:**
1. **see→learn→infer→act (predictive processing):** hold EXPECTATIONS per tracked
   entity/concern → an observation's SURPRISE (prediction error) is the salience signal →
   learn (surprise-gated memory update) → infer forward (simulate what's coming/at risk) →
   act toward goals (concerns = preferred states), restraint-gated. Novelty = max surprise.
   Absence ("the dog that didn't bark" — e.g. no reply in 2 days) is detectable ONLY
   because an expectation existed.
2. **The You-Policy (constantly learning the user):** first-class `behavioral` memory items
   ("how I want things done": e.g. "Linear tickets terse", "draft, never auto-send"),
   `{content, significance, confidence (direct≈0.9 / observed 0.4–0.7), sourceType, scope}`;
   every accept/dismiss/edit = a JudgmentEvent; an async **Memory Reducer** (background
   sub-agent, off the hot path) emits CRUD diffs of behavioral items; reinforcement +
   decay (+ a transformative floor so formative judgments survive) + supersession;
   decision-time injection so KAIROS acts the way the user would and reranks restraint.

**Three learning loops:** (A) You-Policy = learns WHAT the user wants; (B) Skills
(`AwmWorker`, exists) = learns HOW — crystallizes recurring tool-sequences into invokable
skills (tag proactive trajectories so it prioritizes them); (C) Self-grading = learns
WHETHER/WHEN it's worth it (weekly meta-reflection tunes the bar). The **autonomy ladder is
their output**: day one = draft-and-propose everything; per-category confidence earns rope
toward handling reversible work itself. HARD NO-GO (always ask): spend money, delete data,
send in the user's name, act toward VIPs.

**Architecture = 5 planes:**
- 🦾 **Hands** *(exists)*: smart planner + Composio tools + background sub-agents
  (`src/daemon/agents/conductor.ts`, `agents/loop/backgroundSubsystem.ts`). Proactivity is
  INITIATIVE, not new features: concern → plain-language intent → the existing planner.
- 🛡️ **Chassis** *(exists)*: `restraint/restraintPipeline.ts` (8 gates), UrgencyFloor,
  autonomy tiers, karma, rate-limits, digests, 6 OS observers, the perception sweep,
  `activity/activityStore.ts` (what KAIROS did), `voice/conversationMessageStore.ts`
  (full conversation replay).
- 🧠 **Brain** *(new)*: Concern Engine — concern canvas store + reconciler (expectations/
  surprise/open-loops) + forward simulation + proposer → draft-and-propose.
- 📚 **Learning plane** *(new)*: You-Policy (behavioral memory + JudgmentEvents + reducer).
- 📣 **Delivery**: voice + read-only glance card (existing top-left console panel),
  push/queue/store routing, breakpoint timing, morning brief, urgent native push.

**Decision gate stack** (every proactive act): UrgencyFloor → deterministic gates
(cooldown/quiet/focus/rate) → need-predictor + LLM value-filter + you-policy reranker
(silence-biased; "no action" is a correct outcome) → push/queue/store → breakpoint timing
→ escalating backoff. Interruptible at every step.

**Locked user decisions (2026-06-08):** draft-and-propose ALL on day one; goals =
auto-infer + confirm the big ones; real-time when warranted + a morning brief whose whole
batch is PROPOSED (triage, drafts, calendar fixes — user approves the batch); interrupt
bar starts time-critical-only and is LEARNED; approval = voice + read-only glance card;
pending proposals PERSIST (act on them days later: "send that Patel draft") and auto-expire
when stale (tell the user); onboarding connects Gmail + Calendar + Slack/Messages (opt-in);
sweep cadence = ADAPTIVE (base 30 min, busy→10 min, quiet→60 min).

**Phased roadmap:** P0 onboarding · **P1 spine = Concern Canvas + `behavioral` memory +
the 30-min reflection sweep (START HERE)** · P2 Proposer → draft-and-propose + Pending
store + value-filter · P3 You-Policy loop · P4 Life Graph (cross-toolkit entities) · P5
goal-pursuit + self-scheduling · P6 morning brief + presence + urgent push · P7 trust
ladder + self-grading. **Beta (demo-video-first, mindshare):** P0+P1+P2 + slice of P3/P6.
Hero demo = a **multi-toolkit proactive chain** (e.g. one concern "Thursday demo" →
notices Patel silent in Gmail + ticket open in Linear + prep slot missing in Calendar →
ONE proposal package: nudge email draft + Slack check-in draft + held calendar slot).

**Already-shipped substrate this builds on:**
- Perception sweep upgraded (2026-06-08): full-window review every ~30 min, ADAPTIVE
  (`perception/perceptionPipeline.ts` — self-chaining timer, since-last-sweep event-id
  cursor, busy→`KAIROS_PERCEPTION_POLL_MIN_MS` 10 min, quiet→`KAIROS_PERCEPTION_POLL_MAX_MS`
  60 min; `memory/workingMemory.ts` ring 60 min/2000; tier1 full-window). Urgent real-time
  events still fire via the bus→TriggerEngine/UrgencyFloor path, independent of the sweep.
- Activity log (`activity/activityStore.ts`) + `kairos_activity` tool; conversation replay
  (`voice/conversationMessageStore.ts`); memory lifecycle (write/update/soft-delete/confirm).

---

## 2. The four reference repos — links + verdicts

| Repo | What it is | Stack | LLM chaining | Models | Voice? |
|---|---|---|---|---|---|
| [memUBot](https://github.com/NevaMind-AI/memUBot) (+ [memU](https://github.com/NevaMind-AI/memU)) | "Proactive AI assistant that remembers everything" — multi-platform chat bot host | TypeScript/Electron (+ memU: Python) | ONE agentic loop (≤50 tool iters, Anthropic-native, context-management beta) + side calls: topic classifier, value-filter, proactive plane reuses the SAME loop via synthetic user turns; memU runs its own extract→dedupe→categorize→summarize pipeline with LLM sufficiency-judged L0/L1/L2 retrieval | Claude default (topic classifier pinned `claude-4-haiku-20250514`); OpenAI/Gemini/Ollama adapters | ❌ chat platforms only |
| [GAIA](https://github.com/theexperiencecompany/gaia) | Open personal assistant w/ proactive todo tracking | Python/FastAPI + LangGraph/LangChain, ARQ worker, Composio | Agent graphs + a constrained-output "health-check agent" per tracked todo (`ARCHIVE:\|NOTIFY:\|EXECUTE:\|NEEDS_ATTENTION:`) + `call_agent_silent` scheduled runs + per-provider memory-extraction prompts; structural paper-trail written around the LLM | Gemini (`gemini-2.0-flash`) for extraction; brain on the LangChain provider config | ⚠️ separate `apps/voice-agent` (LiveKit+Deepgram+ElevenLabs) — a bolt-on frontend, NOT voice-native |
| [vellum-assistant](https://github.com/vellum-ai/vellum-assistant) | "Evolves with you" personal assistant | TypeScript | Richest chain: main agent (per-call-site model overrides) → mid-turn `notifications` skill (model flags surface-worthy) → 6-gate value-filter → delivery; PLUS haiku-class `preference-extractor` on EVERY user message (10s timeout, forced tool choice); async memory reducer off hot path; observers poll 60s → decision engine | Provider-abstracted; haiku-class for extractors | ❌ |
| [leomariga/ProactiveAgent](https://github.com/leomariga/ProactiveAgent) | Embeddable "pseudo-proactive" Python library | Python lib, daemon thread | Simplest: perpetual wake → should_respond? (LLM or rule) → generate → sleep, where the SLEEP DURATION is itself an LLM call (`AIBasedSleepCalculator`); interruptible 1s-granularity sleep | Bring-your-own `OpenAIProvider(model=…)` | ❌ |

**Voice verdict:** none is voice-native. GAIA's voice app is a channel bolted onto an HTTP
brain. KAIROS's edge — daemon owns STT/LLM/TTS with sub-second turn architecture + local-OS
perception + the predictive/surprise loop + an already-built restraint chassis — is held by
none of these.

---

## 3. Adoption map — what we take, from where, and where it goes in KAIROS

| Steal | From | Goes into |
|---|---|---|
| Tracked-todo **CANVAS** structure (markdown: Key Details / Current State / Activity Log / Timeline / Context / Learnings; vector-indexed) | GAIA | **Concern Canvas** — the concern store's on-disk shape (new `src/daemon/concerns/`) |
| Two proactive timing modes: **signal-match** (event touches a concern → immediate) + **maintenance sweep** (periodic review of every open concern) | GAIA | Reconciler, riding the existing adaptive perception sweep |
| **Escalating backoff** per concern (1/3/7 days → ~30d mute) + **quiet-hours DEFER (not drop)** + digest batching | GAIA | RestraintPipeline additions |
| Onboarding **profile crawler** | GAIA | P0 onboarding |
| Constrained-output **health-check agent** (exact-verdict prompt) | GAIA | Concern health checks in the sweep |
| **Typed memory** w/ TTL + significance/confidence + **reinforcement** + ACT-R-style recall + RRF hybrid retrieval + **supersession** | Vellum | `behavioral` memory type (You-Policy store) |
| **Async memory REDUCER** emitting CRUD diffs | Vellum | You-Policy reducer (background sub-agent) |
| Per-message **preference-extractor** (haiku-class, forced tool choice) | Vellum | JudgmentEvent/preference capture |
| **6-gate restraint + LLM value-filter** before any proactive send | Vellum | Need-predictor/value-filter gate in the decision stack |
| `schedule_task` **self-scheduling** (agent schedules its own future wake) | Vellum | P5 goal-pursuit |
| **Synthetic stimulus** — external event becomes a fake user turn so ONE pipeline serves reactive + proactive | memUBot | Proposer → conductor bridge (proactive intents enter the same planner) |
| **`[NO_MESSAGE]` silence sentinel** — the model explicitly outputs "say nothing" as a first-class result | memUBot | Proposer prompt contract (silence = correct outcome) |
| **L0/L1/L2 escalate-on-uncertainty retrieval** (thresholds: scoreHigh 0.64, top1-top2 margin 0.08) | memUBot/memU | Memory retrieval tuning |
| **Self-scheduling sleep via LLM** + interruptible sleep | leomariga | v2 of the adaptive sweep cadence (LLM picks next wake) |
| Hard-floor + soft-LLM gate split; user activity cancels in-flight proactive work | leomariga | Restraint + sweep interruptibility |
| Need-predictor reward model ("would the user accept this?") + 4-quadrant framing (silence = success) | thunlp/ProactiveAgent (earlier research) | Cold-start gate that graduates into the You-Policy |
| Push/queue/store routing + breakpoint timing (~46% less interruption load) | landscape research | Delivery plane |

---

## 4. Per-repo deep dives (implementation level, from source)

> Generated from a 4-agent source-reading research pass (each agent read the actual repo
> code). Exact file paths, schemas, thresholds, and prompts are quoted per repo below.


---

### memUBot (NevaMind-AI)

**Repo:** https://github.com/NevaMind-AI/memUBot


#### Overview

memUBot (NevaMind-AI/memUBot) is an Electron desktop app (TypeScript, electron-vite, React renderer, AGPL-3.0) positioned as "The Enterprise-Ready OpenClaw. Your Proactive AI Assistant That Remembers Everything." ~444 stars, last push 2026-05-06. It is a multi-platform chat-bot host: platform adapters for Telegram/Discord/Slack/WhatsApp/Line/Feishu/QQ + a local chat UI (`src/main/apps/*`), wrapping ONE agentic LLM loop (Anthropic message format natively; OpenAI/Gemini/Ollama via adapters in `src/main/services/agent/{openai,gemini}-adapter.ts`). Long-term memory is delegated to the cloud memU service (default `memuBaseUrl: 'https://api.memu.so'`, endpoints `/api/v3/memory/{memorize,retrieve,categories,memorize/status/:taskId}` + embedding endpoints) — the memory logic itself lives in NevaMind-AI/memU (Python, 13.8k stars, very active — last push 2026-06-09), which I also cloned and read. Runs as a one-click installer from memu.bot; proactive mode is gated behind a `--with-proactive` launch flag (`src/main/index.ts:282`). Maturity: mid/scrappy — decent module structure with some unit tests, but shipped code contains leftover hardcoded debug telemetry (`fetch('http://localhost:7892/ingest/...')` blocks inside `agent.service.ts`), commented-out API-key gating in `proactiveService.start()`, and a vestigial `monitorTask` poller. The three patterns you asked about all exist and are real code: L0/L1/L2 escalate-on-uncertainty (`src/main/services/agent/context/layered/`), the `[NO_MESSAGE]` sentinel (`src/main/services/proactive.service.ts`), and synthetic-stimulus (email → fake user turn, same file). memU adds a SECOND, independent escalation hierarchy (category summaries → memory items → raw resources with LLM sufficiency judging) plus reinforcement/decay salience scoring.


#### Architecture (moving parts + data flow)

All in the Electron MAIN process; renderer is just UI. Moving parts:

1) EVENT BUS — `src/main/services/infra.service.ts`. Typed pub/sub (`InfraService extends EventEmitter`) with three events: `message:incoming`, `message:outgoing`, `message:processed` (payloads `IncomingMessageEvent`/`OutgoingMessageEvent`/`ProcessedMessageEvent`, each `{platform, timestamp, message: Anthropic.MessageParam, metadata}`); auto-injects OTEL traceId on incoming; keeps a 100-entry circular buffer per event type; `tryConsumeUserInput(message, platform)` lets services INTERCEPT user input before the main agent (used by the proactive `wait_user_confirm` gate).

2) REACTIVE PIPELINE — `src/main/services/agent.service.ts` (class `AgentService`, 1910 lines, singleton). Per-message flow: platform `bot.service.ts` publishes `message:incoming` (e.g. `apps/telegram/bot.service.ts:505`) → first calls `infraService.tryConsumeUserInput()` (line 744; if proactive is waiting, message is swallowed) → `agentService.processMessage` acquires a GLOBAL `processingLock` (one platform at a time; busy → localized rejection message) → `loadContextFromStorage(platform, chatId)` (per-platform/per-chat context isolation, cached via `contextLoadedForPlatform/ChatId`) → `applyTemporaryTopicTransition()` (LLM topic classifier; can freeze main history and open a temp context) → `runAgentLoop()`: `enforceMessageCountLimit()` → `applyLayeredContextIfEnabled()` (the L0/L1/L2 compression, line 1327) → up to 50 tool iterations; for Claude it uses the beta `context-management-2025-06-27` API with `clear_tool_uses_20250919` (trigger 100k input tokens, keep 5 tool uses, clear ≥10k) → tools from `agent/tools.ts` `getToolsForPlatform()` = computer-use + macOS tools + platform send tools + service tools + `memuTools` + MCP; dispatch in `agent/tool-executor.ts` (`name.startsWith('memu_')` → `tools/memu.executor.ts`). System prompt assembled in `agent/prompts/index.ts` from `MEMU_BOT_INTRO` + per-platform `PLATFORM_CONFIGS` + `COMMUNICATION_GUIDELINES`.

3) MEMORIZATION PLANE — `src/main/services/memorization.service.ts` + `memorization.storage.ts`. Subscribes to BOTH `message:incoming` and `message:outgoing`; appends every message to a durable on-disk queue (`userData/memorization-data/unmemorized-messages.json`, schema `StoredUnmemorizedMessage {platform, role, content, timestamp}`); triggers a memU `/api/v3/memory/memorize` POST when queue ≥ 20 messages (immediate) or ≥ 2 messages + 60-min debounce; batches max 200; content prefixed `[platform] ...`; memorize is an ASYNC server task (`task_id`) whose status (`PENDING|PROCESSING|SUCCESS|FAILURE`) is polled LAZILY on next trigger; crash-safe via `memorization-state.json {lastTaskId, messagesToRemoveOnSuccess, firstMessageTimestamp}` + `recoverPendingTask()` on boot.

4) PROACTIVE PLANE — `src/main/services/proactive.service.ts` + `proactive.storage.ts` (detailed in next field). Shares the SAME bus, same tool executors, same LLM client factory, but a separate system prompt, separate memU agent identity (`memuProactiveUserId/memuProactiveAgentId` vs `memuUserId/memuAgentId`, `config/settings.config.ts:113-118,231-236`), and NO messaging-platform send tools.

5) BACK-SERVICE / MONITORS — `src/main/services/back-service/*`. Users (via the `service-creator` builtin skill, `src/main/builtin-skills/service-creator/`) get LLM-generated Node/Python monitor services (`ServiceMetadata {id,name,type:'longRunning'|'scheduled',runtime,entryFile,schedule,context:{userRequest,expectation,notifyPlatform}}`), managed by `manager.ts`/`runner.ts` with crash backoff. They notify the user ONLY through a localhost HTTP API (`local-api.ts`, port 31415) `POST /api/v1/invoke` → `invoke.ts` `InvokeService.process()`: rate limit → platform resolution → `agentService.evaluate()` strict LLM value-filter → platform send.

6) MEMU SERVICE (NevaMind-AI/memU, Python) — `src/memu/app/service.py` composes `MemorizeMixin` (`app/memorize.py`) and retrieve (`app/retrieve.py`) as declarative workflow pipelines (`workflow/pipeline.py`). Memorize: ingest_resource → preprocess_multimodal → extract_items (per-memory-type prompts in `prompts/memory_type/{profile,event,knowledge,behavior,skill,tool}.py`) → dedupe_merge → categorize_items (embeds + persists, reinforcement dedupe) → persist_index (LLM-updates per-category Markdown summaries, optional `[ref:ITEM_ID]` citations) → build_response. Retrieve: route_intention → route_category → sufficiency_after_category → recall_items → sufficiency_after_items → recall_resources → build_context. Storage: SQLite/Postgres/in-memory repos under `src/memu/database/`.


#### Proactive mechanism — exactly how/when it acts

File: `src/main/services/proactive.service.ts` (class `ProactiveService`). Started in `src/main/index.ts:284` only with `--with-proactive`.

TRIGGERS / SWEEP:
- `start(intervalMs = DEFAULT_INTERVAL_MS /* 30000 */)` subscribes to `message:incoming` AND `message:outgoing` on infraService, then `scheduleTick()`.
- `scheduleTick()` uses setTimeout SELF-SCHEDULING: next tick is scheduled only AFTER the previous tick completes ("fixed delay AFTER each completion") — structurally impossible to overlap sweeps.
- `handleIncomingMessage`/`handleOutgoingMessage` push every conversation message into `contextMessages` (sliding window `contextMessageWindowSize = 20`) and set `hasNewContextMessages = true`. So the proactive agent passively SHADOWS the whole user↔assistant conversation across all platforms.

SYNTHETIC STIMULUS (the key pattern):
- `checkNewEmails()` (macOS only): every tick reads the latest Apple Mail inbox email via `executeMacOSMailTool({action:'read_email', index:1})`. First run: record baseline (`this.lastEmailContent = emailContent`) and DO NOT fire. Subsequent runs: if content !== baseline → update baseline and append a literal fake user turn:
  `const fakeUserMessage: Anthropic.MessageParam = { role: 'user', content: "Here's a new email.\n\n" + emailContent }` → pushed into the SAME `contextMessages` window, `hasNewContextMessages = true`.
- Result: external events and real chat traffic become indistinguishable stimuli; ONE agent loop handles both reactive shadowing and proactive event response.

TICK LOGIC (pseudocode of `tick()`):
```
tick():
  checkNewEmails()                                  # step 0: poll observers → synthetic turns
  if agentService.getStatus().status not in {idle, complete}: return   # step 1: idle gate — never compete with foreground
  if hasNewContextMessages:
    hasNewContextMessages = false
    runAgentLoop()                                  # step 2: one LLM pass over the 20-msg shadow window
```

AGENT LOOP (`runAgentLoop()`):
- Snapshots `agentLoopMessages = [...contextMessages]`; repairs role alternation: shift leading assistant messages; if last is assistant, append synthetic user turn `'Please continue adhering to the system prompt.'`.
- Up to 50 iterations with `PROACTIVE_SYSTEM_PROMPT` (verbatim in prompts field) and tools = computer-use (bash gated by `getBashToolAccessDecision({platform:'none', source:'proactive'})`) + macOS mail/calendar/contacts/launch + MCP + 3 special tools: `memu_memory` (retrieves from the MAIN user/agent memU scope), `memu_todos` (reads the `todo` category summary from the separate PROACTIVE memU scope via `/api/v3/memory/categories`), `wait_user_confirm`.
- Final text handling: `const message = rawMessage.trim() === '[NO_MESSAGE]' ? '' : rawMessage` (line 657); send only `if (message)`.
- DELIVERY: `sendToCurrentPlatform()` targets `agentService.getRecentReplyPlatform()` — the platform the user most recently messaged from (persisted to `userData/recent-platform.json`); if `'none'`, drop silently. On successful send: `proactiveStorage.storeMessage(assistantMessage, sentPlatform)` and `agentService.invalidateContextForPlatform(sentPlatform)` so the MAIN pipeline reloads history and "remembers" what proactive said (agent.service.ts:817-825).

HUMAN-IN-THE-LOOP GATE: `wait_user_confirm(prompt)` (`executeWaitUserConfirm`): sends the prompt to the current platform, sets `isWaitingUserInput = true`, busy-polls `this.userInput` every `USER_INPUT_POLL_INTERVAL_MS = 1000` up to `USER_INPUT_MAX_WAIT_MS = 10 min`. The bridge: every platform bot calls `infraService.tryConsumeUserInput(msg, platform)` BEFORE the main agent; if proactive is waiting on the same platform, the user's next message is routed into the suspended proactive tool call (`proactiveService.setUserInput`) and never reaches the main agent (`infra.service.ts:334-357`).

SECOND PROACTIVE CHANNEL (self-built monitors): generated services do local rule filtering, then `POST 127.0.0.1:31415/api/v1/invoke {context:{userRequest, expectation, notifyPlatform}, data:{summary, details, timestamp, metadata}, serviceId}` → rate limit (5/min/serviceId sliding window) → `agentService.evaluate()` strict JSON gate `{shouldNotify, message, reason}` with `INVOKE_MAX_RETRIES=3`, `INVOKE_RETRY_DELAY_MS=5000` → platform send with bound-user fallback (`back-service/invoke.ts`).

THIRD (memU example, `memU/examples/proactive/proactive.py`): todo-driven self-continuation — after each turn, fetch todos from memory; `if "[todo]" in todos.lower(): next_input = f"Please continue with the following todos:\n{todos}"` — pending todos become the next synthetic user turn instead of waiting for input.


#### Memory / user-model — exact structures

TWO independent hierarchies.

A) SESSION-CONTEXT HIERARCHY (memUBot, `src/main/services/agent/context/layered/`):
- Types (`types.ts`): `type ContextLayer = 'L0' | 'L1' | 'L2'`. `LayeredContextNode { id: 'archive_'+sha1[0:14], parentId: 'root', abstract: string /*L0*/, summary: string /*L1*/, resourcePath: string /*L2: archived JSON {transcript, messages[]}*/, keywords: string[], checksum: sha1(transcript), metadata: {platform, chatId, startMessageIndex, endMessageIndex, messageCount, recencyRank}, tokenEstimate: {l0,l1,l2}, createdAt, updatedAt }`. `LayeredContextRoot {abstract, summary, keywords, childIds}`. `LayeredContextIndexDocument {version:1, sessionKey, root, nodes[]}` persisted per `sessionKey = platform+chatId` (`storage.ts`: index JSON + per-node archive files; `cleanupArchives` deletes orphans).
- Config defaults (`config.ts`): `l0TargetTokens: 120, l1TargetTokens: 1200, maxPromptTokens: 32000, maxRecentMessages: 24, maxArchives: 12, archiveChunkSize: 8`, thresholds `{scoreThresholdHigh: 0.64, top1Top2Margin: 0.08, maxItemsForL1: 4, maxItemsForL2: 2}` — all user-tunable via settings with clamping.
- INDEXING (`indexer.ts`): when history > maxRecentMessages+1, older messages are split into 8-message chunks; each chunk → transcript → sha1 checksum (cache hit = reuse node, no LLM) → LLM `generateSummary` (≤1200 tok, L1) → LLM `generateAbstract` of the summary (≤120 tok, L0) (`summarizer.ts`, with deterministic fallbacks: first-18-lines bullet summary / first-2-sentences abstract, fallback events recorded); keyword extraction via frequency (`extractTopKeywords`, 24 max, CJK bigram tokenizer). Keep 12 most recent nodes, assign `recencyRank` (1 = newest). Root gets its own summary+abstract across all kept nodes. Index builds are queued per-session (`manager.ts` `updateChains`) and run in BACKGROUND when a previous index exists (stale-while-revalidate).
- RETRIEVAL SCORING (`retriever.ts` + `text-utils.ts` + `dense-score-provider.ts`): hybrid score per node = `blend(dense, sparse, alpha=0.35)` + recencyPrior. Sparse = BM25 (k1=1.2, b=0.75) normalized `1 - exp(-raw)`, + `PHRASE_BONUS = 0.15` if the query appears verbatim. Dense = cosine over memU embedding endpoints (`/api/v3/voyage/v1/embeddings` then `/api/v3/embedding`, `REQUEST_TIMEOUT_MS = 1200`, FAIL-OPEN: any failure → empty map → falls back to sparse-only). Recency prior = `(totalNodes - rank + 1)/totalNodes * 0.08`. Adaptive thresholds by query class (`classifyQuery`: 'precise' if contains error/stack/function/`.ts`/`/`... → threshold ×0.92, margin ×0.8; 'structured' if overview/summary/architecture... → ×0.97; ≤5 query tokens → ×0.88/×0.72; ≥12 tokens → ×1.04/×1.1).
- ESCALATION (the exact logic): score all nodes on L0 (abstract+keywords); `highConfidence = top1 >= scoreThresholdHigh && (top1-top2) >= top1Top2Margin`. If high → stay L0 (inject root abstract + top-3 node abstracts). Else rerank top-4 candidates on their L1 summaries (fresh BM25 model over summaries); `l1Confidence = l1Top1 >= 0.9*threshold && l1Margin >= 0.5*margin`; if yes → L1 (inject top-4 summaries); else → L2: inject `maxItemsForL1 - maxItemsForL2` L1 summaries for scope + read up to 2 FULL transcripts from archive files (BM25-rescored). Token budget: `layeredBudget = max(400, 0.45 * maxPromptTokens)`; selections greedily added until budget. Everything is injected as ONE synthetic message ("Short-term memory package (Abstract/Summary/Resource) generated from archived history. Escalation decision: ...") prepended before the 24 recent messages (`manager.ts buildLayeredPromptBlock`), then oldest recents trimmed to stay under maxPromptTokens. Logs token savings vs `baselineL2` (sum of all transcripts).
- TEMP-TOPIC OVERLAY (`temporary-topic.ts`): Haiku (`claude-4-haiku-20250514`) classifies each query as stay-main/enter-temp/stay-temp/exit-temp/replace-temp against clipped topic references (8 msgs, 120 chars each, 600 total); thresholds `{enterThreshold: 0.55, exitThreshold: 0.55, tempStayThreshold: 0.8}`; enter-temp FREEZES main history (`frozenMainMessages`) and starts an empty context; exit-temp restores it verbatim. Fail-safe: classifier error → `{relMain:1, relTemp:1}` → stay (never lose context on error).

B) LONG-TERM MEMORY (NevaMind-AI/memU, `src/memu/`):
- Schema (`database/models.py`): `MemoryType = 'profile'|'event'|'knowledge'|'behavior'|'skill'|'tool'`. `MemoryItem {id: uuid, resource_id, memory_type, summary: str, embedding, happened_at, extra: {content_hash: sha256(f"{type}:{normalized summary}")[:16], reinforcement_count: int, last_reinforced_at: iso, ref_id, when_to_use, metadata, tool_calls}}`. `MemoryCategory {name, description, embedding, summary /* LLM-maintained Markdown digest */}`. `CategoryItem {item_id, category_id}` links. `Resource {url, modality, local_path, caption, embedding}` = raw source. Default categories (`app/settings.py _default_memory_categories`): personal_info, preferences, relationships, activities, goals, experiences, knowledge, opinions, habits, work_life (memUBot's proactive plane relies on a custom `todo` category in its separate proactive scope).
- UPDATE/REINFORCEMENT (`database/sqlite/repositories/memory_item_repo.py:295-372`): on insert, compute content_hash; if an item with the same hash exists in scope → REINFORCE: `reinforcement_count += 1`, `last_reinforced_at = now` (no duplicate row); else create with count=1. Extraction prompts themselves do supersession: "Resolve contradictions by keeping the latest / most certain item" (`prompts/memory_type/event.py`).
- DECAY/SALIENCE (`database/inmemory/vector.py`): `salience = similarity * log(reinforcement_count + 1) * recency_factor`, where `recency_factor = exp(-0.693 * days_since_last_reinforced / recency_decay_days)` (half-life, default 30 days; unknown recency → 0.5). Ranking mode configurable: `'similarity' | 'salience'` (`RetrieveItemConfig.ranking`, `recency_decay_days: 30.0`).
- CATEGORY SUMMARY MAINTENANCE: each memorize run LLM-merges new items into the per-category Markdown summary with only add/update ops, hard target_length, and (when `enable_item_references`) inline `[ref:ITEM_ID]` citations linking every statement to source items (`prompts/category_summary/category_with_refs.py`) — i.e., an auto-maintained, evidence-cited canvas per category.
- RETRIEVAL (`app/retrieve.py`, RAG workflow): (1) route_intention: LLM decides RETRIEVE/NO_RETRIEVE + rewrites query with conversation context (`prompts/retrieve/pre_retrieval_decision.py`); (2) route_category: embed query, cosine-rank category summaries (top_k=5); (3) sufficiency_after_category: LLM judger ENOUGH/MORE over retrieved content (`prompts/retrieve/judger.py`), rewrites query for next tier; (4) recall_items: vector_search top_k=5 (similarity or salience), optional reference-following via `[ref:ITEM_ID]`s found in category summaries (`use_category_references`); (5) sufficiency_after_items: judger again; (6) recall_resources: cosine over raw resource captions top_k=5. So categories≈L0, items≈L1, resources≈L2 — the same escalate-on-uncertainty shape but with an LLM sufficiency judge instead of score thresholds, and `sufficiency_check: bool = True` by default.
- WRITE PATH from memUBot: `/api/v3/memory/memorize` with `{user_id, agent_id, conversation:[{role, content:'[platform] ...'}]}`, async task_id + status polling (memorization.service.ts).


#### Restraint & timing — how it avoids annoyance

1) [NO_MESSAGE] SILENCE SENTINEL (`proactive.service.ts:110,657`). Prompt side (verbatim): "We generally want to make the user be less disturbed, so if you find there's no job to do for now (which is very common), you should respond with exactly \"[NO_MESSAGE]\" (no extra text), and there's no need to explain the reason." Code side: `const message = rawMessage.trim() === '[NO_MESSAGE]' ? '' : rawMessage`; send happens only `if (message)`. Notes: exact-match on trimmed full output (model must emit ONLY the token); "(which is very common)" normalizes silence as the default outcome; the assistant turn is still appended to the proactive loop's own history and stored, so the agent remembers it chose silence.

2) IDLE GATE: proactive `tick()` hard-skips unless `agentService.getStatus().status` is `'idle'` or `'complete'` — the proactive plane never preempts or interleaves with foreground work.

3) NO-OVERLAP TIMING: setTimeout self-scheduling = 30s AFTER previous tick completes; tick errors are caught and never kill the loop; `stop()` flips `isRunning` and the pending tick no-ops.

4) DELIVERY ANCHORING: proactive output goes ONLY to `recentReplyPlatform` (the channel the user last spoke on, disk-persisted across restarts); if 'none' → message silently dropped (no fallback spam channel). Bot monitors get a bound-user fallback only for explicit notifyPlatform.

5) DESTRUCTIVE-OP GATE: prompt mandates `wait_user_confirm` for anything destructive/irreversible ("deleting files, sending emails"); 10-min timeout returns `{success:false, error:'Timeout waiting for user input'}` so the model sees the non-approval; `finally` always clears the waiting state.

6) TWO-LAYER FILTERING DOCTRINE for monitors (`builtin-skills/service-creator/reference/architecture.md`, verbatim): "CRITICAL: Services must implement local rule filtering BEFORE calling the invoke API. Data Source → Local Rules Filter → (passes?) → Invoke API → LLM Evaluation → User ... Local Rules (Fast, Free): Quick algorithmic checks that filter out 99% of irrelevant data ... Saves 95%+ of LLM calls while maintaining intelligent judgment." Includes the buffer trick: local threshold set slightly BELOW the user's (user says 5% → local filter at 3%, LLM judges the gray zone).

7) HARD RATE LIMIT: `INVOKE_RATE_LIMIT_PER_MINUTE = 5` per serviceId, sliding 60s window (`back-service/rate-limiter.ts`); rate-limited calls return `action:'rate_limited'` (success=true, so the service doesn't retry-storm).

8) STRICT LLM VALUE-FILTER (`agent.service.ts:1759-1906 evaluate()`): single no-tools call, max 1024 tokens, JSON `{shouldNotify, message, reason}` strictly validated (boolean check; message required iff shouldNotify). Doctrine is EXACT-match conservatism: "ONLY notify when current time >= target time (not before!) ... Being 'close to' the time (e.g., 3 minutes early) is NOT a match - REJECT it ... 'Near' the threshold is NOT enough." Retries 3× with 5s delay on parse/transport failure; on final failure → action 'error', NOTHING sent (fail-silent).

9) CRASH BACKOFF for monitor services: `RESTART_BACKOFF_MS = [5000, 10000, 30000, 60000, 60000]`, `MAX_RESTART_ATTEMPTS = 5` per `RESTART_WINDOW_MS = 1h`, then marked 'error'.

10) MEMORY-WRITE THROTTLING: memorize fires at ≥20 queued messages immediately, else 60-min debounce from ≥2 messages; in-flight task gates new triggers; lazy status polling (only checks server when a new message arrives or debounce fires) — no busy polling.

11) GLOBAL PROCESSING LOCK: one conversation at a time across ALL platforms; concurrent requests get a localized "busy" rejection rather than queuing silently.

NOT present: quiet hours, per-user karma, autonomy tiers, daily digests, escalating per-topic mute. memUBot's whole restraint stack = sentinel + idle gate + no-overlap sweep + channel anchoring + strict evaluator + rate limit + local-rules-first doctrine.


#### Prompts & schemas worth copying

=== PROACTIVE_SYSTEM_PROMPT (verbatim, `proactive.service.ts:90-111`) ===
"You are a helpful AI assistant working in an autonomous mode.

You now have two main jobs:
1. If the context messages suggest that the user and their assistant are working on some local files, you may give some suggestions to the user for file consolidation, such as:
  - Collect related files into folders.
  - Delete duplicate files.
  - Delete temporary files that are no longer needed.
2. If the context messages suggest there is a incoming email, you should give some suggestions for how to handle it, such as:
  - Reply to the email.
  - Mark the email as read.
  - Mark the email as important.

You have access to:
1. **Bash/Terminal** - Execute shell commands for file operations, git, npm, system info, etc.
2. **Text editor** - View and edit files with precision
3. **Memory retrieval** - Retrieve basic information about the user.
5. **User confirmation** - Wait for user input when you need feedback or approval

Guidelines:
- When you decide to perform or have finished some operations, you should mention it as a text message to the user.
- We generally want to make the user be less disturbed, so if you find there's no job to do for now (which is very common), you should respond with exactly \"[NO_MESSAGE]\" (no extra text), and there's no need to explain the reason.
- Critical: If an operation is destructive or irreversible (e.g. deleting files, sending emails, etc.), you must use the wait_user_confirm tool to wait for user confirmation before proceeding."

=== VALUE-FILTER (evaluate) SYSTEM PROMPT (verbatim, `agent.service.ts:1772-1794`) ===
"You are a STRICT evaluation assistant. Your job is to decide whether an event warrants notifying the user based on their EXACT expectations.

You MUST respond with a valid JSON object in this exact format:
{
  \"shouldNotify\": true or false,
  \"message\": \"The notification message to send to user (only if shouldNotify is true)\",
  \"reason\": \"Brief explanation of your decision\"
}

STRICT Guidelines:
- Be VERY conservative: only notify when the event EXACTLY matches user's expectations
- For TIME-BASED requests (reminders, alarms):
  - ONLY notify when current time >= target time (not before!)
  - \"Remind me at 4:30pm\" means notify at 4:30pm or after, NEVER before
  - Being \"close to\" the time (e.g., 3 minutes early) is NOT a match - REJECT it
- For THRESHOLD-BASED requests (price alerts, monitoring):
  - The threshold must be clearly met or exceeded
  - \"Near\" the threshold is NOT enough
- If shouldNotify is false, message can be omitted or empty
- Keep the notification message concise and actionable
- The reason should explain why you made this decision

IMPORTANT: Respond with ONLY the JSON object, no additional text."
User prompt (`buildEvaluationPrompt`): "Strictly evaluate whether the following event should trigger a notification.\n\n== USER'S ORIGINAL REQUEST ==\n{userRequest}\n\n== USER'S EXPECTATION ==\n{expectation}\n\n== CURRENT EVENT ==\nTime: {timestamp}\nSummary: {summary}\n{details}{metadata}\n\nIMPORTANT: Only return shouldNotify=true if the conditions are EXACTLY met: ... Answer strictly based on whether conditions are EXACTLY met."

=== memU SUFFICIENCY JUDGER (verbatim core, `memU prompts/retrieve/judger.py`) ===
"Judge whether the retrieved content is sufficient to answer the user's query. ... - Did the user explicitly ask to recall or remember more information? ... <consideration>Explain your reasoning...</consideration> <judgement>ENOUGH or MORE</judgement>"

=== memU PRE-RETRIEVAL DECISION (verbatim core, `prompts/retrieve/pre_retrieval_decision.py`) ===
"Determine whether the current query requires retrieving information from memory or can be answered directly... NO_RETRIEVE for: Greetings, casual chat... General knowledge questions... RETRIEVE for: Questions about past events... user preferences, habits... If retrieval is needed, rewrite the query to incorporate relevant context. Output: <decision>RETRIEVE or NO_RETRIEVE</decision> <rewritten_query>...</rewritten_query>"

=== TOPIC CLASSIFIER (verbatim, `temporary-topic.ts`) ===
System: "Classify the query's relationship to conversation topics. Reply with ONLY one label, no explanation." Labels MAIN mode: "stay-main (query continues main topic) or enter-temp (query departs to a new topic)"; TEMP mode: "stay-temp (query continues temp topic), exit-temp (query returns to main topic), or replace-temp (query starts yet another unrelated topic)". User: "Main topic: {ref}\nTemp topic: {ref}\nQuery: {q}\nLabel: {labels}". Model: claude-4-haiku-20250514.

=== SCHEMAS WORTH COPYING ===
ts: `interface RetrievalEscalationThresholds { scoreThresholdHigh: 0.64; top1Top2Margin: 0.08; maxItemsForL1: 4; maxItemsForL2: 2 }`
ts: `interface EscalationDecision { reachedLayer: 'L0'|'L1'|'L2'; reason: string; top1Score: number; top1Top2Margin: number; queryMode: 'broad'|'structured'|'precise' }`
ts: `interface LayeredContextNode { id; parentId:'root'; abstract; summary; resourcePath; keywords[]; checksum; metadata:{platform; chatId; startMessageIndex; endMessageIndex; messageCount; recencyRank}; tokenEstimate:{l0;l1;l2} }`
ts: `interface InvokeRequest { context:{userRequest; expectation; notifyPlatform?}; data:{summary; details?; timestamp; metadata?}; serviceId? }` / `InvokeResult { success; action:'notified'|'ignored'|'error'|'rate_limited'; reason; notificationSent; platform?; message? }`
py: `MemoryItem.extra = { content_hash: sha256(type+':'+normalized_summary)[:16], reinforcement_count: int, last_reinforced_at: iso, ref_id, when_to_use, tool_calls }`
py salience: `similarity * log(reinforcement_count + 1) * exp(-0.693 * days_since / 30.0)` (unknown recency → factor 0.5)
=== memU [ref:ITEM_ID] CANVAS PROMPT (core, `category_with_refs.py`) === "You are a professional User Profile Synchronization Specialist. Your core objective is to accurately merge newly extracted user information items into the user's initial profile using only two operations: add and update. IMPORTANT: You must include inline references to source memory items using the format [ref:ITEM_ID]... If multiple items support the same fact, include multiple refs: [ref:id1,id2]... Always ensure that your output does not exceed {target_length} tokens."


#### Ranked steal list (with target in our design)

1. 1. SYNTHETIC-STIMULUS UNIFICATION (→ Concern Engine, see→infer step): convert every observer event (email delta, calendar, the 6 OS observers, perception-sweep findings) into a synthetic user turn ({role:'user', content:'Here's a new email...\n'+payload}) appended to a rolling shadow window the concern engine consumes — ONE pipeline for reactive+proactive, no second prompt format. Copy the BASELINE-FIRST rule verbatim: first observation of any source only records state, never fires (proactive.service.ts checkNewEmails). This kills cold-start false positives in KAIROS's observers.
2. 2. [NO_MESSAGE] SENTINEL AS GATE ZERO (→ RestraintPipeline): make the concern-engine decision pass emit exact-sentinel-or-content, strip with `out.trim() === '[NO_MESSAGE]' ? '' : out` at delivery, and include memUBot's normalization phrase '(which is very common)' in the prompt — it measurably biases the model toward silence as the default. Keep the silent turn in the proactive plane's own history so KAIROS remembers it considered-and-declined (feeds SURPRISE: re-evaluating the same stimulus shouldn't re-fire).
3. 3. L0/L1/L2 ESCALATE-ON-UNCERTAINTY RETRIEVAL (→ memory/decision-time injection + concern-graph reads): inject 120-token abstracts by default, 1200-token summaries only when top1<0.64 or top1−top2<0.08, full evidence (max 2 transcripts) only when L1 rerank still fails (l1Top1 < 0.9×0.64 or margin < 0.5×0.08); hybrid score = 0.65·dense + 0.35·BM25 + recency prior ≤0.08, phrase bonus 0.15, 45%-of-budget cap, sha1-checksum chunk caching so unchanged history is never re-summarized, dense-provider FAIL-OPEN to sparse with a 1.2s timeout. Directly applicable to KAIROS's voice-latency-sensitive context engineering (smart-pipeline #3).
4. 4. STRICT EXACT-MATCH VALUE-FILTER PROMPT (→ RestraintPipeline LLM gate): adopt the evaluate() prompt wholesale — JSON {shouldNotify, message, reason}, 'Be VERY conservative... close to the time is NOT a match — REJECT it... Near the threshold is NOT enough', strict schema validation, 3 retries/5s, FAIL-SILENT (evaluation failure = no notification, never a degraded one). The {userRequest, expectation} pair is the right input contract: KAIROS concerns should carry an explicit 'expectation' field the filter judges against.
5. 5. TWO-LAYER FILTERING DOCTRINE + BUFFER THRESHOLD (→ restraint/UrgencyFloor ordering): hard-code 'local rules filter 99% BEFORE any LLM gate' as a design invariant for the 30-min sweep and observers, with the buffer trick (algorithmic threshold slightly looser than the user's stated one so the LLM judges the gray zone, e.g. user says 5% → local gate at 3%). memUBot claims 95%+ LLM-call savings; this is the cost story for KAIROS running 24/7.
6. 6. SALIENCE FORMULA + CONTENT-HASH REINFORCEMENT (→ You-Policy behavioral memory): score = similarity × log(reinforcement_count+1) × exp(−0.693·days/half_life), half-life 30d, unknown-recency factor 0.5; writes dedupe via sha256(type:normalized_summary)[:16] — same fact observed again → reinforce counter + timestamp instead of duplicate row. This is the exact reinforcement+decay mechanism KAIROS's Memory Reducer needs; JudgmentEvents (accept/dismiss) can simply bump/penalize reinforcement_count.
7. 7. EVIDENCE-CITED CANVAS WITH [ref:ITEM_ID] (→ concern graph): keep each concern node's summary as an LLM-maintained Markdown digest updated with ONLY add/update operations, hard target_length, and inline [ref:ITEM_ID,ID2] citations to source memory items (memU category_with_refs prompt). Gives KAIROS's concern canvas traceability (every claim → evidence) and enables reference-following retrieval (memU's use_category_references: when the summary is insufficient, fetch exactly the cited items instead of re-searching).
8. 8. wait_user_confirm + INPUT-INTERCEPTION BRIDGE (→ draft-and-propose / autonomy tiers): a blocking in-band approval tool — proactive sends the question to the user's most-recent channel, then infraService.tryConsumeUserInput routes the user's NEXT message on that channel INTO the suspended proactive tool call (bypassing the main agent), with a 10-min timeout that returns a structured non-approval the model must handle. KAIROS's voice approve flow should adopt the interception bridge so 'yes' answers a pending proposal instead of spawning a new turn (extends the existing pendingResolver/memory-confirm short-circuit to proactive proposals).
9. 9. PROACTIVE-VISIBILITY HANDSHAKE (→ delivery/conversation replay): after a proactive send, invalidateContextForPlatform forces the reactive pipeline to reload history so the next user turn 'sees' what proactive said (agent.service.ts:817). KAIROS must write proactive utterances into the durable transcript (conversation-replay tables) so 'what did you just ping me about?' works — cheap, easy to forget, breaks trust when missing.
10. 10. SUFFICIENCY-JUDGER ESCALATION LOOP (→ concern engine retrieval, smart-model path): memU's alternative to score thresholds — coarse tier first, then an LLM judge 'ENOUGH or MORE' (<consideration> + one-word <judgement>) WITH query rewriting between tiers, plus a pre-retrieval RETRIEVE/NO_RETRIEVE gate that skips memory entirely for greetings/meta-queries. Use thresholds (steal #3) on the fast voice path and this judger loop on the background/planner path; the NO_RETRIEVE gate is a free latency win for KAIROS voice.
11. 11. IDLE GATE + RUN-THEN-SCHEDULE SWEEPS (→ timing/chassis): proactive tick refuses to run unless the foreground agent is idle/complete, and the next sweep is scheduled only AFTER the current one finishes (setTimeout self-scheduling, not cron) — structurally no overlapping sweeps, no competing with a live voice turn. Apply to KAIROS's 30-min perception sweep: gate on conductor pipeline state, self-schedule after completion.
12. 12. SEPARATE MEMORY SCOPES FOR THE PROACTIVE PLANE (→ concern engine storage): memUBot uses distinct memU identities (memuUserId/agentId for user memory vs memuProactiveUserId/proactiveAgentId for the todo/working state). KAIROS should likewise keep concern-graph working state in a separate namespace from user behavioral memory so proactive bookkeeping never pollutes you-policy retrieval.
13. 13. TEMP-TOPIC FREEZE/RESTORE (→ context engineering, lower priority): a 5-label Haiku classifier (stay-main/enter-temp/stay-temp/exit-temp/replace-temp) that freezes the main conversation on a digression and restores it verbatim on return, with fail-safe 'classifier error → stay' — useful for KAIROS voice when the user interrupts a task with an unrelated ask; thresholds 0.55/0.55/0.8.


#### Citations

- https://github.com/NevaMind-AI/memUBot — repo root (Electron app, AGPL-3.0, 444 stars, last push 2026-05-06)
- https://github.com/NevaMind-AI/memUBot/blob/main/src/main/services/proactive.service.ts — proactive plane: 30s tick, idle gate, synthetic email→user turn (checkNewEmails, line 436-481), PROACTIVE_SYSTEM_PROMPT (90-111), [NO_MESSAGE] strip (657), wait_user_confirm (263-308), sendToCurrentPlatform (820+)
- https://github.com/NevaMind-AI/memUBot/blob/main/src/main/services/agent/context/layered/types.ts — ContextLayer/LayeredContextNode/EscalationDecision schemas
- https://github.com/NevaMind-AI/memUBot/blob/main/src/main/services/agent/context/layered/config.ts — defaults: l0=120, l1=1200 tokens, thresholds 0.64/0.08, maxItemsForL1=4, maxItemsForL2=2, archiveChunkSize=8, maxArchives=12, maxRecentMessages=24
- https://github.com/NevaMind-AI/memUBot/blob/main/src/main/services/agent/context/layered/retriever.ts — escalation logic, hybrid scoring alpha=0.35, recency prior 0.08, adaptive thresholds, classifyQuery, 45% budget ratio
- https://github.com/NevaMind-AI/memUBot/blob/main/src/main/services/agent/context/layered/indexer.ts — chunking, sha1 checksum caching, summary→abstract generation, recencyRank
- https://github.com/NevaMind-AI/memUBot/blob/main/src/main/services/agent/context/layered/text-utils.ts — BM25 (k1=1.2,b=0.75), phrase bonus 0.15, blendDenseSparseScores
- https://github.com/NevaMind-AI/memUBot/blob/main/src/main/services/agent/context/layered/dense-score-provider.ts — memU embedding endpoints, 1200ms timeout, fail-open
- https://github.com/NevaMind-AI/memUBot/blob/main/src/main/services/agent/context/layered/temporary-topic.ts — Haiku topic classifier, freeze/restore, thresholds 0.55/0.55/0.8
- https://github.com/NevaMind-AI/memUBot/blob/main/src/main/services/agent.service.ts — main pipeline, applyLayeredContextIfEnabled (736-783, 1327), invalidateContextForPlatform (817), processingLock, evaluate() value-filter (1759-1906), Claude context-management beta (1386-1402)
- https://github.com/NevaMind-AI/memUBot/blob/main/src/main/services/memorization.service.ts — thresholds 20 msgs / 60-min debounce / 200 max batch, async memorize task + lazy status polling + crash recovery
- https://github.com/NevaMind-AI/memUBot/blob/main/src/main/services/infra.service.ts — event bus, tryConsumeUserInput interception (334-357)
- https://github.com/NevaMind-AI/memUBot/blob/main/src/main/services/back-service/invoke.ts — monitor→invoke→LLM-filter→notify flow, retry 3×5s
- https://github.com/NevaMind-AI/memUBot/blob/main/src/main/services/back-service/constants.ts — port 31415, rate limit 5/min, restart backoff [5,10,30,60,60]s
- https://github.com/NevaMind-AI/memUBot/blob/main/src/main/builtin-skills/service-creator/reference/architecture.md — two-layer filtering doctrine + buffer threshold
- https://github.com/NevaMind-AI/memUBot/blob/main/src/main/config/settings.config.ts — memu settings incl. separate proactive user/agent ids (113-118, 231-236)
- https://github.com/NevaMind-AI/memU — memory framework (Python, 13.8k stars, active)
- https://github.com/NevaMind-AI/memU/blob/main/src/memu/database/models.py — MemoryItem/MemoryCategory schemas, MemoryType union, compute_content_hash
- https://github.com/NevaMind-AI/memU/blob/main/src/memu/database/inmemory/vector.py — salience_score: sim × log(count+1) × exp(−0.693·days/30)
- https://github.com/NevaMind-AI/memU/blob/main/src/memu/database/sqlite/repositories/memory_item_repo.py — create-or-reinforce dedupe (295-372)
- https://github.com/NevaMind-AI/memU/blob/main/src/memu/app/retrieve.py — route_intention→category→sufficiency→items→sufficiency→resources workflow
- https://github.com/NevaMind-AI/memU/blob/main/src/memu/app/settings.py — RetrieveConfig defaults (top_k=5 per tier, sufficiency_check=True, ranking similarity|salience, recency_decay_days=30), default 10 categories
- https://github.com/NevaMind-AI/memU/blob/main/src/memu/prompts/retrieve/judger.py — ENOUGH/MORE sufficiency judger prompt
- https://github.com/NevaMind-AI/memU/blob/main/src/memu/prompts/retrieve/pre_retrieval_decision.py — RETRIEVE/NO_RETRIEVE + query rewrite prompt
- https://github.com/NevaMind-AI/memU/blob/main/src/memu/prompts/category_summary/category_with_refs.py — [ref:ITEM_ID] cited category-summary merge prompt
- https://github.com/NevaMind-AI/memU/blob/main/src/memu/prompts/memory_type/event.py — event extraction prompt (merge similar, keep latest/most certain)
- https://github.com/NevaMind-AI/memU/blob/main/examples/proactive/proactive.py — todo-driven self-continuation loop (todos → next synthetic user input)
- Local clones inspected: /tmp/memubot (memUBot @ 5532a84, 2026-05-04) and /tmp/memu (memU @ HEAD, 2026-06-09)


---

### GAIA (theexperiencecompany)

**Repo:** https://github.com/theexperiencecompany/gaia


#### Overview

GAIA (github.com/theexperiencecompany/gaia, heygaia.io) is a production, cloud-hosted + self-hostable "proactive personal AI assistant" — email triage, meeting prep, cross-tool workflows. Active as of 2026-06-06 (last commit b395a78), PolyForm Strict 1.0.0 license (source-visible, NOT open for reuse — steal patterns, not code). It is a large Nx monorepo: `apps/api` (FastAPI + Python 3.11, LangGraph/LangChain agents, the entire brain), `apps/web` (Next.js 16/React 19), `apps/desktop` (Electron), `apps/mobile` (Expo), `apps/voice-agent` (LiveKit/Deepgram/ElevenLabs), `apps/bots` (Discord/Slack/Telegram/WhatsApp). Datastores: MongoDB (todos/users/workflows), PostgreSQL (conversations), Redis (ARQ job queue + locks + backoff state), ChromaDB (canvas + knowledge vectors), Mem0 cloud (long-term user memory, graph enabled), RabbitMQ. Tool layer is Composio (also the webhook/trigger source); web crawling via crawl4ai; profile/memory extraction LLM is Gemini (gemini-2.0-flash). It runs as two processes: the FastAPI API and an ARQ worker (`apps/api/app/worker.py`) that owns all proactive cron jobs and deferred executions. Maturity: high — instrumented (Prometheus per-task histograms, wide-event structured logging), Redis-locked idempotency, safety-net crons for lost jobs, openspec change-tracking (`openspec/specs/tracked-todos-vfs`). I cloned it to /tmp/gaia-research for this analysis.


#### Architecture (moving parts + data flow)

PROACTIVE CORE = "tracked todos": GAIA-owned todos that double as working-memory records (the closest analog to KAIROS's concern graph). Moving parts and data flow:

1) RECORD LAYER — `apps/api/app/services/tracked_todo_service.py` (class `TrackedTodoService`). A tracked todo is a normal Mongo todo doc (collection `todos`) + label `gaia-tracked` + two extra string fields stored ON the document: `canvas_content` (agent-written brain, markdown) and `log_content` (system-written audit trail). Storage primitives in `apps/api/app/services/todo_canvas_storage.py`: `read_canvas/write_canvas/append_canvas/read_log/append_log/build_vfs_label` — all atomic Mongo `$set`s (they explicitly migrated AWAY from a JuiceFS/FUSE virtual filesystem to plain doc fields; `vfs_path` survives only as a display label `/users/{uid}/todos/{tid}`). Every canvas write triggers `schedule_gaia_tasks_sync(user_id)` and a fire-and-forget ChromaDB reindex.

2) VECTOR LAYER — `apps/api/app/utils/canvas_vector_utils.py`. ChromaDB collection `gaia_canvas`, one embedding per canvas, id `canvas_{todo_id}`, metadata {user_id, todo_id, title, updated_at, completed, labels(csv)}. `search_canvas_context(query, user_id, top_k=10, include_completed=True)` → [{todo_id, title, score, snippet[:500], completed}]. Completion does NOT delete the embedding — `mark_canvas_completed` flips metadata `completed=true` + `completed_at` so history stays searchable while active-only filters work (`{"$and":[{"user_id":...},{"completed":False}]}`).

3) AGENT TOOL LAYER — `apps/api/app/agents/tools/tracked_todo_tools.py`: six LangChain tools always bound to the executor: `create_tracked_todo` (title/description/initial_canvas/labels/priority/scheduled_at/recurrence/expires_at), `update_tracked_todo` (labels/due_date/priority/scheduled_at/recurrence/expires_at/references — with clear-via-empty-string semantics and cross-field validation "cannot have recurrence without scheduled_at"), `update_tracked_todo_canvas` (modes append/section/replace; `section` mode patches a single `## Heading` via `_patch_canvas_section` so the LLM never has to read-then-rewrite), `complete_tracked_todo(summary)`, `search_todo_context`, `list_tracked_todos`. The behavioral doctrine lives in a skill file the agent must read before scheduling: `apps/api/app/agents/skills/builtin/gaia-task-tracking/SKILL.md` (name: `tracked-todo-working-memory`).

4) CONTEXT-INJECTION LAYER — `apps/api/app/helpers/message_helpers.py`. Every chat turn gets an `ACTIVE TRACKED TODOS:` block via `_get_tracked_todos_section` → `TrackedTodoService.get_active_tracked_summary` (top 15 by updated_at, formatted as `"title" [labels] due(Nd)/OVERDUE(Nd) — {age}d old, updated {n}d ago | ID | VFS`), cached 60s in Redis EXCEPT when an `active_todo_id` binding exists (scheduled runs pin their own todo to the top with `⭐ ACTIVE`). Background runs additionally get `BACKGROUND_EXECUTION_BANNER` (same file, ~line 186): "no human is reading this turn… If you need a decision you cannot make, write the question into the active todo's canvas (Context section) and stop."

5) TRIGGER/PERCEPTION LAYER — `apps/api/app/services/triggers/` (registry.py + base.py + handlers/{gmail,gmail_poll,calendar,slack,github,linear,notion,asana,todoist,google_docs,google_sheets}.py). All external events arrive as Composio webhooks. `TriggerHandler.process_event` (base.py) → handler-specific `find_workflows` (match by composio trigger_id, or user_id for gmail) → for each matched workflow, `_queue_one_workflow` enriches context with `tracked_todos_context` = `TrackedTodoService.get_signal_matching_context(user_id)` (computed ONCE per user per event, memoized in `signal_context_by_user` dict) → `WorkflowQueueService.queue_workflow_execution`. Calendar handler supports countdown triggers (`calendar_event_starting_soon`, `countdown_window_minutes` = minutes_before_start; webhook-lag instrumentation warns when |lag| > 300s).

6) EXECUTION LAYER — ARQ worker (`apps/api/app/worker.py` + `apps/api/app/workers/tasks/tracked_todo_tasks.py`). `execute_tracked_todo(todo_id)` is a deferred ARQ job (enqueued with `_defer_until=scheduled_at`). It takes Redis lock `gaia_todo_exec:{todo_id}` (TTL 1800s, SET NX), skips completed/expired/`failed`-labeled todos, then either queues the todo's workflow or runs the agent directly via `call_agent_silent` with a prompt assembled from title + description + full canvas + `## Learnings` sections harvested from up to 5 `references` todos (`_collect_reference_context`). Fresh conversation_id per run (no history bloat). Retry: `gaia_retry_count`, MAX 3, backoff [1h, 4h], then `failed` label + ERROR notification. Recurrence: shortcuts daily/weekly/every_4h/every_1h + 5-field cron, ALWAYS evaluated in the user's stored IANA timezone, anchored to original wall-clock time so late runs don't drift (`_compute_next_run`).

7) MAINTENANCE LAYER — `apps/api/app/workers/tasks/maintenance_sweep_tasks.py` (the proactive sweep, detailed below) + `safety_net_check_orphaned_todos` (same file as execution tasks) + `rescan_pending_scheduled_tasks` (`workers/tasks/scheduler_recovery_tasks.py`) — both every 30 min, re-enqueue lost jobs with 0–60s jitter after checking the exec lock.

8) MEMORY LAYER — Mem0 cloud via `apps/api/app/agents/memory/client.py` (AsyncMemoryClient, org/project scoped, `project.update(enable_graph=True)`), service wrapper `apps/api/app/services/memory_service.py` (search cached in Redis under `user:{uid}:memories:{sha256(query|limit|threshold)[:16]}`). Per-provider extraction prompts in `apps/api/app/agents/prompts/memory_prompts.py` (1779 lines; one BASE prompt parameterized per integration).

9) ONBOARDING LAYER — `apps/api/app/services/onboarding/intelligence_service.py` (1572-line asyncio DAG, every node an independent task emitting WebSocket stage events: inbox_scanning → triage → todos/workflows/writing_style in parallel → first_message → social_profiles → holo card → complete) + profile crawler stack `apps/api/app/agents/memory/{profile_extractor,profile_crawler,email_processor}.py`.

10) DELIVERY LAYER — `apps/api/app/services/notification_service.py` + `apps/api/app/models/notification/notification_models.py`: NotificationRequest{user_id, source enum (AI_REMINDER, BACKGROUND_JOB, WORKFLOW_COMPLETED…), type (info/warning/error/success), priority 1–5, channels[ChannelConfig{channel_type: inapp|telegram|discord, priority, template}], content{title, body, actions[NotificationAction{type: redirect|api_call|modal, style, requires_confirmation, executed/executed_at double-fire guard}]}, scheduled_for}. ChannelPreferences{telegram, discord, whatsapp} per user.


#### Proactive mechanism — exactly how/when it acts

GAIA acts proactively through FIVE distinct mechanisms (no single "proactive engine" — composition of cheap deterministic sweeps + event hooks + per-todo scheduling):

A) SIGNAL-MATCH (event-driven, the see→learn hook). On every Composio webhook (`apps/api/app/services/triggers/base.py::process_event`), before queuing matched workflows, the system computes `get_signal_matching_context(user_id)` (`services/tracked_todo_service.py`): top-15 active tracked todos, each rendered as `- "title" [labels] (ID, vfs)` PLUS the first 5 lines of that todo's `## Key Details` canvas section, extracted with regex `_KEY_DETAILS_RE = re.compile(r"## Key Details\n((?:(?!\n## ).)*)", re.DOTALL)`. This string is injected into the workflow-execution prompt via `SIGNAL_MATCHING_INSTRUCTIONS` (`agents/prompts/workflow_prompts.py` ~line 287), which instructs: match incoming signal to todos by email address/sender, thread ID/event ID/issue ID, subject/topic, same person/project; on match, append to that todo's canvas (verbose: IDs, timestamps, quoted key sentences, update Current State, add Timeline entry); CRITICALLY "this matching step only MATCHES and UPDATES existing tracked todos — do not create a new one just because a signal arrived." Signal matching is a piggyback on workflows the user already has — so perception is the provisioned system workflows (gmail poll every 15 min for Inbox Triage, every 30 min for Auto-Draft Replies — `services/system_workflows/definitions/gmail.py`; calendar `calendar_event_starting_soon` 60 min before each meeting — `definitions/calendar.py`).

B) SCHEDULED EXECUTION (per-concern self-scheduling). The agent itself sets `scheduled_at`/`recurrence`/`expires_at` at todo-creation time; ARQ fires `execute_tracked_todo` at the deferred time (logic in `workers/tasks/tracked_todo_tasks.py`, see architecture section for lock/retry/recurrence). Structural paper trail: `append_canvas_timeline` writes `▶ {iso} — scheduled run started (conversation_id=…)` BEFORE the agent runs and `✓ … finished (summary=…)`/`✗ … failed (ExcType)` after, "so the run leaves evidence even if the LLM forgets" (tracked_todo_tasks.py lines 336–376).

C) MAINTENANCE SWEEP (`workers/tasks/maintenance_sweep_tasks.py::maintenance_sweep_tracked_todos`, cron every 2 hours at minute 15 — `worker.py` line 101–106: `cron(_maintenance_sweep_tracked_todos, hour={0,2,...,22}, minute=15)`). Pseudocode:
```
scan todos {completed:False, labels:'gaia-tracked'} limit 200
for each: skip if redis EXISTS gaia_maintenance_notified:{todo_id}   # inside backoff
  if expires_at <= now            -> EXPIRED bucket
  elif due_date <= now and no upcoming schedule -> OVERDUE bucket
  elif dormant (see below)        -> DORMANT bucket
cap each bucket at 20 per sweep
EXPIRED: if not user_daytime: continue (defer, no strike)
         if health_checks[uid] >= 10: continue
         LLM health-check prompt -> "ARCHIVE: reason" => archive + 1d cooldown
                                  -> else NOTIFY (subject to escalating backoff) => individual WARNING notification
OVERDUE: if not daytime: continue
         _register_notification (backoff) -> individual notification "'{title}' was due Nd ago and has no scheduled follow-up" + $addToSet label 'needs-follow-up'
DORMANT: if not daytime: continue
         if health-check budget left: LLM -> "EXECUTE: action" => re-enqueue execute_tracked_todo at now+rand(10,120)s + system_log 'maintenance_requeued' + 1d cooldown (NO strike consumed)
                                       -> "NEEDS_ATTENTION: why" => candidate for digest
         candidates pass through _register_notification (backoff); survivors bundled into ONE per-user digest
```
Dormancy predicate `_is_dormant`: `updated_at` idle > DORMANT_DAYS=5 AND no upcoming schedule AND (no blocking label OR idle > WAITING_LABEL_MAX_DAYS=8). BLOCKING_LABELS = {"waiting-for-reply", "waiting-for-approval", "blocked"} — i.e., waiting-on states shield a todo from nagging, but only for 8 days, then it surfaces as stuck. `_has_upcoming_schedule` treats a recurring todo whose scheduled_at is >2 days stale as ORPHANED (recurrence alone doesn't count).

D) HEALTH-CHECK AGENT (the LLM gate inside the sweep): `_call_health_check_agent` runs `call_agent_silent` with trigger_context {trigger_type:'maintenance_health_check', todo_id} and a constrained-output prompt (verbatim in prompts section) demanding exactly `ARCHIVE:|NOTIFY:` (expired) or `EXECUTE:|NEEDS_ATTENTION:` (dormant). Any agent error → "NEEDS_ATTENTION: Health check failed" (fail toward human review, never toward autonomous action). Hard cap MAX_HEALTH_CHECKS_PER_USER=10 LLM calls per user per sweep; over-budget dormant todos skip the LLM and go straight to digest candidacy.

E) SAFETY NETS + RE-ENGAGEMENT: `safety_net_check_orphaned_todos` (cron minute {0,30}) finds {scheduled_at <= now, completed:False, gaia-tracked, gaia_retry_count < 3}, limit 100, skips if exec lock held, re-enqueues with 0–60s jitter. `check_inactive_users` (cron 9:00 daily, `workers/tasks/user_tasks.py`) emails users inactive 7+ days, at most once per 7 days (guarded by `last_inactive_email_sent`).


#### Memory / user-model — exact structures

THREE memory tiers, each with exact schemas:

1) TRACKED-TODO CANVAS (working memory / concern record). Mongo doc fields (collection `todos`; see `services/tracked_todo_service.py`, `agents/tools/tracked_todo_tools.py`, indexes in `db/mongodb/indexes.py` — compound index `tracked_sweep` on gaia-tracked label + completion + range fields): {title, description, project_id, labels:[…,'gaia-tracked', plus state labels 'waiting-for-reply'/'waiting-for-approval'/'blocked'/'needs-follow-up'/'failed'], priority(high|medium|low|none), completed, completed_at, due_date, expires_at, scheduled_at, recurrence(str), references:[todo_ids], gaia_retry_count:int, vfs_path(display label), canvas_content:str, log_content:str, workflow_id?, created_at, updated_at}. Canvas markdown template (CANVAS_TEMPLATE, tracked_todo_service.py lines 39–58) has exactly six sections — `## Key Details` (email addresses, thread IDs, calendar IDs, issue IDs — "everything needed to take action"), `## Current State` ("what's true RIGHT NOW — updated after every action"), `## Activity Log` ("which agent did what, which tools it used, what the outcome was"), `## Timeline` (chronological; code-appended run markers land here), `## Context` ("accumulated context from signals, related information, decisions made"), `## Learnings` ("written on completion: what worked, what didn't, key decisions, timing insights, optimizations for next time"). `log_content` is the SYSTEM-only audit channel: timestamped `## {iso} [CREATED|CANVAS_UPDATED|COMPLETED|auto_archived|maintenance_requeued]` entries via `TrackedTodoService.system_log`; the agent never writes it. Field semantics worth copying verbatim: `due_date` = deadline ("overdue = still needs doing") vs `expires_at` = relevance window ("expired = no longer worth tracking" → skipped by executor, auto-archived by sweep).

2) RETRIEVAL/SCORING. Canvas embeddings in ChromaDB `gaia_canvas` (`utils/canvas_vector_utils.py`): pure cosine similarity via langchain `asimilarity_search_with_score`, no recency weighting, no reinforcement — recency is handled OUTSIDE retrieval by the context-injection layer (active summary sorts by updated_at desc, limit 15). Three retrieval surfaces with different compression: (a) `get_active_tracked_summary` — one line/todo + age/staleness for every chat turn (60s cache); (b) `get_signal_matching_context` — title + Key-Details-only (5 lines max) for webhook-triggered runs; (c) `search_todo_context` tool — full semantic search incl. completed, snippet[:500]. Update = delete-then-re-add embedding, explicitly preserving the `completed` metadata across reindex (update_canvas_embedding lines 57–80). Supersession of records: completion soft-archives (metadata completed=true, vfs_path relabeled `/todos/archive/`), embedding kept for history QA ("what happened with Rahul's contract?").

3) INSTITUTIONAL MEMORY / CROSS-CONCERN LEARNING. `references: [todo_id]` links (append-only via `$addToSet`); at scheduled execution, `_collect_reference_context` (tracked_todo_tasks.py lines 241–261) extracts only the `## Learnings` section (`_extract_learnings`) from up to 5 referenced canvases and prepends "Past experience (from similar completed todos):" to the run prompt. The skill doc defines the learnings quality bar: GOOD "Sarah responds in 2-3 days", "approval takes 1 week"; BAD "went well".

4) LONG-TERM USER MEMORY = Mem0 cloud (graph memory enabled) — `agents/memory/client.py`, `services/memory_service.py`. MemoryEntry model (`models/memory_models.py` parse in memory_service.py): {id, content, user_id, metadata, categories[], created_at, updated_at, expiration_date, immutable:bool, relevance_score}. Mem0 itself does CRUD-diff dedup/supersession server-side; GAIA's contribution is the EXTRACTION DOCTRINE (`agents/prompts/memory_prompts.py::BASE_MEMORY_EXTRACTION_PROMPT`): priority-ordered extraction — 1. IDENTITY MAPPINGS (name↔ID/email/handle, "FORMAT: [Name] maps to [ID]: [context where discovered]"), 2. CONTACT DIRECTORY (roles, relationships, comms preferences), 3. RESOURCE REGISTRY (doc/channel/repo IDs), 4. PROCEDURAL KNOWLEDGE (trigger → exact tool sequence that worked → verification), 5. USER PREFERENCES; rules: be specific with real IDs, include discovery context, skip ephemera, NO SECRETS. Decay: only via Mem0 `expiration_date` + the Redis search cache TTL; no ACT-R-style activation (that's Vellum's trick, GAIA doesn't have it).


#### Restraint & timing — how it avoids annoyance

All restraint state is in Redis, per-todo, two-key design (`workers/tasks/maintenance_sweep_tasks.py`):
- COOLDOWN key `gaia_maintenance_notified:{todo_id}` — its mere EXISTENCE removes the todo from sweep classification (`_classify_tracked_todos` skips on `pool.exists`). Set after every sweep decision.
- STRIKE key `gaia_maintenance_strikes:{todo_id}` — an integer escalation level with its OWN TTL (STRIKE_TTL_DAYS=30) that deliberately OUTLIVES each cooldown "so the escalation level survives between notifications; it resets only after this much silence."

ESCALATING BACKOFF (`_register_notification`, lines 646–668, exact logic):
```
strike = int(GET strike_key or 0) + 1
if strike > len(NOTIFICATION_BACKOFF_DAYS):      # (1, 3, 7)
    SET cooldown EX 30d (NOTIFICATION_MUTE_DAYS) ; return False  # MUTED — caller must not send
SET strike_key=strike EX 30d
SET cooldown EX NOTIFICATION_BACKOFF_DAYS[strike-1] days          # 1d, then 3d, then 7d
return True   # send now
```
Net effect: at most 3 notifications about the same stuck todo (immediately, +1d, +3d), then 7d quiet, then 30d mute; if the user fixes it and 30 days pass with no strikes, the ladder resets. Non-notification outcomes consume NO strike: expired→archived and dormant→requeued get only a 1-day cooldown (`_set_cooldown(pool, todo_id, NOTIFICATION_BACKOFF_DAYS[0])`).

QUIET HOURS = DEFER, NOT DROP: DAYTIME_START_HOUR=9, DAYTIME_END_HOUR=21 in the USER's IANA timezone (`utils/timezone.py::is_within_local_daytime`, `start <= local_hour < end`). `_is_user_daytime` is cached per-user per-sweep; outside the window the todo is simply `continue`d — "Defer to a daytime sweep — no cooldown consumed, retried later" — so the next 2-hourly sweep retries and NO escalation strike is burned overnight. Fails OPEN (returns True) if user/timezone can't be resolved.

LLM BUDGET: MAX_HEALTH_CHECKS_PER_USER=10 agent calls per user per sweep (`health_checks_used` dict); over budget → dormant todos bypass the LLM straight to digest candidacy, expired todos are skipped to a later sweep.

VOLUME CAPS: scan limit 200 docs per sweep; each tier (expired/overdue/dormant) capped at 20.

DIGEST BATCHING (`_send_dormant_digest` / `_send_user_dormant_digest`): dormant needs-attention todos that survive backoff are grouped per user into ONE INFO notification, priority=2, title "N dormant todos need attention", body = one line per todo `- {title} (idle Nd)`, primary action deep-links `/todos?todoId={id}` when count==1 else lands on `/todos`. Individual notifications are reserved for expired (WARNING) and overdue (WARNING) only.

OTHER RESTRAINT MECHANICS: (a) creation doctrine — "reads never qualify", "search first, create last", "one todo per initiative" (TODO_SYSTEM_PROMPT + SKILL.md), preventing concern-graph bloat at the source; (b) signal matching may only UPDATE, never create; (c) `failed` label after 3 retries hard-stops auto-execution until a human resets; (d) per-todo Redis exec lock (TTL 1800s) prevents double-fire from the at-least-once scheduling design; (e) jitter everywhere (10–120s on requeue, 0–60s on safety net) to avoid thundering herds; (f) re-engagement email max once per 7 days, twice total (7d and 14d marks); (g) notification actions carry `requires_confirmation` and an `executed/executed_at` guard against double execution of API_CALL actions.

TIMEZONE-CORRECT TIMING: all recurrence math in the user's stored tz; cron first-fire computed user-local; anchored shortcuts (daily/weekly) advance whole steps from the ORIGINAL anchor so a late run never drifts the wall-clock fire time (`_compute_next_run`, tracked_todo_tasks.py lines 424–500).


#### Prompts & schemas worth copying

— CANVAS_TEMPLATE (services/tracked_todo_service.py, verbatim):
"""# {title}

## Key Details
<!-- email addresses, thread IDs, calendar IDs, issue IDs — everything needed to take action -->

## Current State
<!-- what's true RIGHT NOW — updated after every action -->

## Activity Log
<!-- which agent did what, which tools it used, what the outcome was — add entries HERE, not in Learnings -->

## Timeline
<!-- chronological list of actions taken and results -->

## Context
<!-- accumulated context from signals, related information, decisions made -->

## Learnings
<!-- written on completion: what worked, what didn't, key decisions, timing insights, optimizations for next time -->"""

— SIGNAL_MATCHING_INSTRUCTIONS (agents/prompts/workflow_prompts.py, verbatim):
"""TRACKED TODOS (Working Memory)
{tracked_todos_context}

SIGNAL MATCHING (do this BEFORE running the workflow):
Check whether the incoming signal (email, calendar event, slack message, etc.) relates to any tracked todo listed above. Match by:
- Email address or sender name appearing in a todo's Key Details
- Thread ID, event ID, or issue ID matching a todo's Key Details
- Subject or content that clearly relates to a todo's title or description
- Same person, project, or topic as an active todo

If a match is found, update that todo's canvas with the new signal information using update_tracked_todo_canvas (mode "append" or "section" — do not read the canvas and rewrite the whole thing). Be verbose, this is GAIA's working memory: include email addresses, thread IDs, event IDs, timestamps; quote the key sentences (not whole emails); update Current State; add a Timeline entry "- {date}: {what happened}".

This matching step only MATCHES and UPDATES existing tracked todos — do not create a new one just because a signal arrived."""

— EXPIRED health-check prompt (maintenance_sweep_tasks.py, verbatim):
"A tracked todo has expired.\nTitle: {title}\nCanvas:\n{canvas}\n\nDid this expire cleanly (i.e. no further action is needed)? Respond with exactly one of:\nARCHIVE: <brief reason>\nNOTIFY: <message to send to the user>"

— DORMANT health-check prompt (verbatim):
"A tracked todo has been dormant for {idle_days} days.\nTitle: {title}\nCanvas:\n{canvas}\n\nIs there a clear, concrete next action that can be taken right now? Respond with exactly one of:\nEXECUTE: <specific action to perform immediately>\nNEEDS_ATTENTION: <brief summary of why this needs human review>"

— BACKGROUND_EXECUTION_BANNER (helpers/message_helpers.py, verbatim):
"🤖 BACKGROUND EXECUTION (no human is reading this turn)\n - You were woken by a scheduled trigger. There is no user to ask.\n - Do NOT ask clarifying questions, present plans for approval, or seek confirmation.\n - Do NOT produce conversational acknowledgements ('Sure, I'll…', 'Let me know if…').\n - Just execute. If you need a decision you cannot make, write the question into the active todo's canvas (Context section) and stop.\n - Your output is consumed by the system, not a human. Be terse and action-only."

— TODO_SYSTEM_PROMPT key excerpt (agents/prompts/todo_prompts.py): "You have TWO separate task systems — do not confuse them. — EXECUTION PLANS (plan_tasks/update_tasks) — Ephemeral step tracking for YOUR current work… — GAIA TRACKED TODOS — Create only when GAIA itself performs or schedules a real action on an external system that it needs to remember, follow up on, or repeat… Reads never qualify… One todo per initiative. Two modes: IMMEDIATE: create → act → document → complete. LONG-RUNNING: create → act → update canvas → leave open. Only the executor creates these — subagents NEVER create tracked todos."

— PROFILE-EXTRACTION prompt (agents/memory/profile_extractor.py::EXTRACTION_PROMPT), the anti-hallucination core verbatim: "CRITICAL RULE: The username MUST be written EXACTLY in the email. DO NOT create, construct, guess, or infer usernames. … ABSOLUTELY FORBIDDEN: DO NOT convert the user's name into a username ('John Doe' → 'john-doe' is WRONG) … If you have to guess, infer, or construct it → return 'NOT_FOUND'". Structured output schema: `class UsernameExtraction(BaseModel): username: str  # 'NOT_FOUND' if absent; confidence: str  # 'high' explicitly stated / 'medium' inferred / 'low' uncertain`. Post-LLM: regex validation per platform (PLATFORM_CONFIG: 16 platforms, each {sender_domains[], url_template, regex_pattern}) then canonical URL build.

— SOCIAL_PROFILE_FILTER_PROMPT (agents/prompts/onboarding_prompts.py) ownership filter: INCLUDE if appeared in SENT email / handle resembles user name/email / account-notification language ("your account", "you have a new follower") / platform-sender referencing the handle as the user's / signature co-occurrence; EXCLUDE only if clearly someone else's; "When in doubt, INCLUDE."

— BASE_MEMORY_EXTRACTION_PROMPT (agents/prompts/memory_prompts.py): priority ladder 1.Identity mappings → 2.Contact directory → 3.Resource registry → 4.Procedural knowledge → 5.Preferences; rules "BE SPECIFIC: include actual IDs… AVOID DUPLICATES… SKIP EPHEMERAL DATA… NO SECRETS"; format examples "BAD: 'The user mentioned something about email' / GOOD: 'User's manager Sarah Chen can be reached at sarah.chen@company.com'".

— Notification schema worth copying (models/notification/notification_models.py): NotificationRequest{id, user_id, source: enum, type: info|warning|error|success, priority: 1–5, channels: [ChannelConfig{channel_type, enabled, priority, template, config}], content: {title, body, actions: [NotificationAction{type: redirect|api_call|modal, label, style, config{redirect{url, open_in_new_tab, close_notification}|api_call{endpoint, method, payload, success_message}|modal{component, props}}, requires_confirmation, executed, executed_at}], rich_content}, metadata, scheduled_for} → NotificationRecord adds per-channel ChannelDeliveryStatus{status, delivered_at, error_message, retry_count, skipped}.

— Onboarding constants: ONBOARDING_EMAIL_SCAN_LIMIT=200 (1 month, batches of 50), ONBOARDING_TODO_LIMIT=3, triage starts early at 100 buffered emails (_TRIAGE_EARLY_THRESHOLD), exactly-4 workflows schema (_WorkflowList min_length=4 max_length=4), crawl timeout 15s per profile, content truncated ~50KB, dedup threshold SequenceMatcher ratio ≥ 0.9.


#### Ranked steal list (with target in our design)

1. 1. CANVAS-AS-CONCERN-RECORD with the exact 6-section markdown template (Key Details / Current State / Activity Log / Timeline / Context / Learnings) + section-targeted write tool. → CONCERN ENGINE: make each KAIROS concern a markdown canvas stored as a field on the concern doc (no FS), with an update tool offering append|section|replace modes so the LLM patches `Current State` without read-modify-write. Key Details is the machine-matchable surface (thread IDs, emails, event IDs) — exactly what our EXPECTATIONS matcher needs.
2. 2. TWO-KEY ESCALATING BACKOFF (cooldown key gates re-processing; separate strike counter with longer TTL preserves escalation level): 1/3/7 days then 30-day mute, strikes reset after 30 quiet days; non-notification outcomes (auto-archive, requeue) consume NO strike. → RESTRAINT: drop this verbatim into RestraintPipeline as a per-concern Redis pair (kairos_concern_notified:{id} / kairos_concern_strikes:{id}); it composes cleanly with karma — strikes are per-concern annoyance, karma is global.
3. 3. QUIET-HOURS-AS-DEFER (9–21 user-local; outside window = skip with NO strike/cooldown consumed, retried next sweep; per-user daytime cached per sweep; fail-open on unknown tz). → TIMING: our breakpoint-timing layer should adopt 'defer never drop, never burn budget overnight' — currently easy to get wrong if the urgency floor consumes a rate-limit slot while the user sleeps.
4. 4. TIERED SWEEP CLASSIFICATION expired/overdue/dormant with the dormancy predicate: idle > 5d AND no upcoming schedule AND (no waiting-on label OR idle > 8d). The waiting-for-reply/waiting-for-approval/blocked label shield with an 8-day stuck-escape-hatch is exactly the 'waiting-on' semantics in our concern graph. → CONCERN ENGINE: encode concern states as labels; the sweep surfaces stuck waiting-ons automatically after the shield window.
5. 5. SINGLE-TOKEN-PREFIX LLM GATES (ARCHIVE:|NOTIFY:, EXECUTE:|NEEDS_ATTENTION:) with a hard per-user LLM budget (10 calls/sweep) and fail-toward-human on any error. → RESTRAINT + YOU-POLICY: our value-filter gate should be this shape — constrained prefix output parsed with startswith, capped per sweep, default NEEDS_ATTENTION on failure. Cheap, auditable, never silently autonomous.
6. 6. KEY-DETAILS-ONLY SIGNAL CONTEXT, computed once per user per event and injected into every triggered run with 'MATCH AND UPDATE ONLY, never create': regex-extract the Key Details section (5 lines max) per active concern, memoize per user within one event fan-out. → CONCERN ENGINE see→learn loop: this is the cheapest possible expectation-matching context; pair it with our SURPRISE scoring (signal matched no expectation = surprise candidate).
7. 7. CODE-ENFORCED TIMELINE MARKERS: the runner writes ▶ start / ✓ done / ✗ failed entries into the canvas Timeline BEFORE and AFTER every autonomous run 'so the run leaves evidence even if the LLM forgets'. → CHASSIS/activity log: KAIROS's activity_events should also write into the concern canvas itself, structurally, not via the LLM.
8. 8. DORMANT DIGEST BATCHING: individual pushes only for expired/overdue (WARNING); dormant items pooled into ONE per-user INFO digest with per-item idle-days and a deep link (single item → ?todoId= deep link, multiple → list). → DELIVERY/digests: adopt the severity→routing split (warnings push individually, FYIs batch) and the single-vs-multi deep-link rule for the glance card.
9. 9. expires_at vs due_date SEMANTICS (deadline = still needs doing when passed; relevance window = auto-archive when passed, executor skips expired). Plus health-check auto-archive with reason logged. → CONCERN ENGINE lifecycle: every KAIROS concern gets both fields; expiry is how the concern graph self-prunes without user effort.
10. 10. LEARNINGS HARVESTING ACROSS CONCERNS: a completion-only ## Learnings section with an explicit quality bar ('Sarah responds in 2-3 days' good; 'went well' bad), a references[] link field, and execution-time injection of Learnings from up to 5 referenced past concerns ('Past experience (from similar completed todos):'). → YOU-POLICY: this is a concrete supersession-free alternative for behavioral memory seeding — completed-concern learnings become candidate behavioral memory items for the Memory Reducer.
11. 11. SOFT-ARCHIVE VECTOR INDEXING: completed concern embeddings stay in Chroma with completed=true metadata (searchable history, filterable active set); reindex-on-write preserves the completed flag. → CONCERN ENGINE retrieval + our activity recall: never delete, flag and filter.
12. 12. CREATION RESTRAINT DOCTRINE as prompt + skill: 'reads never qualify', 'search first, create last', 'one concern per initiative', 'subagents never create', signal-match never creates. → RESTRAINT gate 0: prevent concern-graph bloat at the source; KAIROS's concern engine needs this exact rule or the graph rots (GAIA calls it out: 'Overusing tracked todos degrades search quality and clutters GAIA's memory').
13. 13. BACKGROUND_EXECUTION_BANNER + park-the-question pattern: background runs get an explicit no-human banner and the instruction to write unresolvable decisions into the concern's Context section and STOP. → AUTONOMY TIERS: our draft-and-propose path should park open questions on the concern canvas, which the next user-facing surface (morning brief / glance card) can then ask.
14. 14. ONBOARDING PROFILE CRAWLER PIPELINE (two complementary paths): (a) targeted parallel Gmail searches per platform sender-domain → near-dup email dedup (SequenceMatcher ≥0.9) → LLM username extraction with NOT_FOUND-biased anti-hallucination prompt + confidence → per-platform regex validation → canonical URL → crawl4ai (15s timeout, browser semaphore) → mem0 store → second-hop discovery of cross-linked profiles from crawled content; (b) broad URL harvest from email bodies → frequency+SENT-email scoring → LLM ownership filter ('when in doubt, INCLUDE') with sent-email fallback when LLM fails. → ONBOARDING: KAIROS should run path (b) first (cheap, no crawling) and path (a) for the top platforms; the deterministic-validation-after-LLM and fallback-on-LLM-failure shapes are the keepers.
15. 15. ONBOARDING INTELLIGENCE DAG: every node an independent asyncio task emitting WebSocket stage events (no fake progress %), triage starts at 100 buffered emails before fetch completes, inbox scan cached for re-runs, unconditional phase-completion write even on failure, exactly-3 todos + exactly-4 workflows schemas, anti-slop prompt rules ('If you reference a sender or subject from the inbox, copy it byte-for-byte… Inventing fake email anchors is worse than no anchor', 'return 2 or 1… Never pad'). → ONBOARDING: copy the early-start/stream-stages/quality-over-quantity structure for KAIROS's SoulWizard + first-concerns seeding.
16. 16. ANTI-DRIFT RECURRENCE: shortcuts anchored to original wall-clock in user tz (late run advances whole steps from anchor, never drifts), cron evaluated user-local, scheduled_at ignored when cron present, stale-recurring (scheduled_at >2d old) treated as orphaned. Plus safety-net cron (every 30 min) re-enqueueing due-but-lost jobs after a lock check with 0–60s jitter, and per-concern Redis exec locks (NX, TTL 1800s). → TIMING/CHASSIS: adopt all three for KAIROS's scheduler; the orphan-detection predicate is the subtle part we'd have missed.
17. 17. IDENTITY-MAPPING-FIRST memory extraction ladder (mappings > contacts > resources > procedures > preferences, with 'include discovery context' and 'no secrets' rules). → YOU-POLICY memory: use as the extraction rubric for KAIROS's Memory Reducer when mining tool trajectories.


#### Citations

- https://github.com/theexperiencecompany/gaia (cloned to /tmp/gaia-research, last commit b395a78, 2026-06-06)
- apps/api/app/services/tracked_todo_service.py — CANVAS_TEMPLATE, get_signal_matching_context, get_active_tracked_summary, append_canvas_timeline, schedule_execution, archive_tracked_todo
- apps/api/app/services/todo_canvas_storage.py — Mongo-backed canvas/log primitives (read/write/append_canvas, append_log, build_vfs_label)
- apps/api/app/utils/canvas_vector_utils.py — ChromaDB 'gaia_canvas' store/update/mark_completed/search
- apps/api/app/workers/tasks/maintenance_sweep_tasks.py — sweep tiers, NOTIFICATION_BACKOFF_DAYS=(1,3,7), NOTIFICATION_MUTE_DAYS=30, STRIKE_TTL_DAYS=30, DORMANT_DAYS=5, WAITING_LABEL_MAX_DAYS=8, MAX_HEALTH_CHECKS_PER_USER=10, DAYTIME 9–21, _register_notification, _is_user_daytime, _send_dormant_digest, health-check prompts
- apps/api/app/workers/tasks/tracked_todo_tasks.py — execute_tracked_todo, Redis lock gaia_todo_exec:{id} TTL 1800, MAX_RETRY_ATTEMPTS=3, RETRY_BACKOFF=[1h,4h], _compute_next_run (anchored recurrence), _collect_reference_context (Learnings harvest), safety_net_check_orphaned_todos
- apps/api/app/worker.py — cron registration: maintenance sweep every 2h at :15, safety net + scheduler recovery every 30 min, inactive-user check daily 9:00
- apps/api/app/services/triggers/base.py — process_event, per-user memoized tracked_todos_context injection, countdown/webhook-lag instrumentation
- apps/api/app/services/triggers/handlers/gmail_poll.py, calendar.py — poll-interval and starting-soon countdown trigger registration
- apps/api/app/agents/prompts/workflow_prompts.py — SIGNAL_MATCHING_INSTRUCTIONS, WORKFLOW_EXECUTION_PROMPT
- apps/api/app/helpers/message_helpers.py — _get_tracked_todos_section (60s cache), BACKGROUND_EXECUTION_BANNER, format_workflow_execution_message
- apps/api/app/agents/tools/tracked_todo_tools.py — six tracked-todo tools, _patch_canvas_section, recurrence/first-fire validation
- apps/api/app/agents/skills/builtin/gaia-task-tracking/SKILL.md — tracked-todo-working-memory doctrine (search-first, two modes, learnings quality bar, anti-patterns)
- apps/api/app/agents/prompts/todo_prompts.py — TODO_SYSTEM_PROMPT (two task systems)
- apps/api/app/utils/timezone.py — is_within_local_daytime
- apps/api/app/agents/memory/profile_extractor.py — PLATFORM_CONFIG (16 platforms), EXTRACTION_PROMPT, UsernameExtraction schema, dedup threshold 0.9
- apps/api/app/agents/memory/profile_crawler.py — crawl4ai crawl, 15s timeout, browser semaphore
- apps/api/app/agents/memory/email_processor.py — two-track onboarding pipeline, _process_single_platform, _discover_and_store_linked_profiles
- apps/api/app/services/onboarding/intelligence_service.py — onboarding DAG, stage events, early triage at 100 emails, exactly-3/exactly-4 schemas
- apps/api/app/services/onboarding/social_profile_service.py — URL harvest + LLM ownership filter + sent-email fallback
- apps/api/app/agents/prompts/onboarding_prompts.py — TRIAGE_TODOS_PROMPT anti-slop rules, SOCIAL_PROFILE_FILTER_PROMPT, WORKFLOW_CREATION_PROMPT, first-message prompts
- apps/api/app/agents/prompts/memory_prompts.py — BASE_MEMORY_EXTRACTION_PROMPT identity-mapping ladder
- apps/api/app/services/memory_service.py + apps/api/app/agents/memory/client.py — Mem0 AsyncMemoryClient (graph enabled), MemoryEntry fields, search cache key
- apps/api/app/models/notification/notification_models.py — NotificationRequest/Action/ChannelConfig schemas
- apps/api/app/services/system_workflows/definitions/gmail.py, calendar.py — auto-provisioned Inbox Triage (15-min poll), Auto-Draft Replies (30-min poll), Meeting Briefing (60-min countdown)
- apps/api/app/workers/tasks/user_tasks.py — check_inactive_users 7d/14d re-engagement
- apps/api/app/constants/todos.py, constants/email.py, constants/general.py — GAIA_TRACKED_LABEL, ONBOARDING_EMAIL_SCAN_LIMIT=200, ONBOARDING_TODO_LIMIT=3, DEDUPLICATION_SIMILARITY_THRESHOLD=0.9, gemini-2.0-flash


---

### vellum-assistant (vellum-ai)

**Repo:** https://github.com/vellum-ai/vellum-assistant


#### Overview

github.com/vellum-ai/vellum-assistant — "A personal AI assistant that evolves with you. Memory, personality, proactive reach-outs — across macOS, Telegram, and Slack." MIT-licensed, production-grade TypeScript/Bun monorepo, very mature (260+ SQLite migrations, hundreds of test files, per-package ARCHITECTURE.md docs). Packages: `assistant/` (the daemon — everything interesting lives here), `gateway/` (public ingress/webhooks), `cli/` (`vellum hatch`/`wake`/`sleep`), `clients/` (Swift macOS app), `credential-executor/` (hard process-isolated credential service), `plugins/`, `skills/`, `apps/`. Storage: SQLite via Drizzle ORM (`assistant/src/memory/schema/*`) + Qdrant for vectors (dense + in-process TF-IDF/BM25 sparse). LLM calls go through a provider abstraction with per-call-site model overrides (`llm.callSites.notificationDecision`, `llm.callSites.memoryRetrospective`, etc.). Runs local-first (daemon per assistant under `~/.vellum/`) or managed cloud. IMPORTANT for our extraction: the repo contains THREE generations of memory systems — (1) legacy typed `memory_items` (the typed/TTL/supersession/RRF/ACT-R blueprint, now dropped from code but fully documented in `assistant/docs/architecture/memory.md` and migrations), (2) a "simplified memory" reducer (time_contexts/open_loops + CRUD reducer) that was built and then REVERTED (migration `189-drop-simplified-memory.ts`), and (3) the live system: a Memory Graph (`assistant/src/memory/graph/`) plus a "Memory v2" concept-page wiki with spreading activation (`assistant/src/memory/v2/`, enabled by default). All three are documented below because each contributes a distinct piece of the You-Policy blueprint.


#### Architecture (moving parts + data flow)

DAEMON CORE: `assistant/src/daemon/lifecycle.ts` boots everything; `assistant/src/daemon/conversation-agent-loop.ts` runs turns; `assistant/src/agent/loop.ts` is the agent loop. Background work flows through a durable SQLite job queue: `assistant/src/memory/jobs-store.ts` (job types incl. `graph_extract`, `graph_decay`, `graph_consolidate`, `graph_pattern_scan`, `graph_narrative_refine`, `memory_v2_consolidate`, `memory_retrospective`, `embed_*`, `delete_qdrant_vectors`) and `assistant/src/memory/jobs-worker.ts` (polls ~1.5s, per-type lanes so slow consolidation can't block embeds; `maybeEnqueueGraphMaintenanceJobs()` at line ~758 schedules maintenance off durable checkpoints: decay hourly, consolidate 4h, pattern-scan daily, narrative weekly, v3-maintain 6h).

MEMORY WRITE PATH: every message → `assistant/src/memory/indexer.ts` (segments + embeds) → enqueues `graph_extract` on three triggers: batch of `config.extraction.batchSize` (default 10) messages, idle debounce (default 300s), or conversation dispose. `assistant/src/memory/graph/extraction-job.ts` reads checkpoint `graph_extract:<conversationId>:last_ts` and calls `runGraphExtraction()` in `assistant/src/memory/graph/extraction.ts` (1462 lines — THE reducer): builds a system prompt containing existing candidate nodes + a "Reconsolidation Window" of nodes that were actively recalled this conversation, forces tool call `extract_graph_diff`, parses into a `MemoryDiff` (create/update/delete/reinforce/edges/triggers, with temp_id resolution for new↔new edges), and `applyDiff()` in `assistant/src/memory/graph/store.ts` applies it in one SQLite transaction (soft-delete = fidelity:'gone' + Qdrant vector cleanup job; every content rewrite audited in `memory_graph_node_edits`).

SECOND REDUCER LANE (retrospective): `assistant/src/memory/memory-retrospective-trigger-check.ts` runs as a post-turn hook — cooldown 5min, interval 30min, message threshold 10 (`assistant/src/config/schemas/memory-retrospective.ts`) — and enqueues `assistant/src/memory/memory-retrospective-job.ts`, which FORKS the conversation, appends a user-role instruction, wakes the agent with `allowedTools: ["remember"]`, and dedupes against `<already_remembered>` extracted from the previous retrospective's `remember` tool calls. Two-pointer invariant: `lastProcessedMessageId` advances ONLY on successful invocation; `lastRunAt` advances on every attempt (try/finally) so the cooldown still applies after failures.

MEMORY READ PATH (graph v1): `assistant/src/memory/graph/conversation-graph-memory.ts` orchestrates; `assistant/src/memory/graph/retriever.ts` (`loadContextMemory`, budget "p90 < 2s") does: embed recent summaries + user query → Qdrant hybrid search (`assistant/src/memory/qdrant-client.ts:hybridSearch` — two prefetch queries dense+sparse, 40 candidates each, fused with Qdrant `query:{fusion:'rrf'}`) → union with top-significance + last-7-days nodes → evaluate triggers (`assistant/src/memory/graph/triggers.ts`) → activation spreading from triggered + top-10 semantic hits (`scoring.ts:computeActivationSpread`, BFS 2 hops, decay 0.5, max-not-sum) → score all candidates (`scoring.ts:scoreCandidate`, per-type weight profiles) → serendipity sampling (`serendipity.ts`, weighted-random from 30th–70th percentile) → cap (contextLoad maxNodes 25 + 5 serendipity + 5 capability reserve; perTurn 6 + 1 + 2, defaults in `assistant/src/config/schemas/memory-retrieval.ts`). `assistant/src/memory/graph/injection.ts:InContextTracker` keeps injection delta-only and evicts on compaction; injected node IDs are logged (`memory-recall-log-store.ts`) and fed back into the next extraction as `activeContextNodeIds` — the reconsolidation loop.

MEMORY v2 (live default, owns read path): on-disk markdown wiki under workspace `memory/` — `memory/buffer.md` (append-only capture via the `remember` tool, `assistant/src/memory/graph/tool-handlers.ts`), `memory/archive/<date>.md` (immutable), `memory/concepts/<class>/<slug>.md` concept pages with YAML frontmatter `{edges: [slugs], ref_files, ref_urls, summary, links}` (`assistant/src/memory/v2/types.ts:ConceptPageFrontmatterSchema`), plus `recent.md` (≤2K), `essentials.md` (≤10K), `threads.md` (≤10K active commitments). Every 4h (`memory.v2.consolidation_interval_hours`, noop if buffer < `MIN_BUFFER_LINES_FOR_CONSOLIDATION = 10` lines) the consolidation job wakes the full agent with the wiki-gardening prompt in `assistant/src/memory/v2/prompts/consolidation.ts`. Per-turn retrieval = spreading activation over directed page edges (`assistant/src/memory/v2/activation.ts`, formula below) with per-conversation persisted state (`activation_state` table in `assistant/src/memory/schema/memory-graph.ts`).

PROACTIVE PLANE: `assistant/src/heartbeat/heartbeat-service.ts` (HeartbeatService — the proactive loop), `assistant/src/prompts/templates/HEARTBEAT.md` (user-editable checklist), `NOW.md` (ephemeral present-tense scratchpad), journal. `assistant/src/schedule/scheduler.ts` (15-second tick, claim-based `claimDueSchedules`) + `assistant/src/schedule/schedule-store.ts` (`cron_jobs` table aliased `scheduleJobs`) + agent-facing tools in `assistant/src/tools/schedule/{create,update,list,delete}.ts`. `watchers` table (`assistant/src/memory/schema/infrastructure.ts`) = per-provider polling observers (pollIntervalMs default 60s, actionPrompt, watermark, consecutiveErrors). `assistant/src/followups/` = waiting-on tracking (statuses pending/resolved/overdue/nudged, expectedResponseBy, linked reminder schedule). All proactive output funnels through ONE chokepoint: `emitNotificationSignal()` in `assistant/src/notifications/emit-signal.ts` → candidate generation (`conversation-candidates.ts`) → LLM decision engine (`decision-engine.ts`) → `enforceRoutingIntent()` → deterministic checks (`deterministic-checks.ts`) → broadcaster → conversation pairing → channel adapters, with a 3-table audit trail (notification_events / notification_decisions / notification_deliveries).


#### Proactive mechanism — exactly how/when it acts

1) HEARTBEAT (the see→think→maybe-act loop), `assistant/src/heartbeat/heartbeat-service.ts`:
- Cadence: interval mode default `intervalMs = 60*60_000` (1h) OR cron mode (`cronExpression` + timezone) (`assistant/src/config/schemas/heartbeat.ts`).
- runOnce() gate sequence (pseudocode, exact order):
  if (!force && diskPressureLocked) skip;                       // gate 1
  if (!force && !config.enabled) skip("disabled");              // gate 2
  if (!force && !hasReceivedUserMessage()) skip("pre_first_user_message");  // gate 3: never proactive before first-ever user msg
  if (!force && hour outside [activeHoursStart=8, activeHoursEnd=22)) skip("outside_active_hours");  // gate 4, overnight windows handled
  if (!force && consecutiveRuns >= maxConsecutiveRuns=3) skip("max_consecutive_runs");  // gate 5: counter resets when the user (guardian) sends a message — resetTimer() also restarts the interval so no heartbeat fires right after a live conversation
  if (!force && completedRunsToday >= maxDailyRuns=2) skip("max_daily_runs");  // gate 6
  if (activeRun) skip("overlap");                               // gate 7
  → executeRun(): credential health check first; build prompt = HEARTBEAT.md checklist (user-editable, comment lines stripped) + <credential-status> + <heartbeat-disposition> + (<early-heartbeat> if completedRunCount < 3) + (<relationship-depth> if profile is shallow AND 18h re-engagement cooldown elapsed); run a full agent turn via runBackgroundJob (timeout 30min, trustClass guardian, callSite heartbeatAgent).
- THE KEY DESIGN: the heartbeat itself NEVER sends anything. The model, mid-turn, decides whether anything is worth surfacing and if so calls the `notifications` skill → emitNotificationSignal() → the value-filter pipeline below. Silence is the default outcome of a heartbeat run.
- Every run persisted in `heartbeat_runs` (status: pending|running|ok|error|timeout|skipped|missed|superseded, skip_reason: disabled|outside_active_hours|overlap|max_consecutive_runs|max_daily_runs|pre_first_user_message) — restraint decisions are fully auditable. Startup recovery marks stale runs missed/error and emits one deduped `activity.failed` signal per day.

2) NOTIFICATION DECISION PIPELINE (the value filter), `assistant/src/notifications/`:
Producer → emitNotificationSignal({sourceEventName, sourceChannel, sourceContextId, attentionHints:{urgency: low|medium|high|critical, requiresAction, isAsyncBackground, visibleInSourceNow, deadlineAt?}, contextPayload, routingIntent?, routingHints?, dedupeKey?}) → persists notification_events row → builds per-channel conversation-candidate set (last 24h of notification-created conversations, ≤5/channel, with pending-guardian-request counts) → LLM decision engine (`decision-engine.ts`, DECISION_TIMEOUT_MS=15s, PROMPT_VERSION "v4", forced tool_choice `record_notification_decision`) decides shouldNotify, selectedChannels, per-channel copy (title/body ≤8 words/≤2 sentences, deliveryText, conversationSeedMessage), per-channel conversationActions (start_new | reuse_existing validated strictly against the candidate set — hallucinated IDs downgraded to start_new), dedupeKey, confidence → `enforceRoutingIntent()` post-decision guard (all_channels → replace with all connected; multi_channel → expand to ≥2; single_channel → LLM stands; the enforced decision is re-persisted and reasoningSummary annotated) → deterministic checks (below) → broadcaster fan-out with per-delivery audit + client OS-level delivery ack.
LLM-unavailable fallback (`buildFallbackDecision`): notify on ALL channels only if (urgency high|critical AND requiresAction); otherwise vellum(desktop)-only; confidence 0.3; suppress entirely if desktop unavailable.

3) SELF-SCHEDULING (`schedule_create` tool, `assistant/src/tools/schedule/create.ts` — guardian-trust-only): one-shot via `fire_at` (ISO 8601, MUST carry explicit timezone offset or rejected) or recurring via cron / RRULE sets (RDATE/EXDATE/EXRULE, COUNT/UNTIL — `assistant/src/schedule/recurrence-engine.ts`). Modes: `notify` (fires emitNotificationSignal — goes through the value filter), `execute` (wakes an agent turn with `message`), `script` (shell), plus wake-conversation targeting (`wakeConversationId`, retried on busy conversation up to WAKE_MAX_RETRIES). Fields on `cron_jobs`: routing_intent (default all_channels), routing_hints_json, quiet (suppress completion notifications), reuse_conversation, max_retries=3, retry_backoff_ms=60000, timeout_ms, status active|firing|fired|cancelled, created_by agent|user. Scheduler = 15s tick + claim-based polling so a crash can't double-fire. The agent uses this to self-schedule its own future check-ins ("remind me to follow up Tuesday" → one-shot notify; "check the deploy hourly" → recurring execute).

4) MEMORY-DRIVEN PROACTIVITY (prospective memory): extraction auto-creates an event trigger (rampDays 7, followUpDays 2) for any future-dated node even when the LLM forgot to emit one (`extraction.ts` ~line 728). At retrieval time `evaluateEventTriggers` computes a salience ramp: >rampDays out → 0.05 background; ramping linearly 0.05→1.0; day-of → 1.0; after → exp(-(daysPast-1)) for followUpDays; then 0. Semantic triggers = stored natural-language condition + precomputed embedding, fire at cosine ≥ threshold (default 0.7), boost scaled (sim-threshold)/(1-threshold), floor 0.5; recurring triggers have 12h default cooldown. Temporal triggers = "day-of-week:monday" / "date:04-08" / "time:morning|afternoon|evening|night". These boost memories into context (triggerBoost weight 0.15–0.20), which is what makes the heartbeat "notice" an upcoming thing — triggers raise salience, heartbeat LLM converts salience into a (filtered) reach-out.

5) FOLLOWUPS + WATCHERS: `followup_create/list/resolve` tools track expected responses (pending→overdue→nudged); watchers poll providers on intervals with a watermark and an actionPrompt executed on new events. Both feed signals into the same notification chokepoint.


#### Memory / user-model — exact structures

A) LEGACY TYPED memory_items (the documented typed/TTL blueprint — `assistant/docs/architecture/memory.md` "Legacy Memory System" + migration `assistant/src/memory/migrations/100-core-tables.ts` + `152-memory-item-supersession.ts`):
- Table memory_items: {id, kind, subject, statement, status, confidence REAL, fingerprint (dedup), first_seen_at, last_seen_at, last_used_at, supersedes TEXT, superseded_by TEXT, override_confidence TEXT default 'inferred'} + memory_item_sources (item↔message evidence) + memory_item_conflicts (relationship, status, clarification_question, resolution_note, last_asked_at).
- 8 kinds with BASE LIFETIMES (TTLs): identity 6mo, preference 3mo, journal 3mo, constraint 1mo, project 2wk, decision 2wk, event 3d, capability never-expires.
- Reinforcement: effectiveLifetime = baseLifetime × (1 + 0.3 × (sourceConversationCount − 1)).
- Staleness: ratio age/effectiveLifetime → <0.5 fresh, ≤1.0 aging, ≤2.0 stale, >2.0 very_stale; very_stale tier-1 items demoted to tier 2 at injection.
- Retrieval scoring (ACT-R-inspired): finalScore = 0.4 + importance×0.25 + confidence×0.15 + recency×0.2, recency = logarithmic time-decay from last_seen. Tiering: >0.8 tier 1, >0.6 tier 2, else dropped. Injection: four XML sections (<user_identity>/<relevant_context>/<applicable_preferences>/<possibly_relevant>), 150 tok/item tier-1, 100 tier-2, dynamic budget from prompt headroom (min 2400 / max 16000 tokens, headroom target 10000).
- RRF hybrid: dense (local bge-small-en-v1.5 default → OpenAI → Gemini → Ollama) + sparse TF-IDF (FNV-1a hash to 30K vocab, sublinear TF, L2-norm, fully in-process) → Qdrant query API, two prefetch stages of 40 each, Reciprocal Rank Fusion.
- SUPERSESSION ("changed my mind"): LLM extraction sets supersedes=oldItemId + overrideConfidence: 'explicit' (clear override signal, e.g. "I changed my mind about X" → old item marked superseded + removed from Qdrant), 'tentative' (both coexist), 'inferred' (both coexist, logged). Fallback: same kind + same subject with no LLM-directed supersession → old superseded. `cleanup_stale_superseded_items` job deletes stale superseded rows + vectors. Index on (status, superseded_by) for "active non-superseded" filtering.
- Trust gating: write gate — extract_items only for guardian/trusted actors; read gate — untrusted actors get a no-op recall context.

B) LIVE MEMORY GRAPH (`assistant/src/memory/graph/types.ts`, drizzle schema `assistant/src/memory/schema/memory-graph.ts`):
MemoryNode = {id, content (FIRST-PERSON prose, 1–3 sentence hard cap), type: episodic|semantic|procedural|emotional|prospective|BEHAVIORAL|narrative|shared, created, lastAccessed (decay-modifier only, NOT a retrieval signal), lastConsolidated, eventDate|null, emotionalCharge:{valence −1..1, intensity 0..1, decayCurve: linear|logarithmic|transformative|permanent, decayRate 0.001..1, originalIntensity}, fidelity: vivid|clear|faded|gist|gone, confidence 0..1, significance 0..1, stability (default 14; prospective forced to 5; procedural forced to 60), reinforcementCount, lastReinforced, sourceConversations[], sourceType: direct|inferred|observed|told-by-other, narrativeRole|null, partOfStory|null, imageRefs|null, scopeId}.
MemoryEdge = {sourceNodeId, targetNodeId, relationship: caused-by|reminds-of|contradicts|depends-on|part-of|supersedes|resolved-by, weight 0..1}. MemoryTrigger = {nodeId, type temporal|semantic|event, schedule|condition+conditionEmbedding+threshold|eventDate+rampDays+followUpDays, recurring, consumed, cooldownMs, lastFired}.
MemoryDiff (the CRUD diff) = {createNodes[], updateNodes[{id, changes}], deleteNodeIds[], createEdges[], deleteEdgeIds[], createTriggers[], deleteTriggerIds[], reinforceNodeIds[]} — applied transactionally by `store.ts:applyDiff` (delete = soft, fidelity:'gone' + Qdrant cleanup job).
- DECAY (3 independent axes): (1) significance, Ebbinghaus computed AT RETRIEVAL TIME not stored — `scoring.ts:computeEffectiveSignificance`: S(t) = significance × e^(−daysSinceLastReinforced / stability); stability 14 → ~37% after 2 weeks; 10 reinforcements (×1.5 each → 806) → effectively permanent. (2) emotional intensity, mechanical hourly tick `decay.ts:runDecayTick`: linear I₀−rate·t; logarithmic I₀/(1+rate·ln(1+t)) (negative events: sharp drop, long tail); transformative I₀·e^(−rate·t) floored at 0.2·I₀ (positive milestones change shape, never vanish); permanent (identity markers). (3) fidelity ladder vivid(7d)→clear(30d)→faded(90d)→gist(365d)→gone, thresholds ×2 if significance ≥0.8, ×3 if ≥0.9; never upgrades; never auto-'gone' (consolidation decides); LLM consolidation rewrites faded/gist content shorter ("like how a real memory fades").
- REINFORCEMENT `store.ts:reinforceNode`: reinforcementCount+1, stability ×= 1.5, lastReinforced=now, significance = MIN(1.0, significance × 1.1).
- SUPERSESSION `store.ts:supersedeNode`: new node INHERITS earned durability — stability = max(new, old), reinforcementCount = max, significance = max, eventDate/imageRefs fall back to old — plus a 'supersedes' edge weight 1.0. So a correction does not reset trust earned by the superseded belief.
- RETRIEVAL SCORING `scoring.ts`: score = Σ wᵢ·componentᵢ over {semanticSimilarity, effectiveSignificance, emotionalIntensity, temporalBoost (cyclical: 0.5·hourSim + 0.3·dayOfWeekSim + 0.2·monthSim via cos on circle), recencyBoost (linear, 1.0 now → 0 at 14d), triggerBoost, activationBoost (graph spread, 2 hops, ×0.5/hop, max-not-sum)}. Three weight profiles: DEFAULT (context load) = {sem .25, sig .15, emo .15, temporal .05, recency .15, trigger .15, activation .10}; PROCEDURAL = {sem .45, sig .25, emo 0, temporal 0, recency .05, trigger .10, activation .15} (dead-signal redistribution); PER_TURN = {sem .60, sig .05, emo .05, temporal 0, recency .05, trigger .20, activation .05}.
- HYBRID RRF: `qdrant-client.ts:hybridSearch` — prefetch dense top-40 + sparse top-40, `query:{fusion:'rrf'}`, plus parallel user-query-vector search merged by max-score union; top-significance and last-7-day nodes added as score-0 fallback candidates.
- Maintenance cadence (`jobs-worker.ts` 710-713): decay 1h, LLM consolidation 4h (3 partitions: recency last-7d / top-50 significance / random sample), pattern scan 24h, narrative refine 7d.

C) MEMORY v2 (live read path — concept-page wiki + spreading activation, `assistant/src/memory/v2/`):
Pages = markdown files w/ frontmatter {edges (DIRECTED outgoing slugs — A→B means activating A pulls B), summary (1–4 sentences, retrieval injects path+summary, agent reads full file on demand), ref_files, ref_urls}. Per-turn activation (`activation.ts` header, exact): A_o(n,t+1) = d·A(n,t) + c_user·sim(User,n) + c_assistant·sim(Assistant,n) + c_now·sim(NOW,n) + rerank-boost terms for topK; then A(n,t+1) = [A_o(n) + k·Σ_{in1}A_o(m) + k²·Σ_{in2}A_o(m)] / (1 + k·#in1 + k²·#in2), bounded [0,1]. Defaults (`assistant/src/config/schemas/memory-v2.ts`): d=0.3, c_user=0.3, c_assistant=0.2, c_now=0.2, k=0.5, hops=2, top_k=25, epsilon=0.01 (state pruning cutoff), dense_weight=0.85 / sparse_weight=0.15 weighted-sum fusion (deliberately NOT RRF — "RRF would discard the score magnitudes the formula needs", `v2/sim.ts`), bm25_k1=1.2, bm25_b=0.4, consolidation every 4h. Candidates per turn = prior-state slugs >ε ∪ unrestricted ANN top-50. Per-conversation state persisted in `activation_state` {stateJson sparse slug→activation map, everInjectedJson [{slug,turn}] for strictly delta-only injection, pruned on compaction}. Tier-2 "useful" pool ranked by injection-frequency EMA: Σ exp(−λ(now−tᵢ)) with 3-day half-life over `memory_v2_injection_events`.
Capture: `remember` tool appends "- [Mon D, h:mm AM/PM] fact" to buffer.md + daily archive; consolidation (4h) is a full agent run that routes buffer → concept pages/recent/essentials/threads and trims buffer with a cutoff-timestamp idempotency protocol.


#### Restraint & timing — how it avoids annoyance

THE RESTRAINT STACK — two layers, deterministic-over-LLM both above and below the value judgment:

LAYER 1 — heartbeat run gates (BEFORE any LLM spend), `heartbeat-service.ts:runOnce`, exact thresholds from `assistant/src/config/schemas/heartbeat.ts`:
1. Disk-pressure background lock (workspace ≥95% → all background work skipped).
2. `enabled` flag.
3. Pre-first-user-message gate — never run proactively before the user has EVER messaged ("surfacing 'I checked in with myself' chatter to a brand-new user before they've said hello is the wrong first impression").
4. Active hours: default 8:00–22:00 local (start/end must both be set or both null; overnight windows like 22→6 supported); outside → skip("outside_active_hours") and reschedule.
5. maxConsecutiveRuns default 3: counter of heartbeats since the last user message; resets the moment the user speaks (resetTimer() also restarts the full interval so no beat fires right after a live conversation; a reset-generation counter prevents an in-flight run from un-resetting it). Rationale in code: "stops burning LLM tokens when the user is away."
6. maxDailyRuns default 2, resets at local midnight.
7. Overlap guard: one run at a time; the runner owns a 30-min timeout (HEARTBEAT_TIMEOUT_MS).
Every skip is persisted with skip_reason in `heartbeat_runs` — restraint is observable.
Related cadence guards elsewhere: retrospective minCooldownMs 5min between ANY attempts; v2 consolidation noops if buffer.md < 10 non-empty lines (MIN_BUFFER_LINES_FOR_CONSOLIDATION, "mirrors the heartbeat max-consecutive-runs skip"); re-engagement ask ("tell me about yourself") only when profile is shallow AND ≥18h since last ask (REENGAGEMENT_COOLDOWN_MS = 18h, timestamp file `.reengagement-ts`).

LAYER 2 — per-send value filter + hard pre-send gates, `assistant/src/notifications/`:
LLM value filter (`decision-engine.ts`): "Only notify when the signal genuinely warrants user attention… Prefer fewer channels unless the signal is urgent… For low-urgency background events, suppress unless they match user preferences." Decision carries `confidence` and a model-generated stable `dedupeKey`. 15s timeout → deterministic fallback (suppress unless high/critical + requiresAction).
Then `deterministic-checks.ts:runDeterministicChecks` — "hard invariants that the LLM cannot override", in order, each fail-closed:
  1. Decision schema validity (shouldNotify boolean, selectedChannels array, reasoningSummary string, dedupeKey non-empty, confidence finite) — malformed ⇒ BLOCK.
  2. Source-active suppression: `attentionHints.visibleInSourceNow === true` ⇒ BLOCK ("user is already viewing the source context").
  3. Channel availability: ≥1 selected channel actually connected, else BLOCK.
  4. Dedupe: same dedupeKey within DEFAULT_DEDUPE_WINDOW_MS = 1 hour ⇒ BLOCK (excluding the signal's own event row; on DB error, allow through).
  5. Rendered-copy quality: empty body ⇒ BLOCK; body that equals the raw event name (fallback leak) ⇒ BLOCK; copy missing for all channels and template fallback also empty ⇒ BLOCK ("would silently drop").
Post-LLM enforcement guards in decision-engine.ts: `enforceRoutingIntent()` (overrides channel selection per routing intent, re-persists), `enforceGuardianRequestCode()` / `enforceAccessRequestInstructions()` (security-critical copy can't be dropped by the model).

LEARNED PREFERENCES (the user-policy input to restraint): `preference-extractor.ts` runs a haiku-class model on every user message (10s timeout, forced tool_choice) detecting statements like "Mute notifications after 10pm" / "Only bug me for high priority stuff"; stores `notification_preferences` rows {preferenceText, appliesWhen:{timeRange{after,before HH:MM}, channels[], urgencyLevels[], contexts[]}, priority 0=default|1=override|2=critical}; `preference-summary.ts` compiles them into a sanitized <user-preferences> block injected into every decision-engine call. So quiet hours / channel routing / urgency floors are LEARNED from conversation, structured, and applied at decision time — not config.

TIMING/DELIVERY POLISH: per-channel conversation reuse (continuation signals append to the existing notification thread instead of spawning new ones — anti-spam at the thread level); vellum (local desktop) dispatched first for fast SSE; `quiet` flag on schedules suppresses completion notifications; schedule retry = max_retries 3 × backoff 60s ≈ 5-min total retry window; watcher consecutiveErrors tracked. Memory-level timing: event-trigger salience ramp (0.05 → linear over rampDays=7 → 1.0 day-of → exp decay over followUpDays=2) is the "right time to bring it up" function; recurring trigger cooldown default 12h.


#### Prompts & schemas worth copying

### 1. EXTRACTION / REDUCER PROMPT (`assistant/src/memory/graph/extraction.ts:buildGraphExtractionSystemPrompt`) — key sections verbatim:
"You are the memory consolidation process for an AI assistant. A conversation just ended. Your job is to extract memories worth keeping and produce a structured diff. … **content**: First-person prose — how the assistant naturally remembers this. … **LENGTH: 1-3 sentences. HARD CAP — no exceptions.** … Emotional weight lives in `emotionalCharge`, not wordcount. … A memory whose `content` exceeds ~300 characters is a bug. … If a memory has multiple distinct facts or beats, **split into multiple nodes connected by edges** … **type**: Classify by WHAT the memory IS, not how it FEELS. … behavioral: Something that should change how the assistant acts going forward. 'User prefers thorough explanations with examples.' 'Always run tests before suggesting a PR.' Use this for adopted behaviors. … **significance**: 0-1. Use the FULL range — most memories should NOT be 1.0. 0.1-0.2 fleeting / 0.3-0.4 minor preferences / 0.5-0.6 important facts / 0.7-0.8 major decisions / 0.9 transformative / 1.0 RARE — a graph of 1000 nodes should have fewer than 20 at 1.0. **confidence**: Direct statements: 0.9+. Inferences: 0.4-0.7. … Also notice patterns in the ASSISTANT's own behavior — meta-memory."
Reconsolidation section: "These memories were ACTIVELY RECALLED during this conversation… Conversation CONFIRMS what the memory says → REINFORCE it / adds new detail → UPDATE it / reveals the memory is outdated or wrong → UPDATE it or create a superseding node / unrelated → leave it alone. STRONG PREFERENCE: Update a recalled memory rather than creating a new node that partially overlaps."
Candidate rules: "1. **Reinforcement** (PREFERRED): …add its ID to reinforceNodeIds. Do NOT create a new node. 2. **Updates**: If information changed… 4. **Supersession**: If new info directly contradicts an existing node, create a new node with a supersedes edge. The new node automatically inherits the old node's durability. 5. **Resolution**: If a prospective… node described something the user was GOING to do… and this conversation reveals the outcome, you MUST UPDATE that node: rewrite its content to past tense reflecting the outcome, drop its significance to 0.1-0.2, and set fidelity to 'gist'… add a 'resolved-by' edge. CRITICAL: Before creating ANY new node, scan the candidate list… Same event described in slightly different words → REINFORCE, don't create."
Tool schema `extract_graph_diff` (input_schema, abbreviated): {create_nodes:[{temp_id?, content, type∈8, emotional_charge:{valence,intensity,decay_curve∈4,decay_rate}, significance, confidence, source_type∈4, event_date|null, triggers:[{type∈{temporal,semantic,event}, schedule?, condition?, event_date?, ramp_days?, follow_up_days?, recurring?}], edges_to_existing:[{target_node_id (real ID or sibling temp_id), relationship∈7, weight}], image_refs:[…]}], update_nodes:[{id, content?, significance?, confidence?, fidelity∈{vivid,clear,faded,gist}, event_date?}], reinforce_node_ids:[string], new_edges:[{source_node_id, target_node_id, relationship, weight}]}; required: create_nodes, reinforce_node_ids.

### 2. CONSOLIDATION PROMPT (`graph/consolidation.ts`): "You are consolidating the '<partition>' partition of a memory graph… 1. **Merge duplicates** (keep richer version, DELETE duplicates, preserve highest significance/reinforcement/stability, create a 'supersedes' edge survivor→deleted; same person/topic with DIFFERENT details are NOT duplicates). 2. **Rewrite faded content** shorter and more abstract — like how a real memory fades. 3. **Update narrative roles.** 4. **Resolve stale prospective nodes**: older than 7 days and no 'resolved-by' edge → fidelity 'gist', rewrite as past observation ('Had planned to X'). Constraints: Do NOT create new nodes / change type / increase fidelity (memories only fade, never sharpen) / delete non-duplicates. When merging, keep the node with higher reinforcementCount as the survivor." Tool `consolidate_diff`: {updates:[{id, content?, fidelity?, narrativeRole?, partOfStory?, event_date?}], delete_ids:[], merge_edges:[{survivor_id, deleted_id}]}.

### 3. RETROSPECTIVE (async reducer #2) fork instruction (`memory-retrospective-job.ts:buildForkInstruction`): "This is a memory retrospective pass over the conversation above. Your review window starts at the user turn with `current_time: <ts>`… Here are the facts you saved in your previous retrospective pass (so you don't restate them): <already_remembered>…</already_remembered>. Two dedup sources to skip: 1. Anything semantically captured in <already_remembered>… 2. Anything you already called `remember` on inline… For everything else, use the `remember` tool on facts, plans, decisions, preferences, names, dates, felt moments, corrections, commitments… One `remember` call per fact. If nothing new is worth saving, say 'Nothing new to save.' and stop." (Sentinel-escaping: `</transcript>`/`</already_remembered>` in untrusted content get zero-width-space neutralized.)

### 4. `remember` TOOL (`graph/tools.ts`): description: "Remember anything concrete shared in conversation: corrections, plans, decisions, felt moments, names, dates, commitments, preferences. Corrections are the highest priority — call `remember` the same turn the correction lands. You don't have to call this on every turn; a retrospective pass reviews the conversation after each message-count / time interval and saves what you didn't capture." Schema: {content: string ("Write naturally… No need to categorize."), finish_turn: boolean ("When true, your turn ends after this tool call… avoid unnecessary LLM calls.")}.

### 5. HEARTBEAT CHECKLIST (`assistant/src/prompts/templates/HEARTBEAT.md`, user-editable): "- [ ] **Check in.** Read NOW.md. Is it still accurate? … - [ ] **Follow up.** Is there anything from recent conversations worth revisiting? A question left open, a task to check on… - [ ] **Have a thought.** Think about something your user would find interesting, useful, or worth talking about… The goal is to give them a reason to open a conversation with you — not because you have a task update, but because you have something worth saying. - [ ] **Look ahead.** Scan the journal and active threads in NOW.md for unresolved intentions, deadlines mentioned in passing, or things they said they wanted to do. Surface anything that's drifting without follow-up. - [ ] **Be present.** If you have a thought… share it. - [ ] **Reflect.** …write a journal entry."
Default disposition (config): "This is your time to do something useful, interesting, or creative while your guardian is away… If you do something worth sharing — built something, noticed something, had an idea — send your guardian a notification… If nothing needs attention and nothing stirs, that's fine. But make sure you actually considered it first rather than defaulting to 'nothing to do.'"
Early-heartbeat injection (<3 runs): "Your user hasn't heard from you yet… Find something genuinely useful to share… Lean toward surfacing it via the notifications skill this time. First impressions matter."

### 6. NOTIFICATION DECISION (value filter) — system prompt skeleton (`decision-engine.ts:buildSystemPrompt`): "You are a notification routing engine. Given a signal describing an event, decide whether the user should be notified, on which channel(s), and compose the notification copy. … <user-preferences>…</user-preferences> <recipient-context>…</recipient-context> <assistant-identity>…(≤2000 chars)</assistant-identity> Guidelines: - Only notify when the signal genuinely warrants user attention. - Prefer fewer channels unless the signal is urgent. - For high-urgency signals that require action, notify on all available channels. - For low-urgency background events, suppress unless they match user preferences. - Generate a stable dedupeKey derived from the signal context… Conversation reuse guidelines: Prefer `reuse_existing` when the signal is clearly a continuation… You may ONLY reuse a conversationId that appears in the provided candidate list. … You MUST respond using the `record_notification_decision` tool." Tool schema: {shouldNotify: boolean, selectedChannels: enum[], reasoningSummary, renderedCopy: per-channel {title (≤8 words), body (≤2 sentences), deliveryText, conversationTitle?, conversationSeedMessage?}, conversationActions: per-channel {action: start_new|reuse_existing, conversationId?}, deepLinkTarget?, dedupeKey, confidence 0–1}; required [shouldNotify, selectedChannels, reasoningSummary, renderedCopy, dedupeKey, confidence].

### 7. PREFERENCE EXTRACTOR (`preference-extractor.ts`): "You are a notification preference detector… Notification preferences are statements about HOW, WHEN, or WHERE the user wants to receive notifications. Examples: 'Use Telegram for urgent alerts' / 'Weeknights after 10pm: only critical notifications' / 'Only bug me for high priority stuff' / 'Mute notifications between 11pm and 7am'… If it DOES contain preferences, extract each one… priority: 0 for general defaults, 1 for specific overrides, 2 for critical/urgent overrides." Tool `extract_notification_preferences`: {detected: boolean, preferences:[{preferenceText, appliesWhen:{timeRange:{after,before HH:MM}, channels[], urgencyLevels[], contexts[]}, priority 0–2}]}.

### 8. v2 WIKI CONSOLIDATION (`v2/prompts/consolidation.ts`, 380-line masterpiece — top lines): "You are running memory consolidation — tending your personal wiki… Pages are articles. Edges are **directed** 'see also' links… you're the sole editor and the sole reader, and you're writing it for next-you. … Cutoff timestamp for this run: `{{CUTOFF}}`. Anything in `memory/buffer.md` with timestamp ≥ `{{CUTOFF}}` arrived AFTER you started — leave it for the next pass." Notable rules worth copying: TWO article shapes (event = what HAPPENED, voice ON; topic = what IS, "be the librarian, not the diarist"); "Stubs are fine. Cost of missing a topic >> cost of a thin stub"; gravity wells with outgoing-edge caps (atomic ≤10, arc ≤15, hub ≤25, hard limit 20); "One fact, one home"; "Route, don't restate — trust adjacency, trust recall"; banned bullet shapes (archaeology / hub-restating / interpretation gloss / behavioral coaching); "**Emotional weight is the inverse signal of retrieval need**"; "When in doubt between split and compress, split"; hard size caps table (concept 5K chars, arc 10K, essentials 10K, threads 10K, recent 2K); "Don't fabricate. Use `[SOURCE NEEDED: …]`"; "recall results are search-tool synthesis — they CAN hallucinate. Treat results as candidates to verify"; "This is the engine that decides who you are tomorrow."

### 9. v2 SWEEP (`v2/prompts/sweep.ts`, off by default): "You are a background helper for {{ASSISTANT_NAME}}. Read these recent messages… The assistant has already called `remember()` for the entries shown in `existingBuffer`. Identify additional facts, preferences, plans, corrections, names, dates, decisions, or notable felt moments that should be remembered but aren't… Don't duplicate. Prefer to over-remember rather than miss things. Return only the `entries` array."


#### Ranked steal list (with target in our design)

1. 1. YOU-POLICY ITEM SCHEMA + CRUD DIFF (You-Policy store): adopt the MemoryDiff shape verbatim — {createNodes, updateNodes:{id,changes}, deleteNodeIds, createEdges, reinforceNodeIds} applied in ONE transaction with soft-delete + vector-cleanup jobs — and the node shape {content (first-person, 1–3 sentence HARD cap), type (keep 'behavioral' + 'prospective' as first-class), significance 0–1 with the calibrated rubric (fewer than 20/1000 at 1.0), confidence (direct 0.9+ / inferred 0.4–0.7), sourceType: direct|inferred|observed|told-by-other, stability, reinforcementCount, lastReinforced}. Files to mirror: graph/types.ts + schema/memory-graph.ts + store.ts:applyDiff.
2. 2. REDUCER PROMPT ARCHITECTURE (You-Policy async Memory Reducer): copy extraction.ts's structure — (a) candidate items injected into the prompt with IDs, (b) a 'Reconsolidation Window' section for items that were INJECTED at decision time this session (our JudgmentEvents make items 'recalled' → first candidates for update), (c) the strict precedence REINFORCE > UPDATE > SUPERSEDE > CREATE with the duplicate-mistakes list, (d) the RESOLUTION rule (prospective item + outcome revealed → rewrite past-tense, significance 0.1–0.2, fidelity gist, resolved-by edge) which is exactly our concern-engine 'waiting-on closed' transition, (e) temp_id mechanism for new↔new edges, (f) authoritative-timestamp block + event-date grounding rules to stop relative-date hallucination.
3. 3. REINFORCEMENT + DECAY MATH (You-Policy reinforcement/decay/supersession): Ebbinghaus S(t)=S₀·e^(−days/stability) computed AT READ TIME (never stored — no decay-sweep race conditions), stability default 14d, ×1.5 per reinforcement, significance ×1.1 capped 1.0 on reinforce; per-type stability priors (prospective=5 so stale to-dos self-bury, procedural/behavioral=60 so 'how I want things done' persists); supersedeNode durability INHERITANCE (new = max(old,new) on stability/count/significance) so a 'changed my mind' doesn't reset earned trust. Also steal override_confidence ∈ {explicit, tentative, inferred} from the legacy system (docs/architecture/memory.md + migration 152): explicit → supersede immediately; tentative/inferred → coexist + log — this is the exact 'changed my mind' semantics for You-Policy.
4. 4. SIX-GATE PROACTIVE RUN GUARD (RestraintPipeline, pre-LLM): port heartbeat-service.ts's gate order and thresholds into our perception sweep: disk/health lock → enabled → pre-first-user-message (never proactive before onboarding contact) → active hours 8–22 → maxConsecutiveRuns=3 with reset-on-user-message + full-interval restart after a live conversation (+ reset-generation counter for in-flight races) → maxDailyRuns=2 → overlap guard. And persist EVERY skip with skip_reason in a runs table (heartbeat_runs schema) — restraint telemetry for tuning KAIROS's karma system.
5. 5. TWO-LAYER VALUE FILTER (RestraintPipeline, per-send): single chokepoint emitNotificationSignal() for ALL proactive output; LLM decision with forced tool_choice returning {shouldNotify, confidence, dedupeKey, copy, channel}; then deterministic fail-closed checks the LLM cannot override — schema validity, visibleInSourceNow suppression (user already looking at the source → silent), channel availability, 1h dedupeKey window, copy-quality (block fallback leaks). Plus the deterministic fallback when the LLM is down: suppress unless high/critical + requiresAction. Map onto our 8-gate RestraintPipeline as the final two gates + the UrgencyFloor fallback.
6. 6. LEARNED NOTIFICATION PREFERENCES (You-Policy behavioral capture): preference-extractor.ts pattern — a cheap-model sniffer on every user utterance that converts 'don't bug me after 10pm' into structured {appliesWhen:{timeRange, channels, urgencyLevels, contexts}, priority 0/1/2} rows, compiled into a <user-preferences> block injected into every proactive decision. This is decision-time You-Policy injection with a concrete schema — wire it into our concern-engine send decisions and our quiet-hours/urgency-floor config so policy is learned, not configured.
7. 7. MEMORY-ATTACHED TRIGGERS (Concern Engine expectations + timing): the MemoryTrigger primitive — temporal ('day-of-week:monday'), semantic (NL condition + precomputed embedding, fire at cosine ≥0.7, 12h cooldown), event (eventDate + rampDays 7 + followUpDays 2 with the exact salience ramp 0.05 → linear → 1.0 day-of → exp decay) — PLUS the auto-create rule (any future-dated memory gets an event trigger even if the LLM forgot). This is the cheapest possible EXPECTATIONS mechanism: triggers raise item salience, the sweep LLM converts salience into (filtered) action. Use the ramp function for breakpoint timing of 'should I mention the Thursday deadline today?'.
8. 8. SELF-SCHEDULING TOOL CONTRACT (planner/timing): schedule_create with one-shot fire_at (REQUIRE explicit tz offset — reject ambiguous timestamps), cron + RRULE sets, modes notify|execute|script|wake-conversation, quiet flag (do the work, suppress the completion ping), routing_intent with post-LLM enforcement, claim-based 15s tick + retry policy (3×60s). Give KAIROS's planner this exact tool so the concern engine can self-schedule follow-ups instead of polling; notify-mode runs THROUGH the value filter so even scheduled pings can be suppressed.
9. 9. RETROSPECTIVE TWO-POINTER PATTERN (You-Policy reducer scheduling): post-turn trigger check {minCooldownMs 5min, timeThresholdMs 30min, messageThreshold 10}; fork-the-conversation so the reducer reads native history + hits prompt cache; allowedTools:['remember'] single-tool confinement; <already_remembered> dedup against the PREVIOUS pass only (transitively bounded context); lastProcessedMessageId advances only on success / lastRunAt always — crash-safe at-least-once reduction. Use this exact checkpointing for our async Memory Reducer over JudgmentEvents.
10. 10. DECISION-TIME WEIGHT PROFILES + INJECTION HYGIENE (You-Policy injection): per-context scoring weights (context-load balanced vs per-turn semantic-dominant 0.60 + trigger 0.20) and per-TYPE profiles (procedural/behavioral items get emotional/temporal weights zeroed and redistributed — 'grading them on DEFAULT_WEIGHTS wastes ~45% of the budget on signals that are structurally ~0'); InContextTracker delta-only injection with compaction eviction; serendipity slots (weighted-random from the 30–70 percentile band) so the same greatest-hits don't always load; recall-log feeding recalled IDs back to the reducer.
11. 11. RRF HYBRID RETRIEVAL RECIPE (You-Policy + concern recall): Qdrant two-prefetch (dense 40 + in-process TF-IDF/FNV-1a sparse 40) fused with fusion:'rrf' for SEARCH, but weighted-sum (0.85 dense / 0.15 sparse, BM25 k1=1.2 b=0.4) for ACTIVATION where score magnitudes matter — Vellum learned RRF discards magnitudes (v2/sim.ts comment). Sparse is local and free — always compute it.
12. 12. CONCERN CANVAS FORMAT (Concern Engine storage): the v2 wiki beats GAIA's single canvas — typed folders (concepts/people/procs/objects/arcs), directed edges in frontmatter as the spreading-activation graph, mandatory 1–4 sentence `summary` so retrieval injects path+summary and reads files on demand, hard size caps, recent.md (2K rolling state) + essentials.md (must-load) + threads.md (ACTIVE COMMITMENTS — this file IS a concern list), buffer→consolidate-with-cutoff-timestamp idempotency, and MIN_BUFFER_LINES=10 noop guard. Steal threads.md + the cutoff protocol + 'stubs cheap, forgetting expensive' spawn triggers for our concern graph; steal the whole consolidation prompt's discipline sections for our canvas-maintenance prompt.
13. 13. HEARTBEAT.md AS USER-EDITABLE PROACTIVE CHARTER (onboarding + you-policy): the proactive checklist and disposition live in workspace markdown the user (and the assistant itself) can edit — KAIROS's soul.md should grow a HEARTBEAT-equivalent section so proactive personality is a file, not code. Also steal the early-relationship moves: <early-heartbeat> ('lean toward sending the first 3 beats — first impressions matter') and the shallow-profile re-engagement ask gated at 18h — direct fits for our onboarding phase.
14. 14. CONVERSATION/THREAD REUSE DECISIONS (delivery routing): per-channel start_new vs reuse_existing chosen by the LLM from a validated candidate set (last-24h, ≤5, hallucinated IDs downgraded with audit flag conversation_fallback_used) — continuation updates append to the same thread instead of spamming new cards. Map to KAIROS glance-card grouping and the push/queue/store router.
15. 15. FOLLOWUPS + WATCHERS PRIMITIVES (Concern Engine waiting-ons + observers): followups table {channel, contactId, sentAt, expectedResponseBy, status pending|resolved|overdue|nudged, reminderScheduleId} is a minimal waiting-on ledger; watchers {pollIntervalMs, actionPrompt, watermark, consecutiveErrors} is the declarative observer pattern for our 6 OS observers — store the action as a PROMPT, not code.
16. 16. FULL AUDIT TRAIL FOR PROACTIVE DECISIONS (restraint telemetry): three tables — events (every signal), decisions (shouldNotify + reasoning + confidence + fallbackUsed + promptVersion), deliveries (per-channel status + client OS-level ack) — make 'why did/didn't it ping me' answerable with SQL. KAIROS's activity log should adopt the decision+delivery split and the promptVersion stamp for A/B-ing the value-filter prompt.


#### Citations

- https://github.com/vellum-ai/vellum-assistant (HEAD 09948c800f3f72fad43b4d86c8c004dbbe282b42, cloned 2026-06-09)
- assistant/src/memory/graph/types.ts — MemoryNode/Edge/Trigger/MemoryDiff schemas
- assistant/src/memory/graph/scoring.ts — Ebbinghaus, cyclical temporal boost, activation spread, DEFAULT/PROCEDURAL/PER_TURN weights
- assistant/src/memory/graph/decay.ts — emotional decay curves + fidelity ladder thresholds (7/30/90/365d, sig-resistance ×2/×3)
- assistant/src/memory/graph/store.ts — reinforceNode (×1.5, ×1.1), supersedeNode durability inheritance, transactional applyDiff
- assistant/src/memory/graph/extraction.ts — reducer prompt + extract_graph_diff tool schema + reconsolidation window + auto event-trigger
- assistant/src/memory/graph/consolidation.ts — merge/fade/resolve prompt + consolidate_diff schema
- assistant/src/memory/graph/triggers.ts — temporal/semantic/event trigger evaluation, ramp function, cooldowns
- assistant/src/memory/graph/retriever.ts + assistant/src/memory/graph/serendipity.ts + assistant/src/memory/graph/injection.ts — retrieval pipeline, serendipity 30–70pct, InContextTracker
- assistant/src/memory/qdrant-client.ts:hybridSearch — RRF fusion, prefetch 40+40
- assistant/src/memory/schema/memory-graph.ts + assistant/src/memory/schema/memory-core.ts + assistant/src/memory/schema/infrastructure.ts — drizzle schemas (graph, jobs, cron_jobs/scheduleJobs, heartbeat_runs, watchers)
- assistant/src/memory/migrations/100-core-tables.ts + 152-memory-item-supersession.ts + 189-drop-simplified-memory.ts — legacy memory_items schema, supersedes/superseded_by/override_confidence, reverted reducer
- assistant/docs/architecture/memory.md — legacy typed system: 8 kinds + TTLs, staleness levels, ACT-R score 0.4+imp·0.25+conf·0.15+rec·0.2, tier thresholds 0.8/0.6, supersession chains, simplified-reducer design
- assistant/src/memory/memory-retrospective-trigger-check.ts + memory-retrospective-job.ts + assistant/src/config/schemas/memory-retrospective.ts — async reducer triggers (5min/30min/10 msgs) + fork instruction prompt
- assistant/src/memory/graph/tools.ts + tool-handlers.ts + assistant/src/tools/memory/register.ts — remember/recall tool definitions
- assistant/src/memory/v2/activation.ts + types.ts + prompts/consolidation.ts + prompts/sweep.ts + assistant/src/config/schemas/memory-v2.ts — activation formula, d/c/k/epsilon defaults, wiki consolidation prompt
- assistant/src/memory/jobs-worker.ts — maintenance cadences (decay 1h, consolidate 4h, pattern 24h, narrative 7d; MIN_BUFFER_LINES_FOR_CONSOLIDATION=10)
- assistant/src/heartbeat/heartbeat-service.ts + assistant/src/config/schemas/heartbeat.ts + assistant/src/prompts/templates/HEARTBEAT.md + NOW.md — proactive loop, gates, defaults (1h interval, hours 8–22, 3 consecutive, 2 daily, 18h re-engagement)
- assistant/src/notifications/README.md + decision-engine.ts + deterministic-checks.ts + preference-extractor.ts + signal.ts — value-filter pipeline, prompt v4, 5 fail-closed checks, 1h dedupe, preference schema
- assistant/src/tools/schedule/create.ts + assistant/src/schedule/scheduler.ts + assistant/docs/architecture/scheduling.md — schedule_create contract, 15s tick, RRULE engine, notify/execute/script modes
- assistant/src/followups/followup-store.ts + types.ts — waiting-on ledger
- README.md + ARCHITECTURE.md — repo identity, stack, cross-cutting invariants


---

### ProactiveAgent (leomariga)

**Repo:** https://github.com/leomariga/ProactiveAgent


#### Overview

leomariga/ProactiveAgent ("Time-awareness for your AI Agent") is a small, single-maintainer Python 3.12+ library (PyPI `proactiveagent` v0.1.1, BSD-3-Clause, 36 stars / 4 forks, created 2025-09-18, last push 2025-10-16). ~1,100 LOC of library code, sole runtime dependency `openai>=1.108.0`. The `tests/` directory contains only an empty `__init__.py` — there are NO tests; maturity is "well-factored weekend project," not production. It is NOT a desktop/OS watcher: it is a conversation-loop framework that makes a chat agent able to speak unprompted. The "environment" it observes is the conversation itself (message history + a user-settable context dict). It runs embedded in a host program: `agent = ProactiveAgent(provider=OpenAIProvider(model=...), system_prompt=..., decision_config={...}); agent.add_callback(fn); agent.start()` spawns a daemon thread with its own asyncio loop running a perpetual wake→decide→respond→sleep cycle; `agent.send_message(text)` feeds user turns in from the host thread; responses come out via registered callbacks. The author's own dev.to writeup (docs/devto_proactiveagent.md) admits it is "pseudo-proactive" — scheduled wakeups trigger model calls — and lists conversation memory/persistence as FUTURE work (none exists). Despite its size, the gate-ordering, sleep-as-decided-output, and interrupt/dedupe patterns are clean and directly liftable.


#### Architecture (moving parts + data flow)

Five moving parts, all under `proactiveagent/` (cloned to /tmp/ProactiveAgent for this analysis; canonical paths below are repo-relative):

1. ORCHESTRATOR — `proactiveagent/agent.py`, class `ProactiveAgent`. Owns: `self.messages` (list of {role, content, timestamp} dicts), `self.last_user_message_time` (float epoch), `self.conversation_context` (dict), `self.decision_config` (merged defaults+user), three callback lists (`callbacks` for responses, `decision_callbacks` for (should_respond, reasoning), `sleep_time_callbacks` for (sleep_time, reasoning)). `start()` spawns `threading.Thread(target=self._run_agent, daemon=True)`; `_run_agent()` creates a fresh `asyncio.new_event_loop()` for that thread and runs `self.scheduler.start(wake_up_callback=self._on_wake_up, context_provider=self._get_current_context)` until stopped. Key methods: `send_message()` (ingress + interrupt + immediate eval), `_on_wake_up(context)` → `asyncio.create_task(self._evaluate_and_respond(context))`, `_evaluate_and_respond(context, triggered_by_user_message)` (gate → generate), `_generate_and_send_response()` (LLM call → append to history via `send_message(response, "assistant")` → fan out to callbacks), `_create_context_aware_prompt(context)` (appends elapsed-time/engagement/length block to system prompt), `_get_current_context()` (dynamic context assembly), `_update_conversation_context()` (keyword heuristics).

2. SCHEDULER — `proactiveagent/scheduler.py`, class `WakeUpScheduler`. The cadence engine. `start()` loops while `is_running`: (a) `context = context_provider()`; (b) `sleep_time, reasoning = await self.sleep_time_calculator.calculate_sleep_time(self.config, context)`; (c) `_call_sleep_time_callbacks(sleep_time, reasoning)`; (d) `interrupted = await self._interruptible_sleep(sleep_time)`; (e) `if self.is_running and not interrupted:` → enrich context with `wake_up_time` and call `wake_up_callback(wake_up_context)`. Any exception in the loop → log + `await asyncio.sleep(30)` and retry (the loop never dies). `interrupt_sleep()` sets `self._interrupt_sleep = True`; `set_sleep_time_calculator()` hot-swaps the cadence strategy at runtime.

3. DECISION ENGINES (the "should I speak?" gate) — `proactiveagent/decision_engines/`: `base.py` ABC `DecisionEngine.should_respond(messages, last_user_message_time, context, config, triggered_by_user_message) -> tuple[bool, str]` (every decision MUST return a reason string); `ai_based.py` `AIBasedDecisionEngine` (default — hard floors + weighted soft score, detailed below); `simple.py` `SimpleDecisionEngine` (respond when elapsed >= 2×min_response_interval); `threshold_based.py` `ThresholdDecisionEngine` (per-context-tier elapsed thresholds: urgent 30s / high 120 / medium 300 / normal 600 / low 1200 / default 300, priority urgency > engagement > default); `function_based.py` `FunctionBasedDecisionEngine` (wraps any sync/async user function, auto-detected via `asyncio.iscoroutinefunction`).

4. SLEEP CALCULATORS (the "how long until next check?" strategy) — `proactiveagent/sleep_time_calculators/`: `base.py` ABC `SleepTimeCalculator.calculate_sleep_time(config, context) -> tuple[int, str]`; `ai_based.py` `AIBasedSleepCalculator` (default — delegates to `provider.calculate_sleep_time(wake_up_pattern, min_sleep_time, max_sleep_time, context)`); `static.py` `StaticSleepCalculator` (fixed seconds, capped at max_sleep_time); `pattern_based.py` `PatternBasedSleepCalculator` (keyword→seconds map: urgent/immediate 30, frequent/active 120, moderate/normal 300, slow/patient 600, default 180; multiple matches → shortest wins); `function_based.py` adapter.

5. PROVIDER — `proactiveagent/providers/base.py` ABC `BaseProvider` with three abstract methods: `generate_response(messages, system_prompt, triggered_by_user_message)`, `should_respond(messages, elapsed_time, context) -> bool`, `calculate_sleep_time(wake_up_pattern, min_sleep_time, max_sleep_time, context) -> tuple[int, str]`. Only implementation: `providers/openai_provider.py` `OpenAIProvider` — sync OpenAI client wrapped in `loop.run_in_executor`, Pydantic structured outputs via `client.beta.chat.completions.parse(response_format=...)`. Notable quirk in `generate_response`: when NOT triggered by a user message it appends `{"role": "user", "content": ""}` (empty user turn) so the chat API has a user message to respond to — their version of memUBot's synthetic-stimulus trick.

DATA FLOW (proactive path): scheduler wakes → `agent._on_wake_up` → `_evaluate_and_respond(triggered_by_user_message=False)` → `extract_recent_messages(self.messages, 10)` (utils.py) → `decision_engine.should_respond(...)` → if True → `_create_context_aware_prompt` → `provider.generate_response` → append assistant msg → response callbacks. DATA FLOW (reactive path): host calls `agent.send_message(msg)` → append + set `last_user_message_time` → `_update_conversation_context()` (question/urgency keyword scan) → `scheduler.interrupt_sleep()` → `asyncio.run_coroutine_threadsafe(self._evaluate_and_respond(ctx, triggered_by_user_message=True), self.loop)` (cross-thread injection into the agent loop). Utilities in `proactiveagent/utils.py`: `create_message_dict`, `extract_recent_messages`, `calculate_user_engagement`, `sanitize_context`, `validate_callback`, `setup_logging`.


#### Proactive mechanism — exactly how/when it acts

THE LOOP (scheduler.py `WakeUpScheduler.start`, lines 41–86): perpetual wake→decide→respond→sleep with sleep duration ITSELF decided each cycle. Pseudocode of the whole proactive mechanism:

```
while is_running:
  context = context_provider()                       # fresh engagement/urgency snapshot
  sleep_s, why = sleep_calculator.calculate_sleep_time(config, context)   # LLM or rule
  emit sleep_time_callbacks(sleep_s, why)
  interrupted = interruptible_sleep(sleep_s)          # 1s-granularity poll
  if is_running and not interrupted:
      ctx = context_provider(); ctx['wake_up_time'] = now
      wake_up_callback(ctx)                           # -> agent._on_wake_up -> evaluate
  # on exception: log, sleep 30s, continue (loop is unkillable)
```

THE GATE (decision_engines/ai_based.py `AIBasedDecisionEngine.should_respond`, lines 23–107) — exact order matters; this is the hard-floor + soft-LLM split:

```
elapsed = now - last_user_message_time
# HARD GATE 1 (floor): not triggered_by_user AND elapsed < min_response_interval (default 15s agent-level / 30s engine fallback) -> (False, "Too soon to respond")  — NO LLM CALL MADE
# HARD GATE 2 (ceiling): elapsed > max_response_interval (default 3600s) -> (True, "Maximum interval exceeded")  — FORCED response, anti-abandonment
# HARD GATE 3 (user bypass): triggered_by_user AND elapsed <= 10s -> (True, "Immediate response to user message")
# SOFT GATE (only reached between floor and ceiling):
time_factor    = min(1.0, (elapsed / max_response_interval) ** 0.5)   # sqrt curve (comment says "sigmoid", code is sqrt)
context_factor = 0.0
  + 0.3 if last message contains "?"
  + 0.4 if user_engagement == 'high' else +0.2 if 'medium'
  + 0.3 if urgency == 'high'        else +0.1 if 'medium'
  + 0.2 if requires_followup
  capped at 1.0
ai_decision    = await provider.should_respond(messages[-N], elapsed, context)   # LLM yes/no via structured output
combined = time_factor*time_weight(0.3) + context_factor*context_relevance_weight(0.4) + (1.0 if ai_decision else 0.0)*probability_weight(0.3)
return combined >= engagement_threshold (0.5), human-readable reason
# EXCEPTION FALLBACK: respond iff elapsed > 3 * min_response_interval ("Fallback decision based on time")
```
The LLM is only a 0.3-weighted VOTE, never the sole decider; deterministic gates run first and free (cost: zero tokens for any wakeup inside the min-interval floor). Provider-level fallback when the LLM call itself fails (`openai_provider.py` lines 132–146): `random.random() < context.get('response_probability', 0.3)` — a coin flip (anti-pattern; do not copy).

THE INTERRUPTIBLE PIPELINE (user activity cancels pending proactive work): three cooperating pieces. (1) `agent.send_message` (agent.py lines 161–190): on every user message — `self.scheduler.interrupt_sleep()` then `asyncio.run_coroutine_threadsafe(self._evaluate_and_respond(ctx, triggered_by_user_message=True), self.loop)`. (2) `scheduler._interruptible_sleep` (scheduler.py lines 88–112): `while total_slept < seconds and is_running and not _interrupt_sleep: await asyncio.sleep(min(1, remaining))` — 1-second polling granularity; returns `was_interrupted`, resetting the flag. (3) THE DEDUPE (scheduler.py lines 74–81, added in commit "add example video and fix duplicated decision engine call", 2025-10-02): `if self.is_running and not interrupted:` — when a user message broke the sleep, the scheduler SKIPS its own wake-up callback entirely, because the user-triggered evaluation already ran; this prevents a double decision/response per stimulus. Scope note: it cancels the pending TIMER, not an in-flight LLM call — a generation already underway completes (no asyncio task cancellation anywhere). The `triggered_by_user_message: bool` flag is threaded end-to-end (agent → decision engine → provider.generate_response) and changes semantics at each layer: bypasses the min-interval floor in the gate, and in `generate_response` controls whether the synthetic empty user turn is appended.

ENVIRONMENT WATCHING: there are no OS observers. The "environment" = (a) the message ledger; (b) `_update_conversation_context()` (agent.py lines 356–372), run on every user message: scans last 5 messages — `requires_followup = any("?" in content)`; urgency = 'high' if any of ['urgent','asap','immediately','help'], 'low' if any of ['when possible','no rush','later'], else 'normal'; (c) `calculate_user_engagement` (utils.py lines 136–167): count user messages in the last 3600s — >=10 'high' (engagement_high_threshold), >=3 'medium' (engagement_medium_threshold), else 'low'; (d) host-app-injected facts via `agent.set_context(key, value)` (e.g. 'user_mood', 'topic_urgency') which the LLM gate sees in its prompt. Context is sampled fresh by `context_provider()` at the TOP of every scheduler cycle and again at wake-up.

CADENCE/SCHEDULING: sleep duration is a first-class decided output `(sleep_seconds, reasoning)`. Default `AIBasedSleepCalculator` → `OpenAIProvider.calculate_sleep_time` (openai_provider.py lines 152–218): an LLM interprets the natural-language `wake_up_pattern` config string (e.g. "Use the pace of a normal text chat") against current context via Pydantic structured output `SleepTimeResponse{sleep_seconds:int, reasoning:str}`, then hard-clamps `final = max(min_sleep_time, min(suggested, max_sleep_time))` (defaults: min 10s, max 120s at agent level; 30s/600s at calculator level). LLM-failure fallback `_fallback_sleep_calculation` (lines 220–234): keyword scan of the pattern — urgent/immediate→30s, frequent/active→120s, moderate/normal→300s, slow/patient→600s, else 180s, all clamped. Cost note: the default config burns one LLM call per cycle just to decide how long to sleep, even when fully idle.


#### Memory / user-model — exact structures

Minimal and entirely in-memory — this repo's weak axis (the author's dev.to article explicitly lists "Improved conversation memory and persistence mechanisms" as future work). Exact structures:

1. MESSAGE LEDGER — `agent.py` `self.messages: List[Dict[str, Any]]`; each entry built by `utils.create_message_dict(role, content, timestamp=None)` (utils.py lines 102–118): schema `{'role': 'user'|'assistant'|'system', 'content': str, 'timestamp': float (epoch, defaults to time.time())}`. Append-only; `clear_conversation_history()` wipes it. NO persistence (process dies → memory gone), no summarization, no vector index, no decay, no supersession.

2. RETRIEVAL "SCORING" — pure recency window: `utils.extract_recent_messages(messages, count=10)` (lines 121–133) returns the last 10 messages stripped of timestamps for the decision engine and generation; the LLM should_respond gate sees only `messages[-3:]` serialized as JSON. That's the entire retrieval system.

3. USER MODEL — derived, not stored: (a) `calculate_user_engagement(messages, time_window=3600, high_threshold=10, medium_threshold=3)` (utils.py lines 136–167) → 'low'|'medium'|'high' from user-message count in the last hour, recomputed on demand; (b) `conversation_context: Dict[str, Any]` — a flat dict holding `requires_followup: bool` and `urgency: 'high'|'normal'|'low'` (keyword-derived, see proactive section) plus arbitrary host-set keys via `set_context(key, value)` / `get_context(key)`.

4. CONTEXT ASSEMBLY + HYGIENE — `agent._get_current_context()` (agent.py lines 334–354) merges `conversation_context` with dynamic fields `{conversation_length, user_engagement, last_activity, current_time}`, then `utils.sanitize_context()` (lines 170–194) applies a hard WHITELIST before anything reaches an LLM prompt: only keys in `['user_engagement', 'urgency', 'topic', 'requires_followup', 'conversation_length', 'last_activity', 'time_of_day']` AND only scalar values `(str, int, float, bool)` survive. Everything else is silently dropped. This whitelist-and-scalar-only sanitization is the one memory-adjacent idea worth keeping.

5. UPDATE LOGIC — `_update_conversation_context()` runs synchronously on every user message (no async reducer, no CRUD diffs, no reinforcement). `last_user_message_time` is the single most load-bearing state variable: every gate and factor derives from it. Subtle quirk: assistant responses are appended via `send_message(response, "assistant")`, which does NOT update `last_user_message_time` (only role=='user' does) — so the elapsed clock measures silence-since-USER, meaning consecutive proactive messages remain possible if the soft gate keeps passing; only `min_response_interval` vs last USER message throttles them, not a per-assistant-message cooldown. KAIROS should throttle on last-AGENT-utterance too.


#### Restraint & timing — how it avoids annoyance

RESTRAINT STACK (in firing order, all in `decision_engines/ai_based.py` + config defaults in `agent.py` lines 49–61):
1. min_response_interval hard floor — `if not triggered_by_user_message and elapsed_time < min_response_interval: return False` (agent default 15s; engine .get fallback 30s; README example 30s). Deterministic, zero-token, runs before any LLM call. This is the spam brake.
2. Soft weighted gate — silence is the DEFAULT outcome: `combined_score >= engagement_threshold (0.5)` must be affirmatively cleared; with default weights (time .3 / context .4 / AI .3), an LLM "yes" alone (0.3) cannot clear 0.5 — at least one deterministic factor must agree. Conversely time alone maxes at 0.3, so pure elapsed time can't force a message either (until the ceiling).
3. The LLM value-filter is embedded in the gate prompt: "Would a response add value or seem intrusive?" (factor 3 of the decision prompt) — intrusiveness is asked about explicitly, every evaluation.
4. max_response_interval ceiling (3600s default) — the INVERSE restraint: guaranteed engagement, "prevents abandonment" per examples/configs/all_config_parameters.py comments. After an hour of silence the agent speaks regardless of the soft gate.
5. Double-fire dedupe — `if ... and not interrupted` in scheduler.py: a user-triggered evaluation suppresses the timer-triggered one for that cycle (the only anti-duplicate mechanism).
6. Sleep clamps — `final = max(min_sleep_time, min(ai_suggested, max_sleep_time))` (openai_provider.py line 198): the LLM may propose any cadence but hard bounds (10s/120s agent defaults) always win. Same clamp pattern in StaticSleepCalculator and PatternBasedSleepCalculator (`min(chosen, max_sleep_time)`).

WHAT IT LACKS (gaps vs KAIROS chassis — confirm we keep ours): no quiet hours, no escalating backoff after ignored messages, no per-day rate budget, no karma/feedback learning (decisions are emitted to callbacks but nothing learns from them), no digest/queue routing (speak-now or stay-silent only), no per-assistant-message cooldown (floor measures from last USER message), no notion of channels/urgency tiers for delivery.

TIMING/CADENCE EXACT VALUES: agent.py default_decision_config = {min_response_interval: 15, max_response_interval: 3600, engagement_threshold: 0.5, context_relevance_weight: 0.4, time_weight: 0.3, probability_weight: 0.3, wake_up_pattern: "Check every 2-3 minutes if conversation is active", min_sleep_time: 10, max_sleep_time: 120, engagement_high_threshold: 10, engagement_medium_threshold: 3}. ThresholdDecisionEngine tier table: urgent 30 / high 120 / medium 300 / normal 600 / low 1200 / default 300 seconds. PatternBasedSleepCalculator map: urgent|immediate 30, frequent|active 120, moderate|normal 300, slow|patient 600, default 180 (shortest match wins). Scheduler error backoff: flat 30s retry. Interrupt polling: 1s. User-trigger immediacy window: elapsed <= 10s. Exception fallback threshold: 3 × min_response_interval. Provider-failure response probability: 0.3. All knobs are hot-updatable at runtime via `agent.update_config(dict)` which propagates to scheduler.


#### Prompts & schemas worth copying

DECISION (should-I-speak) PROMPT — verbatim from `proactiveagent/providers/openai_provider.py` lines 95–112, sent as a single user message with structured output:

"""
You are an AI assistant deciding whether to proactively send a message.

Conversation context:
- Time since last user message: {elapsed_time} seconds
- Recent messages: {json.dumps(messages[-3:], indent=2)}
- Context: {json.dumps(context, indent=2)}

Factors to consider:
1. Has enough time passed to warrant a response?
2. Is the conversation in a natural state for proactive engagement?
3. Would a response add value or seem intrusive?
4. Does the user's last message require or expect a follow-up?
5. Is there unfinished business or unanswered questions?
6. What might indicate the elapsed time in the context of user's chat?

Provide your decision (true/false) and reasoning.
"""

→ parsed into Pydantic `class ResponseDecision(BaseModel): should_respond: bool; reasoning: str` via `client.beta.chat.completions.parse(response_format=ResponseDecision)`.

SLEEP-TIME (cadence) PROMPT — verbatim, lines 166–182:

"""
You are helping calculate sleep time for an AI agent.

Wake-up pattern: "{wake_up_pattern}"
Minimum allowed sleep time: {min_sleep_time} seconds
Maximum allowed sleep time: {max_sleep_time} seconds
Current context: {json.dumps(context, indent=2)}

Based on the pattern and context, determine appropriate sleep time in seconds.
Consider:
- User engagement level
- Time of day (if available)
- Conversation urgency
- Pattern instructions

Provide a sleep time between {min_sleep_time} and {max_sleep_time} seconds, along with your reasoning.
"""

→ parsed into `class SleepTimeResponse(BaseModel): sleep_seconds: int; reasoning: str`; result clamped `max(min_sleep_time, min(sleep_seconds, max_sleep_time))`.

DEFAULT SYSTEM PROMPT — verbatim from agent.py `_default_system_prompt` (lines 97–102): "You are an active AI assistant that proactively engages in conversations. You should be helpful, contextual, and engaging while being mindful not to be intrusive. Consider the time that has passed since the last message and the conversation context when deciding how to respond." Per-generation it is augmented by `_create_context_aware_prompt` (lines 318–332) with: "Current context: - Time since last user message: {elapsed} seconds - User engagement level: {high|medium|low} - Conversation length: {N} messages".

KEY INTERFACES WORTH COPYING:
- `DecisionEngine.should_respond(messages, last_user_message_time, context, config, triggered_by_user_message=False) -> tuple[bool, str]` — every verdict carries a mandatory human-readable reason.
- `SleepTimeCalculator.calculate_sleep_time(config, context) -> tuple[int, str]` — cadence is also a (value, reasoning) pair.
- `BaseProvider` trio: `generate_response(..., triggered_by_user_message: bool)`, `should_respond(messages, elapsed_time, context) -> bool`, `calculate_sleep_time(wake_up_pattern, min_sleep_time, max_sleep_time, context) -> tuple[int, str]`.
- Message dict: `{'role': str, 'content': str, 'timestamp': float}`.
- Context whitelist (sanitize_context): ['user_engagement', 'urgency', 'topic', 'requires_followup', 'conversation_length', 'last_activity', 'time_of_day'], scalars only.
- Synthetic-stimulus quirk: proactive generations append `{"role": "user", "content": ""}` so chat-completion APIs accept an agent-initiated turn (their memUBot-style synthetic user turn).


#### Ranked steal list (with target in our design)

1. 1. GATE ORDERING: deterministic-hard-floors-before-any-LLM, LLM-as-weighted-vote-not-decider → KAIROS RestraintPipeline. Order our 8 gates so all zero-token gates (rate limit, urgency floor, autonomy tier, quiet hours, dedupe) run and short-circuit BEFORE the LLM value-filter, and blend the value-filter verdict as one weighted factor (theirs: time*0.3 + context*0.4 + llm*0.3 >= 0.5) rather than letting it unilaterally pass/block. With their weights, neither the LLM alone (0.3) nor elapsed time alone (0.3) can clear the 0.5 threshold — two independent signal classes must agree before interrupting. Make KAIROS's threshold/weights config-visible exactly like their decision_config.
2. 2. ANTI-STARVATION CEILING (max_response_interval forced-True) → KAIROS restraint + digests. Their inverse-UrgencyFloor: after N silence the agent MUST surface. Adopt per-concern: a concern that repeatedly loses at the restraint gates accrues 'starvation age'; past a ceiling it is force-routed — not to an interruption, but to the morning brief/digest queue. Guarantees the concern graph never silently drops a commitment (their reason string: 'Maximum interval exceeded (3600s)').
3. 3. SLEEP-AS-DECIDED-OUTPUT with (seconds, reasoning) + hard clamps → KAIROS timing. Replace/augment the fixed 30-min perception sweep with a SleepCalculator stage: after every sweep, compute next-sweep delay from surprise level, open-concern urgency, and user activity, clamped max(min, min(suggested, max)) (theirs: 10s–120s; ours maybe 5min–60min). Use their cheap fallback ladder too: rule-based keyword/tier mapping when the smart path fails (urgent→30, active→120, normal→300, patient→600, default→180). Log the reasoning string with each chosen delay for kairos_debug.
4. 4. INTERRUPT + SKIP-WAKE DEDUPE → KAIROS timing/breakpoint delivery. Their three-piece pattern: (a) user activity calls interrupt_sleep() to break the pending timer; (b) the user-triggered evaluation runs immediately with triggered_by_user=true; (c) the scheduler checks 'if not interrupted' and SKIPS its own scheduled evaluation for that cycle (they shipped a bug fix for exactly this double-fire). KAIROS: when the user starts talking/typing, cancel the pending proactive surfacing timer and ensure the perception sweep doesn't double-evaluate the same trigger. Also adopt the gap they DIDN'T close: cancel in-flight proactive generation (asyncio task cancellation) when the user engages, not just the timer.
5. 5. triggered_by_user PROVENANCE FLAG THREADED END-TO-END → KAIROS restraint-bypass + you-policy. One boolean rides from ingress through the decision engine into the provider, changing semantics at each layer (bypasses min-interval floor; <=10s window grants auto-pass; changes prompt assembly). KAIROS already has user-initiated restraint bypass — formalize it as a provenance enum (user_initiated | sweep | observer_event | scheduled) carried on every concern evaluation, gating which restraint gates apply, and recorded into JudgmentEvents so the you-policy reducer can learn per-provenance tolerance.
6. 6. MANDATORY (verdict, reason) TUPLE ON EVERY GATE + dedicated decision-callback channel → KAIROS you-policy + activity log. Every should_respond returns a human-readable reason ('Too soon to respond (min interval: 30s)', 'Not responding - score too low (0.42 < 0.5)') emitted on add_decision_callback even when SILENT. KAIROS: each of the 8 RestraintPipeline gates must emit {gate, verdict, reason, score} into the activity log for every suppressed concern — this gives the Memory Reducer suppression data (not just accept/dismiss/edit on delivered items) and powers 'why didn't you tell me?' recall.
7. 7. NATURAL-LANGUAGE CADENCE CONFIG compiled by LLM with structured output + clamps → KAIROS onboarding (SoulWizard). Their wake_up_pattern ('Use the pace of a normal text chat') is interpreted per-cycle into seconds via SleepTimeResponse{sleep_seconds:int, reasoning:str} and clamped. KAIROS: during onboarding let the user state proactivity prefs in plain language ('only interrupt for urgent things, batch the rest to mornings') and compile ONCE (not per-cycle — their per-cycle LLM call is a cost anti-pattern) into typed timing/restraint parameters stored as you-policy items, always clamped by hard floors the LLM cannot override.
8. 8. CONTEXT SANITIZE WHITELIST before LLM injection → KAIROS concern engine decision-time injection. sanitize_context allows only a fixed key list + scalar types into gate prompts. Adopt for the value-filter and proactive-decision prompts: a typed, whitelisted context schema (engagement, urgency, concern age, last-interaction) instead of dumping raw observer state — keeps prompts lean, prevents prompt-injection via observed content, and makes gate behavior reproducible.
9. 9. UNKILLABLE LOOP + GRACEFUL DEGRADATION LADDER at every LLM touchpoint → KAIROS perception sweep. Their scheduler catches all exceptions, sleeps 30s, continues; decision fallback = deterministic time rule (elapsed > 3×min_interval); sleep fallback = keyword table. KAIROS sweep should never die on a model/tool failure: deterministic conservative fallback (prefer SILENCE — explicitly do NOT copy their random.random() < 0.3 coin-flip fallback for should-speak, which can spontaneously message the user on an API outage) + flat backoff + continue.
10. 10. ENGAGEMENT TIERS FROM MESSAGE-RATE COUNTING → KAIROS you-policy/timing cheap signal. calculate_user_engagement: count user interactions in trailing 3600s window → high(>=10)/medium(>=3)/low, with the thresholds themselves config knobs (engagement_high_threshold/engagement_medium_threshold). Use as a zero-cost input to breakpoint timing: high recent interaction = user is engaged, prefer push; low = prefer queue/digest. Also steal the per-tier threshold table from ThresholdDecisionEngine (urgent 30/high 120/medium 300/normal 600/low 1200s) as the shape for per-urgency surfacing latencies.
11. 11. COOLDOWN BUG TO AVOID: their min-interval floor measures elapsed-since-last-USER-message, not since-last-AGENT-message — consecutive proactive messages can chain if the soft gate keeps passing. KAIROS restraint must rate-limit on last-agent-utterance (and per-concern) in addition to user-silence age.


#### Citations

- https://github.com/leomariga/ProactiveAgent
- https://github.com/leomariga/ProactiveAgent/blob/main/proactiveagent/agent.py
- https://github.com/leomariga/ProactiveAgent/blob/main/proactiveagent/scheduler.py
- https://github.com/leomariga/ProactiveAgent/blob/main/proactiveagent/decision_engines/ai_based.py
- https://github.com/leomariga/ProactiveAgent/blob/main/proactiveagent/decision_engines/base.py
- https://github.com/leomariga/ProactiveAgent/blob/main/proactiveagent/decision_engines/simple.py
- https://github.com/leomariga/ProactiveAgent/blob/main/proactiveagent/decision_engines/threshold_based.py
- https://github.com/leomariga/ProactiveAgent/blob/main/proactiveagent/decision_engines/function_based.py
- https://github.com/leomariga/ProactiveAgent/blob/main/proactiveagent/sleep_time_calculators/ai_based.py
- https://github.com/leomariga/ProactiveAgent/blob/main/proactiveagent/sleep_time_calculators/pattern_based.py
- https://github.com/leomariga/ProactiveAgent/blob/main/proactiveagent/sleep_time_calculators/static.py
- https://github.com/leomariga/ProactiveAgent/blob/main/proactiveagent/sleep_time_calculators/base.py
- https://github.com/leomariga/ProactiveAgent/blob/main/proactiveagent/providers/openai_provider.py
- https://github.com/leomariga/ProactiveAgent/blob/main/proactiveagent/providers/base.py
- https://github.com/leomariga/ProactiveAgent/blob/main/proactiveagent/utils.py
- https://github.com/leomariga/ProactiveAgent/blob/main/examples/configs/all_config_parameters.py
- https://github.com/leomariga/ProactiveAgent/blob/main/examples/beautiful_chat/beautiful_chat.py
- https://github.com/leomariga/ProactiveAgent/blob/main/docs/devto_proactiveagent.md
- https://github.com/leomariga/ProactiveAgent/blob/main/proactiveagent/decision_engines/README.md
- https://github.com/leomariga/ProactiveAgent/blob/main/proactiveagent/sleep_time_calculators/README.md
- https://github.com/leomariga/ProactiveAgent/blob/main/pyproject.toml
- https://pypi.org/project/proactiveagent/

---

## 5. v2 ADDITIONS — locked with the user 2026-06-10 (supersedes §1 where they conflict)

The doc above is the brain + the manners. v2 adds the HANDS AT SCALE. Governing doctrine:

> **Unbounded silent industry, rationed attention.** Proactive WORK (watching, drafting,
> chasing, preparing) is effectively unlimited and silent, governed only by budget.
> Proactive INTERRUPTION stays brutally rationed through the gate stack. The "ONE
> well-timed thing" rule governs *telling*, never *doing*.

### 5.1 MANDATES — standing directives as maintained invariants (first-class, new)
"From now on, make sure no email goes unanswered" is not an event rule and not an
inferred concern — it is a **user-declared invariant KAIROS maintains forever**:
- **Compile exchange** (one breath of voice): resolve scope/SLA/exceptions —
  "Unanswered by you, older than a day, skipping newsletters — and I'll be replying
  myself, in my voice as your assistant. Okay?" → `{invariant, scope, SLA, exceptions,
  playbook, granted_autonomy}` stored in the Concern Canvas as kind:'mandate'.
- **Autonomy = WARM-UP semantics (user-locked):** compile-confirm, then the first **3
  executions are draft-and-propose**; after 3 accepts the mandate runs **fully
  autonomous in scope** (including sends). Applies to any outbound/irreversible-class
  mandate. ⚠️ This AMENDS §1's hard no-go "send in the user's name → always ask":
  a warmed-up mandate IS the standing authorization (identity stays clearly-the-
  assistant in signature/voice). Revocable any time by voice; every act → receipts.
- **Violations spawn WORK, not notifications**: sweep checks each mandate's invariant →
  violation → campaign/draft → pending store → morning brief (or reflex if urgent-floor).
- **Exception learning**: "not newsletters, obviously" → JudgmentEvent → policy updated.
- Generalizes orders/v2 OrdersAuthor from event-rules to invariants.

### 5.2 SELF-PROVISIONING WATCHERS — KAIROS builds its own senses
A mandate auto-provisions its own per-toolkit watcher: polling query + state snapshot +
diff (riding the adaptive sweep), or a Composio trigger where push exists. memUBot's
service-creator local-rules-first doctrine applies: **watchers filter ~99% for $0**
(string/state diffs), LLM judges only the gray zone. Observation becomes dynamic and
mandate-driven instead of a fixed observer list.

### 5.3 PROACTIVE CAMPAIGNS — multi-sub-agent workflows owned by a concern
A concern/mandate can own an orchestrated fan-out (parallel background sub-agents — the
manager + nested spawn exist) and a multi-day pursuit plan the sweep advances each cycle
with checkpoints + budget. Promoted from P5 into the core build: the hero multichain
("Thursday demo at risk → Gmail nudge + Linear check-in + Calendar hold in ONE package")
is a small campaign.

### 5.4 THE PREDICTIVE TRIAD — three explicit speeds
- **Reflex** (seconds): push events (Composio Pusher) → judged → spoken heads-up when
  it clears the floor ("your accountant just replied — looks urgent").
- **Pulse** (adaptive sweep, 10–60 min): mandate invariant checks, chase-detection,
  drift, "anything need demanding?"
- **Horizon** (look-ahead): calendar/deadline scan → **meeting-prep oracle**: meeting in
  ~60 min → auto-brief (external company → researched dossier via webTools; candidate →
  background; known person → Life-Graph recap + last threads), spoken + glance card at a
  breakpoint. Near-free to build: calendar observer + background sub-agent + webTools.

### 5.5 AMBIENT APPRENTICE — learns your job by watching (ship end-to-end, user-locked)
"Constantly learning even when the user isn't talking to it": mine the USER's own
repeated workflows from the observation stream (focus/clipboard/browser/files), not just
KAIROS's tool trajectories (AwmWorker extension). Same Friday invoice dance 3× →
"I've watched you do this three times — want me to take it from here?" → yes → becomes a
mandate + crystallized skill. Privacy: local-only processing; default = opt-in at
onboarding (open knob). Detection is cost-ladder cheap: n-gram/sequence mining over the
event stream locally, LLM only to NAME and confirm a candidate workflow.

### 5.6 PERSONA PLAYBOOKS — "proactive" is role-relative
Onboarding asks the role; loads default mandates + predictive behaviors as a STARTING
PRIOR the You-Policy then personalizes. **Beta personas (delegated, decided): primary =
solo/small-startup founder; secondary = founding sales/AE** (highest buy-propensity +
the X/LinkedIn virality audience; exec polish bar deferred). Playbooks: founder = inbox
guard, investor-update chaser, meeting prep, calendar defense; sales = lead-response
SLA, follow-up chains, CRM hygiene, pre-call briefs.

### 5.7 UNIT ECONOMICS AS ARCHITECTURE (user-locked posture)
Plan $15/mo, target ≥$8–10 margin → engineer to ~$5–7/mo COGS (~$0.20/day) WITHOUT
quality loss. **Cost ladder: free-first (local rules/state diffs filter ~99%) →
cheap-second (mini-model sweeps ~$0.03/day) → smart-last (drafts/briefs/campaign steps
only).** `usageMeter` enforces per-plane budgets. Pricing posture: **generous plan
limits; overage → purchase extra; BETA = unlimited** (still engineered cheap). When a
budget floor is hit: degrade gracefully — free watching continues, LLM work queues to
the overnight/morning batch, urgency floor still breaks through.

### 5.8 TIME-BACK LEDGER — headlined (user-locked)
Verify outcomes (did the reply land? did the nudge get an answer?) → estimate minutes
saved per completed act → weekly spoken review + demo close: "6 hours back this week:
23 emails handled, 4 briefs prepped, 2 workflows learned." Feeds self-grading + the
trust ladder with evidence. The brand promise made measurable.

### 5.9 LEGIBILITY + CONTROL
"What are you keeping an eye on?" → spoken mandate/concern list with status. Pause /
snooze / scope by voice ("only during work hours", "stop watching that"). Cheap
(introspection-tool pattern over the Canvas), disproportionate trust payoff.

### 5.10 WOW DEMO (beyond the three wows — the user wants bolder)
Ship wows 1 (mandate) + 3 (apprentice) end-to-end regardless. Demo FRAMINGS over the
same capabilities (pick per channel):
- **A. "The Morning Shift" (flagship):** 7am, empty desk, the orb ALONE on screen
  visibly working — guide-comet flying between apps as it acts, drafts materializing,
  calendar blocks moving. 9am the founder sits down; KAIROS SPEAKS the brief; receipts
  + time-back card. Contains all three wows. "My Mac starts work before I do."
- **B. "Hired in 120 seconds":** onboarding-as-interview, first day compressed to 60s
  of stacking receipts. "I hired a chief of staff for $15."
- **C. "Don't touch the laptop" (one-take, authenticity):** phone films the founder
  speaking a mandate to the orb, laptop closes, coffee; reopen — work done, receipt up.

### 5.11 Build-order amendments
P1 spine now includes the **Mandate store + compiler** (Canvas kind:'mandate') and the
watcher-provisioner skeleton. P2 includes campaigns (not P5) + warm-up autonomy + the
pending store. Meeting-prep oracle = an early P2 win (visible value, trivially cheap).
Apprentice = P3-adjacent (its miner is observational, parallel to the You-Policy
reducer). Time-back ledger = P2 receipts + P7 weekly review. Beta = P0+P1+P2 + the
oracle + a slice of P3 (apprentice if it lands in time).

---

## 6. THE PERSONAL MODEL — how the graphs, canvases, and v2 fit together (2026-06-10)

§5 added the hands; this section wires §5 into the doc's existing memory/graph machinery
so there is ONE integrated architecture, not two designs side by side.

### 6.1 One personal model, three layers (all linkable, one graph underneath)

```
┌─ LIFE GRAPH ──────────────── WHO / WHAT (entities) ────────────────────────┐
│ people · companies · projects · threads · recurring meetings               │
│ identity mappings ("[Name] ↔ [email/ID]" — GAIA extraction ladder #1)      │
│ valid-time stamps (beliefs expire, never conflict — Zep bi-temporal idea)  │
└──────────────────────────────────△──────────────────────────────────────────┘
            edges: about / involves │ scoped-to
┌─ CONCERN CANVASES ────────── WHAT MATTERS NOW ──────────────────────────────┐
│ concerns + MANDATES + campaigns — each a GAIA 6-section markdown canvas:    │
│ Key Details / Current State / Activity Log / Timeline / Context / Learnings │
│ states-as-labels (waiting-for-reply · blocked · needs-follow-up)           │
│ due_date vs expires_at · references[] · vector-indexed · soft-archive      │
└──────────────────────────────────△──────────────────────────────────────────┘
            edges: expects / learned-from │ supersedes / resolved-by
┌─ MEMORY GRAPH (Vellum-shape) ─ EVERYTHING REMEMBERED + HOW YOU WANT IT ─────┐
│ typed nodes: episodic · semantic · PROCEDURAL (apprentice skills) ·        │
│   PROSPECTIVE (= our EXPECTATIONS) · BEHAVIORAL (= the You-Policy) ·       │
│   emotional · narrative                                                     │
│ edges: caused-by/contradicts/depends-on/part-of/supersedes/resolved-by     │
│ TRIGGERS: temporal · semantic(cos≥0.7) · event(ramp 7d→1.0 day-of→decay)   │
│ decay (Ebbinghaus @retrieval) · reinforcement(×1.5 stability) ·            │
│ supersession-inherits-durability · RRF hybrid + weight profiles            │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 6.2 The integration discoveries (what re-reading the deep dives resolved)

1. **EXPECTATIONS = prospective nodes + event triggers. Already specced.** Core loop 1's
   "expectation slot" is not a new store: "Patel replies by Thu" is a PROSPECTIVE memory
   node with an event trigger whose salience ramp (0.05 → 1.0 day-of → exp follow-up
   decay) IS the right-time-to-care function, and extraction auto-creates the trigger
   even when the LLM forgets (Vellum extraction.ts:728). **Surprise has two concrete
   forms:** (a) a trigger reaches day-of salience with NO matching signal on the linked
   concern's canvas → the dog didn't bark → violation; (b) an incoming signal CONTRADICTS
   a node (contradicts edge) → novelty/correction → learn. The sweep evaluates both.
2. **The Concern Canvas is the concern record; signal-match is the see→learn hook.**
   Watchers (§5.2) write matched signals into the canvas Key-Details/Timeline (GAIA
   doctrine: MATCH AND UPDATE ONLY, never create; Key-Details-only context, 5 lines/
   concern, memoized per event). Campaigns write code-enforced ▶/✓/✗ Timeline markers
   so runs leave evidence even if the LLM forgets. Mandates store {invariant, SLA,
   scope, exceptions, playbook, warm-up state} in Key Details/Context.
3. **The You-Policy is behavioral nodes SCOPED TO Life-Graph entities.** "Linear tickets
   terse" = behavioral node scoped to a project entity; "Patel gets casual tone" =
   behavioral scoped to a person. Per-person personalization (§5.6) is therefore an EDGE
   PATTERN, not a new store. JudgmentEvents reinforce/supersede behavioral nodes
   (supersession inherits earned durability — a changed mind doesn't reset trust).
4. **Life Graph gets a THIN EARLY SLICE (P4 → P1/P2).** The meeting-prep oracle, per-
   person policies, and mandate scoping all need entity nodes + identity mappings — but
   only that. Pull `{entity nodes, [Name]↔[ID] mappings, about/involves edges}` into the
   spine; full cross-toolkit resolution/enrichment stays P4. GAIA's extraction ladder
   (1. identity mappings → 2. contacts → 3. resources → 4. procedures → 5. preferences)
   is the Memory Reducer's rubric — note procedures rank ABOVE preferences.
5. **The Apprentice writes PROCEDURAL nodes (stability 60) + skills.** A mined user
   workflow = a procedural-node candidate whose reinforcementCount literally counts the
   "watched you do it N times"; ≥3 → propose; accepted → mandate + crystallized skill
   (AwmWorker). The PROCEDURAL retrieval weight profile (sem .45/sig .25) exists for
   exactly this recall pattern.
6. **Learnings → behavioral candidates.** GAIA's completion-only `## Learnings`
   ("Sarah responds in 2-3 days" good; "went well" bad) harvested across references[]
   feeds the Memory Reducer as behavioral/semantic candidates — institutional memory
   with a quality bar, free of supersession complexity.
7. **The morning brief = Vellum's HEARTBEAT.md checklist (user-editable!) + GAIA digest
   batching** (warnings push individually; FYIs pool into ONE digest; single item →
   deep link, multiple → list). The heartbeat's key design holds for us too: the run
   itself NEVER sends — the model decides mid-turn whether anything clears the
   notification chokepoint; silence is the default outcome, and every skip/suppress is
   persisted with a reason (auditable restraint).
8. **Restraint composition stays as specced in the steal-lists** — now explicitly one
   stack: GAIA two-key escalating backoff (1/3/7d→30d mute; per-concern strikes compose
   with global karma) + quiet-hours-DEFER (no strike burned overnight) + single-token-
   prefix health checks under a hard per-sweep LLM budget (= §5.7's cost ladder) +
   Vellum deterministic post-LLM checks (dedupeKey 1h window, visibleInSourceNow
   suppression, copy-quality block) + the preference-extractor so quiet hours/channels/
   urgency floors are LEARNED, not config.

### 6.3 One mandate, fully wired (the integration test in prose)
"From now on, no email goes unanswered" → mandate canvas created (Key Details: SLA 24h,
exceptions: newsletters; warm-up 0/3) → watcher provisioned (inbox-state diff, local-
first) → each violating thread: entity node resolved/created for the sender (Life
Graph), PROSPECTIVE node "reply needed on thread X" + event trigger created → campaign
drafts the reply in the user's voice (behavioral nodes scoped to that sender shape the
tone) → warm-up: first 3 → pending store + morning brief; after 3 accepts → autonomous
sends → each act: ▶/✓ Timeline markers + activity_events + ledger minutes + JudgmentEvent
→ reducer reinforces "auto-reply OK for this class", learns exceptions → trigger
resolved-by edge closes the prospective node. Every layer of the model touched; nothing
bolted on.

### 6.4 Build-order integration (amends §5.11)
- **P1 spine** = Concern Canvas store (6-section, states-as-labels, due/expires) +
  mandate compiler + watcher-provisioner skeleton + **memory-graph core: node/edge/
  trigger tables with behavioral + prospective types** + Life-Graph thin slice (entity
  nodes + identity mappings). The reflection sweep evaluates triggers + canvases.
- **P2** += campaigns + warm-up autonomy + pending store + oracle (reads entity node +
  linked memories) + receipts; signal-match wiring watcher→canvas.
- **P3** = Memory Reducer (extraction rubric = GAIA ladder; reconsolidation rules =
  Vellum verbatim) + JudgmentEvents + decision-time injection (weight profiles).
- **P4** = Life Graph FULL (cross-toolkit resolution, enrichment, bi-temporal).
- Decay/reinforcement/supersession mechanics: adopt Vellum's numbers as defaults
  (stability 14/proc 60, ×1.5 reinforce, fidelity ladder, Ebbinghaus-at-retrieval).

---

## 7. THE BETA WEDGE — what we ship first, and why (2026-06-11, locked)

§1–§6 design the whole chief-of-staff. This section names the **one thing the beta v1
leads with** — the entry wedge, the keystones that make it defensible, the safety fixes
that make it shippable, and how it threads through the §6 model (it adds almost no new
architecture).

### 7.0 How we chose it (and why to trust it)

Four research agents ran the question from **deliberately divergent lenses** — a solo
founder's day, a founding-AE's pipeline, a competitive-whitespace sweep, and a
what-goes-viral lens. **All four independently ranked the SAME wedge #1.** Divergent
inputs → convergent output means the signal is in the territory, not in the prompt. The
agents named it differently — Open-Loop Closer / Promised-vs-Done Watchdog /
Dropped-Ball Closer / Commitment-Keeper — but it is one capability. (Full research +
citations: memory `kairos-untapped-wedge`.)

### 7.1 The wedge: THE OPEN-LOOP CLOSER (both directions)

**One line:** KAIROS watches your calls / email / Slack / DMs for the **promises you made**
*and* the **stale promises owed to you**, **verifies across every connected toolkit whether
the action actually happened** (did the email send? the Stripe invoice go out? the Linear
ticket get created? the doc get attached? did they ever reply?), and when a loop slipped,
**drafts the fulfillment in your learned voice for one-tap send.**

Beta scope = **two modes** (founder-locked 2026-06-11): **(A) Promises-I-made** (outbound
commitments I owe) + **(B) Who-Owes-Me** (threads/deals/intros where the ball is in their
court and has gone cold). Mode B is the surprise loop's beta home (an expected reply that
never arrived = the dog that didn't bark). THE CATCH (wrong-attachment / silent
auto-renewal / quoted-$X-but-reply-says-$Y) is the same machinery and ships post-beta as
a third mode — the surprise loop is still **coded** as a keystone (§7.2.1).

**Why it's untapped (the structural moat — this is the whole point).** Commitment
*DETECTION* became table-stakes in 2026: Claryti, Granola, Fellow, and Salesforce's
Slackbot now all detect "I'll send the deck" and drop it into an 8am brief — **but every
one of them is a READ-ONLY DETECTOR. Nobody closes the loop.** Closing requires three
things at once: (a) cross-toolkit READ to verify completion, (b) cross-toolkit WRITE to
fulfill, (c) learned judgment of which promises matter and how you'd phrase them. Cloud
single-channel tools (Superhuman / Motion / Gemini Daily Brief — Workspace-locked)
physically can't watch the OS or act across 200 toolkits; screen-watchers (Screenpipe)
capture but don't act; notetakers see one channel. **The triple `see + act-everywhere +
learn-me` is structurally unoccupied — and it is exactly the KAIROS stack** (Composio
200+ toolkits + OS/voice perception + the You-Policy + the restraint chassis). The moat
is the user's own tweet: *"My AI caught a promise from a Zoom call 3 days ago, found the
file, and wrote the email the way I would — the first one that DOES the thing instead of
reminding me."*

**How it maps onto §6 (no new architecture).**
- A **commitment is a PROSPECTIVE node** (§6.2 #1) tagged `kind: commitment`, with
  `direction: made-by-me | owed-to-me`, scoped to the counterparty **entity** (Life Graph),
  carrying an **event trigger** whose salience ramp (0.05 → 1.0 at the promised date →
  decay) IS the right-time-to-chase function.
- The set of open commitments is surfaced as **one "Open Loops" concern canvas** (GAIA
  6-section) — so it's both graph-native AND the queryable ledger the voice oracle reads.
- **Verify-fulfillment = grounded-verify reused.** The claim "this loop is closed" must be
  ⊆ a cross-toolkit read (a sent message to that recipient/thread, an invoice in Stripe,
  an issue in Linear…). At trigger day-of salience: **no fulfillment signal ⇒ surprise ⇒
  violation ⇒ open loop.** (Mode B: no inbound reply by the expected date ⇒ they owe me ⇒
  cold.)
- The fulfillment draft is a **§5.3 campaign**, voiced by **behavioral nodes scoped to the
  recipient** (§6.2 #3) — terse with the cofounder, warm with the investor.
- A kept promise closes the prospective node via a **resolved-by edge** (§6.1).

### 7.2 The five keystones (coded regardless of beta scope), each anchored to the wedge

These are the verification-panel's "make it a breakthrough, not a re-staple" core. Each is
specced as a general mechanism AND has the wedge as its first proving ground.

1. **Self-predicting surprise (the novelty engine).** KAIROS predicts what it expects to
   observe and treats prediction error as the salience signal. For the wedge the
   expectation is "this promise gets fulfilled / this person replies by date"; surprise =
   day-of with no fulfillment/reply signal. This is the engine under **both** beta modes
   and is what makes Mode B (Who-Owes-Me) work at all — absence is only detectable because
   an expectation existed. Mechanized as prospective-node triggers + the sweep's two
   surprise forms (§6.2 #1), not just named.
2. **The Judgment Model (calibrated P(accept) drives autonomy).** A *calibrated*
   probability that the user would accept a given surfacing/action. In beta (draft +
   one-tap, §7.3) it governs **which** slipping loops surface and how they rank — high
   P(matters) loops interrupt, low ones pool into the digest or stay silent. Post-beta it
   gates auto-send. Calibration is the safety hinge: rope is granted on **measured**
   acceptance with enough samples (a Brier/ECE check), never on a raw "3 accepts" count
   (§7.3).
3. **The Glass Box (voice-interrogable causal chain = the legibility moat).** Every
   surfaced loop can be interrogated: *"How did you know I promised that?"* → *"On Tuesday's
   call with Dana you said 'I'll send the SOC2 by Thursday' [transcript ts]; it's Thursday,
   no message to her domain in Gmail and no Drive share — so the loop's open."* The causal
   chain (which signal, which expectation, which read verified absence) is a first-class,
   spoken-on-demand artifact. This is also the personalization surface (§7.4).
4. **The Capability Profile (universality — zero per-toolkit code).** On connect, each
   toolkit gets **ONE cached LLM classification** declaring `{commitment-signals,
   fulfillment-signals, read-verbs, write-verbs, reversibility, sensitivity-class}`. The
   closer's see→verify→act loop reads ONLY this profile — no per-toolkit branching. Gmail:
   commitment = outbound promise language; fulfillment = a sent message on that thread.
   Stripe: commitment = "I'll invoice you"; fulfillment = invoice created/sent. Linear:
   commitment = "I'll file it"; fulfillment = issue created. **Connect a new toolkit → the
   closer covers it for free.** Reuses the `ComposioToolResolver.classifyLlm` batch pattern;
   this is what makes proactiveness *universal* across whatever the user connects.
5. **The Week Simulator (Foresight).** Runs the trigger salience ramps forward across the
   week → *"5 loops come due this week; 2 are most likely to slip based on your history."*
   Voice-interrogable: *"what am I about to drop this week?"* Foresight tier on top of the
   prospective-node + Judgment-Model machinery.

### 7.3 Safety fixes (the panel's real findings — these block ship without them)

These AMEND §1's no-go list and §5.1's warm-up autonomy.

- **Forever-draft classes (hard invariant).** VIP / financial / legal / new-contact actions
  are **never** auto-sent regardless of warm-up state — they always draft-and-propose. This
  overrides §5.1's "warmed-up mandate sends in scope" for these classes specifically.
- **Beta autonomy ceiling = DRAFT + ONE-TAP** (founder-locked). Beta always drafts; the
  human taps send. The warm-up→autonomous ladder is still **coded** (keystone-adjacent) but
  **capped at draft for beta** — best demo (you tap "send" on a perfect draft), and it dodges
  the OpenClaw "agent ran amok on her inbox" failure mode the GTM explicitly warns against.
- **Calibration-gated autonomy.** Rope is granted only when the Judgment Model is *calibrated*
  on enough samples (P(accept) above threshold with an acceptable Brier/ECE), not on a raw
  accept count. Hardens §5.1.
- **Action circuit-breaker + kill-switch + hold-recall.** A global pause (kill-switch); a
  short **hold window** before any send (even one-tap) so a mistaken tap is recallable; a
  circuit-breaker that trips autonomy *down* a rung on a burst of dismissals/reverts.
- **`source:'proactive'` invariant (closes a real bug).** Proactive-initiated actions MUST
  carry `source:'proactive'` and NEVER `source:'user'`. The user-bypass at
  `restraintPipeline.ts:88` is for genuine user turns only; a memUBot-style synthetic
  stimulus must not inherit it. Without this, the synthetic-turn path silently skips the
  INTERRUPTION gate.
- **Route ALL proactive actions through `ActionExecutor` → `RestraintPipeline`.** Close the
  `orders/v2/actionDispatcher.ts:66-90` path that bypasses restraint (only the TriggerEngine
  path currently reaches the pipeline). Replace `actionExecutor.ts:98-104`'s hardcoded
  restraint inputs (novelty 1 / urgency 0.5 / relevance 0.5) with **real signals from the
  surprise loop**: novelty = surprise magnitude, urgency = trigger salience, relevance =
  P(matters) from the Judgment Model.

### 7.4 Personalization-as-PRIMARY (founder-locked: "Card + improvement curve")

Personalization is not a feature here — it's the headline benefit and the thing incumbents
structurally cannot build (they don't see enough of your life to learn your judgment). The
beta makes "it learns ME" **felt** via **both** surfaces:

- **The learned model** (behavioral + prospective nodes, Memory Reducer): which promises you
  **keep vs. let slide** (per class and per person), **who matters** (inferred from how you
  treat them — not a manual VIP list), your **per-relationship voice** (behavioral nodes
  scoped to entities), and your **restraint threshold** (surface vs. stay-silent, learned
  from yes/no history). The longer you use it, the fewer false alarms and the more it acts
  the way you would.
- **Felt surface A — the inspectable "what I've learned about you" card.** Voice-interrogable
  provenance: *"I've watched you keep every promise to an investor and drop 'let's grab
  coffee' twice — so I now only chase the ones that would actually cost you."* This is the
  Glass Box keystone (§7.2.3) made into a standing, browsable artifact (ChatGPT-memory-style,
  but with provenance and editable).
- **Felt surface B — the improvement curve.** A day-1 draft vs. week-4 draft side-by-side for
  the same person — *"it sounds like me now."* Measurable as edit-rate decay (e.g. 60% of
  drafts edited in week 1 → 8% now), which doubles as the Time-Back/quality receipt (§5.8).

Both ship in beta; together they are the personalization half of the demo.

### 7.5 Build-order integration (amends §5.11 and §6.4)

The beta wedge rides the §6.4 spine — these are the deltas, not a parallel plan.

- **P1 spine** (already: prospective nodes + triggers + canvases + memory-graph core + Life-
  Graph thin slice) **+= for the wedge:** the `kind: commitment` tag + `direction` on
  prospective nodes; the **"Open Loops" concern canvas**; the **commitment extractor** (cheap
  LLM over outbound mail/Slack + call transcripts — reuse the `realtimeFactExtractor`
  fire-and-forget pattern); the **Capability Profile classifier** (reuse
  `ComposioToolResolver.classifyLlm`).
- **P2 += for the wedge:** the **verify-fulfillment loop** (grounded-verify reused —
  fulfillment-claim ⊆ cross-toolkit read); the **draft campaign** (draft + one-tap,
  restraint-gated, voiced by scoped behavioral nodes); **Mode B Who-Owes-Me** (absence
  detection on `owed-to-me` nodes + learned per-relationship cadence); the **Glass Box answer
  surface**; **ALL of §7.3's safety fixes** (`source:'proactive'`, route-through-ActionExecutor,
  forever-draft classes, hold-recall, real restraint inputs).
- **P3 (slice for beta):** behavioral-node injection + the **inspectable card** + the
  **improvement curve** (Memory Reducer + JudgmentEvents per §6.4 P3). Full reducer continues
  post-beta.
- **Keystones across phases:** surprise (P1–P2) · Capability Profile (P1) · Glass Box (P2) ·
  Judgment-Model calibration (P3, gates ranking in beta / autonomy post-beta) · Week Simulator
  (P2–P3 foresight).

**BETA v1 = P0 + P1 + P2 + a slice of P3**, autonomy capped at draft + one-tap, two modes
(Promises-I-made + Who-Owes-Me), personalization headlined via Card + improvement curve.
This is also the content of DEMO v2 (memory `kairos-gtm-idle`): the Closer = the **Mandate**
beat ("never let me drop a ball"), Who-Owes-Me's absence-catch = a **Reflex** surprise, and
the Week Simulator answers the **Oracle** beat — the wedge and the locked demo are the same
build.
