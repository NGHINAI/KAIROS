// src/daemon/agents/loop/approvalGate.ts
// Pause-and-resume approval for DESTRUCTIVE actions a background sub-agent wants
// to take. The agent calls `requestApproval(...)` and AWAITS it — while awaiting,
// no LLM calls happen, so the agent is parked at zero token cost. Resolution
// comes from either: an immediate voice "yes/no", or (if the user doesn't answer
// within the voice window) the action is dropped into the approval INBOX and the
// agent stays parked until approved there or mentioned again by voice.

export interface ApprovalRequest {
  id: string
  summary: string         // human/spoken: "send an email to Sam"
  toolName: string
  args: any
}

export interface ApprovalGateDeps {
  /** Surface the ask now (speak it + emit a UI event). */
  ask: (req: ApprovalRequest) => void
  /** After the voice window with no answer, park it in the approval inbox. */
  inbox: (req: ApprovalRequest) => void
  /** Wait this long for an immediate voice answer before inboxing. Default 20s. */
  voiceWindowMs?: number
  /** Hard cap on how long an approval may stay parked before auto-DENYING — so a
   *  never-answered, never-cancelled approval can't hang a sub-agent (and its
   *  concurrency slot) forever. Default 10 min. */
  maxParkMs?: number
  setTimer?: (fn: () => void, ms: number) => any
  clearTimer?: (h: any) => void
}

interface Pending {
  req: ApprovalRequest
  resolve: (approved: boolean) => void
  voiceTimer: any | null   // inbox-after-window timer (only armed while this is the ACTIVE ask)
  maxTimer: any            // hard auto-deny timer
  order: number
}

export class ApprovalGate {
  private pending = new Map<string, Pending>()
  private seq = 0
  // Only ONE approval is spoken/asked at a time. Others queue (straight to inbox)
  // so a bare voice "yes"/"no" is never ambiguous — it resolves THIS asked one.
  private activeId: string | null = null

  constructor(private deps: ApprovalGateDeps) {}

  private clearT(h: any): void { try { (this.deps.clearTimer ?? clearTimeout)(h) } catch { /* */ } }

  /** Speak/surface a pending as the active ask + arm its voice-window inbox timer. */
  private activate(id: string): void {
    const p = this.pending.get(id)
    if (!p) return
    this.activeId = id
    try { this.deps.ask(p.req) } catch { /* */ }
    const setT = this.deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
    p.voiceTimer = setT(() => { try { this.deps.inbox(p.req) } catch { /* */ } }, this.deps.voiceWindowMs ?? 20_000)
  }

  /** Remove a pending, resolve its promise, and promote the next queued ask. */
  private finalize(id: string, approved: boolean): boolean {
    const p = this.pending.get(id)
    if (!p) return false
    this.pending.delete(id)
    this.clearT(p.voiceTimer)
    this.clearT(p.maxTimer)
    p.resolve(approved)
    if (this.activeId === id) {
      this.activeId = null
      let next: Pending | undefined
      for (const q of this.pending.values()) if (!next || q.order < next.order) next = q // oldest queued
      if (next) this.activate(next.req.id)
    }
    return true
  }

  /** Agent awaits this. Parked (no tokens) until resolved by voice or inbox.
   *  If the run's signal aborts while parked, the approval resolves to a DENIAL
   *  and the pending entry is purged — so a cancelled sub-agent can't hang here,
   *  and a later stray "yes" can't resurrect it. Concurrent requests queue behind
   *  the one being asked (serialized), and a hard maxParkMs cap auto-denies. */
  requestApproval(req: ApprovalRequest, signal?: AbortSignal): Promise<{ approved: boolean }> {
    const setT = this.deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
    return new Promise<{ approved: boolean }>((resolvePromise) => {
      if (signal?.aborted) { resolvePromise({ approved: false }); return }
      const onAbort = () => { this.finalize(req.id, false) }
      try { signal?.addEventListener?.("abort", onAbort, { once: true }) } catch { /* */ }
      const maxTimer = setT(() => { this.finalize(req.id, false) }, this.deps.maxParkMs ?? 10 * 60_000)
      this.pending.set(req.id, {
        req,
        order: ++this.seq,
        voiceTimer: null,
        maxTimer,
        resolve: (approved: boolean) => {
          try { signal?.removeEventListener?.("abort", onAbort) } catch { /* */ }
          resolvePromise({ approved })
        },
      })
      // First in line → ask it aloud now; otherwise queue straight to the inbox.
      if (this.activeId === null) this.activate(req.id)
      else { try { this.deps.inbox(req) } catch { /* */ } }
    })
  }

  /** Resolve a specific pending approval (from the inbox, or a voice answer tied to it). */
  resolve(id: string, approved: boolean): boolean {
    return this.finalize(id, approved)
  }

  /** Resolve the approval currently being ASKED — for a bare voice "yes"/"no" not
   *  tied to an id. Unambiguous because only one is asked at a time; falls back to
   *  the most recent pending if nothing is actively asking. */
  resolveLatest(approved: boolean): boolean {
    let id = this.activeId
    if (!id) {
      let latest: Pending | undefined
      for (const p of this.pending.values()) if (!latest || p.order > latest.order) latest = p
      id = latest?.req.id ?? null
    }
    return id ? this.finalize(id, approved) : false
  }

  /** Parked approvals awaiting a decision — for the UI/inbox. */
  listPending(): ApprovalRequest[] {
    return [...this.pending.values()].sort((a, b) => a.order - b.order).map((p) => p.req)
  }
}
