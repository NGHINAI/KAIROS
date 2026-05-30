// src/daemon/wrapApi/adapters/openRouterAdapter.ts
//
// Streaming LLM via OpenRouter (OpenAI-compatible SSE). This file is the ONLY
// place in the codebase that knows we use OpenRouter — everything else hits
// /v1/llm/complete on the wrap-API. When KAIROS Cloud ships, this swaps for a
// Cloud-side proxy with zero changes to the daemon, sidecar, or anything else.

export type Msg = { role: 'user' | 'assistant' | 'system'; content: string }

export type CompleteBody = {
  messages: Msg[]
  system?: string
  model?: string
  max_tokens?: number
  temperature?: number
  signal?: AbortSignal
}

export type CompleteResult = { text: string; tokensIn?: number; tokensOut?: number }

export type StreamEvent =
  | { kind: 'delta'; text: string }
  | { kind: 'done';  text: string; tokensIn?: number; tokensOut?: number }
  | { kind: 'error'; message: string }

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
    }
    if (body.temperature !== undefined) reqBody.temperature = body.temperature

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
            const delta = parsed?.choices?.[0]?.delta?.content
            if (typeof delta === 'string' && delta.length > 0) {
              fullText += delta
              yield { kind: 'delta', text: delta }
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

    yield { kind: 'done', text: fullText, tokensIn, tokensOut }
  }
}
