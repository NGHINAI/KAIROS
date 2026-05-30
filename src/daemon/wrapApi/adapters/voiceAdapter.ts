// src/daemon/wrapApi/adapters/voiceAdapter.ts
// /v1/voice/chat: transcript → LLM (with persona + history) → response text.
// The voice conductor then hands the text to the sidecar (or sayBackend) for TTS.

import type { LLMAdapter } from './llmAdapter'
import type { ConversationStore } from '../../voice/conversationStore'

export type VoiceAdapterDeps = {
  llm: { complete: (req: any) => Promise<any> }
  store: ConversationStore
  defaultModel?: string
  maxHistoryTurns?: number
}

export type ChatBody = {
  transcript: string
  conversationId: string
  userPersona: Record<string, unknown>
}

export type ChatResult = { text: string; speakId: string }

export class VoiceAdapter {
  private activeAbort: AbortController | null = null
  constructor(private deps: VoiceAdapterDeps) {}

  async chat(body: ChatBody): Promise<ChatResult> {
    this.cancel()
    this.activeAbort = new AbortController()

    const history = await this.deps.store.recentTurns(body.conversationId, this.deps.maxHistoryTurns ?? 10)
    const messages = [
      ...history.map(t => ({ role: t.role === 'agent' ? ('assistant' as const) : ('user' as const), content: t.text })),
      { role: 'user' as const, content: body.transcript },
    ]
    const system = this.buildSystem(body.userPersona)

    await this.deps.store.appendTurn(body.conversationId, { role: 'user', text: body.transcript, at: Date.now() })

    const result = await this.deps.llm.complete({
      messages,
      system,
      model: this.deps.defaultModel,
      max_tokens: 512,
      signal: this.activeAbort.signal,
    })

    const text = result.text || '(no response)'
    const speakId = 'spk_' + Math.random().toString(36).slice(2, 10)
    await this.deps.store.appendTurn(body.conversationId, { role: 'agent', text, at: Date.now() })
    return { text, speakId }
  }

  cancel(): void {
    if (this.activeAbort) {
      this.activeAbort.abort()
      this.activeAbort = null
    }
  }

  private buildSystem(persona: Record<string, unknown>): string {
    const lines = ['You are KAIROS, a proactive AI co-worker who speaks to the user.']
    if (persona.name) lines.push(`The user's name is ${persona.name}.`)
    if (persona.tone) lines.push(`Your tone: ${persona.tone}.`)
    lines.push('Respond conversationally as if speaking out loud. Keep responses brief (1-2 sentences typical).')
    lines.push('Do NOT use markdown or formatting. Plain spoken English only.')
    return lines.join(' ')
  }
}
