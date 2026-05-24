// src/daemon/llm/providers/gemini.ts
// Google Gemini adapter using @google/genai. Flash Lite is the cheapest
// viable model in the entire router catalog ($0.075/M input).

import { GoogleGenAI } from '@google/genai'
import type {
  CompletionRequest, CompletionResult, LLMProvider, ProviderConfig, Tier,
} from '../types'

const PRICING: Record<string, { input: number; output: number }> = {
  'gemini-2.5-flash-lite': { input: 0.075, output: 0.30 },
  'gemini-2.5-flash':      { input: 0.30,  output: 2.50 },
  'gemini-2.5-pro':        { input: 1.25,  output: 5.00 },
}

const TIER_MODELS: Record<Tier, string[]> = {
  ultra_cheap: ['gemini-2.5-flash-lite'],
  mid:         ['gemini-2.5-flash'],
  heavy:       ['gemini-2.5-pro'],
}

export class GeminiProvider implements LLMProvider {
  readonly id = 'gemini' as const
  private client: GoogleGenAI | null = null

  constructor(private cfg: ProviderConfig) {}

  isConfigured(): boolean {
    return Boolean(this.cfg.enabled && this.cfg.api_key_env && process.env[this.cfg.api_key_env])
  }

  modelsForTier(tier: Tier): string[] { return TIER_MODELS[tier] }

  pricePerMillion(model: string): { input: number; output: number } {
    return PRICING[model] ?? { input: 1, output: 4 }
  }

  private getClient(): GoogleGenAI {
    if (this.client) return this.client
    const apiKey = process.env[this.cfg.api_key_env!]
    this.client = new GoogleGenAI({ apiKey })
    return this.client
  }

  async complete(model: string, req: CompletionRequest): Promise<CompletionResult> {
    const start = Date.now()
    const contents = req.system
      ? `${req.system}\n\n${req.prompt}`
      : req.prompt

    const resp = await this.getClient().models.generateContent({
      model,
      contents,
      config: {
        maxOutputTokens: req.max_output_tokens,
        responseMimeType: req.structured ? 'application/json' : undefined,
      },
    })

    const text = resp.text ?? ''
    const inputTok = resp.usageMetadata?.promptTokenCount ?? 0
    const outputTok = resp.usageMetadata?.candidatesTokenCount ?? 0
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
