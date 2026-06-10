// src/daemon/agents/guideBridge.ts
// The daemon side of GUIDE MODE — the request/response bridge between the agent's
// guide_user tool and the native HUD overlay.
//
// Flow: the agent calls guide_user("the Export button") → the bridge broadcasts
// `guide_request {id, find, app?, say?}` over the voice-events WS → the HUD morphs
// the orb into the guide, resolves the element via the Accessibility tree, flies
// there, and answers with `{cmd:'guide_result', id, found, …}` → the bridge resolves
// the awaiting tool call so the agent knows whether the user can see the highlight.
// When the foreground turn ends, `endIfActive()` broadcasts `guide_end` so the HUD
// re-forms the orb — a guide never outlives its conversation turn.

export interface GuideResult {
  found: boolean
  /** What the HUD actually locked onto (the element's resolved title). */
  label?: string
  reason?: string
}

export interface GuideRequest {
  find: string
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
    const id = `g${++this.seq}_${Date.now().toString(36)}`
    const timeoutMs = this.deps.timeoutMs ?? 8000
    this.active = true
    return new Promise<GuideResult | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve(null)
      }, timeoutMs)
      this.pending.set(id, { resolve, timer })
      try {
        this.deps.broadcast({ event: "guide_request", id, find: req.find, app: req.app, say: req.say })
      } catch {
        clearTimeout(timer)
        this.pending.delete(id)
        resolve(null)
      }
    })
  }

  /** HUD answer (`{cmd:'guide_result', id, found, label?, reason?}`). Unknown/duplicate ids are ignored. */
  resolve(id: string, result: GuideResult): void {
    const entry = this.pending.get(id)
    if (!entry) return
    this.pending.delete(id)
    clearTimeout(entry.timer)
    entry.resolve({ found: !!result.found, label: result.label, reason: result.reason })
  }

  /** CLICK: ask the HUD to point at AND press an element (AX action, no cursor move).
   *  Reuses the same request/response plumbing as pointing; resolves with the HUD's
   *  control_result. Marks the guide active so it retracts at turn end. */
  click(req: GuideRequest): Promise<GuideResult | null> {
    const id = `c${++this.seq}_${Date.now().toString(36)}`
    const timeoutMs = this.deps.timeoutMs ?? 8000
    this.active = true
    return new Promise<GuideResult | null>((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve(null) }, timeoutMs)
      this.pending.set(id, { resolve, timer })
      try {
        this.deps.broadcast({ event: "control_request", id, find: req.find, app: req.app })
      } catch {
        clearTimeout(timer); this.pending.delete(id); resolve(null)
      }
    })
  }

  /** HUD control answer (`{cmd:'control_result', id, ok, label?, reason?}`). */
  resolveControl(id: string, result: { ok: boolean; label?: string; reason?: string }): void {
    const entry = this.pending.get(id)
    if (!entry) return
    this.pending.delete(id)
    clearTimeout(entry.timer)
    entry.resolve({ found: !!result.ok, label: result.label, reason: result.reason })
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
