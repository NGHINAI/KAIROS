// src/daemon/memory/embeddings.ts
// Local embeddings via fastembed (BGE-Base-EN-v1.5, 768-dim).
// First call downloads the model into ~/.cache/fastembed/.
// Subsequent calls are fast once the model is cached.
//
// Note: fastembed v2.1.0 does not ship NomicEmbedText.
// BGEBaseENV15 is the best available 768-dim model in this version.
//
// LRU cache for identical text — common when summaries are stable.

import { FlagEmbedding, EmbeddingModel } from 'fastembed'

const MODEL = EmbeddingModel.BGEBaseENV15
const CACHE_SIZE = 256

export class Embedder {
  private modelPromise: Promise<FlagEmbedding> | null = null
  private cache: Map<string, number[]> = new Map()
  public cacheHits = 0

  private async getModel(): Promise<FlagEmbedding> {
    if (!this.modelPromise) {
      this.modelPromise = FlagEmbedding.init({ model: MODEL })
    }
    return this.modelPromise
  }

  async embed(text: string): Promise<number[]> {
    const cached = this.cache.get(text)
    if (cached) {
      this.cacheHits++
      return cached
    }
    const model = await this.getModel()
    const generator = model.embed([text])
    const batches: number[][][] = []
    for await (const batch of generator) batches.push(batch as number[][])
    const vec = batches[0]?.[0]
    if (!vec) throw new Error('Embedder: model returned no vector')

    if (this.cache.size >= CACHE_SIZE) {
      const firstKey = this.cache.keys().next().value
      if (firstKey !== undefined) this.cache.delete(firstKey)
    }
    this.cache.set(text, vec)
    return vec
  }
}
