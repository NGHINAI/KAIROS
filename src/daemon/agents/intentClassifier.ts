// src/daemon/agents/intentClassifier.ts
// Tier 1 classifier — one LLM call returns { tier, reason, confidence }.

import type { IntentDecision, Tier } from "./types"
import { fastMax } from "./tokenBudget"

const CLASSIFIER_SYSTEM = `You are KAIROS's intent router. KAIROS is a voice-first AI coworker. Read ONE user utterance and pick the cheapest tier that can fully handle it. This runs on every turn, so latency matters — be decisive.

Return STRICT JSON only, nothing else: {"tier":"fast"|"smart"|"deep"|"vision","reason":"<=8 words","confidence":0..1}

CRITICAL: only the "smart" tier can call tools or take actions. "fast" can ONLY talk — it has no tools. So ANY request that requires DOING something in the outside world (connecting/disconnecting an integration, sending, creating, scheduling, reminding, reading email/calendar/messages, controlling an app, looking something up via a service) MUST be "smart", even if it's a single step.

Tiers, cheapest first — escalate ONLY when the cheaper tier would genuinely fail:
- "fast": pure conversation that needs NO tool — chitchat, greetings, acknowledgements, a factual question you can answer from general knowledge, or introspection about KAIROS itself. Examples: "what time is it", "thanks", "what skills do you have", "who are you", "cancel that".
- "smart": the request needs ANY tool/action — one OR several. This includes connecting a service, sending/creating/scheduling/reminding, reading email/calendar/messages, or anything chained where one step feeds the next. Examples: "connect me to Linear", "remind me at 5", "summarize today's emails", "create a Linear issue for this", "pull my unread emails, extract action items, and add them to my calendar".
- "deep": the user explicitly asks to think hard / reason carefully, OR it's genuinely open-ended planning, OR multi-step debugging of KAIROS. Phrases like "think this through", "figure out why X keeps failing".
- "vision": the request is about the screen or pointing at the UI. Examples: "what's on my screen", "show me where to click", "read this for me".

Rules:
- If it needs a tool or an external action, it is "smart" — never "fast". When unsure whether a request needs a tool, choose "smart".
- "fast" is ONLY for talk-and-done turns with no side effects.
- USE THE RECENT CONVERSATION (provided below) to resolve short or ambiguous replies. A bare "yes", "ok", "do it", "go ahead", "sure", "the second one", or "that one" is a CONTINUATION — classify it for the action it confirms. If KAIROS just offered to do something with a tool (send, delete, retry, connect, fetch), then "yes" is "smart". Never treat a confirmation of an action as a throwaway "fast" acknowledgement.
- Do NOT escalate for politeness, emphasis ("really need this"), or long wording.
- "vision" and "deep" each need a clear trigger.
- confidence reflects how clear the utterance is, not how hard the task is.`

export interface ClassifyOpts {
  llm: { complete: (body: any) => Promise<{ text: string }> }
  /** Recent conversation (last turn or two) so the router can resolve short
   *  replies like "yes" / "do it" / "the second one" in context. */
  recentContext?: string
}

/** Strip ```json fences / leading prose some models wrap JSON in. */
function extractJson(text: string): string {
  const t = String(text ?? "").trim()
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) return fenced[1]!.trim()
  const brace = t.indexOf("{")
  const end = t.lastIndexOf("}")
  if (brace >= 0 && end > brace) return t.slice(brace, end + 1)
  return t
}

export async function classifyIntent(utterance: string, opts: ClassifyOpts): Promise<IntentDecision> {
  try {
    const userContent = opts.recentContext
      ? `Recent conversation:\n${opts.recentContext}\n\nClassify this latest user utterance: "${utterance}"`
      : utterance
    const resp = await opts.llm.complete({
      messages: [
        { role: "system", content: CLASSIFIER_SYSTEM },
        { role: "user", content: userContent },
      ],
      max_tokens: fastMax(50),  // floor via KAIROS_FAST_MAX_TOKENS for reasoning models
      temperature: 0,
    })
    const parsed = JSON.parse(extractJson(resp.text))
    if (!parsed.tier || !["fast", "smart", "deep", "vision"].includes(parsed.tier)) {
      throw new Error("invalid tier")
    }
    return {
      tier: parsed.tier as Tier,
      reason: String(parsed.reason ?? "unspecified"),
      confidence: Number(parsed.confidence ?? 0.5),
    }
  } catch {
    return { tier: "fast", reason: "classifier fallback", confidence: 0.3 }
  }
}
