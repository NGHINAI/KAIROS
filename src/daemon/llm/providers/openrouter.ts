// src/daemon/llm/providers/openrouter.ts
//
// OpenRouter adapter for ModelRouter. Reuses the existing OpenRouterAdapter
// (src/daemon/wrapApi/adapters/openRouterAdapter.ts) for HTTP/SSE wiring so
// SSE parsing isn't duplicated.
//
// This provider exists because every LLM call site in KAIROS that goes
// through ModelRouter (perception/Tier1Classifier, perception/Tier2Summarizer,
// memory/Dreamer, skills/Crystallizer) was failing silently in BYO mode —
// MODE_PREFS tried anthropic_cli → ollama → openai-direct, none of which
// speak OpenRouter, while the user only had OPENROUTER_API_KEY configured.
//
// With this provider registered + listed first in MODE_PREFS.byo, all four
// call sites now resolve through OpenRouter using KAIROS_*_MODEL env vars.

import type {
  CompletionRequest, CompletionResult, LLMProvider, ProviderConfig, Tier,
} from '../types'
import { PromptAssembler } from '../cache/promptAssembler'
import { OpenRouterAdapter } from '../../wrapApi/adapters/openRouterAdapter'
import { estimateCostCents, PRICING, FALLBACK_PRICE } from '../pricing'

// Tier → ordered model list. The first entry is the user-controllable env var
// override; the second is the hard-coded default (same value when env var is
// unset, since OpenRouter routes the same way either way).
function modelsForTierStatic(tier: Tier): string[] {
  switch (tier) {
    case 'ultra_cheap':
      return [
        process.env.KAIROS_FAST_MODEL ?? 'openai/gpt-4o-mini',
        'openai/gpt-4o-mini',
      ]
    case 'mid':
      return [
        process.env.KAIROS_SMART_MODEL ?? 'moonshotai/kimi-k2',
        'moonshotai/kimi-k2',
      ]
    case 'heavy':
      return [
        process.env.KAIROS_DEEP_MODEL ?? 'moonshotai/kimi-k2-thinking',
        'moonshotai/kimi-k2-thinking',
      ]
  }
}

export type OpenRouterProviderConfig = ProviderConfig & {
  /** Injected fetch — used in tests to intercept HTTP calls. */
  _fetch?: typeof fetch
  /** Optional API key override (takes precedence over OPENROUTER_API_KEY env). */
  apiKey?: string
}

const assembler = new PromptAssembler()

export class OpenRouterProvider implements LLMProvider {
  readonly id = 'openrouter' as const

  private adapter: OpenRouterAdapter | null = null

  constructor(private cfg: OpenRouterProviderConfig = { enabled: true }) {}

  isConfigured(): boolean {
    if (this.cfg.enabled === false) return false
    if (this.cfg.apiKey) return true
    return Boolean(process.env.OPENROUTER_API_KEY)
  }

  modelsForTier(tier: Tier): string[] {
    return modelsForTierStatic(tier)
  }

  pricePerMillion(model: string): { input: number; output: number } {
    return PRICING[model] ?? FALLBACK_PRICE
  }

  warmupTLS(): void {
    if (!this.isConfigured()) return
    const base = this.cfg.base_url ?? 'https://openrouter.ai/api/v1'
    fetch(base, { method: 'HEAD' }).catch(() => { /* ignore */ })
  }

  private getAdapter(): OpenRouterAdapter {
    if (this.adapter) return this.adapter
    this.adapter = new OpenRouterAdapter({
      apiKey: this.cfg.apiKey ?? process.env.OPENROUTER_API_KEY ?? '',
      baseUrl: this.cfg.base_url,
      fetchImpl: this.cfg._fetch,
    })
    return this.adapter
  }

  async complete(model: string, req: CompletionRequest): Promise<CompletionResult> {
    const start = Date.now()

    const assembled = assembler.assemble(req)

    // Build a single system string (long + short blocks concatenated, stable
    // ordering so OpenRouter / upstream providers can take advantage of any
    // automatic prompt caching). Volatile blocks prepended to user prompt.
    const systemParts: string[] = []
    const volatileParts: string[] = []
    for (const block of assembled.layered) {
      if (block.cache_hint === 'none') {
        volatileParts.push(block.text)
      } else {
        systemParts.push(block.text)
      }
    }
    const system = systemParts.length > 0 ? systemParts.join('\n\n') : undefined
    const userContent = volatileParts.length > 0
      ? `${volatileParts.join('\n\n')}\n\n${assembled.user_prompt}`
      : assembled.user_prompt

    const result = await this.getAdapter().complete({
      model,
      system,
      messages: [{ role: 'user', content: userContent }],
      max_tokens: req.max_output_tokens,
    })

    const text = result.text
    const inputTok = result.tokensIn ?? 0
    const outputTok = result.tokensOut ?? 0

    // PRECISE cost — no per-call ceil (the ~12× over-count bug). Sub-cent kept.
    const costCents = estimateCostCents(model, inputTok, outputTok)

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
