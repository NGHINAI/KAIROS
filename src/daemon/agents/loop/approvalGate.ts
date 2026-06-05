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
  setTimer?: (fn: () => void, ms: number) => any
  clearTimer?: (h: any) => void
}

interface Pending {
  req: ApprovalRequest
  resolve: (approved: boolean) => void
  timer: any
  order: number
}

export class ApprovalGate {
  private pending = new Map<string, Pending>()
  private seq = 0

  constructor(private deps: ApprovalGateDeps) {}

  /** Agent awaits this. Parked (no tokens) until resolved by voice or inbox.
   *  If the run's signal aborts while parked, the approval resolves to a DENIAL
   *  and the pending entry is purged — so a cancelled sub-agent can't hang here,
   *  and a later stray "yes" can't resurrect it. */
  requestApproval(req: ApprovalRequest, signal?: AbortSignal): Promise<{ approved: boolean }> {
    const setT = this.deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
    const windowMs = this.deps.voiceWindowMs ?? 20_000
    return new Promise<{ approved: boolean }>((resolvePromise) => {
      // Already cancelled before we even park → deny immediately.
      if (signal?.aborted) { resolvePromise({ approved: false }); return }
      this.deps.ask(req)
      // If unanswered within the window, park into the inbox (still awaiting).
      const timer = setT(() => { try { this.deps.inbox(req) } catch { /* */ } }, windowMs)
      const onAbort = () => {
        const p = this.pending.get(req.id)
        if (p) { this.pending.delete(req.id); try { (this.deps.clearTimer ?? clearTimeout)(p.timer) } catch { /* */ } }
        resolvePromise({ approved: false })
      }
      try { signal?.addEventListener?.("abort", onAbort, { once: true }) } catch { /* */ }
      this.pending.set(req.id, {
        req,
        timer,
        order: ++this.seq,
        resolve: (approved: boolean) => {
          try { signal?.removeEventListener?.("abort", onAbort) } catch { /* */ }
          resolvePromise({ approved })
        },
      })
    })
  }

  /** Resolve a specific pending approval (from the inbox, or a voice answer tied to it). */
  resolve(id: string, approved: boolean): boolean {
    const p = this.pending.get(id)
    if (!p) return false
    this.pending.delete(id)
    try { (this.deps.clearTimer ?? clearTimeout)(p.timer) } catch { /* */ }
    p.resolve(approved)
    return true
  }

  /** Resolve the MOST RECENT pending — for a bare voice "yes"/"no" not tied to an id. */
  resolveLatest(approved: boolean): boolean {
    let latest: Pending | undefined
    for (const p of this.pending.values()) if (!latest || p.order > latest.order) latest = p
    if (!latest) return false
    return this.resolve(latest.req.id, approved)
  }

  /** Parked approvals awaiting a decision — for the UI/inbox. */
  listPending(): ApprovalRequest[] {
    return [...this.pending.values()].sort((a, b) => a.order - b.order).map((p) => p.req)
  }
}
