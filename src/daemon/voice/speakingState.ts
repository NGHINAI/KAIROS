// src/daemon/voice/speakingState.ts
// One authoritative "is KAIROS audibly speaking?" signal for UI clients (the HUD orb).
//
// Why this exists: the orb keyed off per-phrase tts_begin/tts_end events, and the
// StreamingSpeaker speaks sentence-by-sentence — so on any multi-sentence reply the
// orb STROBED speaking→idle→speaking at every sentence boundary. Worse, tts_end means
// "chunks finished DOWNLOADING", while the renderer's Web Audio keeps playing its
// buffer for seconds afterward — so the orb also stopped early.
//
// Two input signals, one output event:
//   • renderer playback acks (`tts_playback {playing}` WS commands) — GROUND TRUTH:
//     the renderer reports when audio is actually coming out of the speakers, on
//     change + a periodic keepalive while playing.
//   • the daemon-side synthesis envelope (StreamingSpeaker onSpeaking) — fallback
//     when no renderer is attached (HUD-only setups, headless tests).
// The tracker prefers renderer truth while its acks are fresh, and broadcasts
// `agent_speaking {speaking}` ON CHANGE ONLY.

export class SpeakingStateTracker {
  private playback = false
  private synthesis = false
  private lastPlaybackAckAt = 0
  private current = false

  constructor(private deps: {
    broadcast: (e: { event: "agent_speaking"; speaking: boolean }) => void
    now?: () => number
    /** How long renderer acks stay authoritative (keepalives arrive every ~2s while playing). */
    rendererFreshMs?: number
  }) {}

  /** Renderer ack: Web Audio playback started/stopped (or keepalive while playing). */
  reportPlayback(playing: boolean): void {
    this.playback = playing
    this.lastPlaybackAckAt = this.now()
    this.recompute()
  }

  /** Daemon-side synthesis envelope from the StreamingSpeaker (fallback signal). */
  reportSynthesis(active: boolean): void {
    this.synthesis = active
    this.recompute()
  }

  get speaking(): boolean { return this.current }

  private now(): number { return this.deps.now?.() ?? Date.now() }

  private recompute(): void {
    const freshMs = this.deps.rendererFreshMs ?? 10_000
    const rendererLive = this.now() - this.lastPlaybackAckAt < freshMs
    const next = rendererLive ? this.playback : this.synthesis
    if (next !== this.current) {
      this.current = next
      try { this.deps.broadcast({ event: "agent_speaking", speaking: next }) } catch { /* UI-only — never break voice */ }
    }
  }
}
