// src/daemon/memory/recall.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { initMemorySchema } from './schema'
import { SemanticMemory } from './semanticMemory'
import { Recall } from './recall'

describe('Recall', () => {
  let db: Database
  let sem: SemanticMemory
  let recall: Recall

  beforeEach(() => {
    db = new Database(':memory:')
    initMemorySchema(db)
    sem = new SemanticMemory(db)
    recall = new Recall(db)
  })

  it('returns lexical matches via FTS5 BM25', () => {
    const fakeEmb = new Array(768).fill(0).map((_, i) => Math.sin(i))
    sem.write({ kind: 'fact', subject: 'meeting', body: 'standup is at 10am daily', embedding: fakeEmb, importance: 0.5 })
    sem.write({ kind: 'fact', subject: 'lunch', body: 'team lunch is on Fridays', embedding: fakeEmb, importance: 0.5 })
    const results = recall.lexical('standup', 5)
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]?.body).toContain('standup')
  })

  it('returns semantic matches via pure-TS cosine over BLOBs', () => {
    const v1 = new Array(768).fill(0); v1[0] = 1
    const v2 = new Array(768).fill(0); v2[0] = 1; v2[1] = 0.1
    const v3 = new Array(768).fill(0); v3[100] = 1
    sem.write({ kind: 'fact', subject: 'a', body: 'first vector', embedding: v1, importance: 0.5 })
    sem.write({ kind: 'fact', subject: 'b', body: 'close to first', embedding: v2, importance: 0.5 })
    sem.write({ kind: 'fact', subject: 'c', body: 'unrelated', embedding: v3, importance: 0.5 })
    const results = recall.semantic(v1, 2)
    expect(results.length).toBe(2)
    expect(results[0]?.body).toBe('first vector')
    expect(results[1]?.body).toBe('close to first')
  })

  it('hybrid combines and dedupes lexical + semantic', () => {
    const v1 = new Array(768).fill(0); v1[0] = 1
    sem.write({ kind: 'fact', subject: 'meeting', body: 'standup is at 10am', embedding: v1, importance: 0.5 })
    const results = recall.hybrid('standup', v1, 5)
    expect(results.length).toBeGreaterThan(0)
    const ids = results.map(r => r.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
