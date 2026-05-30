// src/daemon/agents/executorAgent.ts
// Tier 1 narrator helpers — short LLM calls that produce ack/transition/filler
// speech to keep the user engaged during agentic work.

interface NarratorOpts {
  llm: { complete: (body: any) => Promise<{ text: string }> }
  personaTone?: string
}

const ACK_SYSTEM = `Generate ONE short spoken acknowledgment (max 8 words) for the upcoming tool call. Plain spoken English. No markdown, no quotes. Examples: "On it.", "Checking your calendar.", "Looking that up now."`

const TRANSITION_SYSTEM = `Generate ONE short spoken transition (max 10 words) summarizing a tool result. Plain spoken English. No markdown. Examples: "Found three events.", "Got it.", "Done.", "That worked."`

const FILLER_SYSTEM = `Generate ONE short spoken filler (max 6 words) to indicate work is still in progress. Plain spoken English. Examples: "Still working on it.", "One sec.", "Almost there."`

export async function generateAck(toolName: string, opts: NarratorOpts): Promise<string> {
  const tone = opts.personaTone ? ` Tone: ${opts.personaTone}.` : ""
  const resp = await opts.llm.complete({
    messages: [
      { role: "system", content: ACK_SYSTEM + tone },
      { role: "user", content: `Upcoming tool: ${toolName}` },
    ],
    max_tokens: 20,
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
    max_tokens: 25,
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
    max_tokens: 15,
    temperature: 0.6,
  })
  return String(resp.text ?? "").trim()
}
