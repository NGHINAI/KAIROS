// src/daemon/memory/semanticMemory.ts
// L3 — semantic memory. Persistent facts with 768-dim BLOB embeddings.
// reinforceOrWrite is the human-like behavior — when the dreamer
// re-derives the same fact, we increment frequency + bump last_seen.
//
// SemanticMemory — original structured L3 store (facts with typed fields + embeddings)
// SemanticStore  — lightweight distilled-fact store with hybrid recall (FTS5 + vector)
//                  stores Hermes Dreaming output; implements the MemoryStore interface

import type { Database } from 'bun:sqlite'
import type { VectorIndex } from './vector/vectorIndex'
import { HybridRetriever } from './vector/hybridRetriever'

export type SemanticInput = {
  kind: 'fact' | 'preference' | 'person' | 'project' | 'pattern'
  subject: string
  body: string
  embedding: number[]
  source_episodes?: number[]
  importance: number
}

export type SemanticRow = {
  id: number
  kind: string
  subject: string
  body: string
  source_episodes: number[] | null
  importance: number
  frequency: number
  last_seen: number
  created_at: number
  decayed_at: number | null
}

export class SemanticMemory {
  constructor(private db: Database) {}

  write(input: SemanticInput): number {
    const now = Date.now()
    const info = this.db.run(
      `INSERT INTO mem_l3_semantic
         (kind, subject, body, source_episodes, importance, frequency, last_seen, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      [input.kind, input.subject, input.body,
       input.source_episodes ? JSON.stringify(input.source_episodes) : null,
       input.importance, now, now],
    )
    const id = Number(info.lastInsertRowid)
    const buf = new Uint8Array(new Float32Array(input.embedding).buffer)
    this.db.run('INSERT INTO mem_l3_embeddings(l3_id, embedding) VALUES (?, ?)', [id, buf as any])
    return id
  }

  reinforceOrWrite(input: SemanticInput): number {
    const existing = this.db.query(
      'SELECT id FROM mem_l3_semantic WHERE subject = ? AND body = ? AND decayed_at IS NULL',
    ).get(input.subject, input.body) as { id: number } | null
    if (existing) {
      this.db.run(
        'UPDATE mem_l3_semantic SET frequency = frequency + 1, last_seen = ?, importance = MAX(importance, ?) WHERE id = ?',
        [Date.now(), input.importance, existing.id],
      )
      return existing.id
    }
    return this.write(input)
  }

  getById(id: number): SemanticRow | null {
    const row = this.db.query('SELECT * FROM mem_l3_semantic WHERE id = ?').get(id) as
      (Omit<SemanticRow, 'source_episodes'> & { source_episodes: string | null }) | null
    if (!row) return null
    return { ...row, source_episodes: row.source_episodes ? JSON.parse(row.source_episodes) : null }
  }

  allActive(): SemanticRow[] {
    const rows = this.db.query('SELECT * FROM mem_l3_semantic WHERE decayed_at IS NULL ORDER BY last_seen DESC').all() as
      Array<Omit<SemanticRow, 'source_episodes'> & { source_episodes: string | null }>
    return rows.map(r => ({ ...r, source_episodes: r.source_episodes ? JSON.parse(r.source_episodes) : null }))
  }

  allIncludingDecayed(): SemanticRow[] {
    const rows = this.db.query('SELECT * FROM mem_l3_semantic ORDER BY last_seen DESC').all() as
      Array<Omit<SemanticRow, 'source_episodes'> & { source_episodes: string | null }>
    return rows.map(r => ({ ...r, source_episodes: r.source_episodes ? JSON.parse(r.source_episodes) : null }))
  }

  decay(id: number): void {
    this.db.run('UPDATE mem_l3_semantic SET decayed_at = ? WHERE id = ?', [Date.now(), id])
  }
}

// ---------------------------------------------------------------------------
// SemanticStore — lightweight distilled-fact store for MemoryInjector (L3 slot)
// ---------------------------------------------------------------------------
// Stores short distilled facts produced by the Hermes Dreamer. Each row has a
// TEXT id (UUID), the fact text, and a timestamp. No source field (L3 facts
// are distilled outputs, not attributed observations).
//
// FTS5 table: mem_l3_facts_fts — content-backed by mem_l3_facts
// Hybrid recall: when a VectorIndex is provided, uses HybridRetriever (RRF);
// otherwise falls back to pure FTS5 keyword recall.

const FACTS_TABLE = 'mem_l3_facts'
const FACTS_FTS_TABLE = 'mem_l3_facts_fts'

export type FactInput = {
  text: string
}

export type SemanticHit = {
  id: string
  text: string
  ts: number
}

export class SemanticStore {
  private initialized = false

  constructor(
    private readonly db: Database,
    private readonly vectorIndex?: VectorIndex,
  ) {}

  private init(): void {
    if (this.initialized) return
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${FACTS_TABLE} (
        id  TEXT    PRIMARY KEY,
        text TEXT   NOT NULL,
        ts  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_l3_facts_ts ON ${FACTS_TABLE}(ts);

      CREATE VIRTUAL TABLE IF NOT EXISTS ${FACTS_FTS_TABLE} USING fts5(
        text,
        content='${FACTS_TABLE}',
        content_rowid='rowid'
      );

      CREATE TRIGGER IF NOT EXISTS mem_l3_facts_ai
        AFTER INSERT ON ${FACTS_TABLE} BEGIN
          INSERT INTO ${FACTS_FTS_TABLE}(rowid, text) VALUES (new.rowid, new.text);
        END;
      CREATE TRIGGER IF NOT EXISTS mem_l3_facts_ad
        AFTER DELETE ON ${FACTS_TABLE} BEGIN
          DELETE FROM ${FACTS_FTS_TABLE} WHERE rowid = old.rowid;
        END;
      CREATE TRIGGER IF NOT EXISTS mem_l3_facts_au
        AFTER UPDATE ON ${FACTS_TABLE} BEGIN
          DELETE FROM ${FACTS_FTS_TABLE} WHERE rowid = old.rowid;
          INSERT INTO ${FACTS_FTS_TABLE}(rowid, text) VALUES (new.rowid, new.text);
        END;
    `)
    this.initialized = true
  }

  async record(input: FactInput): Promise<string> {
    this.init()
    const id = crypto.randomUUID()
    const ts = Date.now()
    this.db.run(
      `INSERT INTO ${FACTS_TABLE}(id, text, ts) VALUES (?, ?, ?)`,
      [id, input.text, ts],
    )
    // Auto-embed into the VectorIndex when available (graceful degradation on error)
    if (this.vectorIndex) {
      try {
        await this.vectorIndex.insert(id, input.text)
      } catch (err) {
        console.warn('[SemanticStore] vectorIndex.insert failed (non-fatal):', err)
      }
    }
    return id
  }

  async recall(query: string, limit: number): Promise<SemanticHit[]> {
    this.init()
    if (!this.vectorIndex) {
      return this.recallKeywordOnly(query, limit)
    }
    const retriever = new HybridRetriever(this.db, {
      ftsTableName: FACTS_FTS_TABLE,
      vectorIndex: this.vectorIndex,
      topK: limit * 2,
      finalK: limit,
    })
    const hits = await retriever.retrieve(query)
    return this.hydrate(hits.map(h => h.id))
  }

  private recallKeywordOnly(query: string, limit: number): SemanticHit[] {
    const tokens = query
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 1)
    if (tokens.length === 0) return []
    const matchExpr = tokens.map(t => `"${t}"`).join(' OR ')
    try {
      const rows = this.db.query(`
        SELECT f.id, f.text, f.ts
        FROM ${FACTS_FTS_TABLE} fts
        JOIN ${FACTS_TABLE} f ON f.rowid = fts.rowid
        WHERE ${FACTS_FTS_TABLE} MATCH ?
        ORDER BY bm25(${FACTS_FTS_TABLE}) ASC
        LIMIT ?
      `).all(matchExpr, limit) as SemanticHit[]
      return rows
    } catch {
      return []
    }
  }

  private hydrate(ids: string[]): SemanticHit[] {
    if (ids.length === 0) return []
    const placeholders = ids.map(() => '?').join(',')
    const rows = this.db.query(
      `SELECT id, text, ts FROM ${FACTS_TABLE} WHERE id IN (${placeholders})`,
    ).all(...ids) as SemanticHit[]
    const byId = new Map(rows.map(r => [r.id, r]))
    return ids.map(id => byId.get(id)).filter((r): r is SemanticHit => r !== undefined)
  }
}
