// src/daemon/voice/streamingSpeaker.ts
// Buffers an incoming text stream and speaks it sentence-by-sentence as fast as
// the LLM emits punctuation. Each "phrase" (anything ending in . ! ? or a
// trailing comma after enough words) is queued and spoken sequentially.

import type { SayBackend } from './sayBackend'

export type StreamingSpeakerDeps = {
  backend: Pick<SayBackend, 'speak' | 'stop'>
  voice?: string
  rate?: number
}

export class StreamingSpeaker {
  private buf = ''
  private queue: string[] = []
  private draining = false
  private cancelled = false

  constructor(private deps: StreamingSpeakerDeps) {}

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
    try { this.deps.backend.stop() } catch { /* swallow */ }
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
        await this.deps.backend.speak(phrase, { voice: this.deps.voice, rate: this.deps.rate })
      }
    } finally {
      this.draining = false
    }
  }
}
