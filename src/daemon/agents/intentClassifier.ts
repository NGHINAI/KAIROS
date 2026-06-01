// src/daemon/agents/intentClassifier.ts
// Tier 1 classifier — one LLM call returns { tier, reason, confidence }.

import type { IntentDecision, Tier } from "./types"
import { fastMax } from "./tokenBudget"

const CLASSIFIER_SYSTEM = `You are KAIROS's intent router. KAIROS is a voice-first AI coworker. Read ONE user utterance and pick the cheapest tier that can fully handle it. This runs on every turn, so latency matters — be decisive.

Return STRICT JSON only, nothing else: {"tier":"fast"|"smart"|"deep"|"vision","reason":"<=8 words","confidence":0..1}

Tiers, cheapest first — escalate ONLY when the cheaper tier would genuinely fail:
- "fast": chitchat, greetings, acknowledgements, a factual question, ONE tool call, or introspection about KAIROS itself. Examples: "what time is it", "thanks", "summarize today's emails", "what skills do you have", "cancel that", "remind me at 5".
- "smart": the request needs SEVERAL tool calls chained, OR results from one step feed the next, OR required parameters must be inferred/disambiguated before acting. Examples: "pull my unread emails, extract action items, and add them to my calendar", "find the contract from Acme and reply asking for the signed copy".
- "deep": the user explicitly asks to think hard / reason carefully, OR it's genuinely open-ended planning, OR multi-step debugging of KAIROS. Phrases like "think this through", "figure out why X keeps failing".
- "vision": the request is about the screen or pointing at the UI. Examples: "what's on my screen", "show me where to click", "read this for me".

Rules:
- Default to "fast". A single action — even a write or a send — is still "fast". Multi-step is what makes it "smart".
- Do NOT escalate for politeness, emphasis ("really need this"), or long wording. Count the STEPS, not the urgency.
- "vision" and "deep" each need a clear trigger; when in doubt between fast and smart, pick the lower one.
- confidence reflects how clear the utterance is, not how hard the task is.`

export interface ClassifyOpts {
  llm: { complete: (body: any) => Promise<{ text: string }> }
}

export async function classifyIntent(utterance: string, opts: ClassifyOpts): Promise<IntentDecision> {
  try {
    const resp = await opts.llm.complete({
      messages: [
        { role: "system", content: CLASSIFIER_SYSTEM },
        { role: "user", content: utterance },
      ],
      max_tokens: fastMax(50),  // floor via KAIROS_FAST_MAX_TOKENS for reasoning models
      temperature: 0,
    })
    const parsed = JSON.parse(resp.text)
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
