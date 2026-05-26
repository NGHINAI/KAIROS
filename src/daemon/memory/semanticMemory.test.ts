// src/daemon/memory/semanticMemory.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { initMemorySchema } from './schema'
import { SemanticMemory, SemanticStore } from './semanticMemory'
import { LocalEmbedder } from './vector/embedder'
import { VectorIndex } from './vector/vectorIndex'

describe('SemanticMemory', () => {
  let db: Database
  let mem: SemanticMemory

  beforeEach(() => {
    db = new Database(':memory:')
    initMemorySchema(db)
    mem = new SemanticMemory(db)
  })

  it('writes a fact with embedding and retrieves by id', () => {
    const fakeEmb = new Array(768).fill(0).map((_, i) => Math.sin(i))
    const id = mem.write({
      kind: 'fact', subject: 'John',
      body: 'John prefers concise replies after 6pm',
      embedding: fakeEmb, importance: 0.8,
    })
    const row = mem.getById(id)
    expect(row?.body).toBe('John prefers concise replies after 6pm')
  })

  it('reinforces existing facts by subject + body match', () => {
    const fakeEmb = new Array(768).fill(0).map((_, i) => Math.sin(i))
    const id1 = mem.write({ kind: 'fact', subject: 'John', body: 'prefers concise replies', embedding: fakeEmb, importance: 0.5 })
    const id2 = mem.reinforceOrWrite({ kind: 'fact', subject: 'John', body: 'prefers concise replies', embedding: fakeEmb, importance: 0.5 })
    expect(id2).toBe(id1)
    const row = mem.getById(id1)
    expect(row?.frequency).toBe(2)
  })

  it('marks rows as decayed (forgotten) without deleting', () => {
    const fakeEmb = new Array(768).fill(0).map((_, i) => Math.sin(i))
    const id = mem.write({ kind: 'fact', subject: 'X', body: 'y', embedding: fakeEmb, importance: 0.1 })
    mem.decay(id)
    const active = mem.allActive()
    expect(active.find(r => r.id === id)).toBeUndefined()
    const all = mem.allIncludingDecayed()
    expect(all.find(r => r.id === id)).toBeDefined()
  })
})

describe('SemanticStore hybrid recall', () => {
  it('uses semantic + keyword fusion when vectorIndex is provided', async () => {
    const db = new Database(':memory:')
    const embedder = new LocalEmbedder()
    await embedder.warmup()
    const vec = new VectorIndex(db, embedder, { tableName: 'semantic_vec' })
    await vec.init()
    const store = new SemanticStore(db, vec)

    await store.record({ text: 'user prefers minimalist UI design' })
    await store.record({ text: 'unrelated fact about cooking pasta' })
    await store.record({ text: 'user values clean interfaces and reduced clutter' })

    const results = await store.recall('aesthetic preferences', 3)
    // Both UI-related facts should rank above cooking
    const texts = results.map(r => r.text).join(' | ')
    expect(texts).toMatch(/minimalist|clean interfaces/)
    expect(results[0].text).not.toMatch(/pasta/)
  }, 120_000)

  it('preserves existing keyword-only behavior when vectorIndex is omitted', async () => {
    const db = new Database(':memory:')
    const store = new SemanticStore(db)
    await store.record({ text: 'github commits happen via webhook' })
    await store.record({ text: 'no relation at all to git' })
    const results = await store.recall('github', 5)
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].text).toMatch(/github/)
  })
})
