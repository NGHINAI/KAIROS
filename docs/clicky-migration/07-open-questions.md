# 07 — Decisions: answered + still open (rev. 2026-06-12)

## ✅ ANSWERED (locked — see 00 "Confirmed decisions")

- **07.2 Dedicated key** — YES, a separate key. Env `KAIROS_BRAIN_KEY`, never
  the daemon key. Nirmal will provide it. (→ 02)
- **07.3 "Write off the guide"** — REWORK the visuals, KEEP the engine. Lesson
  sessions + act mode + verifier gates all stay; we add the Clicky affordance
  grammar (arrows/scroll/region/bullseye) on top, keeping the robot-face orb +
  rectangle highlight, made seamless. (→ 03, 11)
- **Effort model** — ONE model, effort PER TURN on `turn/start` (research
  confirmed the override exists + openclicky uses it). smart = low/minimal,
  deep = high/xhigh. `[profiles.*]` are NOT our effort mechanism. (→ 01 §1)
- **Vendoring** — build/bundle codex like a real product (pinned per-arch
  binary + arch shim + bundled rg + isolated CODEX_HOME). NOT the homebrew
  codex. Dev may use the local one. (→ 01 §5, 10 §7, 12 §A)
- **Proxy local-then-host** — one portable `fetch` handler: Bun on 127.0.0.1
  now, same handler as a Cloudflare Worker later; only `base_url` changes.
  Run the facade even in dev (OpenRouter's `/v1/responses` is beta — don't
  point codex straight at it). (→ 02)
- **07.7 Act vs guide default** — "do/switch/change/open X" → ACT; "how do I /
  teach / show me" → GUIDE. Matches the DO_ASK_RE/TEACHING_RE split we built.

## ★ STILL OPEN — please decide (blocks the most work first)

### 07.1 ✅ ANSWERED — MiniMax, env-swappable
Decided 2026-06-12: pilot on **MiniMax**, wired as the alias `kairos-smart`/
`kairos-deep`; the real slug is set via `KAIROS_BRAIN_MODEL_*` env (00 env
table), so swapping later needs NO app/config change. (codex 0.133 rejects
`wire_api="chat"`, so the proxy speaks Responses→OpenRouter-chat regardless of
model.) No further input needed — env handles future changes.

### 07.4 ✅ ANSWERED — keep smart-voice on OUR loop
Decided 2026-06-12 (see 00 LANE DECISION). Smart voice stays on our tuned
low-latency loop; Codex takes deep + background + heavy/multi-step agentic work
(where its harness dominates and latency is free). A heavy smart turn may
escalate to Codex. Rationale: Codex adds first-token latency with ~no benefit on
conversational turns. Revisit per-task with the escalation hook.

### 07.NEW-1 ★ Unattended (proactive) security posture — CONFIRM PLEASE
(Explained in the 2026-06-12 reply.) When you're PRESENT, Codex acting (click/
type) is fine — you're watching + our confirm-gate covers risky buttons. When
UNATTENDED (proactive, you're away), Codex gets a RESTRAINED toolset: read/
search/draft only; anything irreversible (click/type/send/delete) becomes a
PARKED proposal you approve later. (→ 12 §C.) This is the only one I still need
a yes/no on — it's how "proactive" stays safe by construction.

### 07.9 / 07.NEW-2 ⏸ DEFERRED by Nirmal — Apple Dev ID after coding
Vendored `codex`/`rg` must be codesigned + notarized with an Apple Developer ID
(→ 12 §A) to pass Gatekeeper on a shipped build. Nirmal will provide the Dev ID
LATER (after the code exists). Dev/local builds don't need it; only matters at
ship. Lean: bundle the pinned binary, single-arch per build.

### 07.5 Notch vs orb default
Lean: orb stays the identity; notch state-surface is opt-in + the fallback for
non-notch Macs. OK?

### 07.6 Proactiveness aggressiveness
Lean: silent chips first (appear in notch Home, never spoken unless engaged);
earn voice later. Confirm frequency comfort (per app-switch? per hour?).

### 07.8 Proxy hosting (when we host)
Lean: Cloudflare Worker + token store via our existing Supabase. OK, or prefer
a Bun service / different store?

### 07.10 Video deep-dive
I mapped the System Settings walkthrough (bullseye/region/scroll/pills/buddy).
If a specific moment is the UX you most want matched, give me the timestamp and
I'll extract that span at high frame rate.

## Cross-refs
00 (decisions+sequencing) · 01 (brain) · 02 (proxy) · 08 (tools/MCP) ·
09 (memory/skills) · 10 (refactor map) · 11 (UI/events) · 12 (ship hardening).
