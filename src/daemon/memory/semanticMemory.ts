// src/daemon/memory/semanticMemory.ts
// L3 — semantic memory. Persistent facts with 768-dim BLOB embeddings.
// reinforceOrWrite is the human-like behavior — when the dreamer
// re-derives the same fact, we increment frequency + bump last_seen.

import type { Database } from 'bun:sqlite'

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
