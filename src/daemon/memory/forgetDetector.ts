// src/daemon/memory/forgetDetector.ts
// Per-turn automatic FORGET detector — the delete half of the memory lifecycle,
// symmetric with realtimeFactExtractor (the write half). Runs fire-and-forget after
// each user turn: a cheap LLM decides whether the user asked to forget/delete
// something FROM MEMORY, and if so soft-deletes it (supersede — recoverable).
//
// Safety (user's choice): trivial+clear forgets happen immediately; IMPORTANT
// (identity/name) or VAGUE targets are deferred — a `_pending_confirmation` marker
// is written so KAIROS asks before deleting (resolved next turn by PendingResolver).
//
// Scope: only MEMORY deletes ("forget what I told you about X"). "Delete the X
// project / file" is a real-world action (Composio/tool concern) → intent:none here.

import { fastMax } from "../agents/tokenBudget"

// A turn can only be a memory-forget if it contains an explicit forget/delete CUE aimed
// at memory. This deterministic gate runs BEFORE the LLM and is the safety net against a
// false positive that DELETES a fact: a recall QUESTION ("how do I take my coffee?",
// "what's my favorite color?", "do you know my name?") has no cue → never a forget. (Live
// bug: the cheap model classified "How do I take my coffee?" as forget and retired the fact.)
const FORGET_CUE_RE =
  /\b(forget|forgets?|delete|deletes?|erase|erases?|remove|removes?|wipe|wipes?|scrub|unlearn|disregard|purge)\b|\b(do\s?n['o]?t|stop|never|no longer)\s+(remember|recall|keep)\b|\bscratch that\b|\bnever ?mind\b/i

const SYSTEM_PROMPT = `Decide if the user is asking their assistant to FORGET or DELETE something from its MEMORY (not delete a real file/project/email — those are real-world actions, not memory).

Forget-memory examples: "forget what I told you about X", "delete your memory of X", "forget my favorite color", "ignore what I said about the budget".
NOT forget-memory (intent:"none"):
- real-world actions: "delete the Husk project", "remove that file", "cancel the meeting".
- QUESTIONS / RECALL asking ABOUT a memory — these RETRIEVE, they do NOT delete: "how do I take my coffee?", "what's my favorite color?", "do you know my name?", "remind me what I said about the budget", "what do you remember about X?". A question is NEVER a forget.

Return ONLY JSON:
{
  "intent": "forget" | "none",
  "target": "<the subject/topic to forget, short>",
  "scope": "fact" | "preference" | "all",
  "importance": "low" | "high",   // high = identity/name/relationships/core preference
  "vague": true|false,            // true if target is unclear ("forget that", no clear subject)
  "confidence": 0.0-1.0
}
Use the recent conversation to resolve references like "that" / "it".`

export interface ForgetDetectorDeps {
  llm: { complete: (body: any) => Promise<{ text: string }> }
  semanticStore: {
    forget(query: string, opts?: { subject?: string }): Promise<{ superseded: string[] }>
    record(input: { text: string; subject?: string; category?: string; confidence?: number }): Promise<string>
  }
  episodicStore?: { forgetWhere(textLike: string, source?: string): Promise<number> }
  personaUpdater?: { recordNudge: (nudge: string) => unknown }
  log?: (msg: string) => void
}

export type ForgetOutcome = { forgot: string[] } | { pending: string } | null

export class ForgetDetector {
  constructor(private deps: ForgetDetectorDeps) {}

  /** Detect + act on a forget request. Never throws. Returns what it did (or null).
   *  `conversationId` is embedded in any pending marker so the resolver only acts
   *  on this conversation's asks. */
  async detect(utterance: string, recentContext?: string, conversationId = "conv_default"): Promise<ForgetOutcome> {
    const u = (utterance ?? "").trim()
    if (u.length < 5) return null
    // DETERMINISTIC GATE: no explicit forget/delete cue → it can't be a memory delete
    // (it's a question, a statement, or a real-world action). Skips the LLM entirely —
    // both a correctness guard (recall questions never delete facts) and a latency win.
    if (!FORGET_CUE_RE.test(u)) return null
    let j: any
    try {
      const userContent = recentContext
        ? `Recent conversation:\n${recentContext}\n\nLatest utterance:\n"${u}"`
        : u
      const resp = await this.deps.llm.complete({
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        max_tokens: fastMax(150),
        temperature: 0,
      })
      j = parseObj(resp.text)
    } catch (e) {
      this.deps.log?.(`[forgetDetector] llm failed (non-fatal): ${(e as Error).message}`)
      return null
    }
    if (!j || j.intent !== "forget") return null
    const target = String(j.target ?? "").trim()
    if (!target) return null

    const important = j.importance === "high"
    const vague = j.vague === true
    const confident = typeof j.confidence === "number" ? j.confidence >= 0.7 : false

    // Confirm-only-for-important/vague (user's choice): defer instead of deleting.
    if (important || vague || !confident) {
      try {
        await this.deps.semanticStore.record({
          text: `NEEDS CONFIRMATION [cid:${conversationId}]: user asked to forget "${target}". Confirm before deleting, then forget it.`,
          subject: target,
          category: "_pending_confirmation",
          confidence: 1,
        })
      } catch { /* best-effort */ }
      this.deps.log?.(`[forgetDetector] PENDING forget "${target}" (important=${important} vague=${vague})`)
      return { pending: target }
    }

    // Trivial + clear → soft-delete immediately across L3 + L2 (+ preference note).
    const forgot: string[] = []
    try {
      const r = await this.deps.semanticStore.forget(target)
      forgot.push(...r.superseded)
    } catch { /* best-effort */ }
    try { if (this.deps.episodicStore) await this.deps.episodicStore.forgetWhere(target) } catch { /* */ }
    if (j.scope === "preference" && this.deps.personaUpdater) {
      try { this.deps.personaUpdater.recordNudge(`(forget the preference about ${target})`) } catch { /* */ }
    }
    this.deps.log?.(`[forgetDetector] forgot "${target}" — ${forgot.length} L3 fact(s) retired`)
    return { forgot }
  }
}

function parseObj(text: string): any | null {
  if (!text) return null
  const s = text.indexOf("{"), e = text.lastIndexOf("}")
  if (s === -1 || e === -1 || e < s) return null
  try { return JSON.parse(text.slice(s, e + 1)) } catch { return null }
}
