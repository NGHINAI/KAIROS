// src/daemon/agents/guideBridge.ts
// The daemon side of GUIDE MODE — the request/response bridge between the agent's
// guide_user tool and the native HUD overlay.
//
// Flow: the agent calls guide_user("the Export button") → the bridge broadcasts
// `guide_request {id, find, app?, say?}` over the voice-events WS → the HUD morphs
// the orb into the guide, resolves the element via the Accessibility tree, flies
// there, and answers with `{cmd:'guide_result', id, found, …}` → the bridge resolves
// the awaiting tool call so the agent knows whether the user can see the highlight.
// RETRACTION (`endIfActive()` → `guide_end`) is decided by the GuideLessonManager,
// not the turn: a highlight persists until the user dismisses it by voice or by
// acting (lessons span many turns; the comet stays out the whole time).

export interface GuideResult {
  found: boolean
  /** What the HUD actually locked onto (the element's resolved title). */
  label?: string
  reason?: string
  /** screen_request answers: the rendered element inventory (text). */
  summary?: string
}

export interface GuideRequest {
  find?: string
  /** Element NUMBER from the latest read_screen snapshot — the grounded addressing
   *  mode (Cua's element_index, adapted): you can only point at what you've seen. */
  element?: number
  app?: string
  say?: string
}

export class GuideBridge {
  private pending = new Map<string, { resolve: (r: GuideResult | null) => void; timer: ReturnType<typeof setTimeout> }>()
  private seq = 0
  private active = false

  constructor(private deps: { broadcast: (e: Record<string, unknown>) => void; timeoutMs?: number }) {}

  /** True while a guide is on screen (between the first request and guide_end). */
  get isActive(): boolean { return this.active }

  /** Ask the HUD to point at something. Resolves with the HUD's answer, or null when
   *  no HUD answers within the timeout (HUD not running / no AX permission hang). */
  request(req: GuideRequest): Promise<GuideResult | null> {
    this.active = true
    return this.roundTrip({ event: "guide_request", find: req.find, element: req.element, app: req.app, say: req.say })
  }

  /** Ask the HUD what's on screen (the AX element inventory of an app) — READ-ONLY,
   *  no visual change. This is what makes guidance DYNAMIC: the agent plans each step
   *  from what is actually there, then verifies after the user acts (look→point→look).
   *  15s window, not the 8s default: a JUST-LAUNCHED app's AX tree answers each probe
   *  with the 0.3s messaging timeout while it settles — the first inventory after
   *  open_app legitimately runs long (live: System Settings took >8s, the late answer
   *  was dropped, and the turn concluded "the HUD isn't running"). */
  requestScreen(app?: string): Promise<GuideResult | null> {
    return this.roundTrip({ event: "screen_request", app }, 15_000)
  }

  /** Watch the screen until `find` appears (the user completed the step) or timeout.
   *  THE WALKTHROUGH HEARTBEAT: lets a whole guided lesson live in ONE agent turn —
   *  point → speak → wait for the click's effect → next step, no "done?" prompting. */
  requestWatch(req: { find: string; app?: string; timeoutMs: number }): Promise<GuideResult | null> {
    this.active = true
    return this.roundTrip(
      { event: "watch_request", find: req.find, app: req.app, timeoutMs: req.timeoutMs },
      req.timeoutMs + 3000,   // bridge waits a little past the HUD's own deadline
    )
  }

  /** ACT MODE (computer use): press an element or type into a field. The HUD's
   *  comet flies to the element first (the user watches each step happen), then
   *  AXActor presses it (kAXPressAction → per-PID CGEvent fallback — never moves
   *  the cursor, never steals focus). Element-index/label addressing ONLY. */
  requestAct(req: {
    find?: string
    element?: number
    app?: string
    action: "press" | "set_value"
    text?: string
    submit?: boolean
    /** false → the HUD refuses to press an element whose RESOLVED label matches
     *  confirmGuard (answers `needs_confirm` with the comet parked on it). */
    confirm?: boolean
    /** Regex source for irreversible-looking labels (daemon owns the pattern). */
    confirmGuard?: string
  }): Promise<GuideResult | null> {
    this.active = true
    return this.roundTrip(
      {
        event: "act_request", find: req.find, element: req.element, app: req.app,
        action: req.action, text: req.text, submit: req.submit,
        confirm: req.confirm, confirmGuard: req.confirmGuard,
      },
      12_000,   // resolve + comet flight + press; generous for busy apps
    )
  }

  /** Watch the app for ANY screen change (inventory hash differs from baseline).
   *  THE BETWEEN-TURNS HEARTBEAT: while a lesson sleeps between turns, this is how
   *  the daemon notices the user clicked the highlighted step (→ auto-continue), and
   *  how a standalone highlight notices the user acted (→ quiet retraction).
   *  Read-only — does NOT mark the guide active. */
  requestWatchChange(req: { app?: string; timeoutMs: number }): Promise<GuideResult | null> {
    return this.roundTrip(
      { event: "watch_change_request", app: req.app, timeoutMs: req.timeoutMs },
      req.timeoutMs + 3000,
    )
  }

  /** SCROLL GUIDANCE (computer use, guidance-only): show a directional arrow + a
   *  "scroll down/up" pill at the edge of the scrollable region so the USER scrolls
   *  the target into view. KAIROS never auto-scrolls — it points the way (the Guide-
   *  Mode doctrine). The brain calls this when read_screen marked the target
   *  `[off-screen ↓]`; after the user scrolls, the brain re-reads + guide_user's by
   *  number. The HUD acks immediately (arrow shown); `summary` may carry the current
   *  inventory. Marks the guide active (an arrow is on screen until guide_end). */
  requestScroll(req: { app?: string; direction: "up" | "down"; targetElement?: number; timeoutMs?: number }): Promise<GuideResult | null> {
    this.active = true
    return this.roundTrip(
      { event: "scroll_request", app: req.app, direction: req.direction, targetElement: req.targetElement },
      req.timeoutMs ?? 8000,
    )
  }

  private roundTrip(payload: Record<string, unknown>, timeoutOverrideMs?: number): Promise<GuideResult | null> {
    const id = `g${++this.seq}_${Date.now().toString(36)}`
    const timeoutMs = timeoutOverrideMs ?? this.deps.timeoutMs ?? 8000
    return new Promise<GuideResult | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve(null)
      }, timeoutMs)
      this.pending.set(id, { resolve, timer })
      try {
        this.deps.broadcast({ ...payload, id })
      } catch {
        clearTimeout(timer)
        this.pending.delete(id)
        resolve(null)
      }
    })
  }

  /** HUD answer (`{cmd:'guide_result'|'screen_result', id, …}`). Unknown/duplicate ids are ignored. */
  resolve(id: string, result: GuideResult): void {
    const entry = this.pending.get(id)
    if (!entry) return
    this.pending.delete(id)
    clearTimeout(entry.timer)
    entry.resolve({ found: !!result.found, label: result.label, reason: result.reason, summary: result.summary })
  }

  /** Turn finished → retract the guide (orb re-forms). Safe to call when inactive. */
  endIfActive(): void {
    if (!this.active) return
    this.active = false
    // Outstanding requests resolve as "no answer" — the turn is over either way.
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.resolve(null)
      this.pending.delete(id)
    }
    try { this.deps.broadcast({ event: "guide_end" }) } catch { /* */ }
  }
}
