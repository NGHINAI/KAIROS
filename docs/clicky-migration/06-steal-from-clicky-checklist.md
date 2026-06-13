# 06 — Steal-from-Clicky checklist (prioritized, with current-state diff)

Every adoptable detail in one place. ✅ = we already have it, 🟡 = partial,
❌ = missing. "Take" = the action. Refreshed 2026-06-12 against the grounded
research pass (codex 0.133.0 protocol bindings, openclicky source, HeyClicky
binary).

## Tier 1 — high impact, do first
| Item | Us | Take |
|---|---|---|
| Region/block highlight (dashed + ~12% fill) | ❌ | Build affordance (03) + AXFinder.unionFrame (05.A) |
| Scroll guidance (edge line + arrow + pill) | ❌ | Build `guide_scroll` + AXFinder.scrollableAncestor (03/05.A) |
| Arrow affordance (comet→highlight) | ❌ | New shared ArrowAffordance view, the user's explicit "add arrows" ask (03/05.A) |
| Bullseye + label pill for single targets | 🟡 (plain ring) | Upgrade ring→bullseye+pill (03) |
| Codex smart/deep brain (warm app-server, ONE model) | ❌ | 01 + 11 |
| Per-turn effort override (low=smart, high=deep) | 🟡 (think flag) | `turn/start {effort}` per turn, not profiles — openclicky-proven (01.E) |
| Hidden proxy + dedicated key (Responses-in, OR-chat-out) | ❌ | 02 + 09 |
| Pinned vendored codex + arch-dispatch shim + bundled rg | ❌ | 08 |
| In-process KAIROS MCP server (reuse buildActionToolset) | ❌ | 11.B (NOT a `bun run` child — it would have no daemon singletons) |
| Composio auto-connect inline on NOT_CONNECTED | 🟡 (SelfHealConnect stashed) | Wire `__kairosComposioExecute` → connectAndRetry (05.E / 11.C) |
| Per-app knowledge docs | ❌ | 05.B |
| Agents visual surface (running/history cards) | 🟡 (voice-only) | 04.B, map 1:1 to codex threads (10) |

## Tier 2 — the "alive" layer
| Item | Us | Take |
|---|---|---|
| Notch state surface (Listening/Thinking/Speaking) | 🟡 (orb only) | 04.A alt surface (orb stays default) |
| State sounds (launch/done/approval/error) | ❌ | 04.C (5 original sounds; do NOT copy their assets) |
| Idle buddy drift + park-at-corner | 🟡 (comet flies, no idle) | 04.E + 03 (Lissajous drift) |
| Buddy emotes (question tilt, done bounce) | 🟡 (blink) | 04.E off existing events |
| Buddy dock-to-notch mode | ❌ | 04.E (reuse cometPos spring) |
| Secure-input/capture auto-hide | 🟡 (recordable flag) | 04.D (secure-input ALWAYS; capture opt-in via `KAIROS_HIDE_ON_CAPTURE`) |
| Assistant-delta UI debounce (~180ms) | 🟡 (StreamSpeechController meters) | Adopt openclicky's 180ms flush to avoid HUD thrash + WS backpressure (01.C) |
| Warm-up turn ("reply ready only") | ❌ | Pre-spin process+thread so first real [[task]] hits a hot session (01.A) |

## Tier 3 — doctrine & polish
| Item | Us | Take |
|---|---|---|
| File-permission-storm rule | ❌ | 05.D (durable thread/start doctrine + daemon guard) |
| Write-readback + no-alias Composio rule | 🟡 (grounded-verify) | 05.E (fold into durable `thread/start.baseInstructions` — NOT a per-turn `turn/start.instructions` field, which does not exist in codex 0.133, 14§A1) |
| Consent before chaining follow-up points | 🟡 (restraint) | 04.F soft consent (`PointFollowUpConsentPromptPanel`) |
| User-pickable guidance color | ❌ | 04.F pref (`OverlayCursorColorButton`, colorblind win) |
| Proactive frontmost-app suggestion chips | 🟡 (tick + cos design) | 05.C + 10 (synthetic stimulus → CodexBrain, silent first) |
| REMOVE `claude -p` entirely; proactive WORK → Codex (NO Claude in runtime, 14§H1; CI grep-gate) | ❌ | 10 / 05.C (the biggest proactive correctness fix; flips in the SAME rollout step as background) |
| Codex web_search on the responses path | ❌ | Enable `tools.web_search` in generated config; do NOT export our DDG tools to Codex (11.B) — keep DDG only for fast tier + bg sub-agents |
| Codex-native effort escalation ("extra effort") | 🟡 (think flag) | Re-run smart turn once at higher effort on budget/forced-final (01.E) |

## Bugs from openclicky's FULL_SYSTEM_CODE_REVIEW to FIX (do NOT port)
| Bug | What | Our fix |
|---|---|---|
| A1 continuation-leak race | `isRunning` checked outside the state queue → session hangs forever | Register the pending promise + guard `isRunning` in the SAME critical section |
| A3 no RPC timeouts | A frozen-but-alive codex leaves every request pending forever | Deadline timers (≈30s initialize/thread-start, 90s turn/start) → reject + restart child |
| A2 double-startup race | Concurrent warmups issue two `thread/start` → permanent confusion | Single shared startup task that re-entrant callers await |
| R8 TOML injection | `escape()` misses `\n`/`\r`/`\t` → arbitrary config keys | Validate model/effort, escape control chars (05.F) |
| R4 plaintext key in env | `OPENAI_API_KEY` in child env, one refactor from being logged | Keep keys in the proxy; child env holds only the per-install TOKEN; never-log allowlist |
| R2 inverted ordering | OpenAI branch tries billed REST before the Codex session | Codex-app-server-FIRST; REST only as fallback |
| (guard) speech model id | `gpt-realtime-*` cannot go through app-server | `isSpeechModelID` check before the Codex attempt |

## Already AHEAD of Clicky (keep, don't regress)
- Metal live orb identity (they have no orb; sprite atlas only).
- Lesson sessions: highlight persistence ACROSS turns + auto-continue on the
  user's click + gentle check-in (their video shows per-instruction guidance,
  not turn-spanning lessons).
- Act mode with strategy-aware verdicts (row-select vs press) + change
  detection + confirm gate (their shipped video is guidance-only).
- Deterministic verifier gate stack (fabrication/do-mode/false-blindness/
  false-done) — they enforce the same intentions with prompt text only. Ours
  ports as a POST-turn gate over the Codex event stream (01.D).
- AX-first, element-index-grounded everything (shared philosophy; ours is
  already built and live-verified).
- KAIROS memory tiers (L2/L3/L4) + ConversationMessageStore layered replay +
  AwmWorker self-learning — all preserved across the brain swap (11).
- Canonical STT/TTS + persona (we keep voice OURS; Codex is the agent run only).

## Explicitly NOT taking
- Their sound/character ASSETS (copyright; we ship original — 04.C).
- OpenAI Realtime voice (we have canonical STT/TTS + persona).
- Their Cloudflare-specific proxy impl (we design our own portable facade, 02).
- The user's homebrew codex / `~/.codex` config (broken `[[hooks]]`; we vendor +
  isolate — 08, 05.F).
- Cat-mode skin / egg hatch (cute, off-brand for KAIROS; our orb↔comet morph is
  the equivalent beat).
- `clicky-crons` remote tasks (we have our own scheduling/cron surface).
- Clicky's flat saturated red for all affordances (we keep warm-gold→cyan
  liquid glass; adopt the GRAMMAR, not the palette — 03/04).
- `wire_api="chat"` to Codex (0.133.0 hard-rejects it; the proxy must speak
  Responses inbound — 02/09).
- A standalone `bun run kairosMcpServer.ts` MCP child (it would start with NONE of
  the daemon's live singletons; run the MCP server in-process — 08.B).
