// src/daemon/llm/providers/gemini.ts
// Google Gemini adapter using raw HTTP (REST API).
// Flash Lite is the cheapest viable model in the entire router catalog ($0.075/M input).
// Supports explicit cachedContents resource for long-hint blocks ≥4096 tokens.

import { createHash } from 'crypto'
import type {
  CompletionRequest, CompletionResult, LLMProvider, ProviderConfig, Tier,
} from '../types'
import { PromptAssembler } from '../cache/promptAssembler'

// USD per million tokens
// cached_input: 75% discount vs base input (Gemini context cache pricing)
const PRICING: Record<string, { input: number; output: number; cached_input: number }> = {
  // Active models — current generation (2026-05-26)
  'gemini-3.1-flash-lite': { input: 0.25, output: 1.50,  cached_input: 0.025  }, // GA May 7 2026; cached est. (unconfirmed)
  'gemini-3.5-flash':      { input: 1.50, output: 9.00,  cached_input: 0.15   }, // GA May 19 2026
  // Deprecated models — sunset Oct 16 2026; still in use as fallbacks
  'gemini-2.5-flash-lite': { input: 0.10, output: 0.40,  cached_input: 0.025  },
  'gemini-2.5-flash':      { input: 0.30, output: 2.50,  cached_input: 0.075  },
  'gemini-2.5-pro':        { input: 1.25, output: 10.00, cached_input: 0.3125 },
}

// Models that support the explicit cachedContents resource.
// Experimental / preview models are intentionally excluded.
// gemini-1.5-flash and gemini-1.5-pro removed — shut down (not on current pricing page).
const CACHE_SUPPORTED_MODELS = new Set([
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash',
])

// Minimum token count of long-hint content before we bother creating a cache.
const CACHE_MIN_TOKENS = 4096

// TTL for cached content (1 hour, expressed as seconds string for REST API).
const CACHE_TTL_SECONDS = 3600
const CACHE_TTL_MS      = CACHE_TTL_SECONDS * 1000

const GEMINI_BASE = 'https://generativelanguage.googleapis.com'
const API_VERSION = 'v1beta'

const TIER_MODELS: Record<Tier, string[]> = {
  ultra_cheap: ['gemini-2.5-flash-lite', 'gemini-3.1-flash-lite'], // 2.5-flash-lite deprecated Oct 2026; migrate to 3.1-flash-lite
  mid:         ['gemini-2.5-flash'],                               // deprecated Oct 2026; successor: gemini-3.5-flash (but 5× costlier)
  heavy:       ['gemini-2.5-pro'],
}

type CacheEntry = {
  name: string        // e.g. 'cachedContents/abc123'
  created_at: number  // Date.now() when created
  ttl_ms: number
}

export type GeminiProviderConfig = ProviderConfig & {
  /** Injected fetch — used in tests to intercept HTTP calls. */
  _fetch?: typeof fetch
  /** Optional API key override (takes precedence over api_key_env). */
  apiKey?: string
}

const assembler = new PromptAssembler()

export class GeminiProvider implements LLMProvider {
  readonly id = 'gemini' as const

  /** Per-instance cache index: sha256(model:longContent) → CacheEntry */
  private readonly cacheIndex = new Map<string, CacheEntry>()

  constructor(private cfg: GeminiProviderConfig) {}

  isConfigured(): boolean {
    if (!this.cfg.enabled) return false
    if (this.cfg.apiKey) return true
    return Boolean(this.cfg.api_key_env && process.env[this.cfg.api_key_env])
  }

  modelsForTier(tier: Tier): string[] { return TIER_MODELS[tier] }

  pricePerMillion(model: string): { input: number; output: number } {
    const p = PRICING[model]
    return p ? { input: p.input, output: p.output } : { input: 1, output: 4 }
  }

  private getApiKey(): string {
    if (this.cfg.apiKey) return this.cfg.apiKey
    return process.env[this.cfg.api_key_env!] ?? ''
  }

  private getFetch(): typeof fetch {
    return (this.cfg._fetch as typeof fetch) ?? fetch
  }

  warmupTLS(): void {
    if (!this.isConfigured()) return
    fetch(GEMINI_BASE, { method: 'HEAD' }).catch(() => { /* ignore */ })
  }

  // ─── cachedContents helpers ───────────────────────────────────────────────

  private cacheKey(model: string, longContent: string): string {
    return createHash('sha256').update(`${model}:${longContent}`).digest('hex')
  }

  /**
   * Returns an existing cache name if still within TTL, otherwise creates a
   * new cachedContents resource and stores it in the index.
   */
  private async getOrCreateCache(model: string, longContent: string): Promise<string> {
    const key = this.cacheKey(model, longContent)
    const existing = this.cacheIndex.get(key)
    if (existing && Date.now() - existing.created_at < existing.ttl_ms) {
      return existing.name
    }

    // Create new cachedContents resource via POST
    const apiKey = this.getApiKey()
    const url = `${GEMINI_BASE}/${API_VERSION}/cachedContents?key=${encodeURIComponent(apiKey)}`
    // persona + STANDING_ORDERS + procedural memory are semantically a system instruction,
    // not a user message — use systemInstruction for correct conversation structure.
    const body = JSON.stringify({
      model: `models/${model}`,
      systemInstruction: { parts: [{ text: longContent }] },
      ttl: `${CACHE_TTL_SECONDS}s`,
    })

    const resp = await this.getFetch()(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '')
      throw new Error(`Gemini cachedContents create failed (${resp.status}): ${errText}`)
    }

    const data = await resp.json() as { name: string }
    const entry: CacheEntry = {
      name: data.name,
      created_at: Date.now(),
      ttl_ms: CACHE_TTL_MS,
    }
    this.cacheIndex.set(key, entry)
    return entry.name
  }

  // ─── main complete ────────────────────────────────────────────────────────

  async complete(model: string, req: CompletionRequest): Promise<CompletionResult> {
    const start = Date.now()

    const assembled = assembler.assemble(req)

    // Separate blocks by hint tier
    const longParts: string[]     = []
    const shortParts: string[]    = []
    const volatileParts: string[] = []

    for (const block of assembled.layered) {
      if (block.cache_hint === 'long')       longParts.push(block.text)
      else if (block.cache_hint === 'short') shortParts.push(block.text)
      else                                   volatileParts.push(block.text)
    }

    // Estimate tokens in long content (1 token ≈ 4 chars)
    const longContent = longParts.join('\n\n')
    const longTokenEstimate = Math.ceil(longContent.length / 4)

    // Decide whether to use cachedContents
    const useCaching =
      longContent.length > 0 &&
      longTokenEstimate >= CACHE_MIN_TOKENS &&
      CACHE_SUPPORTED_MODELS.has(model)

    let cachedContentName: string | null = null
    if (useCaching) {
      cachedContentName = await this.getOrCreateCache(model, longContent)
    }

    // Build the inline user turn:
    //   volatile content + short content + user prompt
    const inlineParts: string[] = []
    if (!useCaching && longContent.length > 0) {
      // Fall-through: long content goes inline too
      inlineParts.push(longContent)
    }
    inlineParts.push(...shortParts)
    inlineParts.push(...volatileParts)
    inlineParts.push(assembled.user_prompt)

    const userText = inlineParts.filter(Boolean).join('\n\n')

    // Build request body
    const requestBody: Record<string, unknown> = {
      contents: [
        {
          role: 'user',
          parts: [{ text: userText }],
        },
      ],
      generationConfig: {
        maxOutputTokens: req.max_output_tokens,
        responseMimeType: req.structured ? 'application/json' : undefined,
      },
    }
    if (cachedContentName) {
      requestBody.cachedContent = cachedContentName
    }

    const apiKey = this.getApiKey()
    const url = `${GEMINI_BASE}/${API_VERSION}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`

    const resp = await this.getFetch()(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    })

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '')
      throw new Error(`Gemini generateContent failed (${resp.status}): ${errText}`)
    }

    const data = await resp.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
      usageMetadata?: {
        promptTokenCount?: number
        candidatesTokenCount?: number
        cachedContentTokenCount?: number
      }
    }

    const text = data.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? ''
    const inputTok       = data.usageMetadata?.promptTokenCount ?? 0
    const outputTok      = data.usageMetadata?.candidatesTokenCount ?? 0
    const cachedTok      = data.usageMetadata?.cachedContentTokenCount ?? 0
    const nonCachedTok   = Math.max(0, inputTok - cachedTok)

    const pricing = PRICING[model] ?? { input: 1, output: 4, cached_input: 0.25 }
    const costCents = Math.ceil((
      (nonCachedTok / 1_000_000) * pricing.input        +
      (cachedTok    / 1_000_000) * pricing.cached_input +
      (outputTok    / 1_000_000) * pricing.output
    ) * 100)

    let parsed: unknown = undefined
    if (req.structured) {
      try { parsed = JSON.parse(text) } catch { /* leave undefined */ }
    }

    return {
      text,
      parsed,
      provider: this.id,
      model,
      cost_cents: costCents,
      latency_ms: Date.now() - start,
      fallback_count: 0,
      input_tokens: inputTok,
      output_tokens: outputTok,
      cached_input_tokens: cachedTok,
      cache_creation_tokens: 0,
    }
  }
}

/**
 * GeminiApiProvider — test-friendly alias for GeminiProvider.
 * Accepts { apiKey, _fetch } directly and uses 'gemini-1.5-flash' as the
 * default model so tests can call complete(req) without a separate model arg.
 */
export class GeminiApiProvider extends GeminiProvider {
  private readonly defaultModel: string

  constructor(opts: { apiKey?: string; _fetch?: typeof fetch; model?: string }) {
    super({
      enabled: true,
      api_key_env: undefined,
      apiKey: opts.apiKey,
      _fetch: opts._fetch,
    } as GeminiProviderConfig)
    this.defaultModel = opts.model ?? 'gemini-2.5-flash-lite'
  }

  /** Single-arg complete using the default model. */
  override async complete(modelOrReq: string | CompletionRequest, req?: CompletionRequest): Promise<CompletionResult> {
    if (typeof modelOrReq === 'string') {
      return super.complete(modelOrReq, req!)
    }
    return super.complete(this.defaultModel, modelOrReq)
  }
}
