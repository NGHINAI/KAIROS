// src/daemon/voice/tts/index.ts
// Canonical TTS wiring:
//   - ttsFromEnv()          : provider selection via KAIROS_TTS (one-line swap)
//   - StreamingTtsBackend   : adapts a streaming TtsBackend to the existing
//                             SayBackend-shaped { speak, stop } contract that
//                             StreamingSpeaker + VoiceConductor already call,
//                             routing canonical PCM into an injectable AudioSink.
//
// Provider swap is genuinely one line:  KAIROS_TTS=openai  (default deepgram)
// Apple `say` remains available as KAIROS_TTS=apple via the legacy SayBackend.

import type { SpeakOptions } from "../sayBackend"
import type { AudioSink, TtsBackend } from "./types"
import { DeepgramTts } from "./deepgramTts"
import { OpenAiTts } from "./openaiTts"

export * from "./types"
export { DeepgramTts } from "./deepgramTts"
export { OpenAiTts } from "./openaiTts"

export type TtsProvider = "deepgram" | "openai" | "apple"

/**
 * Build the configured streaming TTS provider, or null when KAIROS_TTS is unset
 * or "apple" (caller falls back to the legacy SayBackend / macOS `say`).
 * Throws a clear error if a cloud provider is selected without its key.
 */
export function ttsFromEnv(env: Record<string, string | undefined> = process.env): TtsBackend | null {
  const provider = (env.KAIROS_TTS ?? "").toLowerCase().trim()
  switch (provider) {
    case "":
    case "apple":
      return null
    case "deepgram": {
      const apiKey = env.DEEPGRAM_API_KEY
      if (!apiKey) throw new Error("[tts] KAIROS_TTS=deepgram but DEEPGRAM_API_KEY is not set")
      return new DeepgramTts({ apiKey, model: env.KAIROS_TTS_VOICE })
    }
    case "openai": {
      const apiKey = env.OPENAI_API_KEY
      if (!apiKey) throw new Error("[tts] KAIROS_TTS=openai but OPENAI_API_KEY is not set")
      return new OpenAiTts({ apiKey, model: env.KAIROS_TTS_MODEL, voice: env.KAIROS_TTS_VOICE })
    }
    default:
      throw new Error(`[tts] unknown KAIROS_TTS="${provider}" (expected deepgram|openai|apple)`)
  }
}

let speakSeq = 0

/**
 * Wraps a streaming TtsBackend so the rest of the voice stack keeps calling the
 * familiar `speak(text, opts)` / `stop()` contract. Each speak() opens the
 * provider stream and pumps canonical PCM into the sink; speak() resolves once
 * the phrase is fully synthesized (or aborted). stop() aborts mid-phrase for
 * barge-in.
 */
export class StreamingTtsBackend {
  private active: AbortController | null = null
  private activeSpeakId: string | null = null

  constructor(
    private backend: TtsBackend,
    private sink: AudioSink,
    private defaults: { voice?: string; instructions?: string } = {},
  ) {}

  async speak(text: string, opts: SpeakOptions = {}): Promise<void> {
    const safe = typeof text === "string" ? text.trim() : ""
    if (!safe) return

    // Pre-empt any in-flight utterance (sentence-by-sentence speak is serial,
    // but a barge-in or rapid re-speak can overlap).
    this.stop()

    const speakId = `tts-${++speakSeq}`
    const ac = new AbortController()
    this.active = ac
    this.activeSpeakId = speakId

    this.sink.begin(speakId, this.backend.sampleRate)
    try {
      for await (const chunk of this.backend.synthesize(safe, {
        voice: opts.voice ?? this.defaults.voice,
        instructions: this.defaults.instructions,
        signal: ac.signal,
      })) {
        if (ac.signal.aborted) break
        if (chunk.pcm.byteLength > 0) this.sink.push(speakId, chunk.pcm)
      }
      if (!ac.signal.aborted) this.sink.end(speakId)
    } catch (err) {
      this.sink.abort(speakId)
      if ((err as Error).name === "AbortError") return
      // A TTS provider failure (network, auth, bad voice) must NEVER crash the
      // daemon — degrade to silence for this phrase and log. The caller
      // (StreamingSpeaker) continues with the next phrase.
      console.error(`[tts:${this.backend.name}] synth failed: ${(err as Error).message}`)
    } finally {
      if (this.active === ac) {
        this.active = null
        this.activeSpeakId = null
      }
    }
  }

  stop(): void {
    if (this.active) {
      const id = this.activeSpeakId
      this.active.abort()
      this.active = null
      this.activeSpeakId = null
      if (id) {
        try { this.sink.abort(id) } catch { /* noop */ }
      }
    }
  }
}
