// src/daemon/memory/embeddings.test.ts
import { describe, it, expect } from 'bun:test'
import { Embedder } from './embeddings'

describe('Embedder', () => {
  it('produces 768-dim vectors for BGEBaseENV15', async () => {
    const emb = new Embedder()
    const vec = await emb.embed('the quick brown fox')
    expect(vec.length).toBe(768)
  }, 180_000)   // 3-min timeout for first-run model download

  it('similar texts have higher cosine similarity than unrelated ones', async () => {
    const emb = new Embedder()
    const v1 = await emb.embed('apple iphone macbook')
    const v2 = await emb.embed('apple ipad airpods')
    const v3 = await emb.embed('quantum chromodynamics partons')
    expect(cosine(v1, v2)).toBeGreaterThan(cosine(v1, v3))
  }, 60_000)

  it('caches identical text', async () => {
    const emb = new Embedder()
    const t = 'cached text'
    await emb.embed(t)
    const before = emb.cacheHits
    await emb.embed(t)
    expect(emb.cacheHits).toBe(before + 1)
  }, 60_000)
})

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! ** 2
    nb += b[i]! ** 2
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}
