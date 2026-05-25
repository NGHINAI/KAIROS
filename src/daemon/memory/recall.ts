// src/daemon/memory/recall.ts
// Hybrid retrieval API over L3 semantic memory.
// Lexical: FTS5 BM25 over body + subject
// Semantic: pure-TS cosine over BLOB embeddings loaded in-memory
// Hybrid: interleave + dedupe by id

import type { Database } from 'bun:sqlite'
import type { SemanticRow } from './semanticMemory'

export class Recall {
  constructor(private db: Database) {}

  lexical(query: string, limit: number = 10): SemanticRow[] {
    // Sanitize for FTS5: strip non-alphanumeric (FTS5 MATCH chokes on
    // '?', quotes, etc), tokenize, OR-join. Caller can pass natural-
    // language questions — we extract searchable tokens defensively.
    const tokens = query.replace(/[^\w\s]/g, ' ').split(/\s+/).filter(t => t.length > 1)
    if (tokens.length === 0) return []
    const ftsQuery = tokens.map(t => `"${t}"`).join(' OR ')
    const rows = this.db.query(
      `SELECT s.* FROM mem_l3_fts f
       JOIN mem_l3_semantic s ON s.id = f.rowid
       WHERE mem_l3_fts MATCH ? AND s.decayed_at IS NULL
       ORDER BY rank LIMIT ?`,
    ).all(ftsQuery, limit) as Array<Omit<SemanticRow, 'source_episodes'> & { source_episodes: string | null }>
    return rows.map(r => ({ ...r, source_episodes: r.source_episodes ? JSON.parse(r.source_episodes) : null }))
  }

  semantic(embedding: number[], limit: number = 10): SemanticRow[] {
    const rows = this.db.query(
      `SELECT s.*, e.embedding AS emb_blob
       FROM mem_l3_semantic s JOIN mem_l3_embeddings e ON e.l3_id = s.id
       WHERE s.decayed_at IS NULL`,
    ).all() as Array<Omit<SemanticRow, 'source_episodes'> & { source_episodes: string | null; emb_blob: Uint8Array }>

    const query = new Float32Array(embedding)
    const queryNorm = norm(query)
    if (queryNorm === 0) return []

    const scored: Array<{ row: Omit<SemanticRow, 'source_episodes'> & { source_episodes: string | null }; score: number }> = []
    for (const r of rows) {
      const { emb_blob, ...rowFields } = r
      const vec = new Float32Array(emb_blob.buffer, emb_blob.byteOffset, emb_blob.byteLength / 4)
      const score = cosine(query, vec, queryNorm)
      scored.push({ row: rowFields as any, score })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit).map(s => ({
      ...s.row,
      source_episodes: s.row.source_episodes ? JSON.parse(s.row.source_episodes as any) : null,
    }))
  }

  hybrid(query: string, embedding: number[], limit: number = 10): SemanticRow[] {
    const lex = this.lexical(query, limit)
    const sem = this.semantic(embedding, limit)
    const seen = new Set<number>()
    const merged: SemanticRow[] = []
    for (let i = 0; i < limit; i++) {
      const l = lex[i], s = sem[i]
      if (l && !seen.has(l.id)) { merged.push(l); seen.add(l.id) }
      if (s && !seen.has(s.id)) { merged.push(s); seen.add(s.id) }
      if (merged.length >= limit) break
    }
    return merged.slice(0, limit)
  }
}

function norm(v: Float32Array): number {
  let s = 0
  for (let i = 0; i < v.length; i++) s += v[i]! * v[i]!
  return Math.sqrt(s)
}

function cosine(a: Float32Array, b: Float32Array, aNorm: number): number {
  let dot = 0, bSum = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) { dot += a[i]! * b[i]!; bSum += b[i]! * b[i]! }
  const bNorm = Math.sqrt(bSum)
  return bNorm === 0 ? 0 : dot / (aNorm * bNorm)
}
