# 11 — UI connection & event flow (daemon ⇄ HUD, and where Codex plugs in)

This is the wiring spec for the whole HUD surface: the single WebSocket the HUD
projects, the complete event taxonomy in both directions, and — the load-bearing
part for the Codex migration — exactly WHERE Codex-driven turn events plug into
the existing `onEvent → agent_*` seam so the orb, captions, activity tree, and
TTS all keep working unchanged when `[[task]]`/`[[think]]` move to CodexBrain.

Companion files: 01 (CodexBrain), 03 (guidance overlay grammar), 04 (notch +
Agents surface), 05 (backend protocol extensions). This doc is the contract that
keeps 01's brain swap invisible to the HUD.

---

## 0. The one-line invariant

> The HUD is a pure projection of one WebSocket. The daemon broadcasts JSON
> `{event, ...}` frames; the HUD maps them to orb state / captions / activity /
> approvals / guidance. Swapping the brain (OurLoop → CodexBrain) changes only
> what *produces* `LoopEvent`s upstream of `conductor.onEvent`; the event names
> on the wire and the HUD that consumes them DO NOT change.

If a Codex turn emits the same `LoopEvent` shapes the in-house loop emits, every
downstream consumer (TTS, orb, captions, activity tree, Agents surface) keeps
working with zero HUD edits. This is the entire reason the migration is safe.

---

## 1. The transport — one WebSocket, two clients

- **Endpoint:** `ws://127.0.0.1:<port>/v1/voice/events` (default port `9876`,
  overridable). Served by `src/daemon/wrapApi/server.ts:89` inside the same
  `Bun.serve` that hosts `/v1/voice/chat` etc.
- **Clients:** the Electron renderer AND the native Swift HUD
  (`KairosHUD/Transport/DaemonClient.swift:48`) connect to the SAME socket. Both
  receive the same broadcast; they consume different subsets.
- **Direction:** receive-mostly. The daemon broadcasts to all clients via
  `WrapApiServer.broadcast(event)` (`server.ts:28`). Clients send a small
  `{cmd, ...}` vocabulary back.
- **Resilience:** the Swift HUD auto-reconnects (keepalive every 20s +
  watchdog, `DaemonClient.swift:118/184`). Backpressure: `server.ts` already
  logs `send<=0` drops — a Codex turn streaming `assistant_delta` at token speed
  must be throttled/debounced (see §6) so it doesn't starve the broadcast loop.
- **Framing:** JSON text frames `{event:"<name>", ...payload}`. Binary frames
  are used only for `tts_audio` PCM chunks (`voice/tts/types.ts:60`).
- **Security note:** single unauthenticated localhost socket broadcasting to all
  connected clients. Fine for local; if a hosted control surface is ever added,
  this needs a token (out of scope here).

### How events reach the wire (two producers)

There are two distinct broadcast producers in the daemon — important because
they name events differently:

1. **Voice-bus events** — `index.ts:1717-1719` name-maps a bus kind to an event
   via `voiceEventName(busKind)` (`index.ts:239`) then `wrapApi.broadcast`.
   These are STT/TTS/VAD lifecycle frames (`listening_started`, `tts_begin`,
   `tts_chunk`, `tts_end`, …).
2. **Agent events** — the Conductor's `onEvent` closure calls
   `wrapApi.broadcast({event: e.kind, ...e})` DIRECTLY
   (`index.ts:2494-2496`). These are the flat `agent_*` frames. They are NOT
   bus events — they come straight from the agent pipeline.

Codex turns ride producer #2: a CodexBrain runner emits `LoopEvent`s, the
existing `conductor.onEvent` translates them to `agent_*`, and `index.ts:2496`
broadcasts them. No new broadcast path is introduced.

---

## 2. Daemon → HUD event taxonomy (complete)

Mapped to how `DaemonClient.apply` consumes each (`DaemonClient.swift:231-380`).

### 2a. Orb / voice-state events

| Event | Payload | HUD effect |
|---|---|---|
| `listening_started` | — | orb → `listening` |
| `listening_stopped` | — | orb → `idle` |
| `agent_intent` | `{tier, reason}` | orb → `thinking` |
| `agent_planning` | — | orb → `thinking` |
| `agent_status` | `{text}` | caption line |
| `agent_speaking` | `{speaking:Bool}` | orb → `speaking`/`idle` (**preferred envelope**; once seen, legacy tts_* no longer drive state — `DaemonClient.swift:33,262,274,287`) |
| `tts_begin` / `tts_end` / `tts_abort` | — | speaking/idle (**legacy fallback** only, pre-envelope) |
| `tts_level` | `{level:0..1}` | orb lobe level (authoritative; from renderer, see §4) |
| `tts_chunk` | `{pcm}` | chunk-RMS fallback level (when no `tts_level`) |
| `agent_interrupted` | — | orb → `idle` (barge-in / supersede) |
| `agent_done` | `{text}` | orb → `idle`; **load-bearing terminal** (see §3 warning) |
| `agent_error` / `error` / `sidecar_error` | `{message?}` | orb → `error` (auto-clears ~1.4s) |

### 2b. Activity tree (Lane A — the foreground turn)

| Event | Payload | HUD effect |
|---|---|---|
| `agent_tool_call` | `{id, name, args}` | activity node "started", keyed by `id` |
| `agent_tool_done` | `{id, result?}` | node "done" |
| `agent_tool_failed` | `{id, error?}` | node "failed" |

The HUD keys activity steps on `id` (`DaemonClient.swift:251`), so the CodexBrain
adapter MUST supply STABLE per-tool ids (synthesize from the Codex
`item/mcpToolCall` / `command/exec` item id if needed — open question, §8).

### 2c. Background sub-agents (Lane B — Agents surface, 04§B)

| Event | Payload | HUD effect (`BackgroundModel`) |
|---|---|---|
| `task_spawned` | `{task_id, title}` | new RUNNING card |
| `task_tool` | `{task_id, name}` | card status line |
| `task_progress` | `{task_id, text}` | progress line |
| `task_done` | `{task_id, result}` | move to TODAY history |
| `task_failed` | `{task_id, error}` | failed history card |
| `task_cancelled` | `{task_id}` | remove/cancelled |
| `task_report` | `{task_id, ...}` | final result/attachments |

`DaemonClient.swift:352-380`. With Codex, each background thread maps 1:1 to a
RUNNING card; "Open Agent" resumes that codex thread id (04§B, 01§E).

### 2d. Approvals

| Event | Payload | HUD effect (`ApprovalModel`) |
|---|---|---|
| `approval_request` | `{item_id, ...}` | approval prompt |
| `approval_inboxed` | `{item_id}` | moved to inbox |
| `approval_resolved` | `{item_id, decision}` | clear |

### 2e. Guidance / act — request/reply protocol on the SAME socket

These are not fire-and-forget; each carries an `id` and the daemon holds a
pending promise + timeout (`guideBridge.ts:44-149`). The HUD answers with a
matching `*_result` command (§5).

| Event | Payload | HUD effect |
|---|---|---|
| `guide_request` | `{id, app, kind, find/element, ...}` | resolve + draw affordance (03) |
| `screen_request` | `{id, app}` | AX inventory snapshot |
| `watch_request` | `{id, until}` | poll until match |
| `watch_change_request` | `{id}` | detect change |
| `act_request` | `{id, action, target}` | click/type via AXActor |
| `guide_end` | `{id}` | retract overlay, comet returns to orb |

03 extends `guide_request` with `kind: point|region|scroll|label` and adds a
`guide_scroll` round-trip; the transport mechanics here are unchanged (still an
id-keyed request answered by a `*_result` command).

---

## 3. HUD → daemon command vocabulary (the only sends)

| Command | When | Daemon handler |
|---|---|---|
| `{cmd:"approve"\|"deny", item_id}` | user resolves approval | `index.ts:2831` area |
| `{cmd:"guide_result", id, found, label, reason, summary}` | answers `guide_request` | `index.ts:2840` → `guideBridge.resolve` |
| `{cmd:"screen_result", id, ...}` | answers `screen_request` | `guideBridge.resolve` |
| `{cmd:"hud_keepalive"}` every 20s | liveness | `server.ts:108-119` |
| `{cmd:"tts_level", level}` every 66ms | playback RMS (renderer) | `index.ts:2849` re-broadcasts |
| `{cmd:"tts_playback", playing}` | playback ground truth (renderer) | `index.ts:2831` area |
| `{cmd:"test_inject_utterance"}` / `{cmd:"test_run_awm"}` | dev/test clients | `index.ts:2821/2858` |

03 adds a `{cmd:"scroll_result", id, ...}` mirroring `guide_result` for the new
`guide_scroll` round-trip.

> **Warning — `agent_done` is load-bearing.** It sets `lastAgentReply`
> (`index.ts:2495`), ends Lane A activity, persists the transcript turn, and
> clears `turnActive` in the HUD. A CodexBrain adapter that forgets a single
> terminal `agent_done` (or emits one AFTER an abort) leaves the orb stuck in
> `.thinking` and corrupts replay. On supersede/barge-in emit
> `agent_interrupted`, NEVER `agent_done` (matches handleSmart quiet-abort,
> `conductor.ts:681`).

---

## 4. The Electron renderer's audio role (mic + playback + authoritative level)

The Swift HUD does NOT capture audio — it only renders the level it is told. The
Electron renderer owns the audio plane:

- **Mic in:** captures via `getUserMedia` + VAD (`micVad.ts:64`), streams audio
  to the daemon's STT path.
- **Audio out:** plays the daemon's TTS PCM through `pcmPlayer` (`pcmPlayer.ts`),
  consuming `tts_begin` / `tts_chunk` / `tts_end` (binary `tts_audio` frames,
  `voice/tts/types.ts:60`).
- **Authoritative level:** taps an `AnalyserNode` on the playback graph for true
  RMS and sends `{cmd:"tts_level", level}` every ~66ms plus
  `{cmd:"tts_playback", playing}` as ground truth (`App.tsx:79,123-135,305-312`;
  daemon re-broadcasts at `index.ts:2849`).

Consequence for Codex: a Codex turn's spoken output MUST still route through the
existing `speakBackend` / `streamingSpeaker` + `SpeakingStateTracker`
(`index.ts:2111`) so the `agent_speaking` envelope and the renderer's
`tts_level`/`tts_playback` keep firing. If a Codex TTS path bypassed these, the
orb would sit idle or strobe (open question §8). CodexBrain feeds
`assistant_delta` into the SAME StreamSpeechController the in-house loop uses —
TTS is downstream of the LoopEvent, not the brain.

---

## 5. The Codex seam — where turn events plug in

### 5a. The seam, precisely

A turn's events are born as internal `LoopEvent`s and flow through ONE
translation point before hitting the wire:

```
runAgentLoop / CodexBrain  ──emits──▶  LoopEvent
        │                                  │
        │  (planner runner onEvent)        ▼
        └────────────────────────▶  conductor.onEvent closure   ← conductor.ts:624
                                           │  maps LoopEvent → flat agent_* events
                                           ▼
                                  wrapApi.broadcast({event:e.kind,...})  ← index.ts:2494-2496
                                           │
                                           ▼
                                  /v1/voice/events WS  →  HUD + renderer
```

The `LoopEvent` union is the stable contract (`agents/loop/types.ts:36-46`):

```
type LoopEvent =
  | { kind:"assistant_delta"; text }       // → assistant_delta → StreamSpeechController/TTS + caption
  | { kind:"tool_call_start"; id; name; args }   // → agent_tool_call (activity node)
  | { kind:"tool_call_done";  id; result }       // → agent_tool_done
  | { kind:"tool_call_failed"; id; error }        // → agent_tool_failed
  | { kind:"plan_update"; plan }            // → activity plan node
  | { kind:"compaction"; ... }              // internal
  | { kind:"self_correct"; concern }        // → self_correct envelope (verify retry)
  | { kind:"final"; text }                  // → final → agent_done
```

The Conductor selects its runner via `this.deps.runPlanner ?? defaultPlannerRunner`
(`conductor.ts:663`). `defaultPlannerRunner` (`conductor.ts:948`) builds
OpenRouterAdapters and calls `runAgentLoop`. **This is the exact swap point.**

### 5b. CodexBrain as an injected PlannerRunner

CodexBrain (01§A, `src/daemon/agents/codexBrain.ts`) is implemented as a
`PlannerRunner` and injected via `deps.runPlanner` when
`route ∈ {task, think}` and `KAIROS_BRAIN=codex` (01§E). It must:

1. Map `conversationId → codex thread` (thread/start once per conversation,
   reuse; `turn/start` per turn).
2. Pass the SAME instructions surface `handleSmart` builds today — the
   `contextBuilder` system prompt + lesson context + per-app knowledge doc — as
   `turn/start { input, instructions }`.
3. Translate the Codex app-server JSON-RPC notification stream into `LoopEvent`s:

| Codex notification | → LoopEvent | → wire `agent_*` |
|---|---|---|
| `item/agentMessage/delta` | `assistant_delta` | `assistant_delta` (TTS + caption) |
| `item/mcpToolCall` start / `command/exec` start | `tool_call_start {id,name,args}` | `agent_tool_call` |
| `item/mcpToolCall` end / `command/exec` end | `tool_call_done` / `tool_call_failed` | `agent_tool_done` / `agent_tool_failed` |
| `turn/plan/updated` | `plan_update` | (activity plan node) |
| `turn/completed` (final agentMessage) | `final {text}` | `agent_done` |
| `thread/tokenUsage/updated` / `turn/completed.time_to_first_token_ms` | (meter only) | → `llm_call_log` task_type `codex_smart`/`codex_deep` (01§F) |
| `error` | (error) | `agent_error` |

4. Debounce `assistant_delta` ~180ms before UI/caption (matches openclicky's
   `assistantDeltaFlushDelayNanoseconds`) to avoid HUD thrash and broadcast
   backpressure.
5. Emit the terminal `final` → `agent_done` exactly once per turn; on
   supersede/barge-in fire the interrupt RPC (`turn/interrupt {threadId,turnId}`)
   and emit `agent_interrupted`, never `agent_done`.

Because the mapper at `conductor.ts:624-651` already turns these `LoopEvent`s
into `agent_*`, **no HUD code changes** for the brain swap. The orb states,
captions, activity tree, and TTS are driven entirely by the event names above.

### 5c. The verifier gate stays POST-TURN at the seam

The deterministic verifier (01§D) runs after the turn on
`(utterance, finalText, toolCallLedger)` — all reconstructable from the event
stream. On a `retryable` flag the adapter injects one `[automatic check …]`
follow-up `turn/start` into the SAME codex thread and emits a `self_correct`
LoopEvent (which the HUD already renders). One caveat the adapter must respect:
the verifier's block-writes behavior (withhold the live "done, deleted" claim
until verify confirms) means destructive tool calls must be detected from the
MCP tool name EARLY in the event stream so the `assistant_delta`→TTS path can be
gated before it voices an unverified claim (open question §8).

### 5d. What stays ours (NOT on the Codex path)

- **Fast tier** — STT → fast LLM → TTS, single completion, no agent loop. Never
  enters the planner, never touches Codex. The diagram below shows it bypassing
  the brain.
- **Background sub-agents** migrate first (rollout step 1, 01) via
  `codex exec --json`; their events already map to Lane B (§2c).

---

## 6. Full path diagram (STT → fast-front → CodexBrain → events → HUD/TTS)

```
                              ┌─────────────── Electron renderer ───────────────┐
   mic  ──getUserMedia/VAD──▶ │ micVad.ts → audio frames                        │
                              └───────────────────────┬─────────────────────────┘
                                                       │ (audio over /v1/voice/*)
                                                       ▼
                                            ┌──────────────────┐
                                            │   STT (daemon)    │
                                            └─────────┬─────────┘
                                                      │ transcript
                                                      ▼
                              ┌──────────────── FAST FRONT (OURS) ───────────────┐
                              │ chit-chat / routing (single completion, NO loop)  │
                              │   • quick answer → speak directly ───────────────┼──▶ TTS
                              │   • [[task]] / [[think]] → route to planner       │
                              └───────────────────────┬───────────────────────────┘
                                                       │ route ∈ {task,think}
                                       KAIROS_BRAIN=codex ?
                          ┌────────────────────────────┴───────────────────────────┐
                          │ YES                                                   NO │
                          ▼                                                          ▼
              ┌────────────────────────┐                          ┌────────────────────────┐
              │  CodexBrain (Planner   │                          │  defaultPlannerRunner   │
              │  Runner) — warm         │                          │  → runAgentLoop (OURS)  │
              │  `codex app-server`     │                          └───────────┬─────────────┘
              │  stdio JSON-RPC         │                                      │
              │  tools via MCP (kairos) │                                      │
              │  models via PROXY→OR    │                                      │
              └───────────┬────────────┘                                      │
                          │ JSON-RPC notifications                            │ LoopEvent
                          │  (agentMessage/delta, mcpToolCall, turn/completed)│
                          ▼                                                    ▼
                ┌──────── translate to LoopEvent ──────────┐         (already LoopEvent)
                │ assistant_delta / tool_call_* / final     │
                └───────────────────┬───────────────────────┘
                                    ▼
                        conductor.onEvent  (conductor.ts:624)   ── POST-TURN: verifier gate (01§D)
                                    │  LoopEvent → flat agent_*
                                    ▼
                        wrapApi.broadcast({event,...})   (index.ts:2494)
                                    │
                  ┌─────────────────┴───────────────────────────────┐
                  ▼                                                   ▼
        /v1/voice/events WS  ─────────────────────────▶  Electron renderer
                  │                                         • assistant_delta → pcmPlayer (TTS)
                  ▼                                         • tts_level/tts_playback back ──┐
        KairosHUD (DaemonClient.apply)                                                     │
          • agent_speaking / tts_level → orb state + lobes ◀──────────────────────────────┘
          • agent_tool_call/done       → activity tree (Lane A)
          • task_*                     → Agents surface (Lane B)
          • guide_request              → guidance overlay (03)  ⇄ guide_result
          • agent_done                 → finalize turn / persist
```

Key reading: the brain choice (CodexBrain vs runAgentLoop) is the ONLY fork; it
re-merges at `conductor.onEvent`. Everything from there to the HUD is identical,
which is what makes the swap invisible to the UI.

---

## 7. Proactive hook (coming soon — leave the seam)

Proactive turns (the chief-of-staff design) enter the SAME planner via a
"synthetic stimulus" (an event becomes a fake user turn) and route to CodexBrain
as **non-voice / background threads**. The seam consequence to preserve now:

- A non-voice turn's `assistant_delta` must NOT be auto-piped to TTS unless the
  delivery plane decides to speak. The CodexBrain runner takes a `speak:boolean`
  (or a "muted" mode) so proactive deltas feed the activity tree + Agents card
  but not `SpeakingStateTracker`.
- Proactive acts still flow through the SAME `agent_*` broadcast and Lane B
  cards, so the Agents surface (04§B) shows them with no new event types.
- The `taskRunner` WORK path (today spawns `claude -p`) re-routes through
  CodexBrain when `KAIROS_BRAIN=codex` so proactive and reactive share one brain,
  one tool surface, and one verifier gate (05§C). Leave this hook; do not wire
  proactive delivery yet.

---

## 8. Open questions (HUD/event-flow specific)

- **Stable tool ids:** does codex app-server give per-tool begin/end
  notifications with stable ids mappable to `tool_call_start/done`, or must the
  adapter synthesize ids? The HUD keys activity steps on `id`
  (`DaemonClient.swift:251`) — synthesized ids must be stable across the
  start/done pair. (01 open question.)
- **TTS routing:** will Codex turns route spoken output through the existing
  `speakBackend`/`streamingSpeaker` + `SpeakingStateTracker` so `agent_speaking`
  + renderer `tts_level` still fire, or does Codex need a dedicated TTS bridge?
  The orb's speaking state depends entirely on these signals.
- **Block-writes on streamed deltas:** the verifier's withhold-live-claim
  behavior assumes KAIROS controls when the final is spoken. Codex streams
  deltas straight to TTS — must we re-implement the destructive-stream gate on
  the Codex `assistant_delta` path, or can a destructive MCP tool name be
  detected early enough to gate the stream?
- **MCP namespace in the ledger:** Codex may report namespaced tool names
  (`kairos__guide_user`); the verifier's `LOCAL_TOOLS` / `startsWith('kairos_')`
  logic matches bare names. The ledger translator must strip the namespace
  before feeding the verifier (else every tool mis-gates).
- **Delta backpressure:** confirm the 180ms debounce + broadcast loop survives a
  long deep turn streaming at token speed without `send<=0` drops.
