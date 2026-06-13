# 04 — Notch states, Agents surface, sounds, hide-modes, buddy

Sources: openclicky source (`OpenClickyDynamicNotchKitBridge.swift`,
`OpenClickyNotchCaptureWindowManager.swift`), openclicky captures
(`/tmp/openclicky/captures/*.png`), HeyClicky binary symbols, the user's video
(notch visible throughout). Decision 07.5 stands: the **Metal orb stays the
default identity**; the notch surface is an opt-in minimal mode + the fallback
for non-notch Macs.

## A. Notch state surface (video + openclicky source)

openclicky's notch = DynamicNotchKit, styled `.notch(topCornerRadius:13,
bottomCornerRadius:20)`, `hoverBehavior [.hapticFeedback, .increaseShadow,
.keepVisible]`, `skipIntermediateHides=true`, with three presentation states
(hidden / compact / expanded) and a model `Mode` of `.collapsed` or
`.voice(phase)`. The phase enum is the SAME idle/listening/processing/responding
KAIROS already has.

Verified visual phases (`/tmp/openclicky/captures/{listening,thinking,speaking}
notch.png`) + accent mapping (`activityAccentColor`, `compactActivityTitle`):

- **Listening** — word "Listening" + calm **systemCyan** level bars at the right
  edge (driven by mic VAD level).
- **Thinking** — word "Thinking" + **systemPurple** trailing animated dots; a
  deeper variant shows phrases ("Thinking deeply…") during long reasoning.
- **Speaking** — word "Speaking" + live **systemOrange** waveform bars at the
  right edge (their equivalent of our tts_level-driven lobes).
- **Agent live-activity** — **systemIndigo** accent when a background agent is
  running (ties to the Agents surface, B).
- Adjacent tooltips name the app being acted on ("System Settings") when the
  agent opens/targets one.
- Idle = invisible (notch looks stock).
- Expanded width 560pt (760pt when a context suggestion chip is shown).

KAIROS mapping: every signal already exists in the daemon event pipeline —
- `agent_speaking` envelope + `tts_level` stream → Speaking + orange waveform
  (the authoritative playback level comes from the Electron renderer's
  `{cmd:'tts_level'}` every 66ms; the Swift HUD only RENDERS the reported level,
  it never captures audio).
- `agent_planning`/think events → Thinking + purple dots.
- VAD-armed (`listening_started`) → Listening + cyan bars.
- `open_app`/act events → app tooltip; background `task_*` → indigo live-activity.

Build `NotchStatePanel` in KairosHUD as an ALTERNATIVE surface to the orb
(user-selectable). Keep our warm-gold→cyan material rather than copying flat
system colors — map their phase semantics onto our palette (Listening=cyan
already matches; Speaking can be our gold; Thinking a cooler tint). Non-notch
Macs get a top-center pill fallback (openclicky does exactly this: shows a
fallback pill and `orderOut`s DynamicNotchKit on external/no-notch screens).

## B. Agents surface (openclicky "agents tab" capture)

The notch expands DOWN into a tabbed panel (Home / Agents / ⚙):
- **RUNNING cards**: title ("Saving Stripe to Notion"), live status line
  ("Notion is connected; I'm checking for the existing database now."),
  RUNNING pill, progress bar, cancel ✕.
- **TODAY history**: finished cards w/ one-line result, file-attachment chips
  (csv shown), and **Open Agent** to jump back into that thread.

KAIROS mapping: our background lane already emits everything needed —
`task_spawned`/`task_tool`/`task_progress`/`task_done`/`task_report` (Lane B,
`DaemonClient.swift` 352-380), the activity tree, and per-task ids. This is the
missing VISUAL for it — today it's voice-only. Build `AgentsSurfaceView` fed by
existing `background_tasks` + activity events; cancel ✕ → existing task cancel.

**Thread↔card mapping (reconcile with 10):** with the Codex brain, one
proactive/background Codex thread = one card. The live status line comes from
`tool_call` events; progress from the activity tree; **"Open Agent" resumes that
codex thread id** (`thread/resume`). The Home tab also hosts the proactive
**suggestion chips** (05.C / 10): quiet, never-spoken-until-engaged candidates
evaluated on the tick. Decide in 10 whether proactive concerns reuse the
foreground conversation thread (continuity, "send that Patel draft" days later)
or always spawn isolated threads — the durable concern↔thread map suggests we
need persistence either way.

## C. Sound language (HeyClicky resources)

Distinct, tiny sounds for state transitions — agent-launch / agent-done /
agent-close, text open/close/send/receive, question & surprised character
emotes, skill-up/down, hatching (onboarding). KAIROS today: silence except TTS.

Adopt **5 sounds first**, ship our OWN ORIGINAL files (do NOT copy theirs —
different product identity, and theirs are copyrighted assets):
- listening-start, agent(task)-launched, task-done, approval-needed, error.

Route from existing daemon events in the HUD (`listening_started`,
`task_spawned`, `task_done`/`task_report`, `approval_request`, `agent_error`).
Keep them SUBTLE — KAIROS is a co-worker, not a game. A user mute pref.

## D. Auto-hide compatibility modes (HeyClicky + openclicky)

openclicky's notch NSPanel: `[.borderless, .nonactivatingPanel]`, collection
behavior `[.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]`, window level
`statusBar+1` (main panel +2, dialogs +3) — the SAME recipe as our orb panels.

HeyClicky symbols `wasOverlayVisibleBeforeSystemCaptureCompatibilityMode` /
`…SecureCommerceCompatibilityMode`: they automatically HIDE all overlays when
(a) a screen capture/recording starts, (b) secure/payment input is active —
then restore.

KAIROS: we made the HUD recordable-by-default (user demos). Adopt the inverse as
OPTIONS:
- detect secure-input (`IsSecureEventInputEnabled()`) → **auto-hide overlays
  during SECURE INPUT ALWAYS** (passwords; non-negotiable),
- detect `SCStream`/screen-capture activity → auto-hide only if
  `KAIROS_HIDE_ON_CAPTURE=1` (DEFAULT stays visible — our demos depend on it).
- Store the pre-hide visibility and RESTORE on exit (their
  `wasOverlayVisibleBefore…` pattern).

## E. The buddy / character

Clicky: triangle cursor character, permanent presence, idle drift, parks at
affordances; sprite-atlas "cat mode" skin behind a flag; egg-hatch onboarding
moment (+hatching.wav); a docked buddy parks as a yellow/orange triangle at the
right end of the notch.

KAIROS: the comet (orb-born, with eyes) IS our buddy. Adopt the BEHAVIORS, not
the art:
- **idle-drift presence** during active voice sessions: a slow Lissajous near
  the screen edge when no affordance is active, instead of instantly re-forming
  the orb (reuse `GuideModel`'s `cometPos` spring + blink timer; toggleable; ties
  to 03's idle buddy + this section's dock mode).
- **park-at-affordance-corner per kind**: beside the bullseye ring / at the
  region's top-left corner / at the scroll pill's tip (03).
- **dock-to-notch mode**: the comet can park at the right end of the
  `NotchStatePanel` (their docked-buddy beat) — reuse the same spring.
- **emotes off existing daemon events**: blink exists; add "question tilt" when
  asking/awaiting approval (`approval_request`), "happy bounce" on task-done
  (`task_done`/`agent_done`).
- The orb↔comet morph remains our signature onboarding/demo moment — our
  equivalent of their hatch. (Note: today's "morph" is a panel-alpha crossfade,
  not a true morph, `OrbPanelManager.swift` 107-118 — fine to keep; the comet
  launches from / returns to orb center via `orbCenterProvider`.)

## F. Misc UI details worth keeping (binary symbols)
- `PointFollowUpConsentPromptPanel` — consent before continuing to point at
  follow-up items: maps to our restraint doctrine; we already gate destructive
  acts, add a soft consent when a guidance session wants to chain beyond the
  asked scope (also the proactive consent beat, 10).
- `OverlayCursorColorButton` — user-pickable guidance color. Cheap setting,
  accessibility win (red-green colorblind users). Add to our HUD prefs; the
  default stays our warm-gold→cyan, not Clicky's red.
- Paywall/onboarding panels exist as separate HUD windows — irrelevant now, but
  confirms the multi-panel architecture we already use scales.

## G. Transport note (no change needed for the Codex swap)
The HUD is a pure projection of ONE WebSocket (`ws://127.0.0.1:9876/v1/voice/
events`); the Codex swap happens entirely behind `conductor.onEvent` and is
INVISIBLE to `DaemonClient`'s orb-state cases. The only HUD-side additions are
the new guide_request `kind`/region/scroll/arrow fields (03/05.A) and the new
`NotchStatePanel` + `AgentsSurfaceView`. Watch the backpressure risk: a Codex
turn streaming `assistant_delta` at token speed can starve the broadcast loop
(`server.ts` already logs `send<=0` drops) — meter/debounce deltas (~180ms,
06 Tier 2) as the StreamSpeechController already does.
