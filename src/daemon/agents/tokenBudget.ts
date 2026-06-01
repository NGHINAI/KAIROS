// src/daemon/agents/tokenBudget.ts
// Single source of truth for the SMALL fast/memory LLM token budgets.
//
// WHY: classify / narrate / fact-extract calls historically used tiny max_tokens
// (15–120). That's perfect for non-reasoning models (gpt-4o-mini) but STARVES
// reasoning models (gpt-oss, deepseek-r1, nemotron-super), which spend most of
// their budget on an internal `reasoning` channel and return empty `content`
// before reaching the answer → silent classifier fallback + dropped facts.
//
// KAIROS_FAST_MAX_TOKENS sets a FLOOR for these calls. Defaults preserve the old
// behavior for non-reasoning models; bump it (e.g. 512) when KAIROS_FAST_MODEL /
// KAIROS_MEMORY_MODEL is a reasoning model so it has room to think AND answer.
//
//   KAIROS_FAST_MAX_TOKENS=512   ← recommended when using a reasoning fast model

/** The configured floor (0 if unset → callers use their own small default). */
export function fastMaxFloor(): number {
  const raw = process.env.KAIROS_FAST_MAX_TOKENS
  if (!raw) return 0
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** Apply the floor to a call's intended budget: max(intended, floor). */
export function fastMax(intended: number): number {
  return Math.max(intended, fastMaxFloor())
}
