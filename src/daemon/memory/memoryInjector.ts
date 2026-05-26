import type { ContextBlock } from '../llm/cache/cacheHints'

export interface MemoryStore {
  recall(query: string, limit: number): Promise<Array<{ id: string; text: string; ts?: number }>>
}
export interface ProceduralStore {
  activeSkills(): Promise<Array<{ id: string; text: string }>>
}

export type InjectOptions = {
  max_l2?: number          // default 5
  max_l3?: number          // default 8
  include_l4?: boolean     // default true
}

export class MemoryInjector {
  constructor(private deps: { l2: MemoryStore; l3: MemoryStore; l4: ProceduralStore }) {}

  async inject(query: string, opts: InjectOptions = {}): Promise<ContextBlock[]> {
    const max_l2 = opts.max_l2 ?? 5
    const max_l3 = opts.max_l3 ?? 8
    const include_l4 = opts.include_l4 ?? true

    const [l2Hits, l3Hits, l4Skills] = await Promise.all([
      max_l2 > 0 ? this.deps.l2.recall(query, max_l2) : Promise.resolve([]),
      max_l3 > 0 ? this.deps.l3.recall(query, max_l3) : Promise.resolve([]),
      include_l4 ? this.deps.l4.activeSkills() : Promise.resolve([]),
    ])

    const blocks: ContextBlock[] = []
    for (const s of l4Skills) blocks.push({ text: s.text, source: 'L4', cache_hint: 'long' })
    for (const s of l3Hits) blocks.push({ text: s.text, source: 'L3', cache_hint: 'long', ts: s.ts })
    for (const s of l2Hits) blocks.push({ text: s.text, source: 'L2', cache_hint: 'short', ts: s.ts })

    return blocks
  }
}
