// src/daemon/llm/providers/openai.ts
// One adapter for three providers: openai, kimi (Moonshot), ollama (local).
// All speak the OpenAI Chat Completions API; differ only in baseURL + auth.

import OpenAI from 'openai'
import type {
  CompletionRequest, CompletionResult, LLMProvider, ProviderConfig, ProviderId, Tier,
} from '../types'

type Variant = Extract<ProviderId, 'openai' | 'kimi' | 'ollama'>

const PRICING: Record<Variant, Record<string, { input: number; output: number }>> = {
  openai: {
    'gpt-4o-mini': { input: 0.15, output: 0.60 },
    'gpt-4o':      { input: 2.50, output: 10.00 },
    'gpt-5':       { input: 5.00, output: 15.00 },
  },
  kimi: {
    'moonshot-v1-8k':  { input: 0.15, output: 0.60 },
    'moonshot-v1-32k': { input: 0.30, output: 1.20 },
  },
  ollama: {
    'qwen3:8b':   { input: 0, output: 0 },
    'qwen3:32b':  { input: 0, output: 0 },
    'llama3.3':   { input: 0, output: 0 },
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

export class OpenAIProvider implements LLMProvider {
  readonly id: Variant
  private client: OpenAI | null = null

  constructor(id: Variant, private cfg: ProviderConfig) {
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
    return PRICING[this.id][model] ?? { input: 0, output: 0 }
  }

  private getClient(): OpenAI {
    if (this.client) return this.client
    const apiKey = this.cfg.api_key_env ? (process.env[this.cfg.api_key_env] ?? 'ollama') : 'ollama'
    this.client = new OpenAI({ apiKey, baseURL: this.cfg.base_url })
    return this.client
  }

  warmupTLS(): void {
    if (!this.isConfigured()) return
    const url = this.cfg.base_url ?? 'https://api.openai.com'
    fetch(url, { method: 'HEAD' }).catch(() => { /* ignore */ })
  }

  async complete(model: string, req: CompletionRequest): Promise<CompletionResult> {
    const start = Date.now()
    const messages: { role: 'system' | 'user'; content: string }[] = []
    if (req.system) messages.push({ role: 'system', content: req.system })
    messages.push({ role: 'user', content: req.prompt })

    const completion = await this.getClient().chat.completions.create({
      model,
      messages,
      max_tokens: req.max_output_tokens,
      response_format: req.structured ? { type: 'json_object' } : undefined,
    })

    const text = completion.choices[0]?.message?.content ?? ''
    const inputTok = completion.usage?.prompt_tokens ?? 0
    const outputTok = completion.usage?.completion_tokens ?? 0
    const price = this.pricePerMillion(model)
    const costCents = Math.ceil(
      ((inputTok / 1_000_000) * price.input + (outputTok / 1_000_000) * price.output) * 100,
    )

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
    }
  }
}
