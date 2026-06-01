// src/daemon/memory/realtimeFactExtractor.ts
// Per-turn fact extraction — the "remembers what you said 10 seconds ago" layer.
//
// The idle VoiceConsolidator distills L2→L3 every ~5min (good for depth), but a
// smart agent must recall facts WITHIN the live conversation. This runs a single
// cheap LLM call right after each user utterance, pulling explicit durable facts
// ("my name is X", "I prefer Y", "my project is Z") straight into L3 so the very
// next turn can use them. Cost is ~1 small fast-model call (~150 tokens in); it
// runs fire-and-forget so it never delays the reply.
//
// Conservative by design: most utterances yield 0 facts. Returns [] on anything
// that isn't a clear, durable statement about the user/their world.

import { fastMax } from "../agents/tokenBudget"

const SYSTEM_PROMPT = `Extract durable facts about the USER from their latest utterance. Durable = worth remembering for weeks: name, role, company, projects, people they know, tools they use, stable preferences, important decisions. NOT durable: questions, chitchat, transient state, the assistant's actions.

IMPORTANT — handle CORRECTIONS: if the latest utterance corrects or updates an earlier statement (e.g. "no, I said Nirmal", "actually it's blue", a spelled-out spelling like "N-I-R-M-A-L"), use the recent conversation context to produce the CORRECTED durable fact (e.g. ["User's name is Nirmal"]). A correction of an important fact IS a durable fact — extract it.

Output ONLY a JSON array of short third-person fact strings, e.g. ["User's name is Nirmal","User prefers terse replies"]. Output [] if there is no durable fact. Be strict on chitchat — but always capture name/identity corrections.`

export interface RealtimeFactExtractorDeps {
  /** LLM completer ({messages} → {text}); use the cheapest fast tier. */
  llm: { complete: (body: any) => Promise<{ text: string }> }
  /** Smart-write layer — handles contradiction/supersede/confirm. Each extracted
   *  fact is routed through this instead of a raw record(), so duplicates and
   *  contradictions are resolved (the name flip-flop fix). */
  factWriter: { write(factText: string): Promise<unknown> }
  /** Optional: log line. */
  log?: (msg: string) => void
}

export class RealtimeFactExtractor {
  constructor(private deps: RealtimeFactExtractorDeps) {}

  /**
   * Extract + persist durable facts from one user utterance. Fire-and-forget:
   * never throws, returns the facts it stored (for logging/tests).
   *
   * `recentContext` (optional) is a few prior turns of conversation. It is CRUCIAL
   * for corrections: "No, I said Nirmal" is only a name fact if the extractor can
   * see the preceding "My name is Numa". Without context the correction extracts
   * nothing and the contradiction never reaches the factWriter.
   */
  async extract(utterance: string, recentContext?: string): Promise<string[]> {
    const u = (utterance ?? "").trim()
    if (u.length < 6) return [] // too short to carry a durable fact
    try {
      const userContent = recentContext
        ? `Recent conversation (for context — resolve corrections/pronouns against it):\n${recentContext}\n\nLatest user utterance to extract facts from:\n"${u}"`
        : u
      const resp = await this.deps.llm.complete({
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        max_tokens: fastMax(120),
        temperature: 0,
      })
      const facts = parseFactArray(resp.text)
      const stored: string[] = []
      for (const f of facts) {
        const t = f.trim()
        // Route through the smart-write layer: it dedups, supersedes contradictions,
        // and raises confirmations for important+uncertain conflicts.
        if (t) { await this.deps.factWriter.write(t); stored.push(t) }
      }
      if (stored.length && this.deps.log) this.deps.log(`[factExtractor] processed ${stored.length}: ${stored.join(" | ")}`)
      return stored
    } catch (e) {
      this.deps.log?.(`[factExtractor] failed (non-fatal): ${(e as Error).message}`)
      return []
    }
  }
}

function parseFactArray(text: string): string[] {
  if (!text) return []
  const start = text.indexOf("[")
  const end = text.lastIndexOf("]")
  if (start === -1 || end === -1 || end < start) return []
  try {
    const arr = JSON.parse(text.slice(start, end + 1))
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : []
  } catch { return [] }
}
