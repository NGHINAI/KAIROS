// src/daemon/wrapApi/adapters/openRouterAdapter.ts
//
// Streaming LLM via OpenRouter (OpenAI-compatible SSE). This file is the ONLY
// place in the codebase that knows we use OpenRouter — everything else hits
// /v1/llm/complete on the wrap-API. When KAIROS Cloud ships, this swaps for a
// Cloud-side proxy with zero changes to the daemon, sidecar, or anything else.

// Reasoning models sometimes bake their chain-of-thought INLINE into `content`
// wrapped in <think>…</think> (vs the separate `reasoning` field). That internal
// monologue must NEVER be streamed to TTS. We strip complete think-blocks and a
// dangling open block; the streamer re-strips the ACCUMULATED content each chunk and
// emits only the newly-clean text, holding back a short tail so a tag split across
// chunks ("<thi" | "nk>") is never spoken before it completes.
const THINK_BLOCK_RE = /<(think|thinking|reasoning|thought)>[\s\S]*?<\/\1>/gi
const THINK_DANGLING_RE = /<(think|thinking|reasoning|thought)>[\s\S]*$/i
const TAG_HOLDBACK = 16 // ≥ longest open tag, so a split partial tag is never emitted early
function stripThink(s: string): string {
  return s.replace(THINK_BLOCK_RE, "").replace(THINK_DANGLING_RE, "")
}

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
  /** DISABLE thinking (not just hide it). For a hybrid/thinking model used on the
   *  SPOKEN tier (e.g. gemini-2.5-flash), set true → sends reasoning.max_tokens:0
   *  (OpenRouter maps this to Gemini's thinkingBudget:0) so the model does NOT spend
   *  latency/tokens thinking and can't return an empty answer because thinking ate the
   *  budget. `exclude:true` alone only HIDES thinking — the model still thinks. Harmless
   *  on pure non-thinking models (the param is ignored). Leave false for the DEEP tier,
   *  which we WANT to reason. */
  disableThinking?: boolean
}

export class OpenRouterAdapter {
  private apiKey: string
  private baseUrl: string
  private defaultModel: string
  private defaultMaxTokens: number
  private appName: string
  private fetchImpl: typeof fetch
  private disableThinking: boolean

  constructor(deps: OpenRouterAdapterDeps = {}) {
    this.apiKey = deps.apiKey ?? process.env.OPENROUTER_API_KEY ?? ''
    this.baseUrl = deps.baseUrl ?? 'https://openrouter.ai/api/v1'
    this.defaultModel = deps.defaultModel ?? 'openai/gpt-4o-mini'
    this.defaultMaxTokens = deps.defaultMaxTokens ?? 512
    this.appName = deps.appName ?? 'KAIROS'
    this.fetchImpl = (deps.fetchImpl ?? fetch) as typeof fetch
    this.disableThinking = deps.disableThinking ?? false
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
    // Reasoning models (kimi-k2.5, minimax-m3) must reason INTERNALLY, never speak it.
    // OpenRouter's `reasoning.exclude` lets the model think but omits reasoning tokens
    // from the response — so the chain-of-thought can't reach the spoken `content`.
    // (Harmless on non-reasoning models.) Edit-2 below also strips inline <think> tags
    // for models that bake CoT into content regardless. Disable with KAIROS_OR_EXCLUDE_REASONING=false.
    if (process.env.KAIROS_OR_EXCLUDE_REASONING !== 'false') {
      // exclude:true HIDES reasoning tokens; for a thinking model on the spoken tier
      // we also DISABLE thinking entirely via max_tokens:0 (→ Gemini thinkingBudget:0)
      // so the answer can't come back empty because thinking burned the budget.
      reqBody.reasoning = this.disableThinking ? { exclude: true, max_tokens: 0 } : { exclude: true }
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
    let rawContent = ''   // ALL content received (may contain <think> blocks)
    let emittedLen = 0    // how much CLEAN (think-stripped) text we've already yielded
    let fullText = ''     // the final clean spoken text (for the `done` event)
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
              rawContent += content
              // Re-strip the whole accumulated content; emit only the newly-clean
              // text, minus a small tail (guards a tag split across chunks). While
              // inside a <think> block the clean text doesn't grow → nothing spoken.
              const clean = stripThink(rawContent)
              const emitTo = Math.max(emittedLen, clean.length - TAG_HOLDBACK)
              if (emitTo > emittedLen) {
                yield { kind: 'delta', text: clean.slice(emittedLen, emitTo) }
                emittedLen = emitTo
              }
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

    // Flush the held-back tail of clean text (and drop any unclosed think-block).
    fullText = stripThink(rawContent)
    if (fullText.length > emittedLen) {
      yield { kind: 'delta', text: fullText.slice(emittedLen) }
      emittedLen = fullText.length
    }

    for (const acc of Object.values(toolCallAcc)) {
      if (acc.id && acc.name) {
        yield { kind: 'tool_use', id: acc.id, name: acc.name, args_json: acc.args }
      }
    }

    yield { kind: 'done', text: fullText, tokensIn, tokensOut }
  }
}
