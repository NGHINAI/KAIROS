// src/daemon/wrapApi/adapters/llmAdapter.ts
// Wraps Anthropic SDK. Only this file knows we're using Claude — everything
// else in KAIROS calls /v1/llm/complete on the wrap server.
//
// When KAIROS Cloud ships: this file's body switches from `client.messages.create`
// to `fetch('https://api.kairos.ai/v1/llm/complete', ...)`. Everything else
// stays the same.

import Anthropic from '@anthropic-ai/sdk'

export type CompleteBody = {
  messages: { role: 'user' | 'assistant'; content: string }[]
  system?: string
  model?: string
  max_tokens?: number
  temperature?: number
  signal?: AbortSignal
}

export type CompleteResult = { text: string; tokensIn?: number; tokensOut?: number }

export type LLMAdapterDeps = {
  client?: Anthropic
  apiKey?: string
  defaultModel?: string
  defaultMaxTokens?: number
}

export class LLMAdapter {
  private client: any
  private defaultModel: string
  private defaultMaxTokens: number

  constructor(deps: LLMAdapterDeps = {}) {
    this.client = deps.client ?? new Anthropic({ apiKey: deps.apiKey ?? process.env.KAIROS_ANTHROPIC_KEY ?? '' })
    this.defaultModel = deps.defaultModel ?? 'claude-haiku-4-5'
    this.defaultMaxTokens = deps.defaultMaxTokens ?? 1024
  }

  async complete(body: CompleteBody): Promise<CompleteResult> {
    const req: any = {
      model: body.model ?? this.defaultModel,
      max_tokens: body.max_tokens ?? this.defaultMaxTokens,
      messages: body.messages,
    }
    if (body.system !== undefined)      req.system = body.system
    if (body.temperature !== undefined) req.temperature = body.temperature

    const opts: any = {}
    if (body.signal) opts.signal = body.signal

    const resp: any = await this.client.messages.create(req, opts)
    const text = Array.isArray(resp.content)
      ? resp.content
          .filter((b: any) => b.type === 'text' || typeof b.text === 'string')
          .map((b: any) => b.text)
          .join('')
      : String(resp.content ?? '')
    return {
      text,
      tokensIn: resp.usage?.input_tokens,
      tokensOut: resp.usage?.output_tokens,
    }
  }
}
