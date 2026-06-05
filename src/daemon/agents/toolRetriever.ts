// src/daemon/agents/toolRetriever.ts
// Per-turn dynamic tool selection ("tool RAG"). With 100s of connected Composio
// tools, we never hand the planner all of them — we retrieve the ~K most relevant
// to the current utterance. Hybrid retrieval: dense (bge-small embeddings, catches
// meaning) + BM25 (catches exact proper nouns like "Klaviyo"/"Linear" that dense
// misses), fused via Reciprocal Rank Fusion. This is the converged industry pattern
// (Composio Tool Router, Anthropic Tool Search) and the answer to "what if I have
// 50 toolkits connected" — the planner only ever sees ~K tools, regardless of total.

export interface ToolEmbedder {
  embedBatch(texts: string[]): Promise<Float32Array[] | number[][]>
}

export interface ToolDoc {
  name: string
  toolkit?: string
  description: string
  parameters?: Record<string, any>
  /** Hypothetical utterances the tool answers — the biggest lever for voice recall. */
  hints?: string[]
}

interface IndexedDoc {
  doc: ToolDoc
  vector: number[]
  tokens: string[]      // for BM25
}

const DEFAULT_K = Number(process.env.KAIROS_MAX_TOOLS) || 8
const RRF_K0 = 60       // reciprocal-rank-fusion constant (standard)

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}

function composite(doc: ToolDoc): string {
  return [doc.name, doc.toolkit ?? "", doc.description ?? "", ...(doc.hints ?? [])].join(" ")
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]! }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

export class ToolRetriever {
  private docs: IndexedDoc[] = []
  private avgdl = 0
  private df = new Map<string, number>()   // document frequency per term
  private defaultK: number

  constructor(private deps: { embedder: ToolEmbedder; defaultK?: number }) {
    this.defaultK = deps.defaultK ?? DEFAULT_K
  }

  size(): number { return this.docs.length }

  /** Fetch indexed docs by exact tool name — used to pre-load the user's
   *  most-used tools directly (the "hot set"), skipping the search hop. */
  getByNames(names: string[]): ToolDoc[] {
    const want = new Set(names)
    return this.docs.filter((d) => want.has(d.doc.name)).map((d) => d.doc)
  }

  async index(docs: ToolDoc[]): Promise<void> {
    if (docs.length === 0) { this.docs = []; return }
    const vectors = await this.deps.embedder.embedBatch(docs.map(composite))
    this.docs = docs.map((doc, i) => ({
      doc,
      vector: Array.from(vectors[i] as any),
      tokens: tokenize(composite(doc)),
    }))
    // BM25 stats
    this.df.clear()
    let total = 0
    for (const d of this.docs) {
      total += d.tokens.length
      for (const t of new Set(d.tokens)) this.df.set(t, (this.df.get(t) ?? 0) + 1)
    }
    this.avgdl = total / this.docs.length
  }

  /** BM25 score of a doc against query terms. */
  private bm25(qTerms: string[], d: IndexedDoc): number {
    const k1 = 1.5, b = 0.75, N = this.docs.length
    const tf = new Map<string, number>()
    for (const t of d.tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
    let score = 0
    for (const q of qTerms) {
      const f = tf.get(q)
      if (!f) continue
      const n = this.df.get(q) ?? 0
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5))
      score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * (d.tokens.length / (this.avgdl || 1))))
    }
    return score
  }

  /** Hybrid dense + BM25 retrieval, fused by Reciprocal Rank Fusion. */
  async retrieve(query: string, k?: number): Promise<ToolDoc[]> {
    if (this.docs.length === 0) return []
    const topK = k ?? this.defaultK

    // Dense ranking
    const [qvecRaw] = await this.deps.embedder.embedBatch([query])
    const qvec = Array.from(qvecRaw as any) as number[]
    const denseRank = this.docs
      .map((d, i) => ({ i, s: cosine(qvec, d.vector) }))
      .sort((a, b) => b.s - a.s)

    // Sparse (BM25) ranking
    const qTerms = tokenize(query)
    const sparseRank = this.docs
      .map((d, i) => ({ i, s: this.bm25(qTerms, d) }))
      .sort((a, b) => b.s - a.s)

    // Reciprocal Rank Fusion
    const fused = new Map<number, number>()
    denseRank.forEach((r, rank) => fused.set(r.i, (fused.get(r.i) ?? 0) + 1 / (RRF_K0 + rank)))
    sparseRank.forEach((r, rank) => {
      // Only credit BM25 hits that actually matched a term (s>0), so it stays sparse.
      if (r.s > 0) fused.set(r.i, (fused.get(r.i) ?? 0) + 1 / (RRF_K0 + rank))
    })

    return [...fused.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topK)
      .map(([i]) => this.docs[i]!.doc)
  }
}
