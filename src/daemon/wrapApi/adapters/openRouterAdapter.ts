// src/daemon/wrapApi/adapters/openRouterAdapter.ts
//
// Streaming LLM via OpenRouter (OpenAI-compatible SSE). This file is the ONLY
// place in the codebase that knows we use OpenRouter — everything else hits
// /v1/llm/complete on the wrap-API. When KAIROS Cloud ships, this swaps for a
// Cloud-side proxy with zero changes to the daemon, sidecar, or anything else.

/**
 * Build the OpenRouter `provider` field from env vars.
 *
 *   KAIROS_OR_PROVIDER         — pin to ONE provider only, e.g. "OpenAI" or "Groq".
 *                                Adds {"only":["OpenAI"], "allow_fallbacks": false}.
 *   KAIROS_OR_PROVIDER_ORDER   — comma-separated priority list, e.g. "Groq,OpenAI".
 *                                Adds {"order":["Groq","OpenAI"], "allow_fallbacks": …}.
 *   KAIROS_OR_PROVIDER_IGNORE  — comma-separated providers to never use.
 *   KAIROS_OR_ALLOW_FALLBACKS  — "true"/"false". Used with order. Default true.
 *   KAIROS_OR_PROVIDER_SORT    — "throughput" | "price" | "latency". Default throughput.
 *
 * Provider names are case-sensitive on OpenRouter. Common ones:
 *   OpenAI, Anthropic, Groq, DeepInfra, Together, Lepton, Fireworks, Cerebras,
 *   Google, Mistral, Cohere, Perplexity. Full list: https://openrouter.ai/docs/features/provider-routing
 */
export function buildProviderRouting(): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const only = process.env.KAIROS_OR_PROVIDER
  if (only) {
    out.only = [only]
    out.allow_fallbacks = false
  }
  const orderRaw = process.env.KAIROS_OR_PROVIDER_ORDER
  if (orderRaw) {
    out.order = orderRaw.split(',').map((s) => s.trim()).filter(Boolean)
  }
  const ignoreRaw = process.env.KAIROS_OR_PROVIDER_IGNORE
  if (ignoreRaw) {
    out.ignore = ignoreRaw.split(',').map((s) => s.trim()).filter(Boolean)
  }
  const allowFallbacks = process.env.KAIROS_OR_ALLOW_FALLBACKS
  if (allowFallbacks !== undefined) {
    out.allow_fallbacks = allowFallbacks.toLowerCase() === 'true'
  }
  // Sort is only meaningful if no explicit `only` or `order` was set — but
  // sending it alongside is harmless; OpenRouter ignores it in that case.
  out.sort = process.env.KAIROS_OR_PROVIDER_SORT ?? 'throughput'
  return out
}

export type Msg = { role: 'user' | 'assistant' | 'system'; content: string }

export interface ToolSchema {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, any>   // JSON Schema
  }
}

export type CompleteBody = {
  messages: Msg[]
  system?: string
  model?: string
  max_tokens?: number
  temperature?: number
  signal?: AbortSignal
  tools?: ToolSchema[]
  tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } }
}

export type CompleteResult = { text: string; tokensIn?: number; tokensOut?: number }

export type StreamEvent =
  | { kind: 'delta'; text: string }
  | { kind: 'done';  text: string; tokensIn?: number; tokensOut?: number }
  | { kind: 'error'; message: string }
  | { kind: 'tool_use'; id: string; name: string; args_json: string }

export type OpenRouterAdapterDeps = {
  apiKey?: string
  baseUrl?: string                // default https://openrouter.ai/api/v1
  defaultModel?: string           // e.g. 'google/gemini-2.5-flash-lite'
  defaultMaxTokens?: number
  appName?: string                // OpenRouter wants HTTP-Referer + X-Title
  fetchImpl?: typeof fetch
}

export class OpenRouterAdapter {
  private apiKey: string
  private baseUrl: string
  private defaultModel: string
  private defaultMaxTokens: number
  private appName: string
  private fetchImpl: typeof fetch

  constructor(deps: OpenRouterAdapterDeps = {}) {
    this.apiKey = deps.apiKey ?? process.env.OPENROUTER_API_KEY ?? ''
    this.baseUrl = deps.baseUrl ?? 'https://openrouter.ai/api/v1'
    this.defaultModel = deps.defaultModel ?? 'openai/gpt-4o-mini'
    this.defaultMaxTokens = deps.defaultMaxTokens ?? 512
    this.appName = deps.appName ?? 'KAIROS'
    this.fetchImpl = (deps.fetchImpl ?? fetch) as typeof fetch
  }

  /** One-shot non-streaming completion (compat with LLMAdapter shape). */
  async complete(body: CompleteBody): Promise<CompleteResult> {
    let text = ''
    let tokensIn: number | undefined
    let tokensOut: number | undefined
    for await (const ev of this.stream(body)) {
      if (ev.kind === 'delta') text += ev.text
      else if (ev.kind === 'done') {
        text = ev.text
        tokensIn = ev.tokensIn
        tokensOut = ev.tokensOut
      } else if (ev.kind === 'error') {
        throw new Error(ev.message)
      }
    }
    return { text, tokensIn, tokensOut }
  }

  /** Streaming completion. Yields delta events as tokens arrive. */
  async *stream(body: CompleteBody): AsyncGenerator<StreamEvent, void, unknown> {
    if (!this.apiKey) {
      yield { kind: 'error', message: 'OPENROUTER_API_KEY not set' }
      return
    }
    const reqBody: any = {
      model: body.model ?? this.defaultModel,
      messages: body.system
        ? [{ role: 'system', content: body.system }, ...body.messages]
        : body.messages,
      stream: true,
      max_tokens: body.max_tokens ?? this.defaultMaxTokens,
      provider: buildProviderRouting(),
    }
    if (body.temperature !== undefined) reqBody.temperature = body.temperature
    if (body.tools && body.tools.length > 0) {
      reqBody.tools = body.tools
      if (body.tool_choice) reqBody.tool_choice = body.tool_choice
    }

    const resp = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${this.apiKey}`,
        'http-referer': 'https://kairos.local',
        'x-title': this.appName,
      },
      body: JSON.stringify(reqBody),
      signal: body.signal,
    })

    if (!resp.ok || !resp.body) {
      const errText = await resp.text().catch(() => '')
      yield { kind: 'error', message: `OpenRouter ${resp.status}: ${errText.slice(0, 300)}` }
      return
    }

    const reader = resp.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let fullText = ''
    let tokensIn: number | undefined
    let tokensOut: number | undefined
    const toolCallAcc: Record<number, { id?: string; name?: string; args: string }> = {}

    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx: number
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx).trim()
          buffer = buffer.slice(idx + 1)
          if (!line || !line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (data === '[DONE]') continue
          try {
            const parsed = JSON.parse(data)
            const delta = parsed?.choices?.[0]?.delta
            const content = delta?.content
            if (typeof content === 'string' && content.length > 0) {
              fullText += content
              yield { kind: 'delta', text: content }
            }
            if (delta && Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const tcIdx = tc.index ?? 0
                if (!toolCallAcc[tcIdx]) toolCallAcc[tcIdx] = { args: '' }
                const acc = toolCallAcc[tcIdx]
                if (tc.id)                  acc.id = tc.id
                if (tc.function?.name)      acc.name = tc.function.name
                if (tc.function?.arguments) acc.args += tc.function.arguments
              }
            }
            if (parsed?.usage) {
              tokensIn = parsed.usage.prompt_tokens
              tokensOut = parsed.usage.completion_tokens
            }
          } catch { /* malformed line — skip */ }
        }
      }
    } finally {
      try { reader.releaseLock() } catch { /* swallow */ }
    }

    for (const acc of Object.values(toolCallAcc)) {
      if (acc.id && acc.name) {
        yield { kind: 'tool_use', id: acc.id, name: acc.name, args_json: acc.args }
      }
    }

    yield { kind: 'done', text: fullText, tokensIn, tokensOut }
  }
}
