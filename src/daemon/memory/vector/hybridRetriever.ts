// src/daemon/memory/vector/hybridRetriever.ts
// Reciprocal Rank Fusion (RRF) over FTS5 keyword results + vector cosine results.
//
// RRF is a proven hybrid ranking technique (Cormack et al. 2009) that combines
// two independent ranking systems without requiring normalization or tuning.
// Formula: RRF(d) = sum over all rankings (1 / (k + rank(d)))
// Default k=60 per literature.
//
// Mirrors the punctuation-tokenization fix from recall.ts for FTS5 MATCH queries.

import type { Database } from 'bun:sqlite'
import type { VectorIndex } from './vectorIndex'

export type RankedHit = { id: string; score: number }

const RRF_K = 60

export function rrfFuse(rankings: RankedHit[][], limit: number, k: number = RRF_K): RankedHit[] {
  const acc = new Map<string, number>()
  for (const ranking of rankings) {
    ranking.forEach((hit, rank) => {
      const prev = acc.get(hit.id) ?? 0
      acc.set(hit.id, prev + 1 / (k + rank + 1))
    })
  }
  const fused = [...acc.entries()].map(([id, score]) => ({ id, score }))
  fused.sort((a, b) => b.score - a.score)
  return fused.slice(0, limit)
}

export type HybridRetrieverOptions = {
  ftsTableName: string
  vectorIndex: VectorIndex
  topK?: number // default 20
  finalK?: number // default 10
}

export class HybridRetriever {
  constructor(private db: Database, private opts: HybridRetrieverOptions) {}

  async retrieve(query: string): Promise<RankedHit[]> {
    const topK = this.opts.topK ?? 20
    const finalK = this.opts.finalK ?? 10

    const [ftsHits, vecHits] = await Promise.all([
      this.ftsSearch(query, topK),
      this.opts.vectorIndex.searchByText(query, topK),
    ])

    const ftsRanked: RankedHit[] = ftsHits.map(r => ({ id: r.id, score: r.bm25 }))
    const vecRanked: RankedHit[] = vecHits.map(h => ({ id: h.id, score: h.similarity }))

    return rrfFuse([ftsRanked, vecRanked], finalK)
  }

  private async ftsSearch(query: string, limit: number): Promise<Array<{ id: string; bm25: number }>> {
    // Punctuation-tokenize: drop non-alnum, lower-case, OR-join (mirrors recall.ts fix)
    const tokens = query
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 1)
    if (tokens.length === 0) return []
    const matchExpr = tokens.map(t => `"${t}"`).join(' OR ')
    try {
      return this.db.query(`
        SELECT id, bm25(${this.opts.ftsTableName}) AS bm25
        FROM ${this.opts.ftsTableName}
        WHERE ${this.opts.ftsTableName} MATCH ?
        ORDER BY bm25 ASC
        LIMIT ?
      `).all(matchExpr, limit) as Array<{ id: string; bm25: number }>
    } catch {
      return []
    }
  }
}
