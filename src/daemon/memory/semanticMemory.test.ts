// src/daemon/memory/semanticMemory.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { initMemorySchema } from './schema'
import { SemanticMemory } from './semanticMemory'

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
