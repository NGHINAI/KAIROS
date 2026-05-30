// src/daemon/voice/voiceConductor.ts
// Main voice orchestrator. Subscribes to sidecar events; routes utterances to
// the wrap-API server; hands LLM responses back to the sidecar (or stage-0
// SayBackend) for TTS. Publishes all voice events to the perception bus so
// memory consolidation (TrajWriter + Hermes Dreaming) treats voice as a
// first-class observation channel.

import type { ConversationStore } from './conversationStore'
import type { SidecarSimulator } from './sidecarSimulator'
import type { SayBackend } from './sayBackend'
import type { SidecarEvent } from './types'

export type VoiceConductorState = 'stopped' | 'idle' | 'listening' | 'thinking' | 'speaking'

export type SidecarLike = {
  onEvent(h: (e: SidecarEvent) => void): void
  start(): Promise<void>
}

export type VoiceConductorDeps = {
  sidecar: SidecarLike
  store: ConversationStore
  bus: { publish(kind: string, payload: any): void }
  wrapApiBaseUrl: string
  fetchImpl?: typeof fetch
  speakBackend: Pick<SayBackend, 'speak' | 'stop'>
  conversationId?: string
  /** If true, skip the wrap-API call after publishing voice.user.utterance.
   *  Caller takes responsibility for handling the LLM + TTS. Used for streaming. */
  externalLLMHandling?: boolean
}

export class VoiceConductor {
  state: VoiceConductorState = 'stopped'
  private fetchImpl: typeof fetch
  private conversationId: string
  private currentSpeakId: string | null = null

  constructor(private deps: VoiceConductorDeps) {
    this.fetchImpl = (deps.fetchImpl ?? fetch) as typeof fetch
    this.conversationId = deps.conversationId ?? 'conv_default'
  }

  async start(): Promise<void> {
    this.deps.sidecar.onEvent((e: SidecarEvent) => this.handleSidecarEvent(e))
    await this.deps.sidecar.start()
    this.state = 'idle'
  }

  async stop(): Promise<void> {
    this.deps.speakBackend.stop()
    this.state = 'stopped'
  }

  async proactiveSpeak(text: string): Promise<void> {
    const speakId = 'spk_' + Math.random().toString(36).slice(2, 8)
    this.deps.bus.publish('voice.agent.utterance', {
      text, speakId, at: Date.now(), conversationId: this.conversationId, proactive: true,
    })
    this.state = 'speaking'
    this.currentSpeakId = speakId
    try {
      await this.deps.speakBackend.speak(text)
    } finally {
      this.currentSpeakId = null
      this.state = 'idle'
    }
  }

  private async handleSidecarEvent(e: SidecarEvent): Promise<void> {
    switch (e.event) {
      case 'hotkey':
        this.state = e.state === 'down' ? 'listening' : 'idle'
        this.deps.bus.publish(e.state === 'down' ? 'voice.hotkey.down' : 'voice.hotkey.up', { at: Date.now() })
        // Tell the sidecar to start/stop SFSpeechRecognizer — it doesn't auto-listen.
        try {
          const sc = this.deps.sidecar as any
          if (typeof sc.send === 'function') {
            if (e.state === 'down') await sc.send({ cmd: 'start_listening', mode: 'push_to_talk' })
            else await sc.send({ cmd: 'stop_listening' })
          }
        } catch { /* sim/test transport may not implement send */ }
        break
      case 'stt_final':
        await this.handleUserSpeech(e.text)
        break
      case 'barge_in_detected':
        await this.handleBargeIn()
        break
      case 'speak_finished':
      case 'speak_interrupted':
        if (this.state === 'speaking') this.state = 'idle'
        this.currentSpeakId = null
        break
      case 'error':
        this.deps.bus.publish('voice.sidecar.error', { code: (e as any).code, message: (e as any).message ?? '' })
        break
      case 'stt_partial':
        this.deps.bus.publish('voice.stt.partial', { text: (e as any).text })
        break
      default:
        break
    }
  }

  private async handleUserSpeech(transcript: string): Promise<void> {
    this.deps.bus.publish('voice.user.utterance', {
      text: transcript, conversationId: this.conversationId, at: Date.now(),
    })
    this.state = 'thinking'
    if (this.deps.externalLLMHandling) {
      // Caller handles LLM + TTS via streaming. We're done here.
      this.state = 'idle'
      return
    }
    try {
      const resp = await this.fetchImpl(`${this.deps.wrapApiBaseUrl}/v1/voice/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ transcript, conversationId: this.conversationId, userPersona: {} }),
      })
      const body = (await resp.json()) as { text?: string; speakId?: string; error?: string }
      if (body.error) throw new Error(body.error)
      const replyText = body.text && body.text.trim() ? body.text : '(no response)'
      const speakId = body.speakId ?? 'spk_' + Math.random().toString(36).slice(2, 8)
      this.currentSpeakId = speakId
      this.deps.bus.publish('voice.agent.utterance', {
        text: replyText, speakId, at: Date.now(), conversationId: this.conversationId,
      })
      this.state = 'speaking'
      await this.deps.speakBackend.speak(replyText)
      this.state = 'idle'
    } catch (err) {
      this.deps.bus.publish('voice.error', {
        error: err instanceof Error ? err.message : String(err),
      })
      this.state = 'idle'
    }
  }

  private async handleBargeIn(): Promise<void> {
    this.deps.speakBackend.stop()
    this.deps.bus.publish('voice.agent.utterance.interrupted', {
      speakId: this.currentSpeakId, at: Date.now(),
    })
    this.currentSpeakId = null
    this.state = 'listening'
  }
}
