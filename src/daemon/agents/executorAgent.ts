// src/daemon/agents/executorAgent.ts
// Tier 1 narrator helpers — short LLM calls that produce ack/transition/filler
// speech to keep the user engaged during agentic work.

import { fastMax } from "./tokenBudget"

interface NarratorOpts {
  llm: { complete: (body: any) => Promise<{ text: string }> }
  personaTone?: string
}

const ACK_SYSTEM = `You are KAIROS speaking out loud. The user just asked for something and you're about to act. Say ONE brief, natural acknowledgement (max 8 words) so they know you heard them and are moving.
- Sound like a sharp human assistant thinking aloud, not a phone IVR.
- Contractions are good. No markdown, no quotes, no emoji, no trailing "...".
- Name the thing when it's natural ("Pulling your calendar now") but stay short.
- Vary your phrasing — do not reach for the same stock line every time.
Examples: "On it.", "Pulling that up.", "Let me check.", "Sure — one sec."`

const TRANSITION_SYSTEM = `You are KAIROS speaking out loud. A tool just returned. Say ONE short spoken line (max 10 words) that tells the user what you found or did, in plain language.
- Translate the raw result into human terms — never read out JSON, IDs, or field names.
- Lead with the useful fact ("Three events today" beats "Done").
- Contractions fine. No markdown, no quotes, no emoji.
- If the result is empty or failed, say so plainly ("Nothing there", "That didn't go through").
Examples: "Found three events today.", "Sent.", "Got it — two unread.", "Hmm, nothing matched."`

const FILLER_SYSTEM = `You are KAIROS speaking out loud. Work is still running and you want to reassure the user without being annoying. Say ONE very short line (max 6 words).
- Calm and natural, never repeat the previous filler verbatim.
- No markdown, no quotes, no emoji.
Examples: "Still on it.", "Almost there.", "One moment.", "Nearly done."`

export async function generateAck(toolName: string, opts: NarratorOpts): Promise<string> {
  const tone = opts.personaTone ? ` Tone: ${opts.personaTone}.` : ""
  const resp = await opts.llm.complete({
    messages: [
      { role: "system", content: ACK_SYSTEM + tone },
      { role: "user", content: `Upcoming tool: ${toolName}` },
    ],
    max_tokens: fastMax(20),
    temperature: 0.5,
  })
  return String(resp.text ?? "").trim()
}

export async function generateTransition(
  toolName: string,
  result: any,
  opts: NarratorOpts,
): Promise<string> {
  const tone = opts.personaTone ? ` Tone: ${opts.personaTone}.` : ""
  const resp = await opts.llm.complete({
    messages: [
      { role: "system", content: TRANSITION_SYSTEM + tone },
      { role: "user", content: `Tool: ${toolName}\nResult: ${JSON.stringify(result).slice(0, 200)}` },
    ],
    max_tokens: fastMax(25),
    temperature: 0.5,
  })
  return String(resp.text ?? "").trim()
}

export async function generateFiller(opts: NarratorOpts): Promise<string> {
  const tone = opts.personaTone ? ` Tone: ${opts.personaTone}.` : ""
  const resp = await opts.llm.complete({
    messages: [
      { role: "system", content: FILLER_SYSTEM + tone },
      { role: "user", content: "Still in progress" },
    ],
    max_tokens: fastMax(15),
    temperature: 0.6,
  })
  return String(resp.text ?? "").trim()
}
