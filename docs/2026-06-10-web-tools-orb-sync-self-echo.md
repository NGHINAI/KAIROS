# Web tools · Orb↔speech sync · Self-echo memory guard (2026-06-10)

Three production fixes from the "halting flight-research session" diagnosis. All
unit-tested + live-verified. Not committed.

## 1. The halting session — what actually happened

Ground truth (turns.jsonl + daemon.log, 13:37 local):
- "Can you research flights to San Francisco?" → smart turn, ZERO tool calls,
  reply "I've started looking into flights… in the background" — a hallucination
  (`smartNoTools` warn fired). No web-search capability existed (toolkits: gmail,
  gcal, notion, linear).
- "Continue." → correctly reported no running task. "Yes." → spawned a bg task.
- 40s later the daemon got an external SIGTERM (a kill/restart — not a crash).

Two root causes, both fixed:

### a) No web capability → `src/daemon/agents/webTools.ts`
`web_search` + `read_webpage`, FREE (DuckDuckGo HTML endpoint primary, lite
endpoint fallback, no API key). Text results (shaper-lossless), AbortController
timeouts (`KAIROS_WEB_TIMEOUT_MS`, 12s), browser UA, SSRF guard (no localhost/
private ranges/non-http), teaching errors ("HTTP 429 — try a different result
URL"), bounded output (8 hits / 9k chars head-weighted). Registered in
actionTools (disable: `KAIROS_WEB_SEARCH=0`), read-only in verifier LOCAL_TOOLS,
and `connectedAppsLine` now says the public web is ALWAYS reachable (the old
"only these integrations" line taught the model research was impossible).

**Live proof:** "cheapest nonstop NYC→SFO in August, check an actual page" →
web_search → read_webpage (429 → self-corrected to another URL) → re-search →
JetBlue page → "$97 one-way in August, seen 2 hrs ago". Fully autonomous.

### b) Self-echo memory poisoning, GENERALIZED
The bad session's own replies were memorized, FTS-recalled by the same question,
and PARROTED (zero tools, same fake promise). Three poison classes now guarded:
- failure echoes ("having trouble…") — the original Notion incident;
- **promise echoes** ("I've started looking into…") — teach response mimicry;
- **capability-denial echoes** ("I can't directly help", "I don't have access/a
  X tool") — teach permanent inability.
Fixes: `isSelfEchoMemory()` (contextBuilder, used by the turn delta AND
recall_memory), `PROMISSORY_RE` exported from verifier and applied at the
RECORDER (voiceObservation — promissory replies never memorized), FAILURE_ECHO_RE
extended with denial phrasings, and 17 existing poison rows quarantined
(superseded_at). PROMISSORY_RE also broadened ("i've started/begun", "i'm
researching/working on/looking into") so the verify gate catches those finals.

## 2. Orb↔speaking sync — the speech envelope

The orb keyed on per-phrase `tts_begin`/`tts_end`: it STROBED at every sentence
boundary (StreamingSpeaker speaks phrase-by-phrase) and stopped seconds early
(`tts_end` = chunks DOWNLOADED; renderer Web Audio keeps playing its buffer).

New chain — one authoritative `agent_speaking {speaking}` event:
- `SpeakingStateTracker` (src/daemon/voice/speakingState.ts): renderer playback
  acks (ground truth) overlaid on the synthesis envelope (fallback); broadcasts
  on change only.
- `StreamingSpeaker.onSpeaking`: envelope true at first phrase of an utterance,
  false only when fully drained (or cancelled) — never dips between sentences.
- Renderer (apps/electron App.tsx): 150ms poll of `PcmPlayer.isPlaying()` →
  `{cmd:'tts_playback', playing}` on change + 2s keepalive while playing. Also
  re-anchors the barge-in debounce (`lastTtsEndAt`) to REAL audio end.
- HUD (DaemonClient.swift): `agent_speaking` drives the orb (speaking / back to
  thinking-if-turn-active / idle); per-phrase tts_* demoted to legacy fallback
  (only used if no envelope event ever arrives). `turnActive` tracking added.

**Live proof:** 21 streamed delta chunks → exactly 3 envelope transitions (ack,
work pause, reply), no strobe. Note: headless verification exercises the
synthesis-envelope fallback; with the Electron app running, playback acks take
over automatically (same event, better timing).

## Verification
agents 354 ✓ (0 fail) · voice 86 ✓ (+1 pre-existing boot-timeout) · Swift HUD
builds · Electron renderer builds · live: flight research E2E with real prices.

## Watch-outs
- The stale-daemon gotcha struck AGAIN mid-verification: `pkill -f voice-live`
  missed a daemon started another way; the replacement logged "Refusing to
  start" while the OLD one served traffic. Kill by port: `lsof -ti:9876 |
  xargs kill`.
- DDG can 429/202 under load — the tool teaches the model to try another URL;
  if it becomes chronic, add a `KAIROS_SEARCH_URL` SearXNG override.
