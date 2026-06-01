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
  /** Cloud-STT bridge. When sidecar runs in KAIROS_STT_MODE=cloud, it emits
   *  audio_blob events instead of stt_final. If a whisper transcriber is
   *  provided, we transcribe the blob and feed the text into the same
   *  handleUserSpeech pipeline as the on-device Apple-STT path. */
  whisper?: { transcribe: (bytes: Uint8Array) => Promise<{ text: string }> }
}

export class VoiceConductor {
  state: VoiceConductorState = 'stopped'
  private fetchImpl: typeof fetch
  private conversationId: string
  private currentSpeakId: string | null = null
  private externalUtteranceHandler?: (utterance: string, conversationId: string) => Promise<void>

  constructor(private deps: VoiceConductorDeps) {
    this.fetchImpl = (deps.fetchImpl ?? fetch) as typeof fetch
    this.conversationId = deps.conversationId ?? 'conv_default'
  }

  /** Wire an external handler (e.g. the agent Conductor) to take over utterance
   *  processing. When set, stt_final events route to this handler INSTEAD of the
   *  legacy wrap-API call. The utterance is still published to the bus for
   *  observability (TrajWriter, Hermes Dreaming, perception). */
  setUserUtteranceHandler(fn: (utterance: string, conversationId: string) => Promise<void>): void {
    this.externalUtteranceHandler = fn
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

  /** Swap the event bus at runtime — used so the daemon can wire bootstrap's
   *  stub bus to the real wrap-API WS broadcast after both are constructed. */
  replaceBus(bus: { publish(kind: string, payload: any): void }): void {
    this.deps.bus = bus
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
      case 'audio_blob': {
        // Cloud-STT bridge: sidecar shipped a WAV; transcribe via Whisper,
        // then fall through to the same user-speech handler. We only act if
        // a transcriber is wired — otherwise the daemon-side cloud STT is
        // misconfigured and we drop the blob (logged for visibility).
        if (!this.deps.whisper) {
          console.log('[voice] audio_blob received but no whisper transcriber wired — dropping')
          this.deps.bus.publish('voice.error', { error: 'cloud STT not configured' })
          break
        }
        const wavBase64 = String((e as any).wavBase64 ?? '')
        if (!wavBase64) {
          console.log('[voice] audio_blob with empty wavBase64')
          break
        }
        const t0 = Date.now()
        try {
          const wavBytes = Uint8Array.from(atob(wavBase64), (c) => c.charCodeAt(0))
          const result = await this.deps.whisper.transcribe(wavBytes)
          const text = (result.text ?? '').trim()
          console.log(`[voice] STT [${Date.now() - t0}ms]: "${text}"`)
          if (!text) {
            this.deps.bus.publish('voice.stt.empty', { at: Date.now() })
            break
          }
          await this.handleUserSpeech(text)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.log(`[voice] STT error: ${msg}`)
          this.deps.bus.publish('voice.error', { error: `STT: ${msg}` })
        }
        break
      }
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
    if (this.externalUtteranceHandler) {
      // E.2.1 agent path: route to the agent Conductor. The handler is
      // responsible for emitting agent_* events (via wrapApi.broadcast) and
      // driving TTS itself. We just hand off and return to idle.
      try {
        await this.externalUtteranceHandler(transcript, this.conversationId)
      } catch (err) {
        this.deps.bus.publish('voice.error', {
          error: err instanceof Error ? err.message : String(err),
        })
      } finally {
        this.state = 'idle'
      }
      return
    }
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
