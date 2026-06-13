# Lesson Sessions — guidance that outlives the turn (2026-06-11)

The user's two live sessions exposed the core flaw of turn-scoped guidance:
highlights vanished before KAIROS finished speaking, lessons died the moment a
turn ended ("I'm in Appearance now, what?"), "highlight it again" did nothing,
and the fast front ANSWERED teaching asks from memory — five gaslighting
"I'm highlighting Light again" replies with zero tools.

User-locked design (2026-06-10 Q&A):
- Highlight persists until the user dismisses by VOICE (anything they say) or
  by ACTING (clicking / screen change). Never by turn end.
- Full auto-continue: the lesson watches the screen BETWEEN turns; a click
  advances the lesson with speech + the next highlight, no prompting.
- The comet stays out for the whole lesson; the orb re-forms at the end.
- ~30s stuck → ONE gentle voice check-in, then quiet.

## Architecture

**GuideLessonManager** (`src/daemon/agents/guideLesson.ts`) owns the entire
guide lifecycle across turns:
- A teaching-turn `guide_user` starts a durable LESSON (goal, last point, step
  note, stepsCompleted). Non-teaching points are STANDALONE highlights.
- Turn start (`onUserUtterance`): lesson + dismissal phrase → end; standalone +
  ANY speech → retract. watchEpoch bump invalidates all in-flight watchers.
- Turn end (`afterTurn`, ownership-guarded in index.ts): lesson → arm the
  between-turns change watcher; standalone → arm act-dismissal watch.
- Change watcher fires → inject `[[lesson-continue]]` (visible text "Done.
  What's next?" — deliberately matches WALKTHROUGH_ECHO_RE so it never enters
  recall). The synthetic turn yields to any live real turn.
- `contextBlockFor(cid)` renders the resume block ("## Active walkthrough…")
  or the re-highlight hint for the planner.
- `endRequestFromModel` REFUSES end_lesson while stepsCompleted == 0 (live:
  the model pointed once and instantly declared the goal complete).

**Conductor** (`conductor.ts`):
- Lesson-active / synthetic turns SKIP the fast front → planner with the
  lesson block appended to instructions (never the utterance).
- FABRICATED_ACTION_RE: a front answer claiming highlight/point/show/open is
  discarded → forced [[task]] (the front has no tools; the claim is a lie by
  construction).
- Lesson continuations count as teaching turns (thinking on, maxTurns 26) via
  the "## Active walkthrough" instructions marker.

**Verifier** (`loop/verifier.ts`):
- TEACHING_RE broadened ("show me how", "how to switch", "how i can…" —
  verb-listed so "how to think about X" stays a plain question).
- New GUIDE_RE tier (show me where / highlight / point at): look+point gates
  without forced waiting.
- New SCREEN_OFFLOAD_RE gate: "can you tell me what app you're in?" is flagged
  even on question-finals — the model asking the USER to describe the screen.
- wait-after-point gate is teaching-only; a TIMED-OUT wait counts as watched
  (ending with a check-in is now legitimate — the lesson resumes itself).

**Guide tools** (`guideTools.ts`):
- wait_for_screen default 30s; timeout return = the gentle check-in script.
- read_screen: 15s bridge window + one retry (a just-launched app's AX tree
  legitimately answers slowly); "if nothing matches the goal, point at the
  section that would CONTAIN it" planning rule.
- end_lesson tool (refusal path above). All guide tools silent-ack.

**HUD (Swift)**:
- `watch_change_request` → GuideModel.handleWatchChange: poll the app's
  inventory hash vs baseline every 1s (shares watchGeneration with step
  watches; newest wins; never touches the read_screen snapshot).
- AXFinder.inventory: app-root fallback when kAXWindowsAttribute lies (System
  Settings on macOS 26 returns empty windows while plainly open — find() always
  survived via its own fallback; inventory declared "window is closed").
- DaemonClient: CONNECTION GENERATIONS — a stale socket's failure callback can
  no longer cancel its successor (the HUD oscillated through zombie reconnects
  forever after a daemon restart). screen_result send errors are logged.
- `--axinv "App"` dev probe dumps the inventory summary.

## E2E findings (live, real daemon + real HUD + real System Settings)
- r2: broadened routing verified — the user's exact failing phrasing routes
  [[task]]; verbal-only fallback when the HUD can't answer.
- r4: point → persist (zero guide_end at turn end) → 30s check-in line
  ("No worries… the highlight is still there") → watch_change armed. The
  no-fire was a test artifact (Settings reopened on the already-target pane).
- r5: screen-offload escape caught live → SCREEN_OFFLOAD_RE gate.
- r6: premature end_lesson (8s into the lesson) → endRequestFromModel refusal.
- r7: **THE CORE ARC WORKED LIVE** — lesson started → turn ended (highlight
  persisted, watcher armed) → simulated click → daemon auto-continued ("Done.
  What's next?") → KAIROS resumed speaking/pointing → "okay stop" ended clean.
  Two quality bugs found: (a) empty final after a successful point spoke
  "sorry, didn't catch that" → guide-aware empty-final fallback in agentLoop
  ("I've highlighted it on your screen — click it and I'll take you from
  there"); (b) TOGGLE-STEP LOOP — the last step (click Dark) creates no new
  element, so wait_for_screen instant-hits forever → instant-hit text now has
  the toggle escape (point at it, say it's the last step, END the turn), and
  the verifier's watched-gate accepts a wait attempted after the FIRST point.
- r8: HUD reconnect wedged 70+s across a daemon restart (reconnectScheduled
  state machine stuck; six silent watchdog ticks, zero reconnects) → the >50s
  watchdog now tears down UNCONDITIONALLY and connects fresh. Model degraded
  gracefully meanwhile: honest verbal guidance, zero fabrication.
- r9: FALSE BLINDNESS — two SUCCESSFUL read_screens, then "I'm having trouble
  reading the screen content… you can manually navigate…?" (question-final to
  dodge gates). Guide tools are LOCAL_TOOLS so the LLM groundedness check never
  runs on those turns → new deterministic FALSE_BLINDNESS_RE gate: claiming
  you can't see while the ledger holds a successful read/point = retryable flag,
  even on question-finals.

Tests: guideLesson 20 · agents suite 396 green · tsc clean · Swift builds.
NOT committed (house rule). Electron renderer must be RESTARTED by the user to
pick up tts_level/tts_playback (orb speech-sync from the earlier batch).
