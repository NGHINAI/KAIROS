// src/daemon/voice/stt/types.ts
// Canonical STT contract — the input-side mirror of the TTS canonical layer
// (../tts/types.ts). Inspired by Pipecat's STTService.run_stt(audio)->Transcription
// and LiveKit's STT.recognize(buffer)->SpeechEvent: every provider is adapted to
// ONE canonical audio input + ONE result shape, so swapping vendors is a one-line
// env change (KAIROS_STT=groq|openrouter|deepgram|openai) with no downstream edits.
//
// CANONICAL STT INPUT — PCM, signed 16-bit LE, 16 000 Hz, mono.
//   16kHz (not TTS's 24kHz) is the universal STT rate: Whisper, Deepgram, etc.
//   all expect it, and our renderer/pcm-worklet already emit exactly this. A
//   provider that needs another rate MUST resample inside its own adapter, so
//   everything above the adapter only ever deals in canonical audio.
//
// Output text is already "canonical" (plain UTF-8 string), so unlike TTS the
// thing we standardize on input is the AUDIO; on output it's the RESULT SHAPE.

export const STT_SAMPLE_RATE = 16_000
export const STT_CHANNELS = 1
export const STT_BIT_DEPTH = 16

/** Canonical audio handed to any STT backend. */
export interface SttAudio {
  /**
   * Audio bytes. Either a self-describing WAV (s16le/16kHz/mono, RIFF header) —
   * which is what the renderer and Swift recorder already produce — or raw PCM
   * with `format: 'pcm'` set. Adapters that POST multipart accept the WAV as-is.
   */
  data: Uint8Array
  /** 'wav' (default; has RIFF header) or 'pcm' (raw s16le, no header). */
  format?: "wav" | "pcm"
  /** Sample rate of `data`. Defaults to STT_SAMPLE_RATE. */
  sampleRate?: number
}

/** One transcription result. */
export interface SttResult {
  /** The recognized text (trimmed). Empty string if nothing was heard. */
  text: string
  /** 0..1 if the provider reports it; undefined otherwise. */
  confidence?: number
  /**
   * Whether this is the committed/final transcription for the utterance.
   * Segmented (batch) backends always return true. Reserved for a future
   * streaming mode that emits interim results (isFinal:false) before the final.
   */
  isFinal: boolean
  /** Provider round-trip latency in ms (diagnostics). */
  latencyMs?: number
}

export interface SttTranscribeOptions {
  /** BCP-47 language hint, e.g. "en". Improves accuracy + speed where supported. */
  language?: string
  /** Abort an in-flight transcription. */
  signal?: AbortSignal
}

/**
 * A speech-to-text provider. Segmented/batch mode: hand it one canonical audio
 * clip (a finished utterance), get one final SttResult back. This matches the
 * PTT flow (the renderer ships a WAV clip per utterance). A future streaming
 * variant would add `stream(): AsyncIterable<SttResult>` alongside this.
 */
export interface SttBackend {
  /** Stable id for logging/metrics, e.g. "groq", "openrouter", "deepgram". */
  readonly name: string
  /** Sample rate this backend expects after its own (if any) resampling. */
  readonly sampleRate: number
  transcribe(audio: SttAudio, opts?: SttTranscribeOptions): Promise<SttResult>
}
