// src/daemon/memory/factWriter.ts
// Smart write layer for L3 facts — the contradiction fixer. Replaces raw
// semanticStore.record({text}) in realtimeFactExtractor + voiceConsolidator.
//
// For each candidate fact it: recalls related existing facts, asks ONE cheap LLM
// to judge contradiction + importance + confidence, then resolves per the user's
// rule:
//   - skip                       → duplicate, do nothing
//   - supersede (low importance  → auto-retire old fact(s), record new (silent)
//      OR confidence >= AUTO)
//   - supersede (high importance → DON'T auto-resolve. Record the new fact AND
//      AND confidence < AUTO)      write a _pending_confirmation marker so KAIROS
//                                  asks the user which is correct next turn.
//   - new                        → record with subject/category
//
// This is the generalized version of "don't silently overwrite my name on a
// single mishearing": important + uncertain conflicts get confirmed, trivial ones
// auto-update. Runs in the existing fire-and-forget path → never blocks the reply.

import { fastMax } from "../agents/tokenBudget"

const AUTO_SUPERSEDE_CONFIDENCE = 0.85

const JUDGE_SYSTEM = `You maintain an AI assistant's long-term memory of facts about its user. Given a NEW candidate fact and a list of EXISTING related facts, decide how to integrate it.

Return ONLY JSON:
{
  "action": "new" | "supersede" | "skip",
  "supersedeIds": ["id", ...],   // existing fact ids the new one replaces (for "supersede")
  "subject": "<short singular subject, e.g. 'user name', 'favorite language'>",
  "category": "identity" | "preferences" | "projects" | "relationships" | "knowledge" | "other",
  "importance": "low" | "high",   // high = identity, name, key preference, relationship
  "confidence": 0.0-1.0           // how sure you are this is a real update vs noise/mishearing
}

Rules:
- "skip" if the new fact is already represented by an existing fact (pure duplicate).
- "supersede" if the new fact UPDATES or CONTRADICTS existing fact(s) on the same subject (list their ids). e.g. name changed, preference changed.
- "new" if it's about a subject not covered yet.
- importance "high" for identity/name/relationships/core preferences; "low" for trivia.
- confidence LOW (<0.85) when the contradiction might be a speech-to-text mishearing of an important fact (e.g. two similar-sounding names) — that signals the assistant should confirm with the user rather than silently overwrite.`

export type FactJudgement = {
  action: "new" | "supersede" | "skip"
  supersedeIds: string[]
  subject: string
  category: string
  importance: "low" | "high"
  confidence: number
}

export interface SemanticStoreLike {
  record(input: { text: string; subject?: string; category?: string; confidence?: number }): Promise<string>
  recall(query: string, limit: number): Promise<Array<{ id: string; text: string }>>
  supersede(id: string, reason?: string): Promise<void>
}

export interface FactWriterDeps {
  semanticStore: SemanticStoreLike
  llm: { complete: (body: any) => Promise<{ text: string }> }
  log?: (msg: string) => void
}

export type WriteOutcome = {
  action: FactJudgement["action"] | "pending_confirmation"
  storedId?: string
  superseded: string[]
}

export class FactWriter {
  constructor(private deps: FactWriterDeps) {}

  /** Smart-write one candidate fact. Never throws (memory writes are best-effort). */
  async write(factText: string): Promise<WriteOutcome> {
    const text = (factText ?? "").trim()
    if (!text) return { action: "skip", superseded: [] }

    let existing: Array<{ id: string; text: string }> = []
    try { existing = await this.deps.semanticStore.recall(text, 6) } catch { /* recall best-effort */ }

    // No related facts → straight insert (still classify subject/category cheaply
    // via the judge so the file-system view + future contradiction checks work).
    const judgement = await this.judge(text, existing)
    if (!judgement) {
      // LLM unavailable/failed → degrade to a plain record (better than losing it).
      const id = await this.safeRecord(text)
      return { action: "new", storedId: id, superseded: [] }
    }

    if (judgement.action === "skip") {
      this.deps.log?.(`[factWriter] skip (duplicate): "${text.slice(0, 50)}"`)
      return { action: "skip", superseded: [] }
    }

    const validIds = judgement.supersedeIds.filter(id => existing.some(e => e.id === id))

    if (judgement.action === "supersede" && validIds.length > 0) {
      const autoOk = judgement.importance === "low" || judgement.confidence >= AUTO_SUPERSEDE_CONFIDENCE
      if (autoOk) {
        // Auto-resolve: retire old fact(s), record the new one.
        for (const id of validIds) await this.deps.semanticStore.supersede(id, "superseded by newer fact")
        const storedId = await this.safeRecord(text, judgement)
        this.deps.log?.(`[factWriter] auto-superseded ${validIds.length} for "${judgement.subject}"`)
        return { action: "supersede", storedId, superseded: validIds }
      }
      // Important + uncertain → record the new fact (don't lose it) AND raise a
      // pending-confirmation so KAIROS asks the user before retiring the old one.
      const storedId = await this.safeRecord(text, judgement)
      const conflictTexts = existing.filter(e => validIds.includes(e.id)).map(e => `"${e.text}"`).join(" vs ")
      await this.safeRecord(
        `NEEDS CONFIRMATION about ${judgement.subject}: new statement "${text}" conflicts with ${conflictTexts}. Ask the user which is correct, then forget the wrong one.`,
        { subject: judgement.subject, category: "_pending_confirmation", confidence: 1 },
      )
      this.deps.log?.(`[factWriter] PENDING confirmation for "${judgement.subject}" (important + uncertain)`)
      return { action: "pending_confirmation", storedId, superseded: [] }
    }

    // action "new" (or "supersede" with no valid ids) → record fresh.
    const id = await this.safeRecord(text, judgement)
    return { action: "new", storedId: id, superseded: [] }
  }

  private async safeRecord(text: string, j?: Partial<FactJudgement>): Promise<string | undefined> {
    try {
      return await this.deps.semanticStore.record({
        text,
        subject: j?.subject,
        category: j?.category,
        confidence: typeof j?.confidence === "number" ? j.confidence : undefined,
      })
    } catch (e) { this.deps.log?.(`[factWriter] record failed: ${(e as Error).message}`); return undefined }
  }

  private async judge(text: string, existing: Array<{ id: string; text: string }>): Promise<FactJudgement | null> {
    try {
      const existingBlock = existing.length
        ? existing.map(e => `- [${e.id}] ${e.text}`).join("\n")
        : "(none)"
      const resp = await this.deps.llm.complete({
        messages: [
          { role: "system", content: JUDGE_SYSTEM },
          { role: "user", content: `NEW fact: "${text}"\n\nEXISTING related facts:\n${existingBlock}` },
        ],
        max_tokens: fastMax(200),
        temperature: 0,
      })
      return parseJudgement(resp.text)
    } catch { return null }
  }
}

function parseJudgement(text: string): FactJudgement | null {
  if (!text) return null
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start === -1 || end === -1 || end < start) return null
  try {
    const j = JSON.parse(text.slice(start, end + 1))
    const action = j.action === "supersede" || j.action === "skip" ? j.action : "new"
    return {
      action,
      supersedeIds: Array.isArray(j.supersedeIds) ? j.supersedeIds.filter((x: any) => typeof x === "string") : [],
      subject: typeof j.subject === "string" ? j.subject : "",
      category: typeof j.category === "string" ? j.category : "other",
      importance: j.importance === "high" ? "high" : "low",
      confidence: typeof j.confidence === "number" ? Math.max(0, Math.min(1, j.confidence)) : 0.5,
    }
  } catch { return null }
}
