// src/daemon/voice/streamingSpeaker.ts
// Buffers an incoming text stream and speaks it sentence-by-sentence as fast as
// the LLM emits punctuation. Each "phrase" (anything ending in . ! ? or a
// trailing comma after enough words) is queued and spoken sequentially.

import type { SayBackend } from './sayBackend'

export type StreamingSpeakerDeps = {
  backend: Pick<SayBackend, 'speak' | 'stop'>
  voice?: string
  rate?: number
  /** Speech-envelope signal: fires true when the FIRST phrase of an utterance starts
   *  synthesizing, false when the speaker is fully idle again (drained or cancelled).
   *  This is the SPEECH-level signal UI state wants — per-phrase tts_begin/tts_end
   *  made the orb strobe at every sentence boundary. Synthesis-level (audio playback
   *  in the renderer may lag); the SpeakingStateTracker overlays renderer truth. */
  onSpeaking?: (speaking: boolean) => void
}

export class StreamingSpeaker {
  private buf = ''
  private queue: string[] = []
  private draining = false
  private cancelled = false
  private speaking: string | null = null   // the phrase currently mid-TTS
  private envelopeActive = false           // speech-envelope state (for onSpeaking)

  constructor(private deps: StreamingSpeakerDeps) {}

  private setEnvelope(active: boolean): void {
    if (this.envelopeActive === active) return
    this.envelopeActive = active
    try { this.deps.onSpeaking?.(active) } catch { /* UI signal must never break speech */ }
  }

  /** Chars not yet finished speaking: pending buffer + queued phrases + the phrase
   *  currently mid-TTS. The supersede path uses this to tell a nearly-finished tail
   *  (let it drain) from a long in-flight reply (cancel = real interrupt). */
  remaining(): number {
    return this.buf.length
      + this.queue.reduce((n, p) => n + p.length, 0)
      + (this.speaking?.length ?? 0)
  }

  /** Wait (capped) for the queue to finish NATURALLY — no new feeds expected.
   *  Returns true if fully idle within the cap; false means the caller should cancel. */
  async drainQuietly(capMs: number): Promise<boolean> {
    const t0 = Date.now()
    while ((this.draining || this.queue.length > 0 || this.buf.trim()) && Date.now() - t0 < capMs) {
      // Flush a punctuation-less tail so a final fragment ("got it") still gets spoken.
      if (!this.draining && this.queue.length === 0 && this.buf.trim()) {
        this.queue.push(this.buf.trim()); this.buf = ''
        void this.maybeDrainQueue()
      }
      await new Promise((r) => setTimeout(r, 25))
    }
    return !this.draining && this.queue.length === 0 && !this.buf.trim()
  }

  /** Start a fresh utterance — clears the cancelled latch from a prior barge-in.
   *  MUST be called before feed()/end() for each new reply, otherwise a single
   *  cancel() would permanently mute all future speech (cancelled stays true). */
  begin(): void {
    this.cancelled = false
    this.queue = []
    this.buf = ''
  }

  /** Feed an LLM token. Auto-emits phrases at sentence boundaries. */
  feed(token: string): void {
    if (this.cancelled) return
    this.buf += token
    this.drainPhrasesFromBuffer()
  }

  /** Call when LLM stream completes. Flushes any tail text as a phrase. */
  end(): Promise<void> {
    if (this.cancelled) return Promise.resolve()
    const tail = this.buf.trim()
    if (tail) {
      this.queue.push(tail)
      this.buf = ''
    }
    return this.waitForDrain()
  }

  /** Hard cancel — stop the active speech and discard queued phrases. */
  cancel(): void {
    this.cancelled = true
    this.queue = []
    this.buf = ''
    this.speaking = null   // the mid-TTS phrase is being stopped — it's no longer pending
    try { this.deps.backend.stop() } catch { /* swallow */ }
    this.setEnvelope(false)
  }

  /** Wait for the queue to fully drain (after end() is called). */
  private async waitForDrain(): Promise<void> {
    while (this.draining || this.queue.length > 0) {
      await new Promise(r => setTimeout(r, 50))
    }
  }

  private drainPhrasesFromBuffer(): void {
    // Match: anything ending with . ! ? optionally followed by space.
    // Also catch a long-running phrase ending in , or ; over 60 chars
    // so we don't wait forever if the LLM never punctuates.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const m = /[.!?]\s|[.!?]$|[,;]\s.{0,0}$/.exec(this.buf)
        ?? (this.buf.length > 100 ? /[,;]\s/.exec(this.buf) : null)
      if (!m || m.index === undefined) break
      const end = m.index + m[0].length
      const phrase = this.buf.slice(0, end).trim()
      this.buf = this.buf.slice(end)
      if (phrase) this.queue.push(phrase)
    }
    void this.maybeDrainQueue()
  }

  private async maybeDrainQueue(): Promise<void> {
    if (this.draining || this.cancelled) return
    this.draining = true
    try {
      while (this.queue.length > 0 && !this.cancelled) {
        const phrase = this.queue.shift()!
        this.speaking = phrase
        this.setEnvelope(true)   // speech has audibly started (first phrase of this utterance)
        try {
          await this.deps.backend.speak(phrase, { voice: this.deps.voice, rate: this.deps.rate })
        } finally {
          this.speaking = null
        }
      }
    } finally {
      this.draining = false
      // Fully idle (nothing queued, no partial buffer waiting on a boundary) → envelope down.
      // A pending buffer means more phrases are coming — keep the envelope up so the orb
      // doesn't dip between sentences of one reply.
      if (this.queue.length === 0 && !this.buf.trim()) this.setEnvelope(false)
    }
  }
}
