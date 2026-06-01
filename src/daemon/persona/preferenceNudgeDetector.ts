// src/daemon/persona/preferenceNudgeDetector.ts
// Detects when a user utterance sets a STANDING PREFERENCE about how KAIROS should
// behave ("from now on keep replies short", "don't interrupt me in meetings",
// "always confirm before sending") and records it to persona.md via recordNudge.
//
// Why this exists separately from the kairos_remember_preference tool: preference-
// setting utterances are conversationally simple, so they classify to the FAST tier
// — which has no tools. Relying on the LLM to call a tool there is impossible. This
// runs per-turn (fire-and-forget, like the fact extractor) so preferences are
// captured RELIABLY regardless of tier. A cheap LLM call gates it (most turns: no).

import { fastMax } from "../agents/tokenBudget"

const SYSTEM_PROMPT = `Decide if the user's utterance sets a STANDING PREFERENCE or instruction about how their AI assistant should behave going forward (tone, verbosity, when to interrupt, what to always/never do, formatting, etc.). Examples that ARE preferences: "keep replies short", "from now on be more formal", "don't interrupt during meetings", "always confirm before sending". Examples that are NOT: questions, one-off requests ("summarize this"), facts about the user ("my name is X").

Return ONLY JSON: { "isPreference": boolean, "preference": "<concise imperative phrasing, or empty>" }`

export interface PreferenceNudgeDetectorDeps {
  llm: { complete: (body: any) => Promise<{ text: string }> }
  personaUpdater: { recordNudge: (nudge: string) => unknown }
  log?: (msg: string) => void
}

export class PreferenceNudgeDetector {
  constructor(private deps: PreferenceNudgeDetectorDeps) {}

  /** Returns the recorded preference string, or null. Never throws. */
  async detect(utterance: string): Promise<string | null> {
    const u = (utterance ?? "").trim()
    if (u.length < 8) return null
    try {
      const resp = await this.deps.llm.complete({
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: u },
        ],
        max_tokens: fastMax(80),
        temperature: 0,
      })
      const parsed = parseObj(resp.text)
      if (parsed?.isPreference && parsed.preference?.trim()) {
        const pref = parsed.preference.trim()
        this.deps.personaUpdater.recordNudge(pref)
        this.deps.log?.(`[prefNudge] recorded: "${pref}"`)
        return pref
      }
      return null
    } catch (e) {
      this.deps.log?.(`[prefNudge] failed (non-fatal): ${(e as Error).message}`)
      return null
    }
  }
}

function parseObj(text: string): { isPreference?: boolean; preference?: string } | null {
  if (!text) return null
  const s = text.indexOf("{"), e = text.lastIndexOf("}")
  if (s === -1 || e === -1 || e < s) return null
  try { return JSON.parse(text.slice(s, e + 1)) } catch { return null }
}
