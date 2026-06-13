# 10 — Master file-by-file refactor map (2026-06-12)

The execution checklist for the Codex-brain migration. Every KAIROS file that
changes, what changes, and why — grouped by subsystem, with a status tag, then a
"what we delete/retire" section and a dependency-ordered build sequence an
engineer follows top-to-bottom.

Cross-refs: 01 (Codex brain), 02 (proxy), 03 (guidance overlay), 04 (notch/agents),
05 (backend changes), 07 (open questions). Read those for the *why* in depth; this
file is the *what-to-touch*.

## Status legend

| Tag | Meaning |
|---|---|
| **NEW** | New file/dir to create. |
| **REPLACE** | Codex owns this behavior now for smart/deep; the old code path is bypassed when `KAIROS_BRAIN=codex` (but most "replaced" code is kept as the flagged fallback — see "What we retire"). |
| **PORT** | Reimplement the same behavior on top of Codex's event stream (e.g. the verifier gate). The logic survives; the wiring changes. |
| **EXTEND** | Additive change to an existing file; old callers keep working. |
| **KEEP** | Unchanged — listed so the engineer knows NOT to touch it (and why it's safe). |

## House decisions baked into this map (confirmed by Nirmal)

- **Fast tier stays ours** (no agent loop) — `handleFast` and `frontFlow.answer_now`
  are KEEP, untouched.
- **Smart `[[task]]` + deep `[[think]]` become Codex** app-server, **same model,
  different reasoning effort per turn** (`effort` passed on `turn/start`, NOT
  per-profile — confirmed first-class in the research; see §Conductor below).
- **Models via OpenRouter through a hidden proxy + a SEPARATE dedicated key**
  (`KAIROS_BRAIN_KEY`). Proxy runs **locally now, hosted later** — same `fetch`
  handler.
- **Codex is VENDORED/built like a product** (pinned binary + arch-dispatch shim),
  NOT the user's homebrew codex; homebrew only in dev.
- **Robot-face comet + rectangle highlight stay**; guidance gets seamless +
  arrows + scroll + region affordances (Clicky-style, not identical, keep our
  warm-gold→cyan material, not Clicky's flat red).
- **Proactive features coming soon** — leave hooks, re-route `WORK` through Codex
  now so the proactive lane doesn't diverge from voice (see §Daemon wiring).
- **Preserve KAIROS memory + self-learning + Composio auto-connect** — all KEEP
  or EXTEND; nothing in those subsystems is replaced.

---

## 1) Conductor / agent loop

The injectable `runPlanner` dep is the swap seam: `Conductor` uses
`this.deps.runPlanner ?? defaultPlannerRunner` (conductor.ts:663). A `CodexBrain`
PlannerRunner that emits the SAME `LoopEvent` shapes plugs in with zero downstream
changes — the `onEvent` mapper (conductor.ts:624–651) and the WS broadcast
(index.ts:2494) are untouched.

| File | Status | Change | Why |
|---|---|---|---|
| `src/daemon/agents/codexBrain.ts` | **NEW** | The warm `codex app-server` JSON-RPC child + the `CodexBrain` PlannerRunner. Spawn via `Bun.spawn(['codex','app-server','--listen','stdio://','-c','approval_policy=never','-c','sandbox_mode=danger-full-access'])`, isolated `CODEX_HOME=state/codex/home`, PATH-prepend vendored `rg`. newline-delimited JSON-RPC, `initialize`→`initialized`→`thread/start`→`turn/start`. Per conversation: one thread (`conversationId`→threadId map, reuse). Per turn: `turn/start { input, model, effort, instructions }` where `instructions` = `contextBuilder.build()` output. Translate `item/agentMessage/delta`→`assistant_delta`, `item/mcpToolCall`+`command/exec`→`tool_call_start/done/failed`, `turn/plan/updated`→`plan_update`, `turn/completed`→`final` (+ usage/`time_to_first_token_ms`). Barge-in→`turn/interrupt {threadId,turnId}`. Stale-exit restart guard; per-request timeouts (30s init/thread-start, 90s turn). | The single new agent module — mirrors openclicky `CodexProcessManager` + `CodexVoiceSession`/`CodexAgentSession`. The whole brain swap lives here. |
| `src/daemon/agents/codexProto/` (dir) | **NEW** | Vendored, pinned typed bindings: `codex app-server generate-ts --out src/daemon/agents/codexProto --experimental` output (`ClientRequest`, `ServerNotification`, `ServerRequest`, `TurnStartParams`, `ReasoningEffort`, `v2/*`). Regenerate ONLY on a codex version bump. | Typed JSON-RPC client; app-server is experimental so freeze bindings against the pinned binary. |
| `src/daemon/agents/conductor.ts` | **EXTEND** | Add the `KAIROS_BRAIN=codex` branch in `handleSmart` (574) and `handleThink` (321): when set + route in {task,think}, delegate to the `CodexBrain` runner via `deps.runPlanner`. Keep the SAME `onEvent`→controller→activity wiring (624–651), the SAME `appendTurn`/rolling-summary persistence (715), and the SAME `trajWriter.append` (134) so replay + self-learning are unaffected. Pass `effort` per turn from the tier (task→low/minimal, think→high/xhigh) — NOT a config profile. Preserve quiet-abort: on supersede emit `agent_interrupted`, never `agent_done`. | The routing fork. `handleFast` (546) stays untouched. `runPlanner` injection means no `handleSmart` rewrite. |
| `src/daemon/agents/loop/types.ts` | **KEEP** | The `LoopEvent` union (36–46) is the STABLE CONTRACT Codex must conform to. Do NOT add new kinds during the swap — map every Codex signal onto existing kinds. Document it as the frozen seam. | If the contract drifts, the HUD/TTS/activity-tree all break. The whole "zero downstream change" guarantee rests on this staying fixed. |
| `src/daemon/agents/loop/verifier.ts` | **PORT** | Run the deterministic verifier POST-TURN over `(utterance, finalText, toolCallLedger)` reconstructed from the Codex event stream — `buildDestructiveVerifier.verify` already takes exactly that tuple. On `retryable:true`, inject ONE `[automatic check …]` follow-up turn into the SAME codex thread (mirrors today's in-loop retry). Make `LOCAL_TOOLS` matching and the `startsWith('kairos_')` destructive check robust to MCP namespacing (strip `kairos__`/`kairos.` prefix in the ledger translator before feeding the verifier). | The anti-gaslighting stack (promissory/fabrication/do-mode/false-blindness/false-done) MUST survive the brain swap. It already runs post-turn on a tuple Codex provides — the only new work is the ledger translation + namespace strip. |
| `src/daemon/agents/loop/agentLoop.ts` | **KEEP (as fallback)** | Unchanged. Remains the `KAIROS_BRAIN!=codex` smart/deep path AND the background sub-agent loop. Do NOT delete (see "What we retire"). | The flag is a permanent fallback per 01.E; agentLoop owns tools/streaming/verify/compaction/maxTurns/replan today. |
| `src/daemon/agents/types.ts` | **KEEP** | The `ToolDef { name, description, parameters, execute }` shape (32–41) is reused verbatim by the new MCP server. No change. | Single source of truth for tool shape; the MCP server iterates it. |

**Smart-vs-deep effort handling (confirmed):** `ReasoningEffort` has six values
(`none/minimal/low/medium/high/xhigh`); both `model` and `effort` are overridable
PER TURN on `turn/start` (openclicky proves this in production — voice turns send
`effort:low`, agent turns keep the selected effort). So 01.B's `[profiles.smart]`/
`[profiles.deep]` config split is SUPERSEDED: keep ONE model, pass `effort` on each
`turn/start` from `CodexBrain`. Update 01.B accordingly (it currently shows
per-profile effort).

---

## 2) Tools / MCP exposure

KAIROS today has only MCP **client** code (`mcpHost`/`mcpClient` consume external
servers). There is NO MCP server exposing KAIROS's own tools — that is net-new.
The whole planner toolset is assembled in one closure: `actionTools` in
index.ts:1979–2074.

| File | Status | Change | Why |
|---|---|---|---|
| `src/daemon/index.ts:1979–2074` (`actionTools`) | **REPLACE→EXTRACT** | Extract the closure body into an exported pure `buildActionToolset(deps): ToolDef[]` where `deps` = the `__kairos*` singletons passed EXPLICITLY (not read off `globalThis`). The existing ContextBuilder loader and the new MCP server both consume this one function. | Guarantees the Codex brain and the legacy loop expose byte-identical tools; removes the hidden-global coupling that would make a child process toolless. |
| `src/daemon/mcp/kairosMcpServer.ts` | **NEW** | The KAIROS MCP server. Instantiate `@modelcontextprotocol/sdk` `McpServer`; for each `ToolDef` from `buildActionToolset` register a tool (name, description, JSON-Schema→Zod/json-schema-compat shim, callback→`ToolDef.execute`→`{content:[{type:'text',text}]}`). **CRITICAL: run IN-PROCESS with the daemon, not as a standalone `bun run` child** — the tools close over live singletons (`__kairosToolRetriever`, `__kairosComposioExecute`, GuideBridge, BackgroundAgentManager, MemoryInjector); a child has none of them. Use either an in-memory transport pair handed to the codex child, OR `StreamableHTTP` mounted as the `/mcp` route on the EXISTING daemon `Bun.serve` at `127.0.0.1:9876` (per doc 11 — no second listener) registered as `[mcp_servers.kairos] url="http://127.0.0.1:9876/mcp"`. Tier the surface: smart-voice gets guide/act + Composio dispatch + recall + background; WITHHOLD `composio_search_tools` catalog discovery + heavy tools from the low-latency smart profile. | This is the file 01.B/05 named but doesn't exist. The in-process requirement CORRECTS 01:67–71 (`command=bun args=[run kairosMcpServer.ts]` would be a toolless zombie). |
| `src/daemon/mcp/mcpHost.ts:21–31,204–219` | **KEEP / reuse pattern** | Reuse the existing `DestructiveActionConfirmer` + `DESTRUCTIVE_PATTERN` to wrap the new MCP server's execute callbacks. No change to the file; the pattern is borrowed in `kairosMcpServer.ts`. | Don't reinvent destructive gating; the host already has it. |
| `src/daemon/index.ts:897–900` (`__kairosComposioExecute`) | **EXTEND** | Wire `SelfHealConnect` inline: on a `NOT_CONNECTED` envelope (Composio returns `successful:false`, NOT a throw) OR error from `composioClient.executeTool`, call the stashed `__kairosSelfHealConnect.connectAndRetry(toolkit, ()=>execute)` so OAuth stays daemon-side and Codex only ever sees the final result. Activates the "future inline-on-error wiring" the comment at index.ts:2239 anticipates. | Composio auto-connect must stay 100% daemon-side and invisible to Codex. Codex calls `search_tools`/`execute_tool` and never touches OAuth/tokens/redirects. |
| `src/daemon/agents/selfHealConnect.ts` | **KEEP** | No change — it's already built (initiate→browser→poll ACTIVE→retry). Just gets CALLED inline now from `__kairosComposioExecute`. | The flow exists; only the call site is new. |
| `src/daemon/agents/toolDispatch.ts` | **KEEP** | `search_tools`/`execute_tool` dispatcher unchanged; surfaced through the MCP server as-is. | Composio reaches Codex via the dispatcher pattern, not pre-loaded tools — that design is preserved. |
| `src/daemon/agents/composioToolProvider.ts` | **KEEP** | `composio_search_tools` catalog meta-tool unchanged; just gated out of the smart profile by the MCP server's per-profile filter. | Latency trim, not a behavior change. |
| `src/daemon/agents/recallTool.ts` | **KEEP** | `recall_memory` `ToolDef` unchanged; exposed on the MCP server for Codex mid-task pulls. | Memory-as-tool for mid-task; the cheap pre-injected delta still carries the common case. |
| `src/daemon/agents/webTools.ts` | **KEEP (gated out of Codex)** | `web_search`/`read_webpage` (free DDG) stay for the FAST tier + background sub-agents. Do NOT export to the Codex MCP server IF the chosen OpenRouter model serves native Responses `web_search` (enable `tools.web_search=true` / `--search` in the generated config). If the model is chat-only (no native search), FLIP: export the DDG tools via the MCP server instead. Decision blocks on 07.1. | Avoid double web-search (native + DDG) so the model can't bypass the metered proxy via the keyless path. |
| `src/daemon/agents/guideTools.ts` | **EXTEND** | Add `kind`/`style` params to `guide_user`/`guide_request` and a new `guide_scroll({direction,until,app})` tool (wraps region draw + `wait_for_screen`). `click_element`/`type_text` keep their `DANGEROUS_LABEL_RE` confirm gate. Exposed through the MCP server. | Drives the new Clicky affordances (03); region/scroll successes count as valid "pointed" outcomes in the verifier walkthrough gates. |
| `src/daemon/llm/providers/codexCli.ts` | **KEEP** | The one-shot `codex exec --json` provider stays as the background/sub-agent + stable fallback path (rollout step 1). Optionally share its `detectBinary`/vendored-pin resolution with `codexBrain.ts`. Do NOT extend it into the warm app-server brain. | Stable `exec --json` is the experimental-app-server escape hatch; proves the binary-spawn plumbing. |

---

## 3) Memory / self-learning

Decisive design (BOTH, asymmetric — mirrors openclicky's two layers): durable
persona/doctrine → `thread/start` instructions (AGENTS.md-equivalent, set once per
thread, re-written from ContextBuilder on every CODEX_HOME regen); volatile
per-turn memory delta → `turn/start` instructions; `recall_memory` → MCP tool for
mid-task pulls. Self-learning is UNCHANGED because AwmWorker reads the file store
(`~/.kairos/traj/`), never the model — we only translate Codex's event stream into
the same `TrajWriter.record()` shape.

| File | Status | Change | Why |
|---|---|---|---|
| `src/daemon/agents/contextBuilder.ts` | **EXTEND** | Add a method (or split `build()`) that returns the CACHED session prefix (persona/soul.md + character + talk + act rules + standing orders) SEPARATELY from the per-turn delta. `CodexBrain` writes the prefix into CODEX_HOME's AGENTS.md/model-instructions ONCE per thread (durable doctrine) and passes ONLY the delta as `turn/start` instructions. Keep `build()` for the fallback loop (concatenates both as today). Reuse the existing self-echo strip (`stripSelfEcho`/`isSelfEchoMemory`) + `needsMemoryRecall` pre-gate BEFORE building Codex turn instructions. | Mirrors `CodexVoiceSession.composePrompt`; avoids double-history; keeps all delta hygiene for free on the Codex path. |
| `src/daemon/memory/memoryInjector.ts` | **KEEP** | Unchanged — `contextBuilder` calls it; the L2/L3/L4 merge into ContextBlocks is identical whether the consumer is the loop or Codex. | Memory assembly is brain-agnostic. |
| `src/daemon/memory/episodicMemory.ts` | **KEEP** | Unchanged. SQLite L2 + FTS5 + hybrid recall + soft-delete all stay daemon-side. | Codex never sees the stores; it pulls via `recall_memory` MCP or the injected delta. |
| `src/daemon/voice/conversationMessageStore.ts` | **KEEP (authoritative)** | Stays the transcript of record + layered replay (`loadForReplay`/`appendTurn`/`updateRollingSummary`). DECISION: KAIROS-authoritative continuity — inject `loadForReplay` output as the turn-input prefix; do NOT also let Codex `history.persistence='save-all'` re-feed the same turns (double-history risk). Reuse `buildTurnDigest`'s `execute_tool`-unwrap (116–120) in the event translator so trajectory tool names stay granular. | The layered pyramid + handle-preservation + cross-restart durability are already tuned; keep one source of truth for in-thread continuity. |
| `src/daemon/persona/trajWriter.ts` | **KEEP** | Unchanged. `CodexBrain` emits one `TrajWriter.record()` per turn ({ts, task_goal, intent_id, args_summary, steps, outcome, duration_ms}); ship a coarse per-turn `intent_id` = `codex_smart`/`codex_deep` (per 09 + 01) — the sorted tool-sequence is captured regardless, so per-MCP-tool-action attribution (unwrap `execute_tool`) is a later tuning refinement, not part of v1. | Self-learning reads files, not the model; once the record is emitted, clustering/crystallization/PersonaGate/skills-dir all keep working with zero change. |
| `src/daemon/skills/awmWorker.ts` | **KEEP** | Unchanged. Still mines `~/.kairos/traj/` (cluster on intent_id + sorted tool-sequence, ≥3 occ × >5 tools × >30s success). | The mining is brain-agnostic by design — the whole point of the file-store indirection. |
| `src/daemon/skills/crystallizer.ts`, `personaGate.ts`, `skillRegistry.ts` | **KEEP** | Unchanged. Skills still crystallize into `<sandbox>/skills/active/`, hot-reloaded. | Self-evolving skills pipeline is downstream of TrajWriter; untouched by the brain swap. |

---

## 4) HUD / guidance overlay

The HUD is a pure projection of the WS at `ws://127.0.0.1:9876/v1/voice/events`.
The Codex swap is INVISIBLE to the HUD by design (orb-state cases need no change)
— the only HUD work is the additive Clicky affordance upgrade + (optional)
notch/Agents surfaces. Keep the Metal orb + robot-face comet + rectangle highlight;
add region/scroll/arrow affordances in our material language.

| File | Status | Change | Why |
|---|---|---|---|
| `apps/macos/KairosHUD/Sources/KairosHUD/Transport/DaemonClient.swift` | **EXTEND** | In the `guide_request` case (~303): forward new `kind` + region/scroll fields to GuideModel; add a `guide_scroll`/`scroll_result` round-trip mirroring `sendGuideResult`. Orb-state cases (`agent_*`, `tts_*`, `agent_speaking`) need NO change — Codex turns still emit the same envelope. | Single WS, receive-mostly; the Codex brain reuses the exact same event names so transport is invisible. |
| `apps/macos/KairosHUD/Sources/KairosHUD/Guide/GuideModel.swift` | **EXTEND** | Replace `target: GuideTarget?` with an `affordance: Affordance` enum (`.point(rect,label)`/`.region(rect,label?)`/`.scroll(edgeRect,direction,label)`/`.label(rect,text)`). Derive comet/buddy park-position per kind. Parse new `guide_request` fields in `handle()`. Add `handleScroll`/`guide_scroll` reusing the existing `handleWatch` poll loop for auto-advance. Add idle-buddy Lissajous drift when no affordance is active but a voice session is live. ONLY ONE affordance family on screen at a time (single slot → single enum, no parallel arrays). | The affordance grammar; keeps the "UI never runs ahead of voice" contract. |
| `apps/macos/KairosHUD/Sources/KairosHUD/Guide/GuideOverlayView.swift` | **EXTEND** | KEEP `GuideComet` (robot-face) + `TargetHighlight` (repurposed as the bullseye/point renderer). ADD `RegionBlock` (`RoundedRectangle(cornerRadius:12,.continuous)`, `StrokeStyle(lineWidth:2.5,dash:[7,5])` animating dashPhase = marching ants, `.fill(accent.opacity(0.12))`, comet parks top-left), `ScrollGuide` (edge `Capsule` line + arrowhead + action pill with directional shimmer), and a shared `ArrowAffordance` (capsule line + arrowhead from parked comet to highlight). Add a verb/action accent-pill variant of `CaptionPill` ("scroll down"/"click here") distinct from the element-name label pill. Render all in the existing click-through `guidePanel`. Use warm-gold→cyan, NOT Clicky's flat red; make accent configurable for colorblind users. | Adopt the GRAMMAR, keep our material language — a literal red copy reads as a different product. Arrow is the cheapest high-impact net-new geometry. |
| `apps/macos/KairosHUD/Sources/KairosHUD/Guide/AXFinder.swift` | **EXTEND** | Add `unionFrame(of:[indices/labels])` (group/region rect via the existing act-mode container-climb) and `scrollableAncestor(of:)` (nearest `AXScrollArea` + its frame + whether target is above/below viewport). Keep the numbered inventory snapshot as the addressing contract so guide-by-number, act-mode confirm-gate, and change-detection stay intact. | Prerequisites for region + scroll affordances; both DON'T EXIST yet (zero matches for `ScrollArea|union|scroll` today). Sequence this AHEAD of the SwiftUI shapes — overlays have nothing to point at otherwise. |
| `apps/macos/KairosHUD/Sources/KairosHUD/Guide/AXActor.swift` | **KEEP** | Unchanged. `kAXPressAction`→per-PID CGEvent fallback, no cursor warp; raw x,y blocked. | Act-mode actuation is independent of the guidance grammar. |
| `apps/macos/KairosHUD/Sources/KairosHUD/Orb/*` (MetalOrb, OrbModel, …) | **KEEP** | Unchanged — orb stays the default identity (07.5). | Notch is opt-in/fallback, not a replacement. |
| `apps/macos/KairosHUD/Sources/KairosHUD/Panels/OrbPanelManager.swift` | **KEEP** | Unchanged (alpha-crossfade orb↔guide panel still works). | Affordances render in the existing click-through guidePanel — no new window plumbing. |
| `apps/macos/KairosHUD/Sources/KairosHUD/Panels/NotchStatePanel.swift` | **NEW (optional, Phase C)** | Notch state surface: Listening (VAD-armed, calm level bars) / Thinking (`agent_planning`/think, purple trailing dots) / Speaking (existing `tts_level` stream, orange waveform). All three signals already exist in the event pipeline — pure HUD work. Opt-in + non-notch-Mac fallback pill. | The "alive" layer; orb stays default per 07.5. |
| `apps/macos/KairosHUD/Sources/KairosHUD/Activity/AgentsSurfaceView.swift` | **NEW (optional, Phase C/D)** | Agents surface fed by existing `background_tasks` + activity events: RUNNING cards (title + live status line from `tool_call` events + progress + ✕), TODAY history with one-line results + "Open Agent" → resume codex thread id. Map each proactive/background Codex thread 1:1 to a card. | Surfaces Codex threads visually; reuses existing background/activity events — only the view is new. |
| `apps/macos/KairosHUD/Sources/KairosHUD/Activity/{ActivityModel,BackgroundModel,ApprovalModel}.swift` | **KEEP** | Unchanged — Lane A/B/approvals models still fed by the same events. | Codex tool events map onto the existing activity envelope. |

---

## 5) Daemon wiring (index.ts) + proactive hooks

| File | Status | Change | Why |
|---|---|---|---|
| `src/daemon/index.ts` (CODEX_HOME lifecycle) | **NEW (code block)** | At boot, generate `state/codex/home/config.toml` + AGENTS.md/model-instructions (write ContextBuilder's session prefix as the durable doctrine, RE-WRITE on every regen — daemon is source of truth, never the codex home). `git init state/codex/workspace`, pre-trust via `[projects]`. Delete-and-regenerate safe. Validate/escape model+effort strings (`[A-Za-z0-9./-]+`, escape `\n\r\t`) before writing (fix the openclicky TOML-injection bug R8). | Isolated home so KAIROS config never collides with the user's broken `~/.codex` (GSD `[[hooks]]` parse error). |
| `src/daemon/index.ts:1979–2074` | **REPLACE→EXTRACT** | (See §2) Extract `actionTools` → exported `buildActionToolset(deps)`. | Dual-consumer single source of truth. |
| `src/daemon/index.ts:897–900` | **EXTEND** | (See §2) Inline `SelfHealConnect` on `NOT_CONNECTED`. | Composio auto-connect stays daemon-side. |
| `src/daemon/index.ts:2494` (agentConductor `onEvent` broadcast) | **KEEP** | Unchanged — Codex events become `LoopEvent`s upstream in `CodexBrain`, so this broadcast is brain-agnostic. | The "zero downstream change" guarantee. |
| `src/daemon/index.ts:2379–2413` (bg `appendTraj`) | **KEEP / reuse pattern** | Unchanged; the `CodexBrain` trajectory translator wires to `__kairosTrajWriter` EXACTLY like this bg lane does. | Proven translation pattern; copy it for the foreground Codex path. |
| `src/daemon/index.ts` (routing) | **EXTEND** | Route tier in {task,think} + `KAIROS_BRAIN=codex` → `CodexBrain`, else current `handleSmart`/`handleThink`. Wire `CodexBrain` process lifecycle (warm child, stale-exit guard) + proxy base-URL config. | The flag fork at the daemon boundary. |
| `src/daemon/taskRunner.ts:78–115` | **REPLACE** | Gate the `claude -p` spawn behind `KAIROS_BRAIN`; when codex, route the proactive `WORK` verb through `codex exec --json` (background) or a `CodexBrain` app-server thread — same brain/tools(MCP)/verifier as the conductor's `[[task]]` path. | **Single biggest proactive correctness risk:** if only the conductor swaps and `taskRunner` stays on `claude -p`, the proactive lane diverges (two brains, no verifier wrap) AND fails in shipped builds (`claude -p` 401s without an authenticated Claude CLI; Anthropic is off the cloud path). |
| `src/daemon/index.ts:446–493` (`onWork`/`onNotify`/`onSuggest`) | **EXTEND (hooks)** | Leave proactive hooks: when the Proposer ships, its drafted actions enter via the synthetic-stimulus bridge into the conductor/`CodexBrain` path (restraint-gated BEFORE Codex is invoked). Keep `SUGGEST` as the quiet HUD chip path; add `knowledge/suggestion-rules.json` evaluation as a pre-tick hook. Proactive turns are NON-VOICE: suppress the `assistant_delta`→TTS pipe unless the delivery plane decides to speak. | Proactive coming soon — re-route WORK now, leave the Proposer bridge as a hook. HeyClicky keeps voice off Codex; proactive = "the explicit agent run" = belongs on Codex as background threads. |
| `src/daemon/scheduler.ts`, `src/daemon/decisionEngine.ts` | **KEEP** | Unchanged tick loop + six-verb DecisionEngine; the tick LLM stays the injected OpenRouter completer (NOT claude -p). Only `WORK`'s executor (taskRunner) changes. | Restraint/decision gating runs BEFORE Codex; the engine itself is brain-agnostic. |
| `src/daemon/llm/usageMeter.ts` | **EXTEND** | Add `task_type` `codex_smart`/`codex_deep` + a per-install/token dimension so facade-side metering mirrors local `llm_call_log`; wire budget caps to the facade enforcement point. | Metering unification (05.G); shipped source of truth is proxy-side. |
| `src/daemon/llm/costTracker.ts` | **EXTEND** | Account `codex_*` task types in the budget guard like today's planner calls. | Budget guard must count Codex turns. |
| `src/daemon/index.ts:2858–2875` (`test_run_awm` hook) | **KEEP** | Unchanged — still forces `AwmWorker.runOnce` with relaxed thresholds (disabled in production). | Skill-evolution testing hook is brain-agnostic. |

---

## 6) Proxy (hidden inference facade)

Local-first now, hosted later, IDENTICAL code. The single load-bearing constraint:
codex 0.133.0 REJECTS `wire_api="chat"` at config load — the facade MUST present
the OpenAI **Responses** API to Codex. OpenRouter's `/v1/responses` is beta+stateless,
so the facade translates **Responses-IN → chat/completions-OUT** (the GA path
`openRouterAdapter.ts` already proves).

| File | Status | Change | Why |
|---|---|---|---|
| `src/daemon/brainProxy/facade.ts` | **NEW** | Portable `export default { fetch }` (runs in Bun now, Cloudflare Worker later — Web Fetch/Streams shared). Routes: `POST /v1/responses` (Responses↔chat translator), `POST /v1/chat/completions` (passthrough for our own fast tier later), `GET /v1/models` (ALIASES ONLY — `kairos-smart`/`kairos-deep`, never a real OR slug). | The only thing that changes local→hosted is the `base_url` in the generated config.toml. |
| `src/daemon/brainProxy/responsesToChat.ts` | **NEW** | The translator: Responses `input` items + `instructions` → chat `messages`; `tools`/`tool_choice` near-identical; re-emit OR chat SSE deltas as Responses SSE events (`response.created`, `response.output_text.delta`, `response.function_call_arguments.delta`, `response.completed`). Scope v1 to EXACTLY the item types codex 0.133.0 emits (capture via a logging passthrough on a real turn first). Golden-file tests against a recorded OR stream. | The only nontrivial proxy code; everything else is passthrough. Pin OR SSE behavior with golden files. |
| `src/daemon/brainProxy/modelAliases.ts` | **NEW** | Server-side map `{kairos-smart → OR slug, kairos-deep → OR slug}`; `GET /v1/models` returns only aliases. Swap upstream model = edit the map, zero app update. | Never let a real OR slug appear in bundle/config/traffic/logs. |
| `src/daemon/brainProxy/auth.ts` | **NEW** | Per-install token validate (NOT a provider key in `env_key`); server-side real-key swap. Recommended: STABLE per-install token in the child env + short-lived real-key swap entirely server-side (avoids mid-session respawn). Rotate on 401. `x-kairos-build` version gate / kill-switch. | Copy HeyClicky's per-install token model; `KAIROS_BRAIN_KEY` carries the token, the proxy attaches the real OR key. |
| `src/daemon/brainProxy/metering.ts` | **NEW** | Per-token counters (tokens, $, per-day caps), budget enforcement + kill-switch. Log counters ONLY, NEVER bodies. | Local code can't be trusted to meter in a shipped app; facade is the enforcement point. |
| `src/daemon/wrapApi/server.ts:68–74` | **EXTEND** | Extract the `Bun.serve` routes pattern into a reusable handler so the facade runs as a localhost Bun route now AND exports the identical `fetch` for a Worker later. Mount `/v1/responses`, `/v1/chat/completions`, `/v1/models`. | Reuse the existing route map; the facade is incremental, not greenfield. |
| `src/daemon/wrapApi/adapters/openRouterAdapter.ts` | **EXTEND** | Reuse as the facade's UPSTREAM client (already streams `${baseUrl}/chat/completions`). Factor the SSE parsing so `responsesToChat.ts` can wrap the same chat-delta stream. | OR `/v1/responses` is beta — use the GA chat path upstream; we own state assembly (fine, Codex sends full input per turn). |

Facade-from-day-one is THE rule (per 02): even in dev, `base_url` points at the
localhost facade (`http://127.0.0.1:<port>/v1`, same code you ship) so the
Responses↔chat translator is exercised before ship. Do NOT point `base_url`
straight at `https://openrouter.ai/api/v1` — codex requires `wire_api=responses`
and OR's `/v1/responses` is beta/unreliable, so a direct connection is not safe.
The dedicated key (07.2) lives ONLY in the facade, never in the app.

---

## 7) Vendoring / build

Mirror HeyClicky exactly: pinned per-arch binary + a 648-byte POSIX arch-dispatch
shim. Pin an EXACT validated version (app-server is experimental).

| File | Status | Change | Why |
|---|---|---|---|
| `vendor/codex/bin/codex` | **NEW** | The 648-byte POSIX-sh arch-dispatch shim (verbatim HeyClicky): detect `uname -m` (arm64→`aarch64-apple-darwin`, x86_64→`x86_64-apple-darwin`), prepend `vendor/<triple>/path` (bundled `rg`) to PATH, `exec vendor/<triple>/codex/codex "$@"`. | Don't trust the user's PATH/version; bundled `rg` for codex's grep. |
| `vendor/codex/vendor/<triple>/codex/codex` | **NEW** | The pinned per-arch codex binary (~171–193MB/arch). Source from a PINNED GitHub Release archive at build time (deterministic, no runtime `npm i`) OR `npm install @openai/codex@<exact>` + copy out the platform sub-package binary. Verify executability at boot. | Vendored like a product; arm64-only or download-on-first-run with version pin + signature check if size matters (07.9). |
| `vendor/codex/vendor/<triple>/path/rg` | **NEW** | Bundled ripgrep per arch. | codex shells out to `rg`. |
| build step (package.json / Makefile) | **NEW** | A step that fetches the pinned per-arch archives from the codex GitHub Release and lays out the `vendor/codex/` tree. Decide pin: dev=0.133.0, HeyClicky shipped 0.124.0, npm latest 0.139.0 — VALIDATE one against the generated bindings + the responses translator, lock it, treat bumps as breaking-change events (07.9 / 07.1). | Pinning is non-negotiable since app-server JSON-RPC changes across minors. |
| `src/daemon/agents/codexBrain.ts` (binary resolution) | **NEW (sub-concern)** | Dev = `/opt/homebrew/bin/codex`; ship = `vendor/codex/bin/codex` shim. Share `detectBinary`/vendored-pin fallback with `codexCli.ts`. | One resolver, two consumers. |

---

## What we delete / retire

Nothing is hard-deleted in the first cut. The brain swap is **flag-gated and
reversible** (`KAIROS_BRAIN=codex`), and the research is explicit that the flag is
a **permanent fallback** (01.E). Specifically:

- **`defaultPlannerRunner` (conductor.ts:948) + `runAgentLoop` (agentLoop.ts): KEEP
  as the fallback.** When `KAIROS_BRAIN!=codex`, smart/deep still run the in-house
  loop. The background sub-agent lane (backgroundSubsystem.ts) ALSO independently
  uses `runAgentLoop` — migrate it to `codex exec --json` first (rollout step 1),
  but keep `runAgentLoop` until that lane is proven on Codex. **Decision: do NOT
  remove until both (a) smart-voice-on-Codex passes the A/B latency gate and ships
  as default AND (b) the background lane is validated on `exec --json`.** Treat
  removal as a separate, later, deliberate PR — not part of this migration.
- **`buildActionToolset` must stay dual-consumer** (loop + MCP server) for as long
  as the fallback exists. If/when the loop is retired, the ContextBuilder loader
  drops its consumer and only the MCP server remains.
- **In-loop verify round** is RETIRED in the Codex path (becomes a post-turn
  re-injected thread turn — see verifier PORT). The in-loop version stays only in
  the fallback `runAgentLoop`.
- **`claude -p` in taskRunner.ts: RETIRE for the proactive WORK lane** (it 401s
  without an authenticated Claude CLI; Anthropic is off the cloud path by design).
  This is the one path safe to fully cut over to Codex now (background, no voice
  risk) — keep the `KAIROS_BRAIN` gate so dev can still fall back if needed.
- **`[profiles.smart]`/`[profiles.deep]` per-profile effort config (01.B): RETIRE**
  in favor of one model + per-turn `effort` on `turn/start`. Update doc 01.B.
- **Codex native `web_search` vs KAIROS DDG tools: one is retired per model.** If
  the OR model serves native Responses search, don't export DDG to Codex; if
  chat-only, do. Blocks on 07.1 — don't hardcode until decided.

---

## Dependency-ordered build sequence

An engineer follows this top-to-bottom. Each step is independently testable; later
steps depend on earlier ones.

**Phase 0 — Vendoring + proxy foundation (no behavior change)**
1. `vendor/codex/` layout + build step + shim; validate `codex app-server
   --help` and `generate-ts` against the pinned binary. (§7)
2. Generate `codexProto/` bindings from the pinned binary. (§1)
3. Stand up the proxy facade locally: `facade.ts` + `responsesToChat.ts` +
   `modelAliases.ts` + `auth.ts` + `metering.ts`; reuse `openRouterAdapter` as
   upstream. Capture real codex Responses item types via a logging passthrough,
   then finalize the translator + golden-file tests. (§6) — *blocks on 07.1
   (model) + 07.2 (key).*

**Phase 1 — Tools/MCP (so Codex has hands before it has a brain)**
4. Extract `buildActionToolset(deps)` from `actionTools` (index.ts:1979). (§2)
5. Build `kairosMcpServer.ts` IN-PROCESS MCP server over `buildActionToolset`;
   JSON-Schema→Zod shim; per-profile tool filter; destructive-confirm wrap. (§2)
6. Inline `SelfHealConnect` on `NOT_CONNECTED` in `__kairosComposioExecute`. (§2)

**Phase 2 — CODEX_HOME + CodexBrain (background lane first, no voice risk)**
7. CODEX_HOME/workspace lifecycle in index.ts (config gen, AGENTS.md from
   ContextBuilder prefix, git init, TOML escape/validate). (§5)
8. `contextBuilder.ts` prefix/delta split. (§3)
9. `codexBrain.ts`: warm app-server child (fix A1 continuation-leak,
   A3 per-request timeout, A2 double-startup, R8 TOML); JSON-RPC client;
   event→`LoopEvent` translator (namespace-strip, `execute_tool` unwrap);
   TrajWriter.record() per turn. (§1)
10. **Re-route `taskRunner.ts` WORK → `codex exec --json`** behind the flag —
    rollout step 1, lowest voice risk. Verify ledger→verifier on the background
    lane. (§5)

**Phase 3 — Verifier port + deep tier**
11. PORT the verifier to post-turn over the translated ledger; one-shot
    `[automatic check]` re-injected turn on retryable. (§1)
12. Wire `[[think]]`/deep through `CodexBrain` app-server threads. (§1/§5)
13. Metering: `usageMeter`/`costTracker` `codex_*` task types. (§5)

**Phase 4 — Smart-voice (flagged, A/B gated)**
14. Route `[[task]]` smart-voice through `CodexBrain` behind `KAIROS_BRAIN=codex`;
    suppress TTS for non-voice/proactive turns. Measure `time_to_first_token_ms`
    via turns.jsonl; A/B vs the direct loop before flipping default. (§1) —
    *blocks on 07.4 (latency tolerance).*

**Phase 5 — Guidance overlay (independent of Phase 0–4)**
15. `AXFinder` `unionFrame` + `scrollableAncestor` (AHEAD of the SwiftUI shapes). (§4)
16. `guideTools`/`GuideBridge` `kind`/`style` + `guide_scroll`; verifier walkthrough
    gate accepts region/scroll outcomes. (§2/§4)
17. `GuideModel` Affordance enum; `GuideOverlayView` RegionBlock/ScrollGuide/Arrow +
    action-pill; `DaemonClient` forwards new fields. (§4)

**Phase 6 — Notch / Agents / proactive hooks (last, "alive" layer)**
18. `NotchStatePanel` (opt-in) + `AgentsSurfaceView` (Codex threads → cards). (§4)
19. `suggestion-rules.json` pre-tick hook + Proposer synthetic-stimulus bridge
    (restraint-gated, non-voice). (§5) — *proactive coming soon; hooks only.*

**Later (separate PR, not this migration):** decide whether to retire
`defaultPlannerRunner`/`runAgentLoop` once Codex is the proven default.

---

## Open decisions that gate this map (see 07)

- **07.1** OR model slugs behind `kairos-smart`/`kairos-deep` + does each serve
  `wire_api="responses"` streaming with effort honored? (blocks Phase 0 step 3,
  and the web_search export flip.)
- **07.2** Dedicated `KAIROS_BRAIN_KEY` confirmed separate from the daemon key?
  (blocks Phase 0 step 3 dev mode.)
- **07.4** First-token latency tolerance X for smart-voice on Codex. (gates Phase 4.)
- **07.9** Ship binary: both arches (~193MB each) vs arm64-only / download-on-first-run.
- **Codex pin version** to validate + freeze (0.124 vs 0.133 vs 0.139). (gates §7 + §1.)
- **Transport** for the KAIROS MCP server: in-memory/stdio pair vs StreamableHTTP
  on 127.0.0.1. (gates §2 step 5.)
