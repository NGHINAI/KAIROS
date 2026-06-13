# Guide Mode — the orb becomes the guide (2026-06-10)

The Clicky-inspired wow moment, built end-to-end: ask "where's X?" or "walk me
through Y" and the ORB DISSOLVES — a small guide comet (same liquid-light
language, plus blinking eyes) rises from the orb's position, flies to the actual
UI element, hovers there while a gradient ring breathes around the target and a
glass caption names it. Next step → it glides to the next element. Turn ends →
it flies home and the orb re-forms.

## Perception: why there's no latency
AX-first, validated by research into shipped products: Clicky v1 was pure
screenshot→Claude→[POINT:x,y] (~2–5s/turn); shipped HeyClicky moved to Cua,
which is ACCESSIBILITY-TREE-first (coordinate clicks blocked; element_index
addressing). An AX lookup is ~50ms vs ~2500ms for screenshot+VLM. KAIROS Guide
Mode resolves elements with `AXFinder` (scoped tree walk, fuzzy label match,
role-weighted scoring, 2s budget/6k nodes) — no screenshots anywhere. Vision
fallback (local YOLO/OCR ~0.2s) is the future tier for the ~40% of apps with
poor AX exposure; out of v1 scope.

## The pieces
- **Daemon** — `agents/guideBridge.ts` (request/response over the voice WS,
  timeout→null, turn-end `guide_end`), `agents/guideTools.ts` (`guide_user`
  tool: per-step, teaching errors, degrades to verbal guidance when no HUD),
  wired in index.ts (actionTools + `guide_result` command + endIfActive in
  handleUtterance finally). Read-only (verifier LOCAL_TOOLS). Front routing
  examples added ("where's the export button?" → [[task]]).
- **HUD (Swift)** — `Guide/AXFinder.swift` (element resolution + AppKit coord
  flip), `Guide/GuideModel.swift` (state machine: hidden/active/returning;
  comet launch from orb center, hover above target, blink timer, fake-target
  dev hook), `Guide/GuideOverlayView.swift` (comet w/ eyes + breathing glow,
  TargetHighlight gradient ring, CaptionPill on glass), OrbPanelManager (full-
  screen click-through guide panel, orb alpha-fade morph), DaemonClient
  (guide_request/guide_end cases + sendGuideResult).
- **WS protocol** — `guide_request {id, find, app?}` → `{cmd:'guide_result',
  id, found, label?, reason?}` → `guide_end`.

## Demo / dev flags
- `swift run KairosHUD --guidetest` — rehearse the FULL choreography with fake
  targets (no daemon, no AX permission): orb dissolves → comet flies to two
  "elements" → highlights + captions → returns.
- **Recordable by default** (2026-06-10): HUD panels are `sharingType=.readOnly`
  so demo recordings capture the orb/console/guide out of the box. Pass
  `--capture-invisible` to flip back to `.none` (Phase-H hygiene: the agent's
  own screenshots must not contain the HUD).
- Live pointing needs the Accessibility permission: System Settings → Privacy &
  Security → Accessibility → enable the KairosHUD binary. Without it the tool
  degrades gracefully (KAIROS guides verbally and says why).

## Verified
- Protocol E2E live (fake-HUD smoke): "show me where the Privacy and Security
  section is in System Settings" → planner called guide_user (normalized the
  label to "Privacy & Security", app="System Settings") → result → spoken
  instruction → guide_end on turn completion.
- Unit: guideBridge/guideTools 8 tests. Swift + Electron + daemon all build.
- Full regression: agents 362 · llm 63 · wrapApi 32 · connectors 136 · skills
  96 · voice 86 (+1 pre-existing boot-timeout) · memory per-file green.
- Streaming think deadline → 30s + third filler (minimax first-token measured
  3s–24s variance); live: laptop rent-vs-buy streamed 12 chunks.

## Next tiers (not in v1)
AXObserver cache invalidation + pre-warm on VAD; Electron AXManualAccessibility
attribute for Chromium trees; local detector fallback (Cua som / Screen2AX);
multi-display overlays; guide → Ghost Hands actuation (same AX index becomes
element_index addressing for Phase H computer use).

## Hardening pass (2026-06-10 PM — REAL E2E now verified)
Live-debugged against the real HUD + real System Settings until the full chain
worked: voice ask → AX walk → comet pointing at the actual "Privacy & Security"
sidebar row → spoken confirmation. Fixes found by doing:
1. **AX permission never prompted** — `AXIsProcessTrusted()` is silent by design;
   first guide attempt now fires the system grant dialog via
   `AXIsProcessTrustedWithOptions(prompt:true)` (once per process).
2. **Single AX calls can hang** (System Settings right after launch blocked a
   walk past the bridge timeout) — `AXUIElementSetMessagingTimeout(systemWide,
   0.3)` caps every call so the walk's own 2.5s deadline actually works.
3. **Wrong-element matches** — "Privacy & Security" matched "AppleCare &
   Warranty" via the shared "&" token. Matcher now requires ALL meaningful words
   (no partial-overlap commits), drops 1-char tokens, and normalizes "&"↔"and"
   (STT says "and"; macOS labels use "&").
4. **SwiftUI zero-frames** — System Settings reports 0×0 frames on sidebar text
   nodes; `resolvedFrame()` climbs ≤4 ancestors to the row with real geometry.
5. **Windows walked before menus** — what the user can SEE wins ties.
6. **Dev probe**: `KairosHUD --axprobe "<query>" "<App>"` dumps the walk
   (role: label [score, frame]) — how 3 and 4 were found.

## Orb speech motion fixed (same pass)
The orb sat static mid-speech: lobes were driven by tts_chunk RMS, but chunks
arrive at DOWNLOAD speed (a burst at the start). Now the Electron renderer taps
its playback graph with an AnalyserNode and streams `{cmd:'tts_level', level}`
(~15Hz while audible); the daemon rebroadcasts as `tts_level`; the HUD ingests
it for the lobes (chunk-RMS demoted to fallback). Level now tracks what is
ACTUALLY audible, in sync with the agent_speaking envelope.

## Self-healing + session fixes (2026-06-10 evening, user-session diagnosis)
The user's real session exposed three gaps, all fixed + live-verified with
System Settings CLOSED at the start of the ask:
1. **The app wasn't open and KAIROS made the USER open it** — now `open_app`
   (argv-only `open -a`, no shell) exists AND `guide_user` SELF-HEALS: app not
   running → opens it itself → waits 2.2s for the AX tree → retries once.
   Deterministic tool-level chaining (models fumbled the two-step dance).
2. **"okay it's open now" routed to chit-chat** and never retried the guide —
   front routing examples added for post-step confirmations mid-walkthrough.
3. **Two more self-echo phrasings memorized + parroted** ("can't directly
   guide/show", "on-screen guide isn't available") — FAILURE_ECHO_RE verb class
   extended (help|guide|show|point|look up|search|research), rows quarantined.
Ops gotcha: `lsof -ti:9876` lists CLIENTS too — killing it nukes the HUD/Electron
(why the HUD "kept dying" between tests). Kill the listener only:
`lsof -ti:9876 -sTCP:LISTEN | xargs kill -9`.

## Dynamic guidance — the Clicky loop (2026-06-10 night)
HeyClicky's dynamism = snapshot-act-verify over the AX tree (get_window_state).
KAIROS's pointing equivalent shipped:
- **read_screen tool** (daemon ⇄ HUD `screen_request`/`screen_result`): the visible
  element inventory of any app (AXFinder.inventory — grouped Items/Buttons/Toggles/
  Fields/Labels, ≤90 entries, ≤2.4k chars). Look BEFORE planning steps, look AFTER
  the user acts. Framed "planning ONLY — never read aloud".
- **guide_user miss → read_screen** teaching (don't guess wordings; point at what's
  actually there) and the VOICE-SYNC contract in the success result: SAY one line
  naming the element + its location, then WAIT — never narrate ahead of the screen.
  System-prompt talkRule added (words must match the visible highlight; one step at
  a time; never read screen contents aloud).
- **WS idle-timeout bug (the random "guide isn't cooperating")**: Bun drops clients
  that SEND nothing for 120s; the HUD is receive-only → silently half-open, requests
  vanished. Fix: idleTimeout 960 + HUD 20s `hud_keepalive` (failed send → reconnect)
  + connection-lifecycle stderr logs. HUD now survives daemon restarts (verified:
  auto-reconnect retry loop).
- **The GENERAL self-echo cure**: `stripSelfEcho()` — recalled voice memories carry
  ONLY the user's words; KAIROS's replied half is stripped at injection (kills all
  four mimicry flavors: failure/promise/denial/SUCCESS echoes — "There it is." with
  no action). Facts from replies still reach L3 via the consolidator. Front rule:
  recalled memory is background, never live state to resume.
- 39 synthetic test observations quarantined (drive-script utterances polluted recall).
Final live runs: "Battery" pointed with exact sync speech; teach flow opens the app
itself, points, speaks the step, waits. REAL multi-step teaching (user actually
clicking between steps → read_screen grounding the next step) needs a human run.

## The auto-advance loop — LIVE-VERIFIED (2026-06-10, late)
The user's light-mode session showed the remaining gaps: model GUESSED "Displays"
(never looked), every step needed a "done" prompt (turn-per-step), and "Opening
guide now" ack chatter on every call. All fixed; the whole lesson now runs in ONE
turn with auto-advance:
- **wait_for_screen tool** (bridge `watch_request` → HUD polls AXFinder 600ms until
  the step's effect appears or timeout ≤120s; generation counter cancels on guide
  end). Timeout → read_screen recovery, not nagging.
- **WALKTHROUGH GATE** (verifier, deterministic): teaching ask + pointed + no
  wait_for_screen after it → turn bounced ("keep guiding in this same turn").
  "Show me where X is" asks exempt (pointing IS the answer).
- **WALKTHROUGH_PROTOCOL** on every guide tool: read_screen first (never guess
  panes — the Displays bug), point+speak per step, wait, repeat in-turn.
- **Ack/filler silencing**: SILENT_ACK_TOOLS (guide_user/read_screen/
  wait_for_screen/open_app/recall_memory/update_plan) — no more "Opening guide
  now"; fillers suppressed while wait_for_screen runs (silence = user is clicking).
- AX hardening: messaging timeout set on the APP element too (system-wide alone
  didn't stop a fresh System Settings hanging a walk >8s); guide_result latency
  logging (36–215ms observed). PROMISSORY_RE += guide/show/walk you.
  DEFAULT_MAX_TURNS 12→16 (a 5-step lesson is ~10-12 tool rounds).
Verified end-to-end with a simulated user click (programmatic pane switch): point
Appearance → watch → miss Dark → read_screen → re-point → click simulated → AUTO-
ADVANCED → point Dark → watch Light → "That's all there is to it!"

## Better-than-HeyClicky architecture pass (2026-06-10 night, converged)
User session debug found: wrong pane from memory (Displays/Appearance for other
goals), per-step turn fragmentation, "Opening guide now" chatter, verifier concern
text LEAKED to TTS, tool-result text spoken raw, question-finals dodging all gates,
walkthrough memory echoes scripting the wrong lesson, HUD reconnect dead after
daemon restarts. The HeyClicky lessons applied + our loop:
1. **Grounded addressing (Cua element_index, adapted)**: read_screen returns a
   NUMBERED inventory; the HUD caches the snapshot; guide_user({element:N}) points
   into it (label fallback re-resolves the SEEN label for freshness, cached rect as
   backstop). You can only point at what you've seen.
2. **Teaching turns THINK**: TEACHING_RE routes smart=gemini-2.5-flash WITH thinking
   (reasoning still excluded from speech); KAIROS_GUIDE_THINKING=0 opts out. Verify
   adapter pinned thinking-off. maxTurns 26 for teaching turns (lessons are long);
   budget-exhausted forced finals say "say continue" instead of "didn't catch that".
3. **Verify-retry architecture**: deterministic gates (promissory, look-first,
   never-looked, pointed-not-watched, described-not-pointed) are retryable —
   ONE in-loop action round with the concern as a user-role note; the spoken hedge
   NEVER carries internal concern text (the TTS leak). Look-first + never-looked
   apply even to question-finals (questions are only legitimate AFTER looking).
4. **Echo hygiene**: WALKTHROUGH_ECHO_RE — "teach me X"/"done I clicked" memories
   never injected (they scripted the wrong lesson); 22 more rows quarantined.
5. **Speech hygiene**: empty-final tool-result fallback ALLOWLISTED (spawn/bg only);
   SILENT_ACK_TOOLS already killed the ack chatter.
6. **HUD reconnect bulletproofed**: scheduleReconnect main-serialized + task.cancel
   + logging, 10s watchdog (nil task never stays nil), keepalive send-failure path.
   Verified: daemon killed under a live HUD → retried through boot → reattached.
Final trace (wallpaper lesson): look → point → wrong-guess caught by instant-wait
teaching → look → POINT "WallPAPER" (goal-matched) → wait → speculative next-pane
expectation missed → look → re-point → continue. Misses self-heal via observation.

## The self-barge-in cascade (2026-06-11, user voice-session debug)
Symptoms: "sometimes it doesn't work, sometimes it stops, sometimes I speak and
nothing responds." Ground truth showed every dead turn killed by `barge_in`
arriving EXACTLY when the answer started playing (+13s/+10s/+2s): the renderer's
Silero VAD hears KAIROS'S OWN VOICE through open speakers (AEC residual) and was
ABORTING the very turn it was hearing. Three consecutive turns ("yes", "Hello?",
…) died silently this way.
Fixes:
- **Barge-in is now AUDIO-ONLY** (both renderer + sidecar paths): stops the
  speaker instantly, broadcasts `tts_stopped`, NEVER aborts the turn. A real
  interruption is followed by an actual utterance — and THAT supersedes the turn
  (unchanged). False echo-triggers now cost a trimmed sentence, not a dead turn.
  Live-verified: barge_in fired mid-speech → audio cut → turn completed with its
  full grounded reply.
- **Guide ownership guard**: a superseded zombie turn finishing late can no longer
  retract the NEW turn's on-screen guide (endIfActive only fires for the still-
  current turn).
- **Hedge de-baited**: "Want me to double-check?" invited doomed contextless "yes"
  turns → now "Tell me what you'd like me to do next."
- **Log hygiene**: tts_level (~15 lines/sec!) and tts_playback no longer trace-
  logged — diagnostics were drowning.
Also acknowledged: many of the session's guide failures were caused by MY daemon
restarts killing the user's HUD connection (pre-watchdog) — the standing rule
"don't restart the daemon during user testing" exists for exactly this.

## Full QA matrix pass (2026-06-11)
All suites green (agents 376 · voice 86+1 pre-existing · llm 63 · wrapApi 32 ·
connectors 136 · skills 96 · memory per-file) + Swift/Electron/daemon builds.
Live E2E (real daemon + real HUD): chit-chat ✓ · calendar first-try ✓ · web
research ✓ · streaming think ✓ (now DETERMINISTIC for explicit asks —
EXPLICIT_THINK_RE overrides the front's stochastic routing) · Dock pointing ✓ ·
self-heal pointing (app closed → opened itself → pointed Battery) ✓ · teaching
arc ✓ (look-first → point → instant-wait teaching → unchanged-screen circuit →
goal-correct "Wallpaper" → grounded collaborative ending) · barge-in mid-speech
audio-only, turn survives ✓ · supersede (new turn answers; aborted turns now end
QUIETLY — no phantom "wasn't able to finish" in transcript) ✓ · background task
with accurate spoken report ✓.
Fixed during the pass:
- Zombie-handshake WS mode: TCP connect during daemon boot, upgrade never
  completes, sends buffer silently → daemon now ACKs hud_keepalive PER-SOCKET and
  the HUD watchdog force-reconnects after >50s of inbound silence.
- read_screen DOOM-LOOP (20 identical looks): the loop's stall guard was firing
  as role:"system" (gemini ignores it — switched to user-role like every other
  nudge) + read_screen returns an ACT-NOW demand when the screen is unchanged.
- Walkthrough gates now carry GROUNDED corrections ("Click the highlighted item
  and tell me when you're done…") so retry-exhausted lessons end useful, not hedged.
