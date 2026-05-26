import { describe, it, expect } from 'bun:test'
import { MemoryInjector } from './memoryInjector'

describe('MemoryInjector', () => {
  it('tags L3 snippets as long-cache, L2 as short-cache, L4 as long-cache', async () => {
    const fakeL2 = { recall: async () => [{ id: 'e1', text: 'recent observation' }] }
    const fakeL3 = { recall: async () => [{ id: 's1', text: 'distilled fact' }] }
    const fakeL4 = { activeSkills: async () => [{ id: 'sk1', text: 'a workflow' }] }
    const inj = new MemoryInjector({ l2: fakeL2 as any, l3: fakeL3 as any, l4: fakeL4 as any })
    const blocks = await inj.inject('what was the GitHub thing yesterday?', { max_l2: 3, max_l3: 5, include_l4: true })
    const l2Blocks = blocks.filter(b => b.source === 'L2')
    const l3Blocks = blocks.filter(b => b.source === 'L3')
    const l4Blocks = blocks.filter(b => b.source === 'L4')
    expect(l2Blocks.every(b => b.cache_hint === 'short')).toBe(true)
    expect(l3Blocks.every(b => b.cache_hint === 'long')).toBe(true)
    expect(l4Blocks.every(b => b.cache_hint === 'long')).toBe(true)
  })

  it('respects max counts per tier', async () => {
    const fakeL3 = { recall: async (_query: string, limit: number) => Array.from({ length: 10 }, (_, i) => ({ id: 's' + i, text: 't' + i })).slice(0, limit) }
    const inj = new MemoryInjector({ l2: { recall: async () => [] } as any, l3: fakeL3 as any, l4: { activeSkills: async () => [] } as any })
    const blocks = await inj.inject('q', { max_l2: 0, max_l3: 3, include_l4: false })
    expect(blocks.filter(b => b.source === 'L3').length).toBe(3)
  })

  it('returns empty array gracefully when no stores have results', async () => {
    const inj = new MemoryInjector({
      l2: { recall: async () => [] } as any,
      l3: { recall: async () => [] } as any,
      l4: { activeSkills: async () => [] } as any,
    })
    const blocks = await inj.inject('q', { max_l2: 5, max_l3: 5, include_l4: true })
    expect(blocks.length).toBe(0)
  })
})
