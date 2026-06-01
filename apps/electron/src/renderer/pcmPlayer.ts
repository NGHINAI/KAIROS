// pcmPlayer.ts — Web Audio playback of canonical PCM streamed from the daemon.
//
// The daemon sends TTS audio as JSON frames over the voice-events WS:
//   { event:'tts_begin', speakId, sampleRate }   // canonical: 24000 Hz s16le mono
//   { event:'tts_chunk', speakId, pcm:<base64> }  // raw s16le bytes, base64
//   { event:'tts_end',   speakId }
//   { event:'tts_abort', speakId }                // barge-in / cancel
//
// We schedule each chunk back-to-back on a single AudioContext timeline so
// playback is gapless even though chunks arrive in bursts. Decoding is trivial
// (Int16 → Float32) — no MP3/Opus decode needed because the format is raw PCM.

export class PcmPlayer {
  private ctx: AudioContext | null = null
  private sampleRate = 24_000
  private activeSpeakId: string | null = null
  // Next time (in ctx.currentTime units) a chunk should start. Keeps playback gapless.
  private nextStartAt = 0
  private sources = new Set<AudioBufferSourceNode>()

  /** Start a new utterance. Resets the schedule clock. */
  begin(speakId: string, sampleRate: number): void {
    this.ensureContext()
    this.activeSpeakId = speakId
    this.sampleRate = sampleRate || 24_000
    // Begin slightly in the future to absorb scheduling jitter on the first chunk.
    this.nextStartAt = Math.max(this.ctx!.currentTime + 0.04, this.nextStartAt)
  }

  /** Decode + schedule one base64 s16le PCM chunk. */
  push(speakId: string, base64Pcm: string): void {
    if (speakId !== this.activeSpeakId) return
    const ctx = this.ensureContext()
    const int16 = base64ToInt16(base64Pcm)
    if (int16.length === 0) return

    const buffer = ctx.createBuffer(1, int16.length, this.sampleRate)
    const channel = buffer.getChannelData(0)
    for (let i = 0; i < int16.length; i++) channel[i] = int16[i] / 0x8000 // Int16 → [-1,1)

    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.connect(ctx.destination)

    const startAt = Math.max(this.nextStartAt, ctx.currentTime)
    src.start(startAt)
    this.nextStartAt = startAt + buffer.duration

    this.sources.add(src)
    src.onended = () => this.sources.delete(src)
  }

  /** Utterance finished streaming — nothing to do; scheduled audio drains on its own. */
  end(speakId: string): void {
    if (speakId === this.activeSpeakId) this.activeSpeakId = null
  }

  /** True while audio is ACTUALLY still coming out of the speakers. This lags
   *  tts_end (which only means "chunks finished arriving") because scheduled
   *  buffers keep playing for seconds afterward. Barge-in must check THIS, not
   *  the tts_end event, or interrupting during the tail silently no-ops. */
  isPlaying(): boolean {
    if (this.sources.size > 0) return true
    // Also count audio scheduled into the near future but not yet started.
    return this.ctx != null && this.nextStartAt > this.ctx.currentTime + 0.02
  }

  /** Hard stop (barge-in): kill all scheduled audio immediately. */
  abort(speakId: string): void {
    if (speakId !== this.activeSpeakId && this.activeSpeakId !== null) return
    this.stopAll()
    this.activeSpeakId = null
  }

  /** Unconditional stop of all playback (barge-in, regardless of speakId). */
  stop(): void {
    this.stopAll()
    this.activeSpeakId = null
  }

  /** Stop everything (e.g. component unmount). */
  dispose(): void {
    this.stopAll()
    this.ctx?.close().catch(() => {})
    this.ctx = null
  }

  private stopAll(): void {
    for (const s of this.sources) {
      try { s.stop() } catch { /* already stopped */ }
    }
    this.sources.clear()
    if (this.ctx) this.nextStartAt = this.ctx.currentTime
  }

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: this.sampleRate })
    }
    // Autoplay policy: a user gesture (the Talk click / Option hold) resumes it.
    if (this.ctx.state === 'suspended') void this.ctx.resume()
    return this.ctx
  }
}

/** base64 → Int16Array (little-endian s16le). */
function base64ToInt16(b64: string): Int16Array {
  const binary = atob(b64)
  const len = binary.length
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i)
  // s16le → Int16. Use the underlying buffer; length is guaranteed even by the daemon.
  return new Int16Array(bytes.buffer, 0, bytes.byteLength >> 1)
}
