// src/daemon/memory/voiceObservation.ts
// Builds the per-turn L2 observation text the voice loop records — WITH the
// recorder-side self-poisoning guard. KAIROS's own failure narratives ("I'm having
// trouble retrieving…") must never be memorized: FTS recalls them for the very
// question they failed on and teaches the model the task is impossible (learned
// helplessness, 2026-06-10 — 8 such rows made a Notion read permanently "broken").
// The injection-side filter (contextBuilder.isSelfEchoMemory) protects reads against
// rows that already exist; THIS stops new ones from being written at all. The user's
// own words are always kept — an LLM failure shouldn't lose what the user said.
//
// TWO classes of reply are dropped (both bit us in production):
//   • failure narratives → learned helplessness (the Notion incident);
//   • PROMISES ("I've started looking into flights…") → response mimicry: recalled by
//     the same question later, the model imitates its own past promise and skips the
//     tools entirely (the flight-research parroting loop, 2026-06-10).

import { FAILURE_ECHO_RE } from "../agents/contextBuilder"
import { PROMISSORY_RE } from "../agents/loop/verifier"

export function voiceTurnObservation(utterance: string, reply: string): string {
  const r = String(reply ?? "").trim()
  if (r && !FAILURE_ECHO_RE.test(r) && !PROMISSORY_RE.test(r)) {
    return `User said: "${utterance}". KAIROS replied: "${r}".`
  }
  return `User said: "${utterance}".`
}
