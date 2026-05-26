// In-process embeddings via Transformers.js ONNX runtime.
// Default model: Xenova/bge-small-en-v1.5 (33MB quantized, 384-dim, MTEB-strong).
//
// First call downloads + caches the model under ~/.kairos/cache/huggingface/.
// Subsequent runs load from disk in ~200ms.
//
// v3 API note: `quantized: true` is gone; use `dtype: 'q8'` instead.

import { pipeline, env, type FeatureExtractionPipeline } from '@huggingface/transformers'
import { homedir } from 'os'
import { join } from 'path'

// Pin to a stable model. Override via env if needed for evaluation.
const DEFAULT_MODEL = process.env.KAIROS_EMBED_MODEL ?? 'Xenova/bge-small-en-v1.5'
const DIM = 384

export interface Embedder {
  readonly dim: number
  warmup(): Promise<void>
  embed(text: string): Promise<Float32Array>
  embedBatch(texts: string[]): Promise<Float32Array[]>
}

export class LocalEmbedder implements Embedder {
  readonly dim = DIM
  private pipe: FeatureExtractionPipeline | null = null
  private warmupPromise: Promise<void> | null = null
  private readonly model: string

  constructor(opts: { model?: string; cacheDir?: string } = {}) {
    this.model = opts.model ?? DEFAULT_MODEL
    // Cache models under ~/.kairos/cache/huggingface so we own the cache location.
    env.cacheDir = opts.cacheDir ?? join(homedir(), '.kairos', 'cache', 'huggingface')
  }

  async warmup(): Promise<void> {
    if (this.warmupPromise) return this.warmupPromise
    this.warmupPromise = (async () => {
      this.pipe = await pipeline('feature-extraction', this.model, {
        // v3 uses dtype instead of quantized: true
        dtype: 'q8',
      }) as FeatureExtractionPipeline
    })()
    return this.warmupPromise
  }

  async embed(text: string): Promise<Float32Array> {
    await this.warmup()
    const result = await this.pipe!(text, { pooling: 'mean', normalize: true })
    // result.data is a typed array (Float32Array for fp32/q8 output)
    return new Float32Array(result.data as ArrayLike<number>)
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    await this.warmup()
    const result = await this.pipe!(texts, { pooling: 'mean', normalize: true })
    // For a batch of N texts, result.data is a flat Float32Array of length N*DIM
    const flat = result.data as Float32Array
    const out: Float32Array[] = []
    for (let i = 0; i < texts.length; i++) {
      out.push(new Float32Array(flat.buffer, flat.byteOffset + i * DIM * 4, DIM))
    }
    return out
  }
}

// Stub for future hosted-mode embedder (Voyage / OpenAI / Gemini)
export class HostedEmbedder implements Embedder {
  readonly dim = DIM
  async warmup(): Promise<void> { /* not implemented in C.2.6 */ }
  async embed(_text: string): Promise<Float32Array> { throw new Error('HostedEmbedder: not implemented in C.2.6') }
  async embedBatch(_texts: string[]): Promise<Float32Array[]> { throw new Error('HostedEmbedder: not implemented in C.2.6') }
}
