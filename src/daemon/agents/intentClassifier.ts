// src/daemon/agents/intentClassifier.ts
// Tier 1 classifier — one LLM call returns { tier, reason, confidence }.

import type { IntentDecision, Tier } from "./types"

const CLASSIFIER_SYSTEM = `You are KAIROS's intent classifier. For each user utterance, decide which agent tier should handle it.

Return STRICT JSON only: {"tier": "fast"|"smart"|"deep"|"vision", "reason": "<short>", "confidence": 0..1}

Tiers:
- "fast": chitchat, simple questions, single-step tool call (e.g. "what time is it", "summarize my emails today"), or introspection ("what skills do you have")
- "smart": multi-step plans requiring chained tools (e.g. "pull my emails, extract todos, add to calendar"), parameter filling from ambiguous input
- "deep": explicit "think hard about this", multi-day planning, complex debugging
- "vision": screen-related ("show me where to click", "what's on my screen", "look at my screen")

When unsure, prefer "fast" (it's the cheapest). Reserve "smart" for genuinely multi-step work.`

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
      max_tokens: 50,
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
