// src/daemon/llm/providers/anthropicApi.ts
import Anthropic from '@anthropic-ai/sdk'
import type {
  CompletionRequest, CompletionResult, LLMProvider, ProviderConfig, Tier,
} from '../types'
import { PromptAssembler } from '../cache/promptAssembler'
import type { LayeredBlock } from '../cache/promptAssembler'

const PRICING: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5-20251001': { input: 1,  output: 5  },
  'claude-sonnet-4-6':         { input: 3,  output: 15 },
  'claude-sonnet-4-7':         { input: 3,  output: 15 },
  'claude-opus-4-7':           { input: 15, output: 75 },
}

// Cache pricing multipliers relative to base input price (USD/M)
// cache_write: 1.25x base, cache_read: 0.1x base
const CACHE_WRITE_MULT = 1.25
const CACHE_READ_MULT  = 0.1

const TIER_MODELS: Record<Tier, string[]> = {
  ultra_cheap: ['claude-haiku-4-5-20251001'],
  mid:         ['claude-sonnet-4-6'],
  heavy:       ['claude-opus-4-7', 'claude-sonnet-4-7'],
}

type AnthropicSystemBlock = {
  type: 'text'
  text: string
  cache_control?: { type: 'ephemeral' }
}

const assembler = new PromptAssembler()

/**
 * Build the Anthropic system array from an assembled prompt.
 * Returns an array of system content blocks with cache_control markers on the
 * last 'long' block and the last 'short' block (at most 2 breakpoints).
 * Volatile ('none') context blocks are returned separately to be prepended to
 * the user message.
 */
function buildSystemArray(layered: LayeredBlock[], longBp: number | null, shortBp: number | null): {
  systemBlocks: AnthropicSystemBlock[]
  volatilePrefix: string
} {
  const systemBlocks: AnthropicSystemBlock[] = []
  const volatileParts: string[] = []

  layered.forEach((block, i) => {
    if (block.cache_hint === 'none') {
      // Volatile blocks go into user message prefix
      volatileParts.push(block.text)
      return
    }
    const entry: AnthropicSystemBlock = { type: 'text', text: block.text }
    if (i === longBp || i === shortBp) {
      entry.cache_control = { type: 'ephemeral' }
    }
    systemBlocks.push(entry)
  })

  return { systemBlocks, volatilePrefix: volatileParts.join('\n') }
}

export type AnthropicApiProviderOpts = ProviderConfig & {
  /** Injected fetch — used in tests to intercept HTTP calls. */
  _fetch?: typeof fetch
}

export class AnthropicApiProvider implements LLMProvider {
  readonly id = 'anthropic_api' as const
  private client: Anthropic | null = null

  constructor(private cfg: AnthropicApiProviderOpts) {}

  isConfigured(): boolean {
    return Boolean(this.cfg.enabled && this.cfg.api_key_env && process.env[this.cfg.api_key_env])
  }

  modelsForTier(tier: Tier): string[] { return TIER_MODELS[tier] }

  pricePerMillion(model: string): { input: number; output: number } {
    return PRICING[model] ?? { input: 3, output: 15 }
  }

  private getClient(): Anthropic {
    if (this.client) return this.client
    this.client = new Anthropic({
      apiKey: process.env[this.cfg.api_key_env!] ?? 'test',
      ...(this.cfg._fetch ? { fetch: this.cfg._fetch as any } : {}),
    })
    return this.client
  }

  warmupTLS(): void {
    if (!this.isConfigured()) return
    // Fire-and-forget HEAD to pre-establish TLS to api.anthropic.com.
    // Errors silently swallowed — purely an optimization.
    fetch('https://api.anthropic.com', { method: 'HEAD' }).catch(() => { /* ignore */ })
  }

  async complete(model: string, req: CompletionRequest): Promise<CompletionResult> {
    const assembled = assembler.assemble(req)
    const hasCacheable = assembled.long_cache_breakpoint_index !== null ||
      assembled.short_cache_breakpoint_index !== null

    const { systemBlocks, volatilePrefix } = buildSystemArray(
      assembled.layered,
      assembled.long_cache_breakpoint_index,
      assembled.short_cache_breakpoint_index,
    )

    const userContent = volatilePrefix
      ? `${volatilePrefix}\n${assembled.user_prompt}`
      : assembled.user_prompt

    // Build system: array form when caching is needed, string form for legacy no-block path
    const systemParam: string | AnthropicSystemBlock[] =
      hasCacheable || systemBlocks.length > 0 ? systemBlocks : (req.system ?? '')

    const start = Date.now()
    const resp = await this.getClient().messages.create({
      model,
      max_tokens: req.max_output_tokens ?? 4096,
      system: systemParam as any,
      messages: [{ role: 'user', content: userContent }],
    })

    const text = resp.content
      .map(b => (b.type === 'text' ? b.text : ''))
      .join('')

    const inputTok = resp.usage.input_tokens
    const outputTok = resp.usage.output_tokens
    const cacheWriteTok = (resp.usage as any).cache_creation_input_tokens ?? 0
    const cacheReadTok  = (resp.usage as any).cache_read_input_tokens ?? 0

    const price = this.pricePerMillion(model)
    // Cost: base input + cache_write (1.25x) + cache_read (0.1x) + output
    const costCents = Math.ceil((
      (inputTok    / 1_000_000) * price.input +
      (cacheWriteTok / 1_000_000) * price.input * CACHE_WRITE_MULT +
      (cacheReadTok  / 1_000_000) * price.input * CACHE_READ_MULT +
      (outputTok   / 1_000_000) * price.output
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
      cached_input_tokens: cacheReadTok,
      cache_creation_tokens: cacheWriteTok,
    }
  }
}
