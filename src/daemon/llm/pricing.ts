// src/daemon/llm/pricing.ts
//
// Single source of truth for per-model pricing + a PRECISE cost estimate.
// Bug-fix (2026-06-07 diagnosis #1): the old openrouter provider did
// `Math.ceil(... * 100)` per call, quantizing every sub-cent call up to ≥1¢ —
// a ~12× over-count that falsely exhausted the monthly budget ($50 recorded vs
// ~$5 real). Cost MUST keep sub-cent precision; round only at display/aggregation.

// USD per million tokens. OpenRouter list prices at time of writing; unknown
// models fall through to FALLBACK_PRICE.
export const PRICING: Record<string, { input: number; output: number }> = {
  // OpenAI via OpenRouter
  "openai/gpt-4o-mini":           { input: 0.15, output: 0.60 },
  "openai/gpt-4o":                { input: 2.50, output: 10.00 },
  "openai/gpt-5-mini":            { input: 0.25, output: 2.00 },
  "openai/gpt-5-nano":            { input: 0.05, output: 0.40 },
  "openai/gpt-4.1-mini":          { input: 0.40, output: 1.60 },
  // Anthropic via OpenRouter
  "anthropic/claude-haiku-4-5":   { input: 1.00, output: 5.00 },
  "anthropic/claude-sonnet-4-5":  { input: 3.00, output: 15.00 },
  "anthropic/claude-sonnet-4-6":  { input: 3.00, output: 15.00 },
  // bare ids (anthropic-direct provider may record without the vendor prefix)
  "claude-haiku-4-5":             { input: 1.00, output: 5.00 },
  // Moonshot Kimi via OpenRouter
  "moonshotai/kimi-k2":           { input: 0.55, output: 2.20 },
  "moonshotai/kimi-k2-0905":      { input: 0.60, output: 2.50 },
  "moonshotai/kimi-k2-thinking":  { input: 0.95, output: 4.00 },
  // Google via OpenRouter
  "google/gemini-2.5-flash-lite": { input: 0.10, output: 0.40 },
  "google/gemini-2.5-flash":      { input: 0.30, output: 2.50 },
  // MiniMax via OpenRouter
  "minimax/minimax-m3":           { input: 0.30, output: 1.65 },
}

export const FALLBACK_PRICE = { input: 1, output: 5 } as const

/** PRECISE cost in cents for a call (sub-cent preserved). NEVER ceil/round here. */
export function estimateCostCents(model: string, inputTok: number, outputTok: number): number {
  const p = PRICING[model] ?? FALLBACK_PRICE
  return ((inputTok / 1_000_000) * p.input + (outputTok / 1_000_000) * p.output) * 100
}
