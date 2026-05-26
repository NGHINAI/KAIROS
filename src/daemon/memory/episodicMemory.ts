// src/daemon/memory/episodicMemory.ts
// L2 — episodic memory. Each row is one "episode" — a meaningful sequence
// of events grouped together (a work session, a conversation, etc).
//
// EpisodicMemory  — original structured L2 store (episodes with typed fields)
// EpisodicStore   — lightweight observation store with hybrid recall (FTS5 + vector)
//                   implements the MemoryStore interface used by MemoryInjector

import type { Database } from 'bun:sqlite'
import type { VectorIndex } from './vector/vectorIndex'
import { HybridRetriever } from './vector/hybridRetriever'

export type EpisodeInput = {
  started_at: number
  ended_at: number
  episode_type: string
  title: string
  summary: string
  event_ids: number[]
  importance: number
}

export type Episode = EpisodeInput & {
  id: number
  promoted_l3: number
  created_at: number
}

export class EpisodicMemory {
  constructor(private db: Database) {}

  writeEpisode(e: EpisodeInput): number {
    const info = this.db.run(
      `INSERT INTO mem_l2_episodes
         (started_at, ended_at, episode_type, title, summary, event_ids, importance, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [e.started_at, e.ended_at, e.episode_type, e.title, e.summary,
       JSON.stringify(e.event_ids), e.importance, Date.now()],
    )
    return Number(info.lastInsertRowid)
  }

  recent(limit: number = 20): Episode[] {
    const rows = this.db.query(
      'SELECT * FROM mem_l2_episodes ORDER BY started_at DESC LIMIT ?',
    ).all(limit) as Array<Episode & { event_ids: string }>
    return rows.map(r => ({ ...r, event_ids: JSON.parse(r.event_ids) }))
  }

  byType(type: string, limit: number = 20): Episode[] {
    const rows = this.db.query(
      'SELECT * FROM mem_l2_episodes WHERE episode_type = ? ORDER BY started_at DESC LIMIT ?',
    ).all(type, limit) as Array<Episode & { event_ids: string }>
    return rows.map(r => ({ ...r, event_ids: JSON.parse(r.event_ids) }))
  }

  unpromoted(limit: number = 50): Episode[] {
    const rows = this.db.query(
      `SELECT * FROM mem_l2_episodes
       WHERE promoted_l3 = 0
       ORDER BY importance DESC, started_at DESC
       LIMIT ?`,
    ).all(limit) as Array<Episode & { event_ids: string }>
    return rows.map(r => ({ ...r, event_ids: JSON.parse(r.event_ids) }))
  }

  markPromoted(id: number): void {
    this.db.run('UPDATE mem_l2_episodes SET promoted_l3 = 1 WHERE id = ?', [id])
  }
}

// ---------------------------------------------------------------------------
// EpisodicStore — lightweight observation store for MemoryInjector (L2 slot)
// ---------------------------------------------------------------------------
// Stores short text observations (e.g. from daemon sensors). Each row has a
// TEXT id (UUID), a source label, the observation text, and a timestamp.
//
// FTS5 table: mem_l2_obs_fts — content-backed by mem_l2_observations
// Hybrid recall: when a VectorIndex is provided, uses HybridRetriever (RRF);
// otherwise falls back to pure FTS5 keyword recall.

const OBS_TABLE = 'mem_l2_observations'
const OBS_FTS_TABLE = 'mem_l2_obs_fts'

export type ObservationInput = {
  source: string
  text: string
}

export type EpisodicHit = {
  id: string
  text: string
  ts: number
}

export class EpisodicStore {
  private initialized = false

  constructor(
    private readonly db: Database,
    private readonly vectorIndex?: VectorIndex,
  ) {}

  private init(): void {
    if (this.initialized) return
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${OBS_TABLE} (
        id     TEXT    PRIMARY KEY,
        source TEXT    NOT NULL,
        text   TEXT    NOT NULL,
        ts     INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_l2_obs_ts ON ${OBS_TABLE}(ts);

      CREATE VIRTUAL TABLE IF NOT EXISTS ${OBS_FTS_TABLE} USING fts5(
        text,
        content='${OBS_TABLE}',
        content_rowid='rowid'
      );

      CREATE TRIGGER IF NOT EXISTS mem_l2_obs_ai
        AFTER INSERT ON ${OBS_TABLE} BEGIN
          INSERT INTO ${OBS_FTS_TABLE}(rowid, text) VALUES (new.rowid, new.text);
        END;
      CREATE TRIGGER IF NOT EXISTS mem_l2_obs_ad
        AFTER DELETE ON ${OBS_TABLE} BEGIN
          DELETE FROM ${OBS_FTS_TABLE} WHERE rowid = old.rowid;
        END;
      CREATE TRIGGER IF NOT EXISTS mem_l2_obs_au
        AFTER UPDATE ON ${OBS_TABLE} BEGIN
          DELETE FROM ${OBS_FTS_TABLE} WHERE rowid = old.rowid;
          INSERT INTO ${OBS_FTS_TABLE}(rowid, text) VALUES (new.rowid, new.text);
        END;
    `)
    this.initialized = true
  }

  async record(input: ObservationInput): Promise<string> {
    this.init()
    const id = crypto.randomUUID()
    const ts = Date.now()
    this.db.run(
      `INSERT INTO ${OBS_TABLE}(id, source, text, ts) VALUES (?, ?, ?, ?)`,
      [id, input.source, input.text, ts],
    )
    // Auto-embed into the VectorIndex when available (graceful degradation on error)
    if (this.vectorIndex) {
      try {
        await this.vectorIndex.insert(id, input.text)
      } catch (err) {
        console.warn('[EpisodicStore] vectorIndex.insert failed (non-fatal):', err)
      }
    }
    return id
  }

  async recall(query: string, limit: number): Promise<EpisodicHit[]> {
    this.init()
    if (!this.vectorIndex) {
      return this.recallKeywordOnly(query, limit)
    }
    const retriever = new HybridRetriever(this.db, {
      ftsTableName: OBS_FTS_TABLE,
      vectorIndex: this.vectorIndex,
      topK: limit * 2,
      finalK: limit,
    })
    const hits = await retriever.retrieve(query)
    return this.hydrate(hits.map(h => h.id))
  }

  private recallKeywordOnly(query: string, limit: number): EpisodicHit[] {
    const tokens = query
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 1)
    if (tokens.length === 0) return []
    const matchExpr = tokens.map(t => `"${t}"`).join(' OR ')
    try {
      const rows = this.db.query(`
        SELECT o.id, o.text, o.ts
        FROM ${OBS_FTS_TABLE} f
        JOIN ${OBS_TABLE} o ON o.rowid = f.rowid
        WHERE ${OBS_FTS_TABLE} MATCH ?
        ORDER BY bm25(${OBS_FTS_TABLE}) ASC
        LIMIT ?
      `).all(matchExpr, limit) as EpisodicHit[]
      return rows
    } catch {
      return []
    }
  }

  private hydrate(ids: string[]): EpisodicHit[] {
    if (ids.length === 0) return []
    const placeholders = ids.map(() => '?').join(',')
    const rows = this.db.query(
      `SELECT id, text, ts FROM ${OBS_TABLE} WHERE id IN (${placeholders})`,
    ).all(...ids) as EpisodicHit[]
    const byId = new Map(rows.map(r => [r.id, r]))
    return ids.map(id => byId.get(id)).filter((r): r is EpisodicHit => r !== undefined)
  }
}
