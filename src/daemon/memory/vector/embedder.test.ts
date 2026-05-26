import { describe, it, expect, beforeAll } from 'bun:test'
import { LocalEmbedder } from './embedder'

describe('LocalEmbedder', () => {
  let embedder: LocalEmbedder

  beforeAll(async () => {
    embedder = new LocalEmbedder()
    await embedder.warmup()
  }, 120_000)    // model download can take a minute or two on first run

  it('embeds a string to a 384-dim Float32Array', async () => {
    const v = await embedder.embed('the quick brown fox')
    expect(v.length).toBe(384)
    expect(v).toBeInstanceOf(Float32Array)
  })

  it('produces similar vectors for semantically similar text', async () => {
    const a = await embedder.embed('I went to the store to buy milk')
    const b = await embedder.embed('I picked up some milk from the grocery')
    const c = await embedder.embed('the spaceship docked at the moon base')
    expect(cosine(a, b)).toBeGreaterThan(cosine(a, c))
  })

  it('batch embeds multiple strings', async () => {
    const vs = await embedder.embedBatch(['hello', 'world', 'foo'])
    expect(vs.length).toBe(3)
    expect(vs[0].length).toBe(384)
  })

  it('reports dimension via property', () => {
    expect(embedder.dim).toBe(384)
  })
})

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}
