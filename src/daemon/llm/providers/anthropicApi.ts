// src/daemon/llm/providers/anthropicApi.ts
import Anthropic from '@anthropic-ai/sdk'
import type {
  CompletionRequest, CompletionResult, LLMProvider, ProviderConfig, Tier,
} from '../types'

const PRICING: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5-20251001': { input: 1,  output: 5  },
  'claude-sonnet-4-6':         { input: 3,  output: 15 },
  'claude-sonnet-4-7':         { input: 3,  output: 15 },
  'claude-opus-4-7':           { input: 15, output: 75 },
}

const TIER_MODELS: Record<Tier, string[]> = {
  ultra_cheap: ['claude-haiku-4-5-20251001'],
  mid:         ['claude-sonnet-4-6'],
  heavy:       ['claude-opus-4-7', 'claude-sonnet-4-7'],
}

export class AnthropicApiProvider implements LLMProvider {
  readonly id = 'anthropic_api' as const
  private client: Anthropic | null = null

  constructor(private cfg: ProviderConfig) {}

  isConfigured(): boolean {
    return Boolean(this.cfg.enabled && this.cfg.api_key_env && process.env[this.cfg.api_key_env])
  }

  modelsForTier(tier: Tier): string[] { return TIER_MODELS[tier] }

  pricePerMillion(model: string): { input: number; output: number } {
    return PRICING[model] ?? { input: 3, output: 15 }
  }

  private getClient(): Anthropic {
    if (this.client) return this.client
    this.client = new Anthropic({ apiKey: process.env[this.cfg.api_key_env!] })
    return this.client
  }

  async complete(model: string, req: CompletionRequest): Promise<CompletionResult> {
    const start = Date.now()
    const resp = await this.getClient().messages.create({
      model,
      max_tokens: req.max_output_tokens ?? 4096,
      system: req.system,
      messages: [{ role: 'user', content: req.prompt }],
    })

    const text = resp.content
      .map(b => (b.type === 'text' ? b.text : ''))
      .join('')

    const inputTok = resp.usage.input_tokens
    const outputTok = resp.usage.output_tokens
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
