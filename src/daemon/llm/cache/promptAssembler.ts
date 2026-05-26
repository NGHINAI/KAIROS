// src/daemon/llm/cache/promptAssembler.ts
// Composes SystemBlock[] + ContextBlock[] + prompt into a layered structure
// providers translate to their native caching mechanism.

import type { CompletionRequest } from '../types'
import type { CacheableBlock, CacheHint, SystemBlock, ContextBlock } from './cacheHints'
import { resolveHint } from './cacheHints'

export type LayeredBlock = CacheableBlock & {
  cache_hint: CacheHint   // resolved (non-optional)
  kind: 'system' | 'context'
}

export type AssembledPrompt = {
  layered: LayeredBlock[]                       // ordered: long → short → none
  user_prompt: string                           // volatile, last
  long_cache_breakpoint_index: number | null    // index of LAST 'long' block (-1 if none)
  short_cache_breakpoint_index: number | null   // index of LAST 'short' block (-1 if none)
  estimated_total_tokens: number                // 1 token ≈ 4 chars (rough)
}

const ORDER: Record<CacheHint, number> = { long: 0, short: 1, none: 2 }

export class PromptAssembler {
  assemble(req: CompletionRequest): AssembledPrompt {
    const sys = (req.system_blocks ?? []).map(b => ({ ...b, kind: 'system' as const, cache_hint: resolveHint(b) }))
    const ctx = (req.context_blocks ?? []).map(b => ({ ...b, kind: 'context' as const, cache_hint: resolveHint(b) }))

    // Stable sort: order by cache_hint, then preserve original order within each tier.
    const layered: LayeredBlock[] = [...sys, ...ctx].sort((a, b) => ORDER[a.cache_hint] - ORDER[b.cache_hint])

    let long_bp: number | null = null
    let short_bp: number | null = null
    layered.forEach((b, i) => {
      if (b.cache_hint === 'long') long_bp = i
      if (b.cache_hint === 'short') short_bp = i
    })

    const totalChars = layered.reduce((n, b) => n + b.text.length, 0) + req.prompt.length
    return {
      layered,
      user_prompt: req.prompt,
      long_cache_breakpoint_index: long_bp,
      short_cache_breakpoint_index: short_bp,
      estimated_total_tokens: Math.ceil(totalChars / 4),
    }
  }

}
