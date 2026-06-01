// src/daemon/wrapApi/adapters/claudeCodeAdapter.ts
// LLM adapter that uses the local `claude` CLI (Claude Code) as the LLM backend.
// User authenticates Claude Code once via `claude /login` — KAIROS then uses
// the user's Claude Pro/Max subscription with no API key management.
//
// When KAIROS Cloud ships, the wrap-API's `llm.complete` will swap to a Cloud
// adapter. Users' personal Claude subscriptions are dev-time only.

import { spawn } from 'bun'

export type CompleteBody = {
  messages: { role: 'user' | 'assistant'; content: string }[]
  system?: string
  model?: string         // 'haiku' | 'sonnet' | 'opus' | full slug
  max_tokens?: number
  signal?: AbortSignal
}

export type CompleteResult = { text: string; tokensIn?: number; tokensOut?: number }

export type ClaudeCodeAdapterDeps = {
  /** Path to the `claude` binary. Default: `claude` (assumes on PATH). */
  claudeBin?: string
  /** Default model. 'haiku' for voice (fast). */
  defaultModel?: 'haiku' | 'sonnet' | 'opus' | string
  /** Soft timeout (ms). If exceeded, the spawn is aborted. */
  timeoutMs?: number
}

export class ClaudeCodeAdapter {
  private claudeBin: string
  private defaultModel: string
  private timeoutMs: number

  constructor(deps: ClaudeCodeAdapterDeps = {}) {
    this.claudeBin = deps.claudeBin ?? 'claude'
    this.defaultModel = deps.defaultModel ?? 'haiku'
    this.timeoutMs = deps.timeoutMs ?? 30000
  }

  async complete(body: CompleteBody): Promise<CompleteResult> {
    const prompt = this.buildPrompt(body)
    const model = body.model ?? this.defaultModel
    const args = [this.claudeBin, '-p', prompt, '--output-format', 'text']
    if (model) args.push('--model', this.normalizeModel(model))

    const controller = body.signal ? undefined : new AbortController()
    const signal = body.signal ?? controller?.signal
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null

    // Strip any inherited ANTHROPIC_API_KEY (Claude Code parent shells inject it).
    // Otherwise `claude` prefers it over the subscription OAuth — and if it's expired,
    // we get "Invalid API key" even though the subscription is valid.
    const childEnv: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (k === 'ANTHROPIC_API_KEY' || k === 'ANTHROPIC_AUTH_TOKEN') continue
      if (typeof v === 'string') childEnv[k] = v
    }
    try {
      const proc = spawn({
        cmd: args,
        stdout: 'pipe',
        stderr: 'pipe',
        signal,
        env: childEnv,
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout as any).text(),
        new Response(proc.stderr as any).text(),
        proc.exited,
      ])
      const out = (stdout ?? '').trim()
      const err = (stderr ?? '').trim()
      if (exitCode !== 0) {
        throw new Error(`claude exited ${exitCode}: ${(err || out).slice(0, 500)}`)
      }
      // claude can return success exit with empty stdout if there's an auth or model issue;
      // surface it loud rather than letting downstream consumers handle undefined.
      if (!out) {
        const hint = err
          ? `claude returned no output. stderr: ${err.slice(0, 400)}`
          : 'claude returned empty response. Try running `claude /login` and `claude -p "hi"` in a fresh terminal to verify auth.'
        throw new Error(hint)
      }
      return { text: out }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private buildPrompt(body: CompleteBody): string {
    // Claude Code's `-p` takes a single prompt string. For conversational use,
    // we serialize system + history as a structured plain-text exchange.
    const lines: string[] = []
    if (body.system) {
      lines.push(body.system)
      lines.push('')
    }
    for (let i = 0; i < body.messages.length - 1; i++) {
      const m = body.messages[i]!
      const who = m.role === 'user' ? 'User' : 'You'
      lines.push(`${who}: ${m.content}`)
      lines.push('')
    }
    const last = body.messages[body.messages.length - 1]
    if (last) {
      lines.push(`User just said: "${last.content}"`)
      lines.push('')
    }
    lines.push('Respond directly and conversationally as if speaking aloud. Plain text only, no markdown. 1-2 sentences typical.')
    return lines.join('\n')
  }

  private normalizeModel(model: string): string {
    const m = model.toLowerCase()
    if (m.includes('haiku'))  return 'haiku'
    if (m.includes('sonnet')) return 'sonnet'
    if (m.includes('opus'))   return 'opus'
    return model
  }
}
