// src/daemon/voice/tts/types.ts
// Canonical TTS contract. Inspired by LiveKit's pluggable TTS plugins: every
// provider is adapted to ONE canonical audio format so swapping vendors is a
// one-line env change (KAIROS_TTS=deepgram|openai|apple) with no downstream code
// touched.
//
// CANONICAL FORMAT — chosen because both default providers emit it natively, so
// there is zero resampling on the hot path:
//   - PCM, signed 16-bit, little-endian (s16le)
//   - 24 000 Hz
//   - mono
// Deepgram Aura-2  -> encoding=linear16&sample_rate=24000   (native)
// OpenAI 4o-mini   -> response_format=pcm                   (native: 24kHz s16le mono)
//
// A provider that can't emit canonical natively MUST resample inside its adapter
// before yielding, so everything north of the adapter only ever sees canonical.

export const CANONICAL_SAMPLE_RATE = 24_000
export const CANONICAL_CHANNELS = 1
export const CANONICAL_BIT_DEPTH = 16

/** One slice of canonical audio: raw s16le/24kHz/mono PCM bytes. */
export interface TtsChunk {
  /** Raw PCM frames, s16le 24kHz mono. Length is always even (2 bytes/sample). */
  pcm: Uint8Array
}

export interface TtsSynthesisOptions {
  /** Provider-specific voice id/name. Adapter maps to its own catalog. */
  voice?: string
  /** Speaking rate multiplier where supported (1.0 = natural). */
  speed?: number
  /**
   * Optional style/affect steering. Only some providers honor this
   * (OpenAI gpt-4o-mini-tts `instructions`). Ignored elsewhere.
   */
  instructions?: string
  /** Abort the in-flight synthesis (barge-in / cancel). */
  signal?: AbortSignal
}

/**
 * A streaming TTS provider. `synthesize` opens the provider stream and yields
 * canonical PCM chunks as they arrive — the first chunk should land in
 * roughly one TTFB (≈90ms Deepgram, ≈300-600ms OpenAI) so playback can begin
 * before the full phrase is generated.
 */
export interface TtsBackend {
  /** Stable id for logging/metrics, e.g. "deepgram", "openai", "apple". */
  readonly name: string
  /** Output sample rate. Always CANONICAL_SAMPLE_RATE for canonical adapters. */
  readonly sampleRate: number
  /** Whether this backend produces a canonical PCM stream (vs. self-playing). */
  readonly streaming: boolean
  synthesize(text: string, opts?: TtsSynthesisOptions): AsyncIterable<TtsChunk>
}

/**
 * Where canonical PCM goes once produced. The daemon's default sink broadcasts
 * chunks over the /v1/voice/events WS as binary `tts_audio` frames; the Electron
 * renderer plays them through Web Audio. Tests use a buffering sink.
 */
export interface AudioSink {
  /** Begin a new utterance. `speakId` correlates start→chunks→end and cancel. */
  begin(speakId: string, sampleRate: number): void
  /** Push one canonical PCM chunk for the active utterance. */
  push(speakId: string, chunk: Uint8Array): void
  /** Utterance fully synthesized. */
  end(speakId: string): void
  /** Hard-stop the active utterance (barge-in). Discard any buffered audio. */
  abort(speakId: string): void
}
