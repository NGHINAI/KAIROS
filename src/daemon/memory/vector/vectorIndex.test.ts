import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { VectorIndex } from './vectorIndex'
import { LocalEmbedder } from './embedder'

describe('VectorIndex', () => {
  let db: Database
  let embedder: LocalEmbedder
  let index: VectorIndex

  beforeEach(async () => {
    db = new Database(':memory:')
    embedder = new LocalEmbedder()
    await embedder.warmup()
    index = new VectorIndex(db, embedder, { tableName: 'test_vec' })
    await index.init()
  }, 120_000)

  it('inserts and retrieves by id', async () => {
    await index.insert('doc1', 'the cat sat on the mat')
    const found = await index.searchByText('feline on a rug', 3)
    expect(found.length).toBeGreaterThan(0)
    expect(found[0].id).toBe('doc1')
  })

  it('cosine ranks results by semantic similarity', async () => {
    await index.insert('doc-a', 'I love programming in Rust')
    await index.insert('doc-b', 'My favorite hobby is gardening')
    await index.insert('doc-c', 'Systems programming is fascinating')
    const results = await index.searchByText('writing systems software', 3)
    expect(results[0].id).toMatch(/^doc-(a|c)$/)
    expect(results[1].id).toMatch(/^doc-(a|c)$/)
    expect(results[2].id).toBe('doc-b')
  })

  it('delete removes an entry', async () => {
    await index.insert('x', 'hello')
    await index.delete('x')
    const r = await index.searchByText('hello', 5)
    expect(r.find(h => h.id === 'x')).toBeUndefined()
  })

  it('respects limit parameter', async () => {
    for (let i = 0; i < 10; i++) await index.insert('id-' + i, 'document number ' + i)
    const r = await index.searchByText('document', 3)
    expect(r.length).toBe(3)
  })

  it('returns high similarity for near-identical text', async () => {
    await index.insert('exact', 'the quick brown fox')
    const r = await index.searchByText('the quick brown fox', 1)
    expect(r[0].similarity).toBeGreaterThan(0.95)
  })
})
