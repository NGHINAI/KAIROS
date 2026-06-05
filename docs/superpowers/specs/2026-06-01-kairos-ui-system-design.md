# KAIROS UI System — Design Spec (Living Oval HUD, always-on, full surface set)

- **Date:** 2026-06-01 (rev 2026-06-02)
- **Revision:** **v3** — now on **macOS 26 Tahoe** (true Liquid Glass primary); aligned to the backend session's **Lane A / Lane B** model (sub-agents = detached `runAgentLoop`, **not** `claude -p`); added **always-on vs push-to-talk** interaction modes; fleshed voice onboarding; added an embedded **Questions-for-backend** block (§15) to answer inline. (v1 wrongly modeled sub-agents as `claude -p`; v2 corrected to in-process loop; v3 aligns to Lane A/B + always-on + Tahoe.)
- **Status:** Draft — **shared between the UI session and the backend session.** Backend session: please **answer §15 inline** and edit anything the code contradicts. Every daemon change is tagged **[BACKEND HOOK]** (consolidated §10).
- **Scope:** The complete native macOS UI — the voice-first "Living Oval" HUD, **always-on listening**, the Lane A/Lane B sub-agent activity tree, and a minimal summoned surface for every capability.
- **🟢 STATUS (2026-06-04):** Backend **shipped the UI-hooks batch** — the unified live **`agent_activity`** tree (with `parentRunId`/`depth` lineage), `agent_delta`/`agent_plan`/`agent_status`, Lane B **`task_*`** events, and the WS **`approve`/`deny`** command (→ `approval_resolved`) are **LIVE and independently verified**. **Wave 1 is now fully wireable against the real daemon — no mock dependency.** Authoritative verified wire shapes are in **§17**; the backend's inline answers + corrections are in **§15/§16**. Where the body (§3/§6.3/§9) predates Batch 2, **§16/§17 win.**

---

## 1. North star & philosophy

KAIROS is a voice-first, always-on macOS coworker. The UI makes the voice feel **alive**, lets you **talk to it anytime**, and lets you **see & control everything** — *minimally*.

> **Full coverage, minimal aesthetic.** Every user-meaningful capability gets a surface, but surfaces are *summoned* glass cards that emanate from the orb and dissolve when done — never a dashboard. A small set of internal mechanics stay invisible (§6.Z).

### Goals
- A native, audio-reactive **orb HUD** that breathes/listens/thinks/speaks like a living thing.
- **Always-on** listening (talk anytime) *and* push-to-talk, switchable, with first-class **privacy** controls (§ Interaction modes).
- **Watch KAIROS work** as a live **tree** — the foreground turn (Lane A) and any background sub-agents it spawns (Lane B), nested.
- A minimal summoned card for **every** capability (approvals, integrations, orders, schedules, skills, memory, persona, privacy, status/cost, background tasks).
- True macOS **Liquid Glass** (Tahoe `.glassEffect`).
- Decoupled from backend internals: the UI is a **projection of the WS event stream + HTTP/MCP reads**.

### Non-goals
- ❌ No persistent dashboard / activity feed / home screen. No editors — authoring/tuning stays voice (memory/persona/orders/skills are read/approve/kill surfaces).
- ❌ Not Windows/Linux. macOS 26 (Tahoe) target, 14.2+ supported.
- ❌ Pointer overlay / "where do I click" is **Wave 4 / Phase H** (needs a computer-use plane that doesn't exist).
- ❌ No UI for genuinely-internal mechanics (§6.Z): prompt A/B internals, intent-classifier internals, restraint scoring math, self-debug fingerprints, compaction/token mechanics, tick-history.

---

## 2. Architecture & platform

**HUD = native Swift `NSPanel` sidecar** (`apps/macos/KairosHUD/`), amending "Architecture A" (Electron retired for the HUD). The Bun daemon stays the single source of truth. The HUD speaks the **same WebSocket** the Electron app used (`ws://127.0.0.1:9876/v1/voice/events`) + `/v1/*` HTTP + `kairos_*` MCP tools.

**Platform (verified 2026-06-02):** macOS **26.5.1 (Tahoe)**, Swift **6.0.3**. **Xcode NOT installed** — only Command Line Tools (`/Library/Developer/CommandLineTools`).
- **Liquid Glass is now primary**, not a fallback: SwiftUI `.glassEffect(.regular, in:)` on the panels/cards.
- ⚠️ **Build caveat / §15-Q:** `.glassEffect` requires the **macOS 26 SDK**, which ships with **Xcode 26**; the current Command-Line-Tools SDK (target `macosx16.0`) may not expose it, and **Metal shaders need Xcode** regardless. So either (a) **install Xcode 26** → true `.glassEffect` + optional Metal orb, or (b) stay CLT → `NSVisualEffectView` glass + Core-Animation orb. Spec targets (a); `GlassEffect` shim still degrades to `NSVisualEffectView` if the SDK lacks `.glassEffect`.

---

## 3. The two lanes (aligned to the backend "Batch 2" plan)

KAIROS runs work in **two lanes**. The UI renders both as one nested activity tree, but their lifecycles differ.

### Lane A — Foreground voice (live, on the WS) — the hero
- **What:** the conversational turn. `Conductor.handle()` classifies (`fast|smart|deep|vision`); non-fast routes to `defaultPlannerRunner` → **`runAgentLoop`** (in-process, on OpenRouter). Streams tokens, calls tools, self-corrects, compacts, verifies destructive actions. Fast, conversational, **never blocks**.
- **Live signals:** ride the WS via `Conductor.onEvent → wrapApi.broadcast({event:e.kind,...e})` (`index.ts:2096`). *Caveat:* today the flat `agent_tool_*` are emitted **post-turn** (`conductor.ts:214-228`); live streaming needs hook #1 (thread `onEvent`).
- **UI:** the orb + the **ephemeral inner-orbit** of this turn's tool calls (Lane A satellites/timeline), gone when the turn settles.

### Lane B — Background sub-agents (detached, multi-step) — the persistent orbit
- **What (per backend Batch 2 — SHIPPED):** a sub-agent **runs OUR `runAgentLoop` detached** (multi-step, background) — **NOT `claude -p`**. Spawned by the **`spawn_background_task`** tool (live check-in via **`background_tasks`**) and/or proactively. Tracked **in-memory** by `BackgroundAgentManager` (`Map<id,BgTask>`, **not** the `tasks` table — that's the legacy `claude -p` path; see §16.1/§17) + the **soul/persona/memory/skills loaders + RestraintPipeline**. On completion → **DeliveryRouter** → speaks the result (`proactiveDone`) **+ a `task_report` card**.
- **Live signals:** *(backend fork — §15-Q5)* either streams `runAgentLoop` LoopEvents live over WS (preferred for live progress), or only status transitions + a final delivery card.
- **UI:** **persistent satellites** that keep orbiting the hero **even when you're not talking**, each showing its status; on done, a **delivery card** (summary + artifacts + follow-ups). Also listed in the Tasks board (§6.3).

> **Legacy note:** `claude -p`/`taskRunner` subprocess execution is the *old* autonomous-WORK path (proactive Scheduler, `index.ts:316/402/411`). Batch 2 swaps the **executor** to `runAgentLoop` while **reusing the status store**. The UI treats "background sub-agents" and "scheduled/cron tasks" as one **Tasks** surface (§6.3), tagged by origin.

> **One envelope for both lanes (§15-Q6):** a normalized **`agent_activity {runId, parentRunId, depth, lane, kind, status, tool?, summary?, ts}`** lets one UI tree render Lane A turns and Lane B sub-agents identically. Promoted to **required**.

---

## 4. Interaction modes — push-to-talk vs always-on (NEW)

The user wants to **talk anytime**. Today the system is **push-to-talk only** (hold Option / click Talk / `Option+Space`; Silero VAD runs but only for barge-in; no wake-word, no continuous capture, no addressing gate; `SidecarCmd.mode` stub = `push_to_talk|toggle`). Always-on is the planned "E.4 continuous mode." This section specs both and how they **look**.

### 4.1 The modes
1. **Push-to-talk (PTT)** — *current.* Mic cold between presses; deterministic boundaries; zero ambient-privacy concern. Orb dark/idle until pressed.
2. **Always-on — wake-word** — mic hot continuously; KAIROS rouses on "hey kairos"/its name, then captures the directed utterance (VAD+EOU endpointed); ambient speech ignored.
3. **Always-on — hands-free conversation** — once roused / in a session, the mic stays open and VAD+EOU segment turns; back-and-forth with no re-press; barge-in works; auto-returns to dormant after a silence timeout.
4. **Muted** — mic hard-off; orb dimmed + mute glyph.

### 4.2 How it LOOKS (orb behavior) — PTT vs always-on

| aspect | Push-to-talk | Always-on |
|---|---|---|
| **resting orb** | dark/idle, mic **cold** | softly breathing **dormant**, mic **hot** + persistent privacy dot |
| **to start talking** | hold Option / click / `⌥Space` | just say **"hey kairos"** (or already in conversation) |
| **ambient room sound** | nothing (mic cold) | orb **micro-reacts** to room level (very subtle) but stays dormant — not treated as directed |
| **rouse** | n/a | wake-word → orb **flares/perks** ("roused") → **directed listening** |
| **listening** | only while key held | "directed" listening, **VAD+EOU bounded** (no key) |
| **end of turn** | release key | **EOU** detects you stopped; silence timeout → back to dormant |
| **privacy** | none needed (cold mic) | **persistent "mic-live" ring** + one-tap **hard-mute** (click the dot / hotkey / "kairos, stop listening"); **quiet-hours auto-mute** |
| **best for** | precise, deliberate, shared/quiet rooms | hands-free, flow, "talk anytime" |

### 4.3 New orb states for always-on
Add to the §6.1 state machine: **`dormant`** (always-on idle, mic hot — slow ambient breath + faint privacy ring), **`roused`** (wake detected — quick bright flare → listening), **`muted`** (dimmed + mute glyph). Existing listening/thinking/speaking/error unchanged. `mic_level` now also drives the *dormant* micro-reaction.

### 4.4 Mic ownership (load-bearing — §15-Q16/17)
Always-on needs ONE stable native mic owner. Today: renderer (`KAIROS_MIC=renderer`, requires cloud STT) OR the `KairosVoiceHelper` Swift sidecar. **Recommendation:** the **KairosHUD Swift app owns the always-on mic + wake-word** (it's the always-running native surface) — or keep `KairosVoiceHelper` and HUD stays display-only. Backend decides.

### 4.5 Always-on backend hooks (see §10 #17–#22)
Continuous capture; wake-word engine; VAD+EOU turn segmentation; optional addressing classifier; events `listening_mode`, `listening_state{dormant|ambient|roused|directed}`, `wake_detected`, `mic_level`, `mute_state`; commands `set_listening_mode`, `set_mute`. The `SidecarCmd.mode` stub extends to `'always_on'`.

---

## 5. Design language
- **One hero + transient cards.** Orb is the only persistent element; cards materialize (glass-refraction wipe) and dissolve.
- **Motion & light over chrome.** Orb deforms to the voice; **Liquid Glass** depth (Tahoe `.glassEffect`); satellites orbit; spring physics.
- **Color = state:** idle cool cyan/white · dormant faint breath · listening brightening cyan · thinking amber · speaking green (deformation) · error red · muted dim. Approval tiers green/yellow/orange/red.
- **Never in the way:** notch-docked; never steals focus; dismiss by voice/Esc/click-away.

### Locked choices
- **Sub-agent viz: hybrid + nesting** — collapsed satellites (Lane A = ephemeral inner orbit; Lane B = persistent satellites); a sub-agent satellite can have its own sub-satellites (depth); tap → **depth-indented timeline tree**.
- **Home: notch-docked, draggable**, top-center fallback.
- **Liquid Glass (Tahoe) primary**, `NSVisualEffectView` degrade if SDK lacks it.
- **Modes: PTT + always-on, switchable**; default mode is a §15-Q14.

---

## 6. Surfaces

### 6.1 Orb HUD (hero) — Wave 1
Always present, notch-docked. **States:** idle · **dormant** (always-on) · **roused** · listening · thinking · speaking · error · **muted** (triggers in §4.3 + §6.1 table below).
| state | enters on | look |
|---|---|---|
| idle (PTT) / dormant (always-on) | default | idle: dark; dormant: slow breath + mic-live ring |
| roused | `wake_detected` | quick flare → listening |
| listening | `listening_started` / `listening_state:directed` | cyan, ripples track `mic_level` |
| thinking | `agent_planning`/`agent_intent`(non-fast) | amber pulse, rotating ring |
| speaking | `tts_begin` | green, core/ring deform to voice RMS |
| error | `agent_error`/`error`/`sidecar_error` | red glow + shake |
| muted | `mute_state{muted:true}` | dimmed + mute glyph |

- **Captions:** ephemeral `you:` (`stt_partial`→`stt_final`) + `kairos:` (token-streamed via `agent_delta` **after hook #7**; today set once on `agent_done`).
- **Status line:** `agent_status` text.
- **Mic-live + mute affordance (always-on):** persistent privacy ring; click = hard mute (`set_mute`).
- **Text-input bar (`kairos_tell` fallback):** summonable typed-turn field → `test_inject_utterance`/`utterance_text`.

### 6.2 Lane A — live foreground activity tree — Wave 1
The "watch it work" surface for the current turn. Collapsed: tool calls of the turn as the **inner orbit** (tier glyph from `agent_intent`; caption = `agent_status`/narration). Expanded: depth-indented timeline (tool name, spinner→✓/✗, `result_summary`, `update_plan` checklist, compaction marker). Built from the `agent_activity` envelope; needs Wave-1 hooks #1–#7. `MockDriver` supplies a tree for dev now.

### 6.3 Lane B + scheduled — Background sub-agents & Tasks — Wave 2 (read) / Wave 3 (live)
The persistent plane: background `runAgentLoop` sub-agents (Lane B) **and** scheduled/cron tasks, unified, tagged by origin.
- **Persistent satellites:** running background sub-agents keep orbiting the hero across turns; brightness = activity; click → its timeline/tree.
- **Summoned board:** list grouped by status (running/queued/done/failed/blocked) from `kairos_tasks`/`kairos_status`; per row: description, origin (foreground-spawned / proactive / scheduled), elapsed, `cost_cents`, `tick_count`, `result_summary`, **Cancel**. **Schedules & reminders** sub-list from `kairos_schedule` (next-fire, pause/resume/delete).
- **Delivery cards (DeliveryRouter):** on a sub-agent's completion, a glass card (summary + artifacts + follow-up actions); also spoken (`proactiveDone`). Blocked sub-agents surface **Approve** via §6.5.
- **Live:** `task_update` status transitions + (fork §15-Q5) optional live LoopEvent stream make satellites/board live; else poll.

### 6.5 Approval cards (trust/consent) — Wave 3
Slides from the orb on `approval_pending`. Variants share one chassis: **action approval** (tier color, `title`, `args_preview`, `reasoning`; Approve once / Approve for task / Deny; RED = explicit click; 👍/👎); **self-modification diff-review** (`kairos_self_modify` → `target_file` + unified diff + compile-check; RED, click-only); **staged-skill approval** (self-authored skill → Approve/Discard before auto-promote).

### 6.6 Proactive pulse / interrupt / digest / inbox / observations (+ feedback) — Wave 3
`proactive{mode}`: `surface` = orb badge/pulse; `interrupt` = transient card + 👍/👎 (`feedback`); `digest` = stacked card at slot times. A minimal **inbox** peek (`kairos_inbox`) folds task-results/blockers. Environment **observations** (`kairos_observe`) surface here as surface-mode pulses / inbox items with **act/dismiss**. Respects pause/quiet-hours.

### 6.7 Voice onboarding (incl. always-on consent) — Wave 3
Orb-led, voice-first. **Sequence:** (1) welcome + privacy; (2) **permissions** — mic / speech recognition / (later) screen / accessibility, native prompts; (3) **listening-mode choice** — PTT vs always-on, with the §4.2 comparison shown as two glass cards; if always-on: **wake-word enrollment/confirm** + explain the mic-live indicator & mute; (4) **soul wizard** (5 questions, `persona/soulWizard.ts`) — spoken; (5) connect a first integration (Calendar) via §6.8; (6) first conversation. Minimal visual = **progress dots** (`onboarding_step{step,total}`) + a "paste your API key" affordance where a setup flow needs it. Driven by `onboarding_step` events + `onboarding_response` command; conversational turns run the normal loop. (§15-Q23/24.)

### 6.8 Integrations pool (+ Discord chip) — Wave 2 (HTTP today)
Summoned toolkit-chip grid (Gmail, Calendar, Linear, Slack, Notion, …) with status dots (connected / needs re-auth / disconnected); connect/disconnect → `POST /v1/composio/connect|disconnect` (OAuth browser hop). Reads `GET /v1/composio/connections`; live-refresh on `connection_changed` else poll. Small read-only **Discord** status chip.

### 6.9 Standing-orders review/kill — Wave 2 (HTTP today)
Minimal list: plain-English rule + state (live / observing-24h dry-run / paused) + last-fired + **pause/delete (kill switch)**; dry-run shows "would have fired N×". `GET /v1/orders/list` / `POST /v1/orders/disable`. Authoring stays voice. *(Kill switch is load-bearing — the 4,454-notification incident.)*

### 6.10 Skills + capability gaps — Wave 2 (read) / Wave 3 (approve)
List active + staged skills (`kairos_skills`); staged self-authored skills get the §6.5 approve/discard gate. Capability gaps (`kairos_gaps`) as a proactive pulse.

### 6.11 Memory — "what I've learned" (read-only) — Wave 3
Card listing top learned facts/preferences; each row a 👎 **"forget this"** (`forget_fact`). No editor.

### 6.12 Persona / user-model (read-only) — Wave 3
Card: current tone + what KAIROS has learned about you. Read-only; tuning stays voice.

### 6.13 Privacy / pause / watching / mic — Wave 3 (+ mute is Wave 1 if always-on ships early)
**Watching indicator** (observers active) + global **Pause / quiet-hours** (`set_pause`/`set_quiet_hours` ↔ `pause_state`/`watching`) + the always-on **mic-live + hard-mute** control (`set_mute` ↔ `mute_state`). The consent center.

### 6.14 Status & cost glance — Wave 2 (poll) / Wave 3 (push)
Compact card: "what I'm doing / running / queue" (`kairos_status`, `/status`) + "spend this month" (`cost` / `/status`). Not a chart, not a tick viewer.

### 6.16 Pointer overlay + cursor result-bubble — Wave 4 (Phase H, deferred)
Bezier-arc pointer to an on-screen target + cursor result bubble. Blocked on a computer-use coordinate plane; needs native screenshot self-exclusion (in the panel recipe).

### 6.Z Deliberately invisible (no surface)
Prompt A/B internals (`kairos_prompts`), intent-classifier internals (tier glyph is enough), restraint scoring math (user sees the *outcome* in §6.6), self-debug fingerprints (`kairos_debug` — only the proposed patch surfaces via §6.5), tick-decision history (`kairos_history` — debug-only), compaction/token mechanics.

---

## 7. Orb visual & motion
- **Composition (Core Animation / SwiftUI Canvas; Metal only if Xcode installed):** radial-gradient **core** (state-color halo, additive); **chromatic fringe** (warm/cool offset layers, lighten blend — the red/cyan split); **ring** stroked path with noise-perturbed vertices, wobble = `level`; **glow** brightens with `level`.
- **Motion:** `level∈0..1` (smoothed) drives core scale (±~8%), ring wobble, glow; **dormant** = slow breath + faint mic-live ring + tiny `mic_level` micro-reaction; **roused** = fast flare; speaking maps RMS→deformation.
- **Satellites:** Lane A = ephemeral inner orbit (this turn's tools); Lane B = persistent outer satellites (background sub-agents) that linger until done; nesting = sub-satellites; flare+fade on done/fail.
- **App structure / panel recipe / glass shim / state model:** unchanged from v2 — `apps/macos/KairosHUD/` SwiftPM app, never-steal-focus `NSPanel` (`.nonactivatingPanel`, `.canJoinAllSpaces`, `level=.statusBar+1`, `becomesKeyOnlyIfNeeded`), `GlassEffect` (Tahoe `.glassEffect` → `NSVisualEffectView` degrade), `@Observable AppState` reducer over events, `ActivityTree` from `agent_activity`, `MockDriver` for daemon-free dev (now includes always-on state cycling + a Lane B tree).

---

## 8. Amplitude / "level"
`(state, level)`. Speaking → RMS from each `tts_chunk` base64 PCM (s16le 24kHz) client-side, **no backend change**. Listening/dormant → `mic_level` event (now needed for always-on, §10 #20). Thinking → synthetic pulse.

---

## 9. The daemon ↔ UI contract

One bidirectional WebSocket (`/v1/voice/events`, :9876) for the live plane; HTTP `/v1/*` + `kairos_*` MCP tools for summoned reads/writes.

### 9a. Existing daemon → UI events (verified)
`subscribed{clients}` · `tts_begin/chunk/end/abort{speakId,…,pcm?}` (base64 s16le 24kHz) · `stt_partial/stt_final{text}` · `listening_started/stopped` · `agent_intent{tier,reason}` · `agent_planning{tier}` · `agent_tool_call{id,name,args}` · `agent_tool_done{id,name,result_summary}` · `agent_tool_failed{id,name,error}` · `agent_done{text}` · `agent_interrupted` · `agent_error{message}` · `sidecar_error{code,message?}` · `error{message}`.
> Bridge `index.ts:2096` = `broadcast({event:e.kind,...e})` → any new `AgentEvent` member is one `emit()` away (no `server.ts` change). `agent_status`/`agent_ack` declared but **no producer**; `LoopEvent`s **dropped** (no `onEvent` threaded). Flat `agent_tool_*` are **post-turn** (`conductor.ts:214-228`).

### 9b. Existing UI → daemon commands
`test_inject_utterance{text,conversationId?}` · `utterance_audio{wavBase64,…}` · `barge_in{}`.

### 9c. Existing HTTP + MCP surface (reads & writes)
`GET /status` · `GET /v1/composio/connections` · `POST /v1/composio/connect|disconnect` · `GET /v1/orders/list` · `POST /v1/orders/add|disable`. `kairos_*` tools (`src/shim/tools.ts`): `tell, assign, status, tasks, history, inbox, approve`(stubbed)`, schedule, skills, gaps, debug, feedback, self_modify, prompts, observe`.

### 9d. NEW events — **[BACKEND HOOK]** (daemon → UI)
**Lane A live (Wave 1):** `agent_activity` (the envelope §9f, REQUIRED) · `agent_status{text}` · `agent_plan{steps:[{step,status}]}` · `agent_delta{text}`.
**Lane B background sub-agents — ⚠️ SHIPPED with different names (see §17, authoritative):** actual events are `task_spawned · task_tool · task_progress · task_done · task_failed · task_cancelled · task_report` + the `agent_activity` (`lane:"B"`) tree (carries `parentRunId`/`depth`). Approvals are `approval_request`/`approval_inboxed` + WS `approve`/`deny`→`approval_resolved`. (The `agent_subagent_*`/`delivery` names were the original proposal — **not used**.)
**Tasks/scheduled (Wave 3):** `task_update{task_id,status,description,origin,priority,started_at,completed_at?,cost_cents,tick_count,result_summary?}` · `schedule_changed/fired{…}`.
**Always-on / voice (Wave 1–3):** `listening_mode{mode}` · `listening_state{state:dormant|ambient|roused|directed}` · `wake_detected{}` · `mic_level{level}` · `mute_state{muted}`.
**Trust/proactive/mgmt (Wave 3):** `approval_pending{item_id,kind,tier,title,args_preview,reasoning,diff?,skill?}` (`kind∈action|source_patch|staged_skill`) · `approval_resolved{item_id,decision}` · `proactive{item_id,mode,text,priority,cost_cents?}` (bridge proactive `EventBus`→broadcast via the `replaceBus` publish→broadcast pattern at `index.ts:1599-1601`; *not* `:1326`, which is the reactive-evaluator subscription) · `skill_staged{…}` · `onboarding_step{step,total,title,status,prompt?}` · `pause_state{paused,until?}` · `watching{active}` · `connection_changed{toolkit,status}` · `standing_order_fired{slug,summary}` · `cost{costCents,costBudget}`.

### 9e. NEW commands — **[BACKEND HOOK]** (UI → daemon, via `wrapApi.onCommand`)
`approve{item_id,scope}` · `deny{item_id}` · `skill_approve/skill_discard{skill_id}` · `feedback{item_id,signal}` · `set_pause{paused,until?}` · `set_quiet_hours{ranges}` · `set_listening_mode{mode:push_to_talk|always_on|toggle}` · `set_mute{muted}` · `onboarding_response{step,value}` · `cancel_task{task_id}` · `pause_schedule{schedule_id,paused}` · `forget_fact{fact_id}` · `utterance_text{text,conversationId?}` *(or reuse `test_inject_utterance`)*.

### 9f. The `agent_activity` envelope (REQUIRED, both lanes)
```
agent_activity {
  runId: string          // stable per runAgentLoop invocation (replace conductor.ts:311 `t${i}` renumbering)
  parentRunId: string|null
  depth: number          // 0 root, +1 per spawn, hard-capped (~10)
  lane: "A"|"B"          // foreground vs background
  conversationId: string
  tier: "fast"|"smart"|"deep"|"vision"
  kind: string           // planning|agent_delta|tool_call|tool_done|tool_failed|plan_update|compaction|subagent_start|subagent_done|final|status
  status?: "running"|"done"|"failed"
  tool?: string; args?: any; summary?: string
  ts: number
}
```
Delivery: add `runId/parentRunId/depth/lane` to `LoopEvent`+`AgentLoopResult`; thread `deps.onEvent` through `defaultPlannerRunner` **and** the recursive `spawn_subagent` call (tag with `runId/parentRunId`); merge `LoopEvent`+`AgentEvent` into the envelope before `broadcast` (rename `LoopEvent.assistant_delta`→`agent_delta`, the name the UI listens for, `App.tsx:28`). In-process sub-agents are ephemeral — lineage lives in the event stream (no new DB lineage column needed for the live tree; the `tasks` store handles Lane B persistence per §3).

---

## 10. Backend hook checklist

| # | Hook | Type | Where | Wave | Lane |
|---|---|---|---|---|---|
| 1 | thread `runAgentLoop` `onEvent` through `defaultPlannerRunner` (dropped today) | wiring | `conductor.ts:287` | **1** | A |
| 2 | add `runId/parentRunId/depth/lane` to `LoopEvent`+`AgentLoopResult`; stop `t${i}` renumber (`conductor.ts:311`) | types | `loop/types.ts`,`conductor.ts` | **1** | A/B |
| 3 | merge Loop+Agent → `agent_activity` envelope before `broadcast` | wiring | `conductor.ts`,`index.ts:2096` | **1** | A/B |
| 4 | `buildSpawnSubagentTool` (recursive/detached `runAgentLoop`, depth-cap, re-tag) + `agent_subagent_*` | feature | `loop/`,`conductor.ts:285`,`types.ts` | **1–3** | B |
| 5 | `agent_status{text}` emit (union member exists, no producer) | event | conductor/narrator | 1 | A |
| 6 | wire `update_plan` `onPlan` → `agent_plan{steps}` (add `agent_plan` to **AgentEvent** union; `LoopEvent.plan_update` exists) | event | `updatePlanTool.ts`,`conductor.ts` | 1 | A |
| 7 | `agent_delta{text}` (from threaded `onEvent`) | event | `conductor.ts` | 1 | A |
| 8 | `delivery{…}` card on Lane B completion (DeliveryRouter) | event | DeliveryRouter, `taskRunner` store | 3 | B |
| 9 | `task_update`/`schedule_*` + `cancel_task`/`pause_schedule` | event+cmd | `taskRunner.ts`,`scheduleManager.ts` | 3 | B |
| 10 | `approval_pending/resolved` + `approve`/`deny` (replace stubbed `kairos_approve`); incl. `source_patch`+`staged_skill` | event+cmd | `agency/actionExecutor.ts`,`agency/inboxSurface.ts`,shim self-modify,`index.ts:2242` | 3 | — |
| 11 | bridge proactive `EventBus`→`proactive{…}`; `feedback`; `kairos_inbox` peek; `kairos_observe` act/dismiss | event+cmd | `proactive/narrator.ts`,`index.ts:1599-1601`,`feedbackCollector.ts` | 3 | — |
| 12 | `onboarding_step` + `onboarding_response` | event+cmd | `onboarding/setupFlowRuntime.ts`,`persona/soulWizard.ts` | 3 | — |
| 13 | `pause_state`/`watching` + `set_pause`/`set_quiet_hours` | event+cmd | restraint pause, observers | 3 | — |
| 14 | `skill_staged` + `skill_approve/discard` | event+cmd | `skills/reviewQueue.ts`,`skillWriter.ts` | 3 | — |
| 15 | memory facts read + `forget_fact`; persona read | read+cmd | memory/`forgetDetector`,`personaAwareness` | 3 | — |
| 16 | `cost`; `connection_changed`; `standing_order_fired`; `utterance_text` (or confirm `test_inject_utterance`) | event/cmd | `budgets.ts`,`connectors/*`,`orders/v2/reactiveEvaluator.ts`,`index.ts:2242` | 2–3 | — |
| **17** | **continuous mic capture** (always-on) — keep mic open; decide owner (§4.4) | feature | mic owner (HUD / sidecar / renderer) | 1–3 | — |
| **18** | **wake-word engine** ("hey kairos") | feature | HUD Swift / sidecar / renderer | 3 | — |
| **19** | **VAD+EOU turn segmentation** (the planned E.4 continuous mode) | feature | mic owner + `voice/` | 3 | — |
| **20** | `listening_mode`/`listening_state`/`wake_detected`/`mic_level`/`mute_state` events; `set_listening_mode`/`set_mute` cmds; extend `SidecarCmd.mode`→`always_on` | event+cmd | `voice/types.ts:20`,`voiceConductor.ts`,`index.ts:2242` | 1–3 | — |
| 21 | *(optional)* addressing classifier ("is this for KAIROS") | feature | post-STT | 3 | — |
| — | *(Plane-2 legacy, optional)* `claude -p --output-format stream-json` per-task timeline — only if any background work still uses `claude -p` | event+db | `taskRunner.ts`,`db.ts:78` | 3 | B |

**Wave-1 critical:** #1–#7 (+#16 utterance_text). Always-on basics (#17/#20) are Wave-1 *if* you want always-on early; full wake-word/EOU (#18/#19) are Wave 3.

---

## 11. Build waves (revised 2026-06-04 — most live-plane hooks SHIPPED)
| Wave | Surfaces | Backend status |
|---|---|---|
| **1 — now FULLY WIREABLE** | Orb (idle/listening/thinking/speaking/error) + captions (`agent_delta`/`stt_*`) + status line (`agent_status`) + text-input; **Lane A live activity tree** (`agent_activity`); **Lane B persistent satellites** (`task_*`, nested via `agent_activity` lane:B); **background-approval card** (`approval_request`→`approve`/`deny`→`approval_resolved`); `MockDriver` as fallback | **all events LIVE** — build wired, not mocked |
| **2** | Integrations+Discord (6.8), standing-orders (6.9), skills list (6.10), Tasks board read (`background_tasks`/6.3), status/cost (6.14) | HTTP/MCP reads exist today |
| **3** | Proactive pulse/inbox/observe (6.6), memory (6.11), persona (6.12), self-modify + staged-skill **unified** approvals (6.5), privacy/pause (6.13), push events (cost/connection/order-fired) | needs hooks #11–#16 + unify #10 names |
| **3.5 / later** | **Always-on** (wake-word, VAD+EOU, `dormant`/`roused`/`muted` orb states, `mic_level` listening ripple, hard-mute) + **onboarding wiring** (SoulWizard not yet run on first launch — backend gap) | **not built backend-side** (#17–#21); PTT only today |
| **4** | Pointer overlay + cursor bubble (6.16) | large — computer-use plane (Phase H) |

> **Wave-1 orb caveat:** the always-on-only states (`dormant`/`roused`/`muted`) and a mic-driven *listening* ripple need always-on events that don't exist yet — so Wave-1 ships the **idle/listening/thinking/speaking/error** states; *listening* uses a generic ripple, *speaking* uses `tts_chunk` RMS (client-side, no hook). The dormant/roused/muted states light up when always-on (3.5) lands.

## 12. Dev workflow
`bun run daemon` (Terminal 1) + `cd apps/macos/KairosHUD && swift run` (live) / `swift run KairosHUD --mock` (daemon-free: nested Lane A/B tree + always-on state cycling). SwiftPM + CLT (install Xcode 26 for `.glassEffect`/Metal — §15-Q1).

## 13. Risks
No Xcode → `.glassEffect`/Metal may be unavailable (degrade to `NSVisualEffectView`/Core Animation) **even on Tahoe** until Xcode 26 installed; SwiftUI-via-SwiftPM else AppKit fallback for the orb; always-on mic privacy + battery; wake-word false-accepts; no-notch Macs → top-center; `loop/` is untracked/moving — verify refs.

## 14. Decisions locked
- Native Swift `NSPanel` HUD sidecar (amends Architecture A). **Tahoe Liquid Glass primary.**
- **Two lanes:** A foreground voice (live tree) · B background sub-agents = **detached `runAgentLoop`, not `claude -p`**, status-stored + DeliveryRouter card. One `agent_activity` envelope (required).
- **Always-on + push-to-talk, switchable**, with first-class privacy (mic-live indicator + hard-mute).
- Sub-agent viz: hybrid + nesting (Lane A inner orbit, Lane B persistent satellites → timeline tree).
- Notch-docked; full UI coverage, minimal aesthetic; ~6 internals invisible (§6.Z).
- Waves 1→4 as above.

---

## 15. Questions for the backend session — **please answer inline (`ANSWER:`)**

These shape the UI contract. Answer what you can; flag anything the code already decides.

### A. Lanes & sub-agents (Batch 2)  *(Batch 2 is SHIPPED + hardened + audited 2026-06-02/03)*
- **Q1.** What are the **"four genuine forks"**? — **ANSWER:** The four locked Batch-2 design forks: **(1) Brain** = our own in-process `runAgentLoop` (deep model), not `claude -p`; **(2) Tool scope** = the full foreground toolset **+ gated shell/file exec** (`read_file`/`list_dir`/`write_file`/`run_shell`); **(3) Approval** = pause-the-agent on destructive/mutating calls (zero-token park), resolve by voice now or inbox later; **(4) Promotion** = auto (model calls the tool when work is heavy) **+** explicit ("do X in the background"). All four implemented.
- **Q2.** Parallel/sequential? caps? — **ANSWER:** **Both.** Fire-and-forget non-blocking spawn → parallel fan-out, also chainable sequentially. `maxConcurrent`=3 (`KAIROS_BG_MAX_CONCURRENT`), `maxDepth`=2 (`KAIROS_BG_MAX_DEPTH`). Over-cap spawn returns `{accepted:false, reason:"at capacity…"}`; over-depth returns `{accepted:false, reason:"spawn depth limit reached"}`.
- **Q3.** Trigger? — **ANSWER:** A **`spawn_background_task`** tool (NOT `spawn_subagent`) in the foreground toolset, plus **`background_tasks`** (the check-in tool). The smart/deep model calls it when work is heavy, or when the user says "in the background" / "keep talking while you do it." **Yes, voice spawn works today.** Proactive spawn is possible (`manager.spawn()`) but not yet wired to a proactive source.
- **Q4.** Reuse the `tasks` table? — **⚠️ ANSWER (CORRECTION):** **No.** Lane B is tracked **in-memory** by `BackgroundAgentManager` (`Map<id, BgTask>`, bounded retention `KEEP_TERMINAL=24`). `BgTask = {id, goal, status(running|done|failed|blocked|cancelled), lastActivity, toolsUsed, summary, error, depth, startedAt, endedAt}`. **No DB table, no `parent_run_id` column.** Lineage + live state live in the **WS event stream** + the `background_tasks` tool. (The `tasks` table is the *legacy* `claude -p` taskRunner — a different, older path. The doc body §3/§6.3 conflates them; see §16.)
- **Q5.** Stream LoopEvents live? — **ANSWER:** Live **per-tool + progress** events, not a full token stream. The manager maps the sub-agent's `LoopEvent`s → `task_tool{id,tool}` (each tool start) and updates `lastActivity` (delta flashes), then `task_done{summary}` / `task_failed{error}`. The foreground reads live status via `background_tasks` (→ `{goal,status,doing,tools_used,summary}`). Full token streaming for Lane B isn't implemented (the per-tool events already drive live satellites). **Drive Lane B satellites from `task_*`.**
- **Q6.** Adopt `agent_activity` envelope for both lanes? — **ANSWER:** Agreed as the **target**, **not yet built.** Today Lane A emits flat `agent_*` (live) and Lane B emits `task_*`. Unifying needs hooks #1–#3 (runId/parentRunId/depth/lane). I'll support it; until then render Lane A from `agent_*`, Lane B from `task_*`.
- **Q7.** Delivery card payload? — **ANSWER:** Today `task_report{id(=runId), goal, summary}` + `task_done{id, summary}` on completion (also spoken). Success/fail = `task_done` vs `task_failed{error}`. Artifacts/followups not produced yet — easy to add. So current fields: `{runId, goal, summary, success}`.
- **Q8.** Block mid-run for approval + resume? — **ANSWER:** **Yes — built.** A sub-agent blocks on any destructive/mutating tool via the `ApprovalGate` (zero-token park) and resumes on approve. Events: **`approval_request{id,summary,toolName}`** (spoken at once) → if unanswered in the voice window, **`approval_inboxed{id,summary}`**. Resolve: voice ("yes"/"no", or name the action) today; programmatic via `globalThis.__kairosResolveBgApproval(reqId, approved)`. The WS `approve{item_id}` → that resolver is hook #10 (UI wiring pending). **Note the event is `approval_request`, not `approval_pending`.**
- **Q9.** Auto-promote to Lane B? — **ANSWER:** The promotion *is* the model calling `spawn_background_task` (driven by an OFFLOAD prompt rule or explicit user ask). When it does, **`task_spawned{id, goal}`** fires during the foreground turn — animate "moved to background" on that. No separate mid-turn auto-detach signal.

### B. Always-on & voice  *(NOTE: always-on is NOT built — current system is PTT-only. Answers below are state-of-today + backend recommendations; these decisions are open and lower-priority than the agent work that's shipped.)*
- **Q10.** Which always-on model? — **ANSWER:** **Both, selectable.** Wake-word to rouse from dormant + open-mic hands-free *within* an active session. Default off (PTT). Not built yet.
- **Q11.** Wake-word engine + location? — **ANSWER:** Recommend **openWakeWord** (or Porcupine) running in the **HUD Swift app** (the always-running native surface). Custom phrase "hey kairos". Open / not built.
- **Q12.** Addressing classifier? — **ANSWER:** Defer. Wake-word is sufficient for v1; an addressing classifier is a nice-to-have for noisy hands-free rooms — add later if false-triggers hurt.
- **Q13.** EOU/turn segmentation? — **ANSWER:** Components **exist**: Silero VAD is already used (barge-in) and an EOU model lives in the voice stack (`src/daemon/voice/`, EOU download-on-first-run). They'd need wiring into a continuous-capture loop for E.4. Runs in the mic owner.
- **Q14.** Default mode for new users? — **ANSWER:** **Push-to-talk** (privacy-first). Offer always-on in onboarding with explicit consent + the mic-live/mute explainer.
- **Q15.** Silence timeout → dormant? — **ANSWER:** ~10s default (configurable). Tune in testing.

### C. Mic ownership & listening events
- **Q16.** Where should the always-on mic live? — **ANSWER:** Backend-agnostic; recommend the **KairosHUD Swift app** (always-running native surface). Current options are renderer (`KAIROS_MIC=renderer`, needs cloud STT) or the `KairosVoiceHelper` sidecar — both feed the daemon over WS today.
- **Q17.** Retire/merge `KairosVoiceHelper`? — **ANSWER:** If the HUD owns the mic, yes — `KairosVoiceHelper` can be retired/merged; the daemon only needs audio-in via WS (`utterance_audio`) or STT events, it doesn't care which native process produces them. If the sidecar keeps the mic, the HUD stays display-only — both are fine. Your call.
- **Q18.** OK to add the listening events/commands + `SidecarCmd.mode`→`always_on`? — **ANSWER:** **Yes, no objection.** New daemon→UI events are one `broadcast()` away (the `{event:e.kind,...e}` bridge), and UI→daemon commands route through `wrapApi.onCommand`. Extending `SidecarCmd.mode` is fine.

### D. Build / platform (Tahoe)
- **Q19.** Install Xcode 26? — **ANSWER:** Backend-agnostic — the daemon doesn't care. Your call on the orb ceiling: Xcode 26 → true `.glassEffect` + Metal orb; CLT → `NSVisualEffectView` + Core-Animation degrade. Recommend Xcode 26 if the visual bar matters.
- **Q20.** SwiftPM layout objection? — **ANSWER:** None. `apps/macos/KairosHUD/` SwiftPM is fine.

### E. Tiers, deep, routing
- **Q21.** Does `deep` get its own model / auto-spawn Lane B? — **ANSWER (UPDATE):** **deep is a real, distinct model now** — `moonshotai/kimi-k2-thinking` by default (`KAIROS_DEEP_MODEL`; the user's `.env` currently points it at `minimax/minimax-m3`). It is the model **Lane B sub-agents run on**, and a deep-tier *foreground* turn uses it too. It does **not** auto-spawn Lane B — spawning is always via the `spawn_background_task` tool. So satellites appear on **`task_spawned`**, not on deep-tier per se. (Doc's "defined-but-unused" is outdated.)
- **Q22.** Show the tier glyph? — **ANSWER:** Yes — a subtle fast/smart/deep/vision glyph from `agent_intent{tier}` is good (this is the one classifier signal worth surfacing; the rest stays invisible per §6.Z).

### F. Wave-1 hooks & timing
- **Q23.** Commit to Wave-1 hooks #1–#7? — **ANSWER:** **#1 is effectively already done** — the conductor threads `runAgentLoop`'s `onEvent` and emits `agent_tool_call`/`agent_tool_done`/`agent_tool_failed` **live during the turn** (`conductor.ts:212-214`), broadcast via the bridge. Still TODO: the unified `agent_activity` envelope + `runId/parentRunId/depth/lane` (#2/#3), `agent_status` + `agent_plan` producers (#5/#6), and `agent_delta` token-stream to the WS (#7 — deltas currently go to the *speaker*, not the WS). I can deliver #2/#3/#5/#6/#7 as a focused "UI-hooks" batch on your go — no committed date yet, but they're small/contained.
- **Q24.** Bridge still intact? — **ANSWER:** **Confirmed intact.** `wrapApi.broadcast({event:e.kind,...e})` now lives at **`index.ts:2262`** (moved from `:2096` after the Batch 2 + filler work — functionally identical). Live `agent_tool_*` ARE emitted during the turn.

### G. Surfaces, onboarding, misc
- **Q25.** Onboarding voice vs visual? — **ANSWER:** Voice-first, orb-led. The `SoulWizard` (5 questions → `soul.md`, `persona/soulWizard.ts`) **exists but is NOT wired to run on first launch** (nothing collects the answers yet — known gap, high-priority). Recommend: voice turns drive the wizard via the normal loop, calling `SoulWizard.compose(answers)`; visual = progress dots only; add a wake-word enrollment step **iff** always-on is chosen.
- **Q26.** Self-modify diffs + staged skills via `approval_pending`? — **ANSWER:** Both exist (`kairos_self_modify`; staged skills via `reviewQueue`/`PersonaGate`) but do **not yet** route through a unified `approval_pending` WS event — that's hooks #10/#14. Agreed as the target shape (`kind∈action|source_patch|staged_skill`). Note the *background-action* approval today fires `approval_request`/`approval_inboxed` (Batch 2) — unify these names when we build #10.
- **Q27.** Retire `apps/electron/`? — **ANSWER:** Electron was already retired for the Swift NSPanel HUD (per the UI-system decision); the daemon has **no** Electron dependency. Safe to retire once the Swift HUD lands; keep short-term as a fallback if you want.
- **Q28.** Anything the code contradicts / add-cut? — **ANSWER:** Yes — see the new **§16 Backend reconciliation** for the full list. The big ones: Lane B is **in-memory, not the `tasks` table**; the tool is **`spawn_background_task`/`background_tasks`** (not `spawn_subagent`); Lane B events are **`task_*`** (not `agent_subagent_*`); approval events are **`approval_request`/`approval_inboxed`** (resolver `__kairosResolveBgApproval`); **deep model is live**. Surface to ADD: a cheap **"what's it doing?" check-in** already exists in the backend (`background_tasks` tool) — the UI can expose live sub-agent status for free. Nothing else in the spec is contradicted by the code.

---

## 16. Backend reconciliation (answers from the backend session, 2026-06-03)

The backend session has **answered all of §15 inline above**. This section consolidates the **factual corrections** the UI session should apply to the body of this doc, because parts of §3/§6.3/§9d/§10 were written before Batch 2 shipped. **Batch 2 (the background sub-agent lane) is SHIPPED, hardened (22-finding adversarial audit), and live-verified.**

### 16.1 Lane B is in-memory — NOT the `tasks` table
- `BackgroundAgentManager` (`src/daemon/agents/loop/backgroundAgentManager.ts`) holds sub-agents in a `Map<id, BgTask>` with bounded retention (`KEEP_TERMINAL=24`). **There is no DB table, no `parent_run_id`/`depth`/`lane` columns.** The `tasks` table belongs to the *legacy* `claude -p` taskRunner (a separate, older path that Batch 2 does NOT use).
- **UI impact:** source Lane B from the **WS `task_*` events** + the **`background_tasks`** tool/MCP, not from a DB read. The §3 "reuses TaskRunner's status store (the tasks table)" line and §6.3's "from `kairos_tasks`/`kairos_status`" are **wrong for Lane B sub-agents** (still correct for legacy scheduled/cron tasks). Treat them as two sources unified in the UI, tagged by origin — but Lane-B-sub-agent rows come from `task_*`, scheduled rows come from the tasks store.

### 16.2 Real names (use these in the UI)
| Doc said | Actual backend |
|---|---|
| `spawn_subagent` tool | **`spawn_background_task`** (+ **`background_tasks`** check-in tool) |
| `agent_subagent_start/done/failed` | **`task_spawned{id,goal}` · `task_tool{id,tool}` · `task_progress{id,note}` · `task_done{id,summary}` · `task_failed{id,error}` · `task_cancelled{id}` · `task_report{id,goal,summary}`** |
| `approval_pending{...}` | **`approval_request{id,summary,toolName}`** (spoken at once) → **`approval_inboxed{id,summary}`** (after the voice window) |
| `approve{item_id}` → resolves | currently `globalThis.__kairosResolveBgApproval(reqId, approved)` (inbox item carries `intent_id: bg_approval:<reqId>`); **WS `approve` command → that resolver is hook #10, not yet wired** |
| deep = `kimi-k2-thinking` "defined-but-unused" | deep **is live** — `KAIROS_DEEP_MODEL` (default `moonshotai/kimi-k2-thinking`; user's env → `minimax/minimax-m3`); it's the **Lane B sub-agent model** |

### 16.3 What's already DONE (more than the doc assumes)
- **Lane B blocking-approval** (pause at zero token cost, resume on approve) — shipped.
- **Context parity** — sub-agents inherit the foreground conversation + fresh memory delta (a `setActiveConversation`→`conversationId` thread).
- **Self-evolving-skills feed** — sub-agent trajectories → persona TrajWriter → AwmWorker (`intent_id:'subagent'`), thresholds met.
- **Live check-in** — `background_tasks` returns `{goal, status, doing, tools_used, summary}` so the foreground answers "how's my task going?" in plain language; the UI can show the same live status for free.
- **Sub-agent has real execution tools** — `read_file/list_dir/write_file/run_shell` (sandboxed to a per-agent scratch dir today; "work in the user's project dir" is a proposed, approval-gated enhancement) + all Composio tools + skills + memory.
- **Data-aware voice fillers** (2026-06-03) — acks now say "Okay, sending that email to Sam now" / "opening Gmail now — one sec" / "pulling up your Linear issues", derived from the real tool+args; long waits get "still on your issues" instead of silence. (Affects captions/`tts_*` timing only — no UI contract change.)

### 16.4 Hook status deltas (vs §10 checklist)
- **#1 (thread `onEvent`)** — effectively **done** for Lane A tool events (live `agent_tool_*` during the turn, `conductor.ts:212-214`). The remaining envelope work (#2/#3) and `agent_status`/`agent_plan`/`agent_delta` producers (#5/#6/#7) are still open and small.
- **#24 bridge** — intact at **`index.ts:2262`** (moved from `:2096`).
- **#10 approval** — the background half is built (gate + `__kairosResolveBgApproval`); only the WS-command wiring + name-unification remain.

### 16.5 NEW this session (2026-06-04) — affects the UI surface
- **`task_progress{id, note}` is now LIVE** (was declared-but-dormant). A background sub-agent that uses `update_plan` now emits a human **"step 3 of 4: drafting the summary"** note — the UI satellite/Tasks row can show real plan progress, and the check-in already speaks it. (Lane A plan steps are NOT yet on the WS — that's hook #6.)
- **Nested sub-agents are REAL now** (R5 `run_subtask`): a Lane B sub-agent can fan out worker sub-agents (depth+1) and synthesize. So the §6.3/§7 "sub-satellite (depth)" tree is backed by actual nested `task_spawned` events. **CAVEAT:** the `task_*` events do NOT yet carry `parentRunId`/`depth`, so the UI **cannot reconstruct the nesting from the event stream yet** — building the parent-linked tree needs the `agent_activity` envelope (hooks #2/#3) or, minimally, adding `parentRunId`+`depth` to `task_spawned`.
- **Data-aware fillers** shipped — affects caption/`tts_*` timing only, no contract change.

### 16.6 What the UI can consume TODAY vs what the live TREE still needs
**Live now (WS):** Lane A — `agent_intent` · `agent_planning` · `agent_tool_call/done/failed` · `agent_done` · `agent_interrupted` · `agent_error` + voice (`tts_*`/`stt_*`/`listening_*`). Lane B — `task_spawned` · `task_tool` · `task_progress` · `task_done` · `task_failed` · `task_cancelled` · `task_report` + `approval_request`/`approval_inboxed`. Reads — all the §9c HTTP/MCP.

### 16.7 UI-hooks batch — **SHIPPED 2026-06-04** (the unified live tree is now real)
Hooks #2/#3/#5/#6/#7 are **done**. The backend now emits, ALONGSIDE the flat events:
- **`agent_activity`** — the unified tree envelope, **wrapped**: WS message is `{ event: "agent_activity", activity: { runId, parentRunId, depth, lane:"A"|"B", conversationId?, tier?, kind, status?, tool?, summary?, ts } }`. (Wrapped under `activity` to avoid colliding with the message's own `event`/`kind` discriminant — read `msg.activity`.) `kind` ∈ `planning | tool_call | tool_done | tool_failed | plan_update | compaction | subagent_start | final`.
- **Lineage**: the foreground turn is the root (`lane:"A"`, `depth:0`, `parentRunId:null`, a per-turn `runId`). A top-level background sub-agent links to that turn (`parentRunId = turn runId`). A nested R5 `run_subtask` worker links to its parent sub-agent (`parentRunId = parent runId`, `depth+1`). **So the UI reconstructs the full nested tree purely from `parentRunId`.**
- **`agent_delta{text}`** — foreground token stream (captions). **`agent_plan{steps}`** — Lane A plan checklist. **`agent_status{text}`** — human status line ("Working on your emails").
- Lane B continues to emit the flat `task_*` for the simpler satellite/Tasks views; both are kept.

**Build the tree from `agent_activity` (group by `runId`, nest by `parentRunId`); use `agent_delta` for the live caption, `agent_plan`/`task_progress` for the checklist, `agent_status` for the status line.**

### 16.8 WS approve/deny — **SHIPPED 2026-06-04** (hook #10 UI half)
The HUD/inbox can now resolve a parked background-agent destructive approval over the WS (no longer voice-only):
- **Command:** `{ cmd: "approve" | "deny", item_id }` via the WS command channel. `item_id` is the gate req.id from an `approval_request` event, OR the inbox `intent_id` (`bg_approval:<id>`) — both accepted (prefix stripped).
- **Reply:** broadcasts `{ event: "approval_resolved", item_id, decision: "approved"|"denied", matched }`. `matched:false` means no such pending approval (already resolved / wrong id) — clear the card either way.
- Effect: the parked sub-agent (zero token cost) resumes and runs the action on approve, or skips it on deny — verified by the by-id resolve test + the live WS smoke.
- Still open (on request): the always-on voice hooks (#17–#22); a `scope:"task"` ("approve all for this run") variant (today every approval is approve-once, which composes with R1's per-run approved-root design).

---

## 17. Authoritative build contract — verified wire shapes (UI session, independently verified 2026-06-04)

This supersedes §9d/§9f and any body text where they differ. **This is exactly what `Sources/KairosHUD/Transport/Protocol.swift` encodes.** All shapes confirmed against the daemon source.

**Two representations are on the wire at once — the UI uses both:**
- **Flat events** (simple live signals) — broadcast as `{ event: <kind>, kind: <kind>, ...payload }` (bridge `wrapApi.broadcast({event:e.kind,...e})`, `index.ts:2262/2274`; `event` == `kind`). Decode on `event`.
- **`agent_activity`** (the nested tree) — `{ event:"agent_activity", activity:{ runId, parentRunId, depth, lane:"A"|"B", conversationId?, tier?, kind, status?, tool?, summary?, ts } }`. **Read `msg.activity`.** `kind ∈ planning | plan_update | compaction | tool_call | tool_done | tool_failed | subagent_start` (turn completion arrives via the flat `agent_done`). **Build the tree:** group by `runId`, nest by `parentRunId` — root = the foreground turn (`lane:"A"`, `depth:0`, `parentRunId:null`); top-level background sub-agents have `parentRunId` = the turn's `runId`; nested (R5 `run_subtask`) workers have `parentRunId` = parent sub-agent + `depth+1`.

**Lane A (foreground) — flat, LIVE during the turn**
`agent_intent {tier,reason}` · `agent_planning {tier}` · `agent_tool_call {id,name,args}` · `agent_tool_done {id,name,result_summary}` · `agent_tool_failed {id,name,error}` · `agent_done {text}` · `agent_interrupted {}` · `agent_error {message}` · `agent_delta {text}` (→ caption) · `agent_plan {steps:[{step,status}]}` · `agent_status {text}`.

**Lane B (background sub-agents) — flat, LIVE**
`task_spawned {id,goal}` · `task_tool {id,tool}` · `task_progress {id,note}` · `task_done {id,summary}` · `task_failed {id,error}` · `task_cancelled {id}` · `task_report {id,goal,summary}`. *(Nesting/lineage for these comes from the `agent_activity` `lane:"B"` stream — the flat `task_*` do not carry `parentRunId`/`depth`.)*

**Approvals (background destructive-action gate) — LIVE**
- in: `approval_request {id,summary,toolName}` (spoken immediately) → `approval_inboxed {id,summary}` (after the voice window).
- out: `{ cmd:"approve"|"deny", item_id }` — `item_id` accepts the gate id **or** `bg_approval:<id>`.
- ack: `approval_resolved {item_id, decision:"approved"|"denied", matched:bool}` (`matched:false` ⇒ already resolved/unknown id — clear the card regardless).

**Voice/TTS — unchanged**
`tts_begin {speakId,sampleRate}` · `tts_chunk {speakId,pcm}` (base64 s16le 24kHz mono) · `tts_end {speakId}` · `tts_abort {speakId}` · `stt_partial {text,confidence}` · `stt_final {text,confidence}` · `listening_started {}` · `listening_stopped {}` · `subscribed {clients}`.

**Commands — unchanged**
`test_inject_utterance {text,conversationId?}` · `utterance_audio {wavBase64,conversationId?}` · `barge_in {}`.

**NOT yet on the wire (later waves)** — always-on (`listening_mode`/`listening_state`/`wake_detected`/`mic_level`/`mute_state` + `set_listening_mode`/`set_mute`); `proactive`/`cost`/`connection_changed`/`standing_order_fired` push (poll HTTP/MCP for now); `onboarding_step`/`onboarding_response` (SoulWizard not wired to first launch); self-modify/staged-skill via a *unified* `approval_pending` (only the background gate is unified so far).

**Backend facts (context, not Codable):** Lane B = in-memory `BackgroundAgentManager` `Map<id,{task:BgTask,controller}>`; `BgTask {id,goal,status:"running"|"done"|"failed"|"blocked"|"cancelled",lastActivity?,toolsUsed,summary?,error?,depth,parentRunId?,startedAt,endedAt?}`; caps `KAIROS_BG_MAX_CONCURRENT=3` / `KAIROS_BG_MAX_DEPTH=2` (over-cap ⇒ `{accepted:false,reason}`); tools `spawn_background_task` + `background_tasks` (→ `{tasks:[{goal,status,doing?,tools_used,summary?,error?}],note?}`); deep model `KAIROS_DEEP_MODEL=moonshotai/kimi-k2-thinking` runs Lane B.
