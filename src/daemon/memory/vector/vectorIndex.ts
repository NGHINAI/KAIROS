// src/daemon/memory/vector/vectorIndex.ts
// Vector index using BLOB storage + pure-TS cosine similarity at query time.
//
// sqlite-vec is not usable under Bun's bundled SQLite (compiled with
// SQLITE_OMIT_LOAD_EXTENSION). This matches the Phase B pattern established
// in recall.ts / semanticMemory.ts: store embeddings as BLOB (Uint8Array),
// round-trip via Float32Array view, compute cosine in TypeScript.
//
// bge-small-en-v1.5 (via LocalEmbedder) produces UNIT-NORMALIZED vectors
// (normalize: true), so cosine similarity == dot product — no magnitude
// calculation needed.
//
// At KAIROS scale (≤100K memories per user), a full-scan over 384-dim vectors
// takes ~50-100ms — acceptable. HNSW indexing is a future follow-up if needed.

import type { Database } from 'bun:sqlite'
import type { Embedder } from './embedder'

export type VectorHit = {
  id: string
  similarity: number   // 0..1, higher = more similar (cosine)
  distance: number     // 1 - similarity, kept for compatibility
}

export type VectorIndexOptions = {
  tableName?: string   // default 'vec_memory'
  dim?: number         // default 384 (bge-small-en-v1.5)
}

export class VectorIndex {
  private readonly tableName: string
  private readonly dim: number
  private initialized = false

  constructor(
    private readonly db: Database,
    private readonly embedder: Embedder,
    opts: VectorIndexOptions = {},
  ) {
    this.tableName = opts.tableName ?? 'vec_memory'
    this.dim = opts.dim ?? 384
  }

  async init(): Promise<void> {
    if (this.initialized) return
    // Sanitize table name — only allow word chars to prevent SQL injection
    if (!/^\w+$/.test(this.tableName)) throw new Error(`Invalid tableName: ${this.tableName}`)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        id         TEXT    PRIMARY KEY,
        embed      BLOB    NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_${this.tableName}_created_at
        ON ${this.tableName}(created_at);
    `)
    this.initialized = true
  }

  async insert(id: string, text: string): Promise<void> {
    await this.init()
    const vec = await this.embedder.embed(text)
    // Round-trip: Float32Array → Uint8Array bytes for BLOB storage
    const blob = new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength)
    this.db.run(
      `INSERT OR REPLACE INTO ${this.tableName}(id, embed, created_at) VALUES (?, ?, ?)`,
      [id, blob, Date.now()],
    )
  }

  async insertBatch(items: Array<{ id: string; text: string }>): Promise<void> {
    await this.init()
    if (items.length === 0) return
    const texts = items.map(i => i.text)
    const vecs = await this.embedder.embedBatch(texts)
    const now = Date.now()
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO ${this.tableName}(id, embed, created_at) VALUES (?, ?, ?)`,
    )
    const insertAll = this.db.transaction(() => {
      for (let i = 0; i < items.length; i++) {
        const vec = vecs[i]!
        const blob = new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength)
        stmt.run(items[i]!.id, blob, now)
      }
    })
    insertAll()
  }

  async searchByText(query: string, k: number): Promise<VectorHit[]> {
    await this.init()
    const queryVec = await this.embedder.embed(query)
    return this.searchByVector(queryVec, k)
  }

  async searchByVector(queryVec: Float32Array, k: number): Promise<VectorHit[]> {
    await this.init()
    const rows = this.db
      .query(`SELECT id, embed FROM ${this.tableName}`)
      .all() as Array<{ id: string; embed: Uint8Array }>

    const hits: VectorHit[] = []
    for (const r of rows) {
      // Round-trip: Uint8Array BLOB → Float32Array view
      const vec = new Float32Array(r.embed.buffer, r.embed.byteOffset, r.embed.byteLength / 4)
      // bge-small-en-v1.5 is unit-normalized → cosine = dot product
      let dot = 0
      for (let i = 0; i < this.dim; i++) dot += queryVec[i]! * vec[i]!
      // Clamp to [0, 1] — numerical noise can push slightly outside
      const sim = Math.max(0, Math.min(1, dot))
      hits.push({ id: r.id, similarity: sim, distance: 1 - sim })
    }
    // Sort by similarity DESC, take top k
    hits.sort((a, b) => b.similarity - a.similarity)
    return hits.slice(0, k)
  }

  async delete(id: string): Promise<void> {
    await this.init()
    this.db.run(`DELETE FROM ${this.tableName} WHERE id = ?`, [id])
  }

  async count(): Promise<number> {
    await this.init()
    const row = this.db
      .query(`SELECT COUNT(*) AS n FROM ${this.tableName}`)
      .get() as { n: number }
    return row.n
  }
}
