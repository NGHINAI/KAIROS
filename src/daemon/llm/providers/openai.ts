// src/daemon/llm/providers/openai.ts
// One adapter for three providers: openai, kimi (Moonshot), ollama (local).
// All speak the OpenAI Chat Completions API; differ only in baseURL + auth.

import OpenAI from 'openai'
import type {
  CompletionRequest, CompletionResult, LLMProvider, ProviderConfig, ProviderId, Tier,
} from '../types'
import { PromptAssembler } from '../cache/promptAssembler'

type Variant = Extract<ProviderId, 'openai' | 'kimi' | 'ollama'>

// USD per million tokens
// cached_input: OpenAI charges 50% of base input for cache hits; cache writes are FREE.
const PRICING: Record<Variant, Record<string, { input: number; output: number; cached_input: number }>> = {
  openai: {
    'gpt-4o-mini': { input: 0.15,  output: 0.60,  cached_input: 0.075 },
    'gpt-4o':      { input: 2.50,  output: 10.00, cached_input: 1.25  },
    'gpt-5':       { input: 5.00,  output: 15.00, cached_input: 2.50  },
  },
  kimi: {
    'moonshot-v1-8k':  { input: 0.15, output: 0.60, cached_input: 0 },
    'moonshot-v1-32k': { input: 0.30, output: 1.20, cached_input: 0 },
  },
  ollama: {
    'qwen3:8b':   { input: 0, output: 0, cached_input: 0 },
    'qwen3:32b':  { input: 0, output: 0, cached_input: 0 },
    'llama3.3':   { input: 0, output: 0, cached_input: 0 },
  },
}

const TIER_MODELS: Record<Variant, Record<Tier, string[]>> = {
  openai: {
    ultra_cheap: ['gpt-4o-mini'],
    mid:         ['gpt-4o'],
    heavy:       ['gpt-5'],
  },
  kimi: {
    ultra_cheap: ['moonshot-v1-8k'],
    mid:         ['moonshot-v1-32k'],
    heavy:       ['moonshot-v1-32k'],
  },
  ollama: {
    ultra_cheap: ['qwen3:8b'],
    mid:         ['qwen3:32b'],
    heavy:       ['qwen3:32b'],
  },
}

export type OpenAIProviderConfig = ProviderConfig & {
  /** Injected fetch — used in tests to intercept HTTP calls. */
  _fetch?: typeof fetch
}

const assembler = new PromptAssembler()

export class OpenAIProvider implements LLMProvider {
  readonly id: Variant
  private client: OpenAI | null = null

  constructor(id: Variant, private cfg: OpenAIProviderConfig) {
    this.id = id
  }

  isConfigured(): boolean {
    if (!this.cfg.enabled) return false
    if (this.cfg.api_key_env) {
      return Boolean(process.env[this.cfg.api_key_env])
    }
    return Boolean(this.cfg.base_url)
  }

  modelsForTier(tier: Tier): string[] {
    return TIER_MODELS[this.id][tier]
  }

  pricePerMillion(model: string): { input: number; output: number } {
    const p = PRICING[this.id][model]
    return p ? { input: p.input, output: p.output } : { input: 0, output: 0 }
  }

  private getClient(): OpenAI {
    if (this.client) return this.client
    const apiKey = this.cfg.api_key_env ? (process.env[this.cfg.api_key_env] ?? 'ollama') : 'ollama'
    this.client = new OpenAI({
      apiKey,
      baseURL: this.cfg.base_url,
      ...(this.cfg._fetch ? { fetch: this.cfg._fetch as any } : {}),
    })
    return this.client
  }

  warmupTLS(): void {
    if (!this.isConfigured()) return
    const url = this.cfg.base_url ?? 'https://api.openai.com'
    fetch(url, { method: 'HEAD' }).catch(() => { /* ignore */ })
  }

  async complete(model: string, req: CompletionRequest): Promise<CompletionResult> {
    const start = Date.now()

    // Normalize to block-based form
    const normalised = (req.system_blocks && req.system_blocks.length > 0)
      ? req
      : PromptAssembler.fromLegacy(req)

    const assembled = assembler.assemble(normalised)

    // Build system string: non-volatile blocks (long first, then short) concatenated.
    // OpenAI caches the prompt prefix automatically — stable ordering ensures cache hits.
    const systemParts: string[] = []
    const volatileParts: string[] = []
    for (const block of assembled.layered) {
      if (block.cache_hint === 'none') {
        volatileParts.push(block.text)
      } else {
        systemParts.push(block.text)
      }
    }

    const messages: { role: 'system' | 'user'; content: string }[] = []
    if (systemParts.length > 0) {
      messages.push({ role: 'system', content: systemParts.join('\n\n') })
    }

    // Volatile blocks prepended to user message
    const userContent = volatileParts.length > 0
      ? `${volatileParts.join('\n\n')}\n\n${assembled.user_prompt}`
      : assembled.user_prompt
    messages.push({ role: 'user', content: userContent })

    const completion = await this.getClient().chat.completions.create({
      model,
      messages,
      max_tokens: req.max_output_tokens,
      response_format: req.structured ? { type: 'json_object' } : undefined,
    })

    const text = completion.choices[0]?.message?.content ?? ''
    const inputTok = completion.usage?.prompt_tokens ?? 0
    const outputTok = completion.usage?.completion_tokens ?? 0
    const cachedTok = (completion.usage as any)?.prompt_tokens_details?.cached_tokens ?? 0

    const pricingEntry = PRICING[this.id][model]
    const inputPrice  = pricingEntry?.input        ?? 0
    const outputPrice = pricingEntry?.output       ?? 0
    const cachedPrice = pricingEntry?.cached_input ?? inputPrice * 0.5

    // Cost: (input - cached) at full rate + cached at discounted rate + output
    const nonCachedTok = inputTok - cachedTok
    const costCents = Math.ceil((
      (nonCachedTok / 1_000_000) * inputPrice  +
      (cachedTok    / 1_000_000) * cachedPrice +
      (outputTok    / 1_000_000) * outputPrice
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
