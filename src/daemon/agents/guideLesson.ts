// src/daemon/agents/guideLesson.ts
// THE GUIDE SESSION MANAGER — what makes guidance feel like a colleague instead of
// a per-turn parlor trick. It owns the WHOLE on-screen guide lifecycle:
//
//  LESSONS (teaching asks): a walkthrough is a durable object that OUTLIVES turns —
//   • the highlight persists between turns (no more vanishing mid-sentence); it is
//     replaced by the next step or retired when the lesson ends;
//   • between turns a SCREEN-CHANGE WATCHER runs: when the user's click changes the
//     app (a pane opens), the daemon injects a continuation turn and KAIROS speaks
//     the next step unprompted — full auto-continue (user-chosen 2026-06-10);
//   • follow-ups ("now what?", "highlight it again") resume via injected context
//     instead of re-deriving the lesson from scratch;
//   • the comet stays out for the whole lesson (orb re-forms only at the end).
//
//  STANDALONE POINTS ("show me where X is"): the highlight persists past the turn
//   until the user SPEAKS again or ACTS (the screen changes) — the user's exact
//   spec: "until I say okay or something else, anything, or I click it".
//
// Lesson END: the model calls end_lesson at the goal, the user dismisses by voice,
// or a hard cap expires. Ending retracts the guide (guide_end → orb re-forms).

export interface LessonPoint {
  label: string
  find?: string
  element?: number
  app?: string
}

export interface LessonState {
  conversationId: string
  goal: string
  startedAt: number
  lastPointed?: LessonPoint
  /** What KAIROS told the user to do for the current step (for check-ins/re-asks). */
  stepNote?: string
  continuations: number
  /** Steps the USER has actually completed (wait_for_screen confirmed, or an
   *  auto-continue fired) — gates premature end_lesson calls. */
  stepsCompleted: number
}

const HARD_CAP_MS = 10 * 60_000          // a lesson never outlives 10 minutes
const MAX_CONTINUATIONS = 12             // runaway guard on auto-continue turns
const STANDALONE_DISMISS_WATCH_MS = 180_000

/** Phrasings that mean "we're done here" — the user moving on ends the lesson. */
export const LESSON_DISMISS_RE =
  /\b(stop|cancel|never ?mind|forget it|that'?s (all|it|enough)|i'?m (done|good)|we'?re done|thanks,? (that'?s|i'?m)|got it,? thanks|leave it|exit|quit)\b/i

/** The sentinel handleUtterance recognizes as a daemon-injected lesson continuation.
 *  The visible replacement text deliberately matches WALKTHROUGH_ECHO_RE ("what's
 *  next") so these synthetic turns are quarantined from long-term memory recall. */
export const LESSON_CONTINUE_SENTINEL = "[[lesson-continue]]"
export const LESSON_CONTINUE_TEXT = "Done. What's next?"

export class GuideLessonManager {
  private lesson: LessonState | null = null
  /** Last non-lesson highlight left on screen (persists until voice/act dismissal). */
  private standalone: { point: LessonPoint; at: number } | null = null
  /** Per-turn context set by handleUtterance so tool-level hooks know who's asking. */
  private turn: { conversationId: string; goal: string; teaching: boolean } | null = null
  /** Monotonic token: bumping it invalidates every in-flight between-turns watcher. */
  private watchEpoch = 0
  /** Did the CURRENT turn actually point at something (guide_user/scroll)? Reset at turn
   *  start, set when a point is noted. A lesson turn that ends WITHOUT pointing means the
   *  user did something unrelated → the lingering cue is stale and must be retracted. */
  private pointedThisTurn = false

  constructor(private deps: {
    /** Watch the app for ANY screen change (inventory hash differs from baseline) —
     *  resolves true when changed, false on timeout / no HUD / superseded. */
    watchChange: (app: string | undefined, timeoutMs: number) => Promise<boolean>
    /** Inject a continuation turn into the conversation (full normal pipeline). */
    continueLesson: (conversationId: string) => void
    /** Retract the on-screen guide (comet returns, orb re-forms). */
    retractGuide: () => void
    log?: (m: string) => void
  }) {}

  get active(): LessonState | null {
    if (this.lesson && Date.now() - this.lesson.startedAt > HARD_CAP_MS) this.end("hard cap")
    return this.lesson
  }

  isActiveFor(conversationId: string): boolean {
    return this.active?.conversationId === conversationId
  }

  // ── turn lifecycle (called by handleUtterance) ────────────────────────────

  /** A REAL user utterance arrived. Applies the dismissal rules BEFORE the turn runs:
   *  lesson + dismissal phrase → lesson ends (guide retracts); no lesson but a
   *  standalone highlight on screen → the user speaking dismisses it ("until I say
   *  okay or something else, anything"). Mid-lesson non-dismissal speech keeps the
   *  highlight — the turn will replace or re-point it. */
  onUserUtterance(conversationId: string, utterance: string): void {
    this.watchEpoch++                          // any real turn supersedes pending watchers
    const lesson = this.active
    if (lesson && lesson.conversationId === conversationId) {
      if (LESSON_DISMISS_RE.test(utterance)) this.end("user moved on")
      return
    }
    if (lesson && lesson.conversationId !== conversationId) this.end("new conversation")
    if (this.standalone) {
      this.standalone = null
      try { this.deps.retractGuide() } catch { /* */ }
    }
  }

  /** Stamp who/what this turn is about so notePointFromTool can attribute points. */
  setTurnContext(conversationId: string, goal: string, teaching: boolean): void {
    this.turn = { conversationId, goal, teaching }
    this.pointedThisTurn = false   // fresh turn — hasn't guided yet
  }

  /** Turn finished (and is still the CURRENT turn — caller ownership-guards).
   *  Lesson alive AND this turn POINTED → arm auto-continue (the fresh cue waits for the
   *  user to act). Lesson alive but this turn produced NO guidance → the user asked
   *  something unrelated; the old cue is stale and was lingering across turns (live bug
   *  2026-06-16: scroll arrow stuck, orb never re-formed) → RETRACT it (lesson stays
   *  armed so a later "continue" re-shows). Standalone up → arm the act-dismissal watch. */
  afterTurn(conversationId: string): void {
    const pointed = this.pointedThisTurn
    this.turn = null
    const lesson = this.active
    if (lesson && lesson.conversationId === conversationId) {
      if (pointed) { this.armAutoContinue(); return }
      try { this.deps.retractGuide() } catch { /* */ }
      return
    }
    if (this.standalone) this.armStandaloneDismiss()
  }

  // ── tool-side hooks (wired into guideTools) ───────────────────────────────

  /** guide_user succeeded. Teaching turn (or live lesson) → the point becomes the
   *  lesson's current step; plain ask → it's a standalone highlight. */
  /** A non-point guide cue (scroll arrow) was shown this turn — counts as "guided" so
   *  afterTurn's stale-cue retract doesn't wipe an arrow we just put up. */
  noteGuideShown(): void {
    this.pointedThisTurn = true
  }

  notePointFromTool(point: LessonPoint, stepNote?: string): void {
    this.pointedThisTurn = true   // this turn produced on-screen guidance → cue is fresh
    const lesson = this.active
    if (lesson) {
      lesson.lastPointed = point
      if (stepNote) lesson.stepNote = stepNote
      this.standalone = null
      return
    }
    if (this.turn?.teaching) {
      this.lesson = {
        conversationId: this.turn.conversationId,
        goal: this.turn.goal,
        startedAt: Date.now(),
        lastPointed: point,
        stepNote,
        continuations: 0,
        stepsCompleted: 0,
      }
      this.standalone = null
      this.deps.log?.(`[lesson] started: "${this.turn.goal.slice(0, 60)}"`)
      return
    }
    this.standalone = { point, at: Date.now() }
  }

  /** Most recent target (lesson step or standalone) — "highlight it again" support. */
  lastPointed(): LessonPoint | null {
    return this.active?.lastPointed ?? this.standalone?.point ?? null
  }

  /** wait_for_screen confirmed the user did a step (or an auto-continue fired). */
  noteStepDone(): void {
    const l = this.active
    if (l) l.stepsCompleted++
  }

  /** The MODEL asked to end the lesson. Refused (returns false) when the user
   *  hasn't completed a single step yet — live failure 2026-06-11: the model
   *  pointed at the first element and immediately declared the goal complete,
   *  killing the highlight 8 seconds into the lesson. */
  endRequestFromModel(reason: string): boolean {
    const l = this.active
    if (!l) return true                              // nothing to end — fine
    if (l.stepsCompleted === 0 && Date.now() - l.startedAt < 90_000) return false
    this.end(reason)
    return true
  }

  // ── context for the planner ───────────────────────────────────────────────

  /** Rendered for a turn in this conversation: the resume block (lesson) or the
   *  re-highlight hint (recent standalone point). Empty when neither applies. */
  contextBlockFor(conversationId: string): string {
    const l = this.active
    if (l && l.conversationId === conversationId) {
      const pointed = l.lastPointed
        ? `You last highlighted "${l.lastPointed.label}"${l.lastPointed.app ? ` in ${l.lastPointed.app}` : ""} — it is STILL highlighted on their screen. `
        : ""
      const note = l.stepNote ? `The step you gave them: "${l.stepNote}". ` : ""
      return (
        `## Active walkthrough (VOICE-PACED — resume it; do NOT start over or answer from memory)\n` +
        `Goal: ${l.goal}. ${pointed}${note}` +
        `The user just told you they're ready for the next step (e.g. "continue" / "I'm ready" / "okay"). ` +
        `Call read_screen to see where they are NOW, then point at the NEXT step's element and give ONE short instruction that ENDS by asking them to say "continue" / "I'm ready" when done — then STOP and wait for them. ` +
        `(If they ask to see the last one again, guide_user it again.) When the goal is complete, say so warmly and call end_lesson.`
      )
    }
    if (this.standalone && Date.now() - this.standalone.at < 5 * 60_000) {
      const p = this.standalone.point
      return (
        `## Recent on-screen highlight\n` +
        `You highlighted "${p.label}"${p.app ? ` in ${p.app}` : ""} moments ago. ` +
        `If the user asks to highlight/show it again, call guide_user({find: ${JSON.stringify(p.find ?? p.label)}${p.app ? `, app: ${JSON.stringify(p.app)}` : ""}}).`
      )
    }
    return ""
  }

  // ── end ───────────────────────────────────────────────────────────────────

  /** The user moved on / the model declared completion / cap hit. */
  end(reason: string): void {
    if (!this.lesson) return
    this.deps.log?.(`[lesson] ended (${reason}): "${this.lesson.goal.slice(0, 60)}"`)
    this.lesson = null
    this.watchEpoch++
    try { this.deps.retractGuide() } catch { /* */ }
  }

  // ── between-turns watchers ────────────────────────────────────────────────

  private armAutoContinue(): void {
    const lesson = this.active
    if (!lesson) return
    if (lesson.continuations >= MAX_CONTINUATIONS) { this.end("continuation cap"); return }
    const epoch = ++this.watchEpoch
    void this.deps.watchChange(lesson.lastPointed?.app, 120_000).then((changed) => {
      // Stale (a real turn started, the lesson ended, or a newer watcher armed)?
      if (epoch !== this.watchEpoch) return
      const current = this.active
      if (!current) return
      if (!changed) return                     // timeout/no HUD — stay quiet; next turn re-arms
      current.continuations++
      current.stepsCompleted++                 // the screen changed = the user did the step
      this.deps.log?.(`[lesson] screen changed → auto-continuing (#${current.continuations})`)
      this.deps.continueLesson(current.conversationId)
    }).catch(() => { /* watcher is best-effort */ })
  }

  private armStandaloneDismiss(): void {
    const epoch = ++this.watchEpoch
    void this.deps.watchChange(this.standalone?.point.app, STANDALONE_DISMISS_WATCH_MS).then((changed) => {
      if (epoch !== this.watchEpoch || !this.standalone) return
      if (!changed) return
      // The user acted (clicked it / moved on) — the highlight has served its purpose.
      this.standalone = null
      this.deps.log?.("[lesson] standalone highlight dismissed (screen changed)")
      try { this.deps.retractGuide() } catch { /* */ }
    }).catch(() => { /* */ })
  }
}
