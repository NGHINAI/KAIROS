# Clicky Migration — Master Plan (rev. 2026-06-12)

Everything KAIROS changes to swap its SMART/DEEP brain to a vendored OpenAI
Codex CLI, hidden behind our own inference proxy, while keeping our identity
(Metal robot-face orb + comet + rectangle highlight), our memory + self-learning,
and our Composio auto-connect. Based on:

- the HeyClicky.app binary teardown (`docs/clicky-teardown-research.md`),
- the openclicky OSS source (cloned at `/tmp/openclicky`, ~87 Swift files +
  notch captures + `FULL_SYSTEM_CODE_REVIEW_2026-06.md`),
- the user's 173s screen recording of Clicky guiding through System Settings
  (frame-by-frame at `/tmp/clicky-video/`),
- a grounded research pass against the live KAIROS tree + codex 0.133.0 + the
  generated `app-server generate-ts` protocol bindings.

## ‼️ NON-NEGOTIABLE + decisions added 2026-06-12 (supersede where noted)

- **PORT THE VERIFIER GATES.** The one non-negotiable nuance of the whole swap:
  our deterministic verifier gates MUST be ported to run POST-TURN on Codex's
  output (fabrication / do-mode / false-blindness / false-done / promissory /
  walkthrough), or we lose this week's anti-fabrication + do-mode protections.
  On a retryable flag, re-inject one corrective turn into the Codex thread —
  same mechanic as today's in-loop retry. (01 §D, 10 PORT row.) Never ship the
  swap without this.
- **LANE DECISION (refines decision #2 below).** The dividing line is
  *conversational vs agentic*, NOT *smart vs deep*:
  - **Our loop keeps:** the fast chain AND smart *voice* `[[task]]` (quick
    replies, single actions) — low latency, already tuned. Codex buys ~nothing
    for conversational turns and adds first-token latency.
  - **Codex takes:** deep `[[think]]` + background/agent runs + any genuinely
    heavy / multi-step / "do a whole task" request. The harness (planning,
    retries, sandboxed shell, MCP) dominates there and latency is free.
  - A heavy smart turn may ESCALATE to Codex (hook in 01). Measure per-task.
- **AX-first; Cua is the EXPLICIT automatic AX-failure backup (14 §H2).** Our own
  computer-use (`AXActor` AXPress→per-PID CGEvent, `AXFinder`,
  `click_element`/`type_text`/`read_screen`) is the fast default and powers the
  guide/teach UX (Cua does pure actuation, no guidance). Cua is the registered
  fallback MCP server, triggered AUTOMATICALLY when `AXFinder` returns
  not-found/unresolvable OR an AX-blind app is detected (Electron/canvas/games/
  poor-AX) — it brings vision + browser-DOM (query/execute-JS in-page) + rich
  input (scroll/hotkey/drag). Since Codex consumes tools via MCP, Cua registers as
  an extra MCP server (exactly as HeyClicky does). Narrowest-route doctrine: our
  AX → Cua last-mile. AX-first + guide engine stay the default; "wholesale vision"
  stays DECLINED, targeted-vision-via-Cua is the fallback. (08 §A0.)
- **Model = MiniMax for now, ENV-SWAPPABLE.** Pilot on MiniMax; the proxy
  exposes it as the alias `kairos-smart`/`kairos-deep` and the real slug is set
  by ENV, so swapping models later needs NO app/config change (env table below).
- **End-state = ONE agentic brain (item E, 14§E).** EVERYTHING agentic (any
  tool-using turn — deep, background, AND proactive WORK) is Codex's job; the
  loop-free fast chat tier (no tools, pure conversation/routing) stays ours
  forever. There is ONE shared post-turn verifier + ONE shared block-writes/
  `suppressedFinal` gate that BOTH `agentLoop` and `CodexBrain` call, so the two
  paths can't drift during the transition (kills the divergence trap).
- **`KAIROS_BRAIN` is a TEMPORARY rollback — with an explicit RETIREMENT
  criterion, NOT a standing parallel architecture.** It's a migration/rollback
  switch only; it is removed once deep + background are stable on Codex for N days.
  `defaultPlannerRunner` stays ONLY until then, not indefinitely.
- **`KAIROS_BRAIN_SMART_VOICE` (default off) gates ONLY the smart-voice lane**,
  separate from `KAIROS_BRAIN`. Smart-voice-agentic is the ONE measured lane:
  flip it to Codex (low effort, warm process, ported filler contract) IF measured
  TTFT passes the stated budget; else it stays on our loop as an explicit,
  documented latency exception — NOT a permanent parallel architecture.

### Environment variables (single source — keep updated as we add knobs)

| Var | Purpose | Example |
|---|---|---|
| `KAIROS_BRAIN_KEY` | Dedicated provider key the proxy uses (NOT the daemon key) | `sk-or-…` |
| `KAIROS_BRAIN_BASE_URL` | Where codex's generated config points (the proxy) | dev `http://127.0.0.1:8788/v1`, ship `https://brain.<domain>/v1` |
| `KAIROS_BRAIN_MODEL_SMART` | Real OpenRouter slug behind alias `kairos-smart` | `minimax/minimax-01` |
| `KAIROS_BRAIN_MODEL_DEEP` | Real slug behind alias `kairos-deep` | `minimax/minimax-01` (same model, effort differs) |
| `KAIROS_BRAIN_EFFORT_SMART` | per-turn effort for smart/escalated | `low` |
| `KAIROS_BRAIN_EFFORT_DEEP` | per-turn effort for deep | `high` |
| `KAIROS_BRAIN` | TEMP migration rollback (`codex` \| `local`); retired once deep+background stable on Codex for N days (14§E) | `codex` |
| `KAIROS_BRAIN_SMART_VOICE` | Gates ONLY the smart-voice→Codex flip (default OFF); on only if measured TTFT passes budget (14§E) | `0` |
| `KAIROS_MCP_TOKEN` | Bearer for the in-process `/mcp` mount + the codex child's allowlisted env; never the daemon key (14§A6/§B8) | `mcp-…` |
| `KAIROS_HIDE_ON_CAPTURE` | overlay auto-hide during screen capture (default off) | `0` |

> Model swaps = change `KAIROS_BRAIN_MODEL_*` (and the proxy's alias map);
> nothing in the app bundle or codex config changes. This is the whole point of
> the alias indirection (02 / 09).

## Confirmed decisions (locked by Nirmal — reflect everywhere)

1. **Fast tier stays ours, loop-free (confirmed).** `frontFlow`/`answer_now`
   is a single fast completion with NO agent loop (`conductor.ts` 235-242,
   307-313); `handleFast` is loop-free (`conductor.ts` 546-572). Only
   `handleSmart` and the background executor call `runAgentLoop`
   (`conductor.ts` 1029, `backgroundSubsystem.ts` 212). Codex replaces ONLY
   those two — never the fast chain.
2. **DEEP `[[think]]` + background/heavy-agentic become Codex `app-server`;
   smart VOICE stays on our loop** (refined by the LANE DECISION above,
   2026-06-12). One warm stdio JSON-RPC child, mirroring openclicky's
   `CodexProcessManager`. (Originally "smart+deep→Codex"; narrowed because Codex
   adds latency with ~no benefit on conversational smart-voice.)
3. **One model, effort PER TURN (confirmed against research).** `turn/start`
   accepts `model?` and `effort?` overrides "for this turn and subsequent
   turns" (`/tmp/codex-ts/v2/TurnStartParams.ts`). openclicky proves it in
   production: voice sends `effort:"low"`, agent keeps the selected effort
   (`CodexVoiceSession.swift` 210-224). So smart = same model @ low/minimal
   effort, deep = same model @ high/xhigh effort — set on `turn/start`, NOT via
   `[profiles.*]`. `ReasoningEffort` ∈ {none, minimal, low, medium, high, xhigh}.
   (End-state per 14§E: smart-voice is the ONE measured lane — it flips to Codex
   behind `KAIROS_BRAIN_SMART_VOICE` only if measured TTFT passes the budget;
   otherwise it stays on our loop as a documented latency exception.)
4. **Models via OpenRouter through a hidden proxy + a SEPARATE dedicated key.**
   codex 0.133.0 HARD-REJECTS `wire_api="chat"` at config load, so the proxy
   must speak the OpenAI **Responses** API to Codex and translate to OpenRouter
   `chat/completions` outbound. Dedicated key `KAIROS_BRAIN_KEY`, never the
   daemon key (02 / 07.2).
5. **Proxy runs LOCALLY now, hosts later.** ONE portable `fetch(req)` handler:
   Bun.serve on `127.0.0.1` in dev, the SAME handler as a Cloudflare Worker for
   ship. Only the generated `config.toml` `base_url` changes (02 / 09).
6. **Vendor/build codex like a real product (NOT the user's homebrew codex).**
   Copy HeyClicky's layout: a POSIX arch-dispatch shim → pinned per-arch
   binaries + bundled `rg`, isolated `CODEX_HOME` (the user's `~/.codex` has a
   GSD `[[hooks]]` parse error in 0.133.0 and must never be touched). Dev may
   use `/opt/homebrew/bin/codex`; ship uses the vendored pinned binary (08).
7. **Keep the robot-face orb + rectangle highlight; make guidance seamless +
   add Clicky affordances.** Add arrows, scroll guide, and region blocks
   alongside the existing comet + ring — similar to Clicky, not identical;
   keep our warm-gold→cyan liquid-glass material, not Clicky's flat red (03/04).
8. **Proactive features are coming soon — leave hooks.** The daemon tick +
   suggestion rules + synthetic-stimulus bridge route proactive WORK through
   the SAME Codex brain — `claude -p` is REMOVED ENTIRELY (NO Claude anywhere in
   the runtime, 14 §H1; CI grep-gates `grep -r "claude -p"` empty), WORK flips to
   Codex in the SAME rollout step as background; silent chips first (05 / 10).
9. **Preserve KAIROS memory + self-learning + Composio auto-connect.** Durable
   persona → `thread/start.baseInstructions`; volatile per-turn delta injected
   via `thread/inject_items` BEFORE `turn/start` (codex 0.133 `turn/start` has NO
   `instructions` field — see 14§A1); `recall_memory` → MCP tool; trajectories
   keep feeding AwmWorker unchanged; Composio OAuth stays 100% daemon-side,
   invisible to Codex (11).

## Target architecture (one picture)

```
Voice → STT → fast front (OURS, loop-free, unchanged — chit-chat + routing)
                ├─ [[task]] (smart)  → CodexBrain turn/start { effort: low }
                ├─ [[think]] (deep)  → CodexBrain turn/start { effort: high }
                │      (ONE warm `codex app-server` child, ONE model,
                │       effort overridden per turn)
                │      model calls → OUR PROXY (Responses-in, OR chat-out)
                │                    → OpenRouter (dedicated KAIROS_BRAIN_KEY)
                │      tools  → in-process KAIROS MCP server (guide/act/memory/
                │               Composio search+execute/background); Codex-native
                │               web_search on the responses path
                │      memory → durable persona in thread/start.baseInstructions;
                │               per-turn delta via thread/inject_items (pre-turn);
                │               recall_memory tool
                │      events → translate to our LoopEvents → daemon → TTS + HUD
                │      verify → deterministic gate POST-turn; one re-injected turn
                │      learn  → translate events → TrajWriter.record() (unchanged)
                └─ quick answers / single-tool reads → spoken directly (carve-out)
  background lane → codex exec --json first (rollout step 1, no voice risk)
  proactive (soon) → tick + suggestion-rules.json → synthetic stimulus →
                     SAME CodexBrain path (restraint-gated), silent chips first
HUD: orb stays identity; notch-style state surface (alt) + guidance overlay
     (bullseye / region / scroll / arrow / pills / buddy anchor) + Agents surface
Knowledge: per-app .md docs injected by target app (the ONLY md we generate)
```

## File index

| File | Contents |
|---|---|
| 00-OVERVIEW.md | This master plan, locked decisions, sequencing, file index |
| 01-codex-brain-migration.md | Smart/deep → Codex app-server: process, config, protocol adapter, per-turn effort, verifier port, fallback |
| 02-proxy-server.md | Our intermediate proxy so shipped builds never reveal Codex/OpenRouter; dedicated key, local-then-host |
| 03-ui-guidance-overlay.md | Clicky guidance visual grammar (from the video) → our HUD: bullseye/region/scroll/arrow/pills/buddy |
| 04-ui-notch-hud.md | Notch state surface, Agents surface, original sounds, capture/secure auto-hide, buddy behaviors |
| 05-backend-changes.md | Daemon work: guide/AX protocol extensions, proactiveness on the tick, per-app knowledge docs, file-permission-storm rule, Composio discipline, CODEX_HOME lifecycle, metering |
| 06-steal-from-clicky-checklist.md | Every adoptable detail, prioritized, with current-state diff |
| 07-open-questions.md | Decisions still needed from Nirmal |
| 08-composio-and-tools-in-codex.md | The in-process KAIROS MCP server: how guide/act/web/recall/background + the dynamic Composio toolkit surface reach Codex; Composio connect/auto-connect/self-heal stays daemon-side; who-calls-what (NEW) |
| 09-memory-and-skill-learning.md | Memory split (durable persona → thread/start; per-turn delta → turn/start), recall_memory as an MCP tool, trajectory→AwmWorker self-learning across the swap, persona/soul.md, per-app knowledge docs (NEW) |
| 10-refactor-map.md | The master file-by-file refactor map: every KAIROS file marked REPLACE/PORT/KEEP/NEW, what we retire (defaultPlannerRunner/runAgentLoop behind the flag), dependency-ordered build sequence (NEW) |
| 11-ui-connection-and-event-flow.md | Full daemon⇄HUD event taxonomy, where Codex-turn events plug into the onEvent→agent_* seam, the WS transport, Electron mic/audio role, end-to-end path diagram (NEW) |
| 12-ship-hardening.md | Ship-blockers the critic flagged: codesign/notarize the vendored binaries, warm-child + MCP-server teardown/orphan-reaping, the unattended/proactive security posture, the [[task]]/[[think]] parse seam (NEW) |

> Docs 08–12 are net-new and split out the implementation-heavy material that
> 01/02/05 reference. Vendoring detail lives in 01 §5 + 10 §7 (+ codesign in 12);
> the proxy facade detail lives in 02; proactive routing lives in 05.C + 10;
> the MCP/tools layer is 08; memory/self-learning is 09. 05 folds in
> proactiveness + Composio discipline and cross-refs 08/09/10.

## Sequencing (recommended)

1. **Phase A — Codex backbone** (01 + 02 + 08 + 10; hardening 12):
   - A0: vendoring + isolated `CODEX_HOME` boot generation (01 §5 + 10 §7;
     codesign/notarize per 12).
   - A1: the local proxy facade (Responses→OR-chat translator) with the
     dedicated key (02) — run it from day one so wire bugs surface in dev,
     not at ship.
   - A2: in-process KAIROS MCP server reusing `buildActionToolset` (08).
   - A3: background sub-agent lane on `codex exec --json` (no voice risk).
   - A4: `[[think]]`/deep on app-server threads (effort high).
   - A5: `[[task]]`/smart-voice behind `KAIROS_BRAIN=codex` (effort low),
     A/B latency via `state/logs/turns.jsonl` before flipping the default.
   - A6: port the deterministic verifier gate POST-turn (01 §D) + wire
     trajectory capture → AwmWorker (09) so nothing regresses.
2. **Phase B — Guidance overlay rework** (03 + 05.A): affordance system
   (bullseye/region/scroll/arrow/pills/buddy) on top of the existing lesson
   engine. Biggest visible UX jump; independent of Phase A.
3. **Phase C — Notch/Agents surface + sounds** (04): the "alive" layer; Agents
   cards map 1:1 to Codex threads (10).
4. **Phase D — Proactiveness + app knowledge** (05.B/C + 10): tick rules +
   per-app docs + synthetic-stimulus → CodexBrain (WORK with `claude -p` REMOVED
   entirely, routed to Codex in the SAME rollout step as background — 14 §H1),
   silent chips first.

Every phase stays behind env flags (`KAIROS_BRAIN`, `KAIROS_BRAIN_SMART_VOICE`,
`KAIROS_BRAIN_BASE_URL`, `KAIROS_HIDE_ON_CAPTURE`, …); nothing ships half-on.
`KAIROS_BRAIN` is a TEMPORARY migration/rollback switch (decided 2026-06-12) —
Codex is the destination for ALL agentic lanes (deep + background + proactive
WORK); the flag is removed against an explicit retirement criterion (deep +
background stable on Codex for N days, 14§E), not kept as a standing parallel
brain. The model-alias + key envs (table above) are the ones that persist.

## The seam, restated (why the swap is low-risk)

A turn's events are born as `LoopEvent`s in `runAgentLoop`; the conductor's
`onEvent` (`conductor.ts` 624-651) is the SINGLE translation point mapping
`LoopEvent` → flat `agent_*` events + the activity envelope; `index.ts` 2494
broadcasts each over the WS to the HUD. The planner runner is INJECTABLE
(`this.deps.runPlanner ?? defaultPlannerRunner`, `conductor.ts` 663). So
CodexBrain is implemented as a `PlannerRunner` that emits the SAME `LoopEvent`
shapes — orb, captions, activity tree, TTS, replay, and self-learning all keep
working with zero downstream changes. Do NOT mutate the `LoopEvent` union
(`agents/loop/types.ts` 36-46) during the swap; map any Codex-only signal onto
existing kinds. Note: `LoopEvent` carries `name` on `tool_call_done`/
`tool_call_failed` (not just on `tool_call_start`) — CodexBrain MUST emit the
namespace-stripped tool name on EVERY tool event so the activity-tree + trajectory
naming stay correct (`conductor.ts:631-636`; 14§A5, detailed in 11§5).

## Source artifacts

- `docs/clicky-teardown-research.md` — binary teardown (incl. 2026-06-11 addendum)
- `/tmp/openclicky/` — readable Swift source (87 files), notch captures, internal docs
  (`FULL_SYSTEM_CODE_REVIEW_2026-06.md` enumerates the bugs to NOT port:
  continuation-leak race A1, no RPC timeouts A3, double-startup race A2,
  TOML injection R8, plaintext key-in-env R4, inverted REST-before-Codex R2)
- `/tmp/clicky-video/sheets|frames/` — the user's recording, mapped + key frames
- `/tmp/codex-ts/` — `codex app-server generate-ts --experimental` output
  (ReasoningEffort, v2/TurnStartParams, ClientRequest, ServerNotification, …)
- `docs/2026-06-11-act-mode.md`, `docs/2026-06-11-lesson-sessions.md` — what we
  already built that this plan extends (act mode, lesson sessions, gates)
