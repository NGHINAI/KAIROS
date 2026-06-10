# KAIROS Architecture

Subsystem-by-subsystem map of the daemon and its satellites, as of
`v0.6.0-alpha` + Phase E.2 (branch `phase-e2-core`, June 2026). Every file
path is relative to the repo root. Boot order lives in
`src/daemon/index.ts`: parse args → load `config.json` → init SQLite →
start HTTP servers → wire memory/perception/voice/agents → arm tick
scheduler → wait for signals.

## Data flow at a glance

```
                        ┌─────────────────────── macOS ────────────────────────┐
  hotkey/mic ──► KairosVoiceHelper (Swift sidecar: audio, STT, TTS, VAD)       │
                 │  UDS JSON-line protocol            KairosHUD (SwiftUI)      │
                 ▼                                        ▲                    │
        ┌─ src/daemon/voice/ ─────────────┐               │ /v1/voice/events   │
        │ sidecarClient → voiceConductor ─┼──► wrap-API (127.0.0.1:9876)       │
        └─────────────┬───────────────────┘   /v1/llm /v1/voice /v1/memory     │
                      ▼                       /v1/orders /v1/composio /v1/...  │
        ┌─ src/daemon/agents/ ────────────┐               ▲                    │
        │ Conductor ─ fast path ─► reply  │               │                    │
        │     └─ smart path ─► Planner +  │      Electron app / CLI / shim     │
        │        agent loop (tools) +     │                                    │
        │        Narrator (speak-while-   │                                    │
        │        acting) + Verifier       │                                    │
        └──┬───────────┬───────────┬──────┘                                    │
           ▼           ▼           ▼                                           │
        LLM router  Composio    skills/, MCP host, introspection tools        │
        (providers) (OAuth,                                                    │
                    triggers)                                                  │
           ▲           │                                                       │
           │           ▼ webhook events (Pusher)                               │
  observers (focus/clipboard/files/calendar/tabs)                              │
           └─► perception pipeline ─► trigger engine + Orders v2               │
                      │                    │                                   │
                      ▼                    ▼                                   │
               memory (SQLite ─ dreams ─► state/MEMORY.md)   restraint ─► you  │
└──────────────────────────────────────────────────────────────────────────────┘
```

## 1. Daemon core & tick loop

**Purpose:** lifecycle, persistence, and the classic autonomous heartbeat.

**Key files:** `src/daemon/index.ts` (boot, ~1500+ lines of wiring),
`lifecycle.ts` (pid/port/ready files, single-instance check, graceful
shutdown), `config.ts` (loads `config.json`), `db.ts` (SQLite at
`state/state.db`), `server.ts` (legacy daemon HTTP, default port 8765 —
serves the CLI and MCP shim), `scheduler.ts` + `decisionEngine.ts` +
`tickContext.ts` (tick loop), `taskRunner.ts` (spawns provider subprocesses
for WORK), `budgets.ts` (hourly cost/subprocess/message caps), `logger.ts`,
`notify.ts` (macOS notifications), `discord.ts`/`discordBot.ts` (optional
Discord surface), `scheduleManager.ts`, `cronParser.ts`.

**How it connects:** every tick the DecisionEngine builds context (inbox,
tasks, observations, memory) and asks the tick model (Haiku) for one of
`SLEEP | WORK | INVESTIGATE | NOTIFY | CONSOLIDATE` (`src/daemon/types.ts`).
WORK goes to TaskRunner, CONSOLIDATE to the Dreamer, NOTIFY through the
restraint pipeline. The tick loop predates the Phase E.2 agent loop and runs
alongside it.

## 2. Agent loop & subagents (Phase E.2)

**Purpose:** turn a user utterance into classified, tool-using, spoken work.

**Key files (`src/daemon/agents/`):** `conductor.ts` (entry point: classify,
fast-path or smart-path, honors AbortSignal for barge-in),
`intentClassifier.ts` (tier-1 routing), `executorAgent.ts` (acks/fillers),
`plannerAgent.ts` (tier-2 multi-step planning), `narrator.ts` +
`fillerBank.ts` + `streamSpeechController.ts` (speak-while-acting),
`contextBuilder.ts` (session-prefix cache + turn delta),
`loaders/soulDigestLoader.ts` (persona digest), `introspectionTools.ts`
(soul/skills/orders/memory/traj/dreams/composio/help), `selfHealConnect.ts`
(OAuth retry flow), `composioToolProvider.ts` + `toolRetriever.ts` +
`toolDispatch.ts` (dynamic Composio tool discovery, LRU cache),
`skillToolAdapter.ts` (crystallized skills as tools), `spokenSanitizer.ts`
(never speak internal text/raw ids), `turnLogger.ts`, `tokenBudget.ts`.

**The inner loop (`agents/loop/`):** `agentLoop.ts` (the turn loop),
`toolExecutor.ts`, `verifier.ts` (grounding gate: claims ⊆ tool results,
model from `KAIROS_VERIFY_MODEL`, default gpt-4o; also read/write tool
classification), `approvalGate.ts`/`approvalWrap.ts` (write-action approval),
`compactor.ts` (context compaction), `backgroundAgentManager.ts` +
`backgroundSubsystem.ts` + `backgroundTools.ts` (long-running background
agents), `priorRuns.ts`, `systemTools.ts`, `updatePlanTool.ts`.

**Model tiers:** `agents/types.ts` `TIER_MODELS` — fast=gpt-4o-mini,
smart=gpt-4o (non-reasoning on purpose; reasoning models leak CoT into
speech), deep=kimi-k2-thinking, vision falls back to smart. All overridable
via `KAIROS_*_MODEL` env vars; served through OpenRouter via
`agentsRouterAdapter.ts`.

**How it connects:** VoiceConductor hands utterances to the Conductor; the
Conductor speaks through the Narrator → StreamingSpeaker → TTS sink, calls
tools via Composio/MCP/skills, and logs every turn to `traj/` via
TrajWriter (`src/daemon/persona/trajWriter.ts`).

## 3. Voice pipeline

**Purpose:** push-to-talk in, low-latency speech out, barge-in abort.

**Key files (`src/daemon/voice/`):** `voiceConductor.ts` (orchestrator:
sidecar events → agent → speech → perception bus), `bootstrap.ts` (backend
selection), `types.ts` (`VoiceEvent`, `SidecarCmd`, `SidecarEvent` — single
source of truth), `sidecarClient.ts` (talks to the Swift helper),
`sidecarSimulator.ts` (in-process mock, same JSON protocol; all tests use
it), `nullSidecar.ts`, `sayBackend.ts` (stage-0 TTS via macOS `say`),
`streamingSpeaker.ts` (sentence-streamed TTS for the Narrator),
`utteranceCoalesce.ts` (merge STT fragments), `conversationStore.ts` +
`conversationMessageStore.ts` (SQLite turn history, durable conversation
memory + replay), `whisperAdapter.ts`; `stt/` (Deepgram, Whisper),
`tts/` (Deepgram, OpenAI, `wsAudioSink.ts` for the Electron renderer).

**Sidecar protocol:** newline-delimited JSON over a Unix domain socket.
The Swift `KairosVoiceHelper` and the in-process simulator implement it
byte-for-byte, so the real sidecar drops in with no daemon changes. Helper
events include hotkey down/up, transcripts, TTS finish/cancel, and VAD
barge-in — the barge-in event aborts the Conductor mid-run.

## 4. Wrap-API (cloud-shaped local API)

**Purpose:** one in-process HTTP contract for every frontend; migrating to
KAIROS Cloud later is a base-URL flip.

**Key files:** `src/daemon/wrapApi/server.ts` (Bun HTTP + WebSocket on
`127.0.0.1:9876`, `KAIROS_DAEMON_PORT`), adapters in `wrapApi/adapters/`:
`llmAdapter.ts` (Anthropic SDK), `openRouterAdapter.ts` (incl. tool_use SSE
+ reasoning-model CoT handling), `claudeCodeAdapter.ts`, `voiceAdapter.ts`
(persona-aware `/v1/voice/chat`).

**Routes:** `/v1/health`, `/v1/llm/complete`, `/v1/voice/chat|cancel|events`,
`/v1/memory/get|append`, `/v1/orders/add|list|disable`,
`/v1/composio/connect|connections|disconnect`, `/v1/settings/get|update`.

**How it connects:** the voice stack, Electron app, and HUD all speak only
`/v1/*`; only the adapters know which provider is underneath.

## 5. LLM router & providers

**Purpose:** pick the right provider/model per request, track cost.

**Key files (`src/daemon/llm/`):** `router.ts` + `policy.ts` (routing by
`KAIROS_MODE`: `byo` subscriptions / `hosted` APIs / `local` Ollama),
`costTracker.ts`, `pricing.ts`, `cache/promptAssembler.ts` (prompt cache
hints); `providers/`: `anthropicApi.ts`, `anthropicCli.ts` (`claude -p`),
`codexCli.ts`, `openai.ts`, `gemini.ts`, `openrouter.ts`.

**How it connects:** tick/work/dream models come from `config.json`
(Haiku/Sonnet); the agent loop uses OpenRouter tier models; the wrap-API
`/v1/llm/complete` fronts all of it. `scripts/smoke-all-llm.ts` and
`smoke-router.ts` are the gates.

## 6. Connectors: Composio + triggers

**Purpose:** real third-party actions (Gmail, Calendar, Slack, ...) with
OAuth, live event triggers, and self-healing.

**Key files (`src/daemon/connectors/`):** `composioClient.ts` (executeTool,
positional signature + `dangerouslySkipVersionCheck`), `connectionFlow.ts` +
`connectionStore.ts` (OAuth state), `toolkitResolver.ts`,
`composioSessionManager.ts`, `tokenExpiryPoller.ts`,
`connect|disconnect|findIntegration` intents; `triggers/`: `listener.ts`
(Pusher websocket), `instanceManager.ts`, `normalizer.ts`, `schemaCache.ts`,
`eventLog.ts`, `metrics.ts`, `connectGuard.ts` (rules referencing
unconnected toolkits get `pending_connection` + OAuth kickoff). Local
non-Composio connectors live in `connectors/` at repo root
(`macos-reminders`).

**How it connects:** trigger events → `agency/triggerEngine.ts` → Orders v2
(`src/daemon/orders/`: `parser.ts`, `compiler.ts`, `runtime.ts`, and `v2/`
with `author.ts` — LLM rule authoring grounded in real tool schemas —
`actionDispatcher.ts`, `conditionEvaluator.ts`, `approvalPrompt.ts`).
The agent loop reaches the same tools through `composioToolProvider` and
heals broken connections via `SelfHealConnect`.

## 7. Memory, dreams, perception

**Purpose:** remember everything cheaply, distill it while idle, recall it
on demand.

**Key files (`src/daemon/memory/`):** `schema.ts` (SQLite tables),
`workingMemory.ts`, `episodicMemory.ts`, `semanticMemory.ts` +
`vector/` (local embeddings + vector index; `embeddings.ts`,
fastembed/transformers), `proceduralMemory.ts`, `recall.ts` +
`memoryInjector.ts` (decision-time injection), `realtimeFactExtractor.ts` +
`factWriter.ts`, `forgetDetector.ts`, `pendingResolver.ts`, `dreamer.ts`
(consolidation passes), `voiceConsolidator.ts` (voice turns → memory),
`memoryFileView.ts` (renders `state/MEMORY.md`), `idleDetector.ts` (dreams
run when you're away). Activity recall: `src/daemon/activity/activityStore.ts`
+ `agents/introspectionTools` ("what did you do today?").

**Perception (`src/daemon/perception/` + `proactive/`):** observers
(`proactive/observers/`: focusApp, browserTabs, clipboard, fileEvents,
calendarLocal, activityWatch) publish to `proactive/eventBus.ts`;
`perception/tier1Classifier.ts` (cheap filter) → `tier2Summarizer.ts` →
`perceptionPipeline.ts` → `perceptionLog.ts`. Voice events are published to
the same bus for consolidation.

**Restraint (`src/daemon/restraint/`):** `restraintPipeline.ts` with
`actionScorer`, `urgencyFloor`, `karma`, `rateLimiter`, `cooldownTracker`,
`focusDetector`, `coalescer`, `digestComposer`, `deliveryRouter`,
`dryRunMode`, `personaShift` — the "should I interrupt?" gate for all
proactive output. Agency glue lives in `src/daemon/agency/`
(intentRegistry, triggerEngine, perceptionToTrigger, actionExecutor,
autonomyTier, inboxSurface, nativeNotifier, trajectoryLog).

**Skills (`src/daemon/skills/`):** `awmWorker.ts` detects recurring tool
sequences in trajectories and `crystallizer.ts`/`skillWriter.ts` turn them
into named skills under `skills/active/`, runnable via `tsRunner`/
`pythonRunner` and exposed back to the agent loop as tools.

## 8. Safety & hooks

**Purpose:** KAIROS never pushes, publishes, or destroys without approval.

**Key files:** `hooks/push-guard.sh` (Claude Code PreToolUse hook: regex
deny-list over Bash commands; blocked commands write an approval request;
single-use SHA-256 approval tokens in `state/approved/`),
`hooks/inject-inbox.sh`, `hooks/status-line.sh`;
`agents/loop/approvalGate.ts` (the same idea for in-process agent tools:
write-classified actions pause for approval), `restraint/` (interruption
safety), `budgets.ts` + `llm/costTracker.ts` (spend safety),
`persona/` soul + `templates/` (voice safety: tone, no internal text spoken).

## 9. MCP — shim (server) and host (client)

**Shim (`src/shim/`):** stdio MCP server that exposes KAIROS to Claude Code
as 7 tools (`kairos_assign`, `kairos_tell`, `kairos_status`, `kairos_inbox`,
`kairos_approve`, `kairos_history`, `kairos_cancel`) — `tools.ts`,
`index.ts`, `lifecycle.ts` (daemon auto-start/shutdown with last session).

**Host (`src/daemon/mcp/`):** KAIROS as MCP *client*: `mcpHost.ts`,
`mcpClient.ts`/`httpMcpClient.ts`, `smithery.ts` (catalog), `keychain.ts`
(secrets), `skillLoader.ts`, `toolToIntent.ts`. The onboarding subsystem
(`src/daemon/onboarding/`) can resolve a service, auto-install an MCP
server, and walk OAuth callbacks end-to-end.

## 10. CLI

`src/cli/index.ts` — `kairos inbox|status|act|dismiss|approve|deny|
schedules|tasks|feedback`. Plain HTTP to the legacy daemon server using
`runtime/port.txt`; no MCP or Claude Code required. `agency.ts` carries the
agency-facing subcommands.

## 11. Electron + macOS apps

- **`apps/electron/`** (`@kairos/electron` 0.6.0-electron-alpha) — Electron
  + React + Vite shell. Renderer does mic capture + Silero VAD
  (`@ricky0123/vad-web` + onnxruntime); main process owns the global
  hotkey, spawns `KairosSpeechHelper`, and bridges to the daemon wrap-API.
  Status: scaffolded and building; end-to-end wiring still in progress
  (see `apps/electron/README.md`).
- **`apps/macos/KairosVoiceHelper/`** — the full Swift audio sidecar:
  AVAudioEngine VoiceProcessingIO (echo cancel), SFSpeechRecognizer,
  AVSpeechSynthesizer, CoreML Silero VAD (barge-in), CGEventTap push-to-talk,
  UDS JSON-line protocol. `BUILD.md` covers xcodebuild/signing/LaunchAgent.
  (`KairosVoiceHelper-xcode/` is the Xcode-project variant.)
- **`apps/macos/KairosSpeechHelper/`** — minimal (~150 LOC) STT/TTS helper
  the Electron shell spawns.
- **`apps/macos/KairosHUD/`** — SwiftUI menu-bar HUD (activity, transport,
  panels) fed by wrap-API `/v1/voice/events`.

## 12. state/ and runtime/ layout

- **`state/`** (durable, gitignored): `state.db` (+wal/shm) — all SQLite
  stores; `MEMORY.md` — dream-consolidated long-term memory; `inbox/`,
  `pending-approvals/`, `approved/` (one-time approval tokens), `tasks/`,
  `logs/daemon.log`, `agents/`, `patches/`, `multimodal-cache/`,
  `secrets.json`, `tool-usage.json`.
- **`runtime/`** (ephemeral, gitignored): `daemon.pid`, `port.txt`,
  `ready.flag`, plus dumped `tick-prompt.txt` / `work-prompt-*.txt` for
  debugging exactly what the models saw.
- **`traj/`**: JSONL agent trajectories (`subagents.jsonl`) — the raw
  material the AwmWorker mines for new skills.
