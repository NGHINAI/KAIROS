import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { initMemorySchema } from './schema'

describe('memory schema', () => {
  let db: Database

  beforeEach(() => {
    db = new Database(':memory:')
  })

  it('creates all 4 tier tables and embedding table', () => {
    initMemorySchema(db)
    const tables = db.query("SELECT name FROM sqlite_master WHERE type IN ('table','virtual')").all() as { name: string }[]
    const names = tables.map(t => t.name)
    expect(names).toContain('mem_l2_episodes')
    expect(names).toContain('mem_l3_semantic')
    expect(names).toContain('mem_l4_procedural_index')
    expect(names).toContain('mem_l3_embeddings')   // BLOB-based, not sqlite-vec
  })

  it('creates FTS5 index for lexical search on L3', () => {
    initMemorySchema(db)
    const ftsExists = db.query("SELECT name FROM sqlite_master WHERE name = 'mem_l3_fts'").get()
    expect(ftsExists).toBeTruthy()
  })

  it('schema is idempotent — running twice does not error', () => {
    initMemorySchema(db)
    expect(() => initMemorySchema(db)).not.toThrow()
  })
})
