// src/daemon/voice/sidecarSimulator.ts
// In-process mock of the Swift KairosVoiceHelper sidecar. Used by VoiceConductor
// tests + the demo script. Real sidecar replaces this when built and signed.
//
// Implements the exact same protocol as the Swift sidecar — same JSON event
// shapes, same command set — so conductor code is identical against both.

import type { SidecarCmd, SidecarEvent } from './types'

export type SidecarSimulatorOpts = {
  speakDurationMs?: number       // simulated TTS duration per `speak`
}

export type EventHandler = (e: SidecarEvent) => void

export class SidecarSimulator {
  private handlers: EventHandler[] = []
  private speakDurationMs: number
  private currentSpeak: { speakId: string; cancel: () => void } | null = null

  constructor(opts: SidecarSimulatorOpts = {}) {
    this.speakDurationMs = opts.speakDurationMs ?? 50
  }

  onEvent(h: EventHandler): void {
    this.handlers.push(h)
  }

  async start(): Promise<void> {
    this.emit({ event: 'sidecar_ready', version: '0.6.0-sim' })
  }

  async send(cmd: SidecarCmd): Promise<void> {
    switch (cmd.cmd) {
      case 'speak': {
        const speakId = cmd.speakId ?? 'spk_' + Math.random().toString(36).slice(2, 8)
        this.cancelCurrentSpeak()
        this.emit({ event: 'speak_started', speak_id: speakId })
        const ctl = new AbortController()
        this.currentSpeak = { speakId, cancel: () => ctl.abort() }
        await new Promise<void>(resolve => {
          const t = setTimeout(resolve, this.speakDurationMs)
          ctl.signal.addEventListener('abort', () => { clearTimeout(t); resolve() })
        })
        const interrupted = ctl.signal.aborted
        if (this.currentSpeak?.speakId === speakId) this.currentSpeak = null
        if (interrupted) {
          this.emit({ event: 'speak_interrupted', speak_id: speakId })
        } else {
          this.emit({ event: 'speak_finished', speak_id: speakId, interrupted: false })
        }
        break
      }
      case 'stop_speaking':
        this.cancelCurrentSpeak()
        break
      case 'health_check':
      case 'shutdown':
      default:
        break
    }
  }

  simulateHotkey(state: 'down' | 'up'): void {
    this.emit({ event: 'hotkey', state, modifier: 'option' })
  }

  simulateUtterance(text: string): void {
    const partial = text.split(' ').slice(0, -1).join(' ') || text
    this.emit({ event: 'stt_partial', text: partial, confidence: 0.75 })
    this.emit({ event: 'stt_final', text, confidence: 0.95 })
  }

  simulateBargeIn(): void {
    // Always fire barge_in_detected when called — Silero VAD has no notion of
    // "current speak"; it just observes user voice. The during_speak_id is
    // populated when one happens to be active, omitted otherwise.
    const id = this.currentSpeak?.speakId
    if (id) this.emit({ event: 'barge_in_detected', during_speak_id: id })
    else    this.emit({ event: 'barge_in_detected' })
    this.cancelCurrentSpeak()
  }

  private cancelCurrentSpeak(): void {
    if (this.currentSpeak) {
      this.currentSpeak.cancel()
      this.currentSpeak = null
    }
  }

  private emit(e: SidecarEvent): void {
    for (const h of this.handlers) {
      try { h(e) } catch { /* swallow handler errors */ }
    }
  }
}
