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
