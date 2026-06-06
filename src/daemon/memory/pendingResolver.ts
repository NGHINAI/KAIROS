// src/daemon/memory/pendingResolver.ts
// Closes the half-wired _pending_confirmation loop. Markers were written + surfaced
// in the prompt (so KAIROS asks "confirm?") but NOTHING ever executed the deferred
// action when the user answered — they just lingered. This runs per-turn BEFORE the
// forget/extract detectors: if there are live pending markers, it checks whether the
// user's latest utterance confirms/denies them, executes the deferred op, and clears
// the marker. Fixes BOTH the new forget-confirm AND the pre-existing contradiction-
// confirm (FactWriter writes the same marker shape).
//
// Marker text conventions it understands:
//   forget:        'NEEDS CONFIRMATION [cid:..]: user asked to forget "<subject>" ...'
//   contradiction: 'NEEDS CONFIRMATION about <subject>: new "..." conflicts with "..." ...'
// On confirm it forgets by `subject` (the marker's subject column) — works for both.

import { fastMax } from "../agents/tokenBudget"

const SYSTEM_PROMPT = `KAIROS previously asked the user to confirm one or more pending memory actions. Given the pending items and the user's latest reply, decide for EACH item whether the user CONFIRMED it, DENIED it, or it's UNCLEAR.

Return ONLY JSON: { "decisions": [ { "id": "<item id>", "decision": "confirm" | "deny" | "unclear" } ] }
A short "yes"/"do it"/"go ahead" confirms; "no"/"keep it"/"cancel" denies; anything off-topic or ambiguous = unclear (leave it pending).`

export interface PendingItem { id: string; text: string; subject?: string; category?: string }

export interface PendingResolverDeps {
  llm: { complete: (body: any) => Promise<{ text: string }> }
  semanticStore: {
    livePending(limit?: number): PendingItem[]
    forget(query: string, opts?: { subject?: string }): Promise<{ superseded: string[] }>
    clearPending(opts?: { id?: string; subject?: string }): Promise<number>
  }
  episodicStore?: { forgetWhere(textLike: string, source?: string): Promise<number> }
  log?: (msg: string) => void
}

export class PendingResolver {
  constructor(private deps: PendingResolverDeps) {}

  /** Resolve outstanding confirmations against the user's latest utterance.
   *  Returns count resolved (executed or denied), or null if nothing pending.
   *  conversationId: only act on markers tagged for THIS conversation (or untagged). */
  async resolve(utterance: string, conversationId = "conv_default"): Promise<{ resolved: number } | null> {
    const all = this.safeLivePending()
    if (all.length === 0) return null  // fast path: no LLM call when nothing pending

    // Scope to this conversation: markers embed [cid:..]; untagged ones match any.
    const pending = all.filter(p => !/\[cid:[^\]]+\]/.test(p.text) || p.text.includes(`[cid:${conversationId}]`))
    if (pending.length === 0) return null

    let decisions: Array<{ id: string; decision: string }> = []
    try {
      const list = pending.map(p => `- id=${p.id} :: ${p.text}`).join("\n")
      const resp = await this.deps.llm.complete({
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `Pending items:\n${list}\n\nUser's latest reply: "${utterance.trim()}"` },
        ],
        max_tokens: fastMax(200),
        temperature: 0,
      })
      decisions = parseDecisions(resp.text)
    } catch (e) {
      this.deps.log?.(`[pendingResolver] llm failed (non-fatal): ${(e as Error).message}`)
      return null
    }

    let resolved = 0
    for (const d of decisions) {
      const item = pending.find(p => p.id === d.id)
      if (!item) continue
      if (d.decision === "confirm") {
        // Execute the deferred action: forget by the marker's subject (covers both
        // forget-pending and contradiction-pending — supersedes the matching facts).
        const subject = item.subject?.trim()
        try {
          if (subject) await this.deps.semanticStore.forget("", { subject })
          else await this.deps.semanticStore.forget(stripMarker(item.text))
          if (this.deps.episodicStore && subject) await this.deps.episodicStore.forgetWhere(subject)
        } catch { /* best-effort */ }
        await this.safeClear(item.id)
        resolved++
        this.deps.log?.(`[pendingResolver] CONFIRMED "${subject ?? item.id}" → executed + cleared`)
      } else if (d.decision === "deny") {
        await this.safeClear(item.id)
        resolved++
        this.deps.log?.(`[pendingResolver] DENIED "${item.subject ?? item.id}" → cleared, kept`)
      } // "unclear" → leave pending for a later turn
    }
    return { resolved }
  }

  private safeLivePending(): PendingItem[] {
    try { return this.deps.semanticStore.livePending(10) } catch { return [] }
  }
  private async safeClear(id: string): Promise<void> {
    try { await this.deps.semanticStore.clearPending({ id }) } catch { /* */ }
  }
}

function parseDecisions(text: string): Array<{ id: string; decision: string }> {
  if (!text) return []
  const s = text.indexOf("{"), e = text.lastIndexOf("}")
  if (s === -1 || e === -1 || e < s) return []
  try {
    const o = JSON.parse(text.slice(s, e + 1))
    return Array.isArray(o.decisions) ? o.decisions.filter((d: any) => typeof d?.id === "string") : []
  } catch { return [] }
}

/** Best-effort: pull a forget target out of a marker if it has no subject column. */
function stripMarker(text: string): string {
  const m = text.match(/forget "([^"]+)"/i) ?? text.match(/about ([^:]+):/i)
  return m ? m[1]!.trim() : text
}
