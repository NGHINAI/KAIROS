// src/daemon/llm/cache/cacheHints.ts
// Taxonomy of how long different prompt sections stay stable.
// Per-provider adapters translate these hints to native cache_control markers.

export type CacheHint = 'long' | 'short' | 'none'

// 'long'  — stable for hours/days (system prompt, persona, procedural memory, semantic memory)
//           Anthropic: cache_control with ephemeral type + 1h extended (when available)
//           OpenAI:    place first in prompt, automatic caching takes care of it
//           Gemini:    create explicit cachedContents resource
//
// 'short' — stable for minutes (recent episodic snippets, recent observations)
//           Anthropic: cache_control with ephemeral type, default 5-min TTL
//           OpenAI:    place after long-cached blocks, still benefits from automatic caching
//           Gemini:    inlined (TTL not worth the cachedContents overhead)
//
// 'none'  — volatile (current event/question, timestamp, random seed)
//           All providers: never cached

export type SystemBlock = {
  text: string
  cache_hint?: CacheHint    // defaults to 'long' for system blocks
  source?: 'persona' | 'standing_orders' | 'procedural_memory' | 'skills'
}

export type ContextBlock = {
  text: string
  cache_hint?: CacheHint    // defaults to 'short' for context blocks
  source: 'L1' | 'L2' | 'L3' | 'L4' | 'observation'
  ts?: number               // when the snippet was recorded (for sorting)
}

export type CacheableBlock = SystemBlock | ContextBlock

export function resolveHint(block: CacheableBlock): CacheHint {
  if (block.cache_hint) return block.cache_hint
  // Defaults: SystemBlock → long, ContextBlock by source
  if ('source' in block && (block.source === 'L1' || block.source === 'observation')) return 'none'
  if ('source' in block && (block.source === 'L2')) return 'short'
  return 'long'    // L3, L4, persona, standing_orders, procedural_memory default to long
}
