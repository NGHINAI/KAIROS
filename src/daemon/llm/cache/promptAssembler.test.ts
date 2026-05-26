// src/daemon/llm/cache/promptAssembler.test.ts
import { describe, it, expect } from 'bun:test'
import { PromptAssembler } from './promptAssembler'
import type { SystemBlock, ContextBlock } from './cacheHints'

describe('PromptAssembler', () => {
  it('orders blocks: long-cached first, then short-cached, then volatile', () => {
    const sys: SystemBlock[] = [
      { text: 'PERSONA', cache_hint: 'long' },
      { text: 'STANDING_ORDERS', cache_hint: 'long' },
    ]
    const ctx: ContextBlock[] = [
      { text: 'L2_recent', cache_hint: 'short', source: 'L2' },
      { text: 'L3_semantic', cache_hint: 'long', source: 'L3' },
      { text: 'now_obs', cache_hint: 'none', source: 'observation' },
    ]
    const out = new PromptAssembler().assemble({ system_blocks: sys, context_blocks: ctx, prompt: 'Q?', task_type: 'narrative' as any })
    // long-cached blocks come first (system + L3)
    expect(out.layered[0].cache_hint).toBe('long')
    expect(out.layered[1].cache_hint).toBe('long')
    expect(out.layered[2].cache_hint).toBe('long')
    // short-cached next
    expect(out.layered[3].cache_hint).toBe('short')
    // volatile last
    expect(out.layered[4].cache_hint).toBe('none')
  })

  it('marks the cache breakpoints — last long-block + last short-block', () => {
    const sys: SystemBlock[] = [{ text: 'A', cache_hint: 'long' }, { text: 'B', cache_hint: 'long' }]
    const ctx: ContextBlock[] = [{ text: 'C', cache_hint: 'short', source: 'L2' }]
    const out = new PromptAssembler().assemble({ system_blocks: sys, context_blocks: ctx, prompt: 'P', task_type: 'narrative' as any })
    // Anthropic-style markers: cache breakpoint goes on the LAST block of each cacheable tier
    expect(out.long_cache_breakpoint_index).toBe(1)    // last 'long' block
    expect(out.short_cache_breakpoint_index).toBe(2)   // last 'short' block (after 2 long blocks)
  })

  it('computes total estimated tokens (rough)', () => {
    const sys: SystemBlock[] = [{ text: 'a'.repeat(400) }]    // ~100 tokens at 4 chars/token
    const out = new PromptAssembler().assemble({ system_blocks: sys, context_blocks: [], prompt: 'short', task_type: 'narrative' as any })
    expect(out.estimated_total_tokens).toBeGreaterThanOrEqual(100)
    expect(out.estimated_total_tokens).toBeLessThanOrEqual(150)
  })
})
