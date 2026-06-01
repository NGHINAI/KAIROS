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
  /** Singular subject this fact is about, e.g. "user's name", "favorite language".
   *  Used by the smart-write layer to detect contradictions on the same subject. */
  subject?: string
  /** Category bucket, e.g. "identity", "preferences", "projects", "relationships",
   *  or the reserved "_pending_confirmation". Powers the file-system view (Unit 5). */
  category?: string
  /** 0..1 — how confident we are. Defaults to 1. */
  confidence?: number
}

export type SemanticHit = {
  id: string
  text: string
  ts: number
  subject?: string
  category?: string
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
    // Additive, backward-safe schema migration: add evolving-memory columns to an
    // existing mem_l3_facts table. Existing rows get NULLs (treated as live/uncat).
    this.addColumnIfMissing('subject', 'TEXT')
    this.addColumnIfMissing('category', 'TEXT')
    this.addColumnIfMissing('superseded_at', 'INTEGER')   // NULL = live; set = retired
    this.addColumnIfMissing('confidence', 'REAL')
    this.initialized = true
  }

  /** ALTER TABLE ADD COLUMN guarded by a pragma check (idempotent across boots). */
  private addColumnIfMissing(col: string, type: string): void {
    try {
      const cols = this.db.query(`PRAGMA table_info(${FACTS_TABLE})`).all() as Array<{ name: string }>
      if (!cols.some(c => c.name === col)) {
        this.db.run(`ALTER TABLE ${FACTS_TABLE} ADD COLUMN ${col} ${type}`)
      }
    } catch (err) {
      console.warn(`[SemanticStore] addColumn ${col} failed (non-fatal):`, err)
    }
  }

  async record(input: FactInput): Promise<string> {
    this.init()
    const id = crypto.randomUUID()
    const ts = Date.now()
    this.db.run(
      `INSERT INTO ${FACTS_TABLE}(id, text, ts, subject, category, confidence) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, input.text, ts, input.subject ?? null, input.category ?? null, input.confidence ?? 1],
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

  /** Retire a fact: it stops surfacing in recall (superseded_at set) AND its vector
   *  is removed so it can't return via similarity search. Used by the smart-write
   *  layer when a newer fact contradicts/updates this one. Idempotent. */
  async supersede(id: string, _reason?: string): Promise<void> {
    this.init()
    try { this.db.run(`UPDATE ${FACTS_TABLE} SET superseded_at = ? WHERE id = ? AND superseded_at IS NULL`, [Date.now(), id]) }
    catch (err) { console.warn('[SemanticStore] supersede failed (non-fatal):', err) }
    if (this.vectorIndex) {
      try { await this.vectorIndex.delete(id) }
      catch (err) { console.warn('[SemanticStore] vectorIndex.delete failed (non-fatal):', err) }
    }
  }

  /** DELETE (soft) facts the user asked to forget. Finds matching live facts —
   *  by exact `subject` if given, else by relevance recall(query) — and supersedes
   *  each (superseded_at set + vector removed → never surfaces again, row kept for
   *  audit/recovery). Returns the retired ids. Excludes pending-confirmation rows.
   *  Mirrors the contradiction-handling mechanism; this is the real delete pipeline. */
  async forget(query: string, opts: { subject?: string; limit?: number } = {}): Promise<{ superseded: string[] }> {
    this.init()
    let matches: Array<{ id: string }> = []
    try {
      if (opts.subject) {
        matches = this.db.query(
          `SELECT id FROM ${FACTS_TABLE} WHERE subject = ? AND superseded_at IS NULL
           AND (category IS NULL OR category != '_pending_confirmation')`,
        ).all(opts.subject) as Array<{ id: string }>
      } else {
        const hits = await this.recall(query, opts.limit ?? 8)
        matches = hits.filter(h => h.category !== '_pending_confirmation').map(h => ({ id: h.id }))
      }
    } catch { matches = [] }
    const superseded: string[] = []
    for (const m of matches) { await this.supersede(m.id, 'user asked to forget'); superseded.push(m.id) }
    return { superseded }
  }

  /** All live pending-confirmation markers (the deferred asks). Used by the
   *  PendingResolver to decide what KAIROS is waiting on. */
  livePending(limit = 10): SemanticHit[] {
    return this.liveByCategory('_pending_confirmation', limit)
  }

  /** Retire pending-confirmation markers once resolved (confirmed or denied) so they
   *  stop re-surfacing. By id (preferred), or all matching a subject, or all. */
  async clearPending(opts: { id?: string; subject?: string } = {}): Promise<number> {
    this.init()
    let ids: string[] = []
    try {
      if (opts.id) ids = [opts.id]
      else {
        const where = opts.subject ? `AND subject = ?` : ''
        const params = opts.subject ? [opts.subject] : []
        ids = (this.db.query(
          `SELECT id FROM ${FACTS_TABLE} WHERE category = '_pending_confirmation' AND superseded_at IS NULL ${where}`,
        ).all(...params) as Array<{ id: string }>).map(r => r.id)
      }
    } catch { ids = [] }
    for (const id of ids) await this.supersede(id, 'pending resolved')
    return ids.length
  }

  /** List all live (non-superseded) facts in a category — for the file-system view
   *  (Unit 5) and the smart-write layer's same-subject lookup. */
  liveByCategory(category: string, limit = 200): SemanticHit[] {
    this.init()
    try {
      return this.db.query(
        `SELECT id, text, ts, subject, category FROM ${FACTS_TABLE}
         WHERE category = ? AND superseded_at IS NULL ORDER BY ts DESC LIMIT ?`,
      ).all(category, limit) as SemanticHit[]
    } catch { return [] }
  }

  async recall(query: string, limit: number): Promise<SemanticHit[]> {
    this.init()
    const base = this.vectorIndex
      ? await this.recallHybrid(query, limit)
      : this.recallKeywordOnly(query, limit)
    return this.withPending(base, limit)
  }

  private async recallHybrid(query: string, limit: number): Promise<SemanticHit[]> {
    // Over-fetch from the hybrid retriever, then drop superseded rows + apply a
    // light recency tiebreaker. Fetch extra so that after filtering retired facts
    // we still have enough live ones to return `limit`.
    const retriever = new HybridRetriever(this.db, {
      ftsTableName: FACTS_FTS_TABLE,
      vectorIndex: this.vectorIndex!,
      topK: limit * 4,
      finalK: limit * 3,
    })
    const ranked = await retriever.retrieve(query)
    const live = this.hydrateLive(ranked.map(h => h.id))
    return this.applyRecencyTiebreak(live).slice(0, limit)
  }

  /** Always surface live pending-confirmation facts at the TOP, regardless of
   *  whether they matched the query — KAIROS must raise an unresolved conflict on
   *  the next turn even if the user changed topic. Deduped against base hits. */
  private withPending(base: SemanticHit[], limit: number): SemanticHit[] {
    const pending = this.liveByCategory('_pending_confirmation', 5)
    if (pending.length === 0) return base.slice(0, limit)
    const seen = new Set(pending.map(p => p.id))
    const rest = base.filter(h => !seen.has(h.id))
    return [...pending, ...rest].slice(0, limit)
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
      // superseded_at IS NULL → retired facts never surface.
      const rows = this.db.query(`
        SELECT f.id, f.text, f.ts, f.subject, f.category
        FROM ${FACTS_FTS_TABLE} fts
        JOIN ${FACTS_TABLE} f ON f.rowid = fts.rowid
        WHERE ${FACTS_FTS_TABLE} MATCH ? AND f.superseded_at IS NULL
        ORDER BY bm25(${FACTS_FTS_TABLE}) ASC
        LIMIT ?
      `).all(matchExpr, limit * 3) as SemanticHit[]
      return this.applyRecencyTiebreak(rows).slice(0, limit)
    } catch {
      return []
    }
  }

  /** Hydrate ids → live (non-superseded) hits, preserving input order. */
  private hydrateLive(ids: string[]): SemanticHit[] {
    if (ids.length === 0) return []
    const placeholders = ids.map(() => '?').join(',')
    const rows = this.db.query(
      `SELECT id, text, ts, subject, category FROM ${FACTS_TABLE}
       WHERE id IN (${placeholders}) AND superseded_at IS NULL`,
    ).all(...ids) as SemanticHit[]
    const byId = new Map(rows.map(r => [r.id, r]))
    return ids.map(id => byId.get(id)).filter((r): r is SemanticHit => r !== undefined)
  }

  /** Light recency tiebreaker: among results already ranked by relevance, give
   *  newer facts a small nudge so a fresh fact edges out an equally-relevant old
   *  one. NOT a takeover — relevance (input order) dominates; recency only shifts
   *  near-ties. Pending-confirmation facts are floated to the very top so KAIROS
   *  raises them first. Decay horizon ~30 days. */
  private applyRecencyTiebreak(hits: SemanticHit[]): SemanticHit[] {
    const now = Date.now()
    const HORIZON = 30 * 24 * 3600_000
    const TIEBREAK_WEIGHT = 0.15 // small — relevance rank still dominates
    return hits
      .map((h, i) => {
        const relevanceScore = 1 / (i + 1)                 // input order = relevance
        const ageFrac = Math.max(0, 1 - (now - h.ts) / HORIZON)
        return { h, score: relevanceScore + TIEBREAK_WEIGHT * ageFrac }
      })
      .sort((a, b) => b.score - a.score)
      .map(x => x.h)
  }
}
