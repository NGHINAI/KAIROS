// src/daemon/voice/stt/index.ts
// Canonical STT wiring: sttFromEnv() selects a provider via KAIROS_STT — the
// input-side mirror of ttsFromEnv(). One-line provider swap, no downstream edits.
//
//   KAIROS_STT=groq        → Whisper via Groq        (GROQ_API_KEY)        [default]
//   KAIROS_STT=openrouter  → Whisper via OpenRouter  (OPENROUTER_API_KEY)  [HTTP500 as of 2026-05-30]
//   KAIROS_STT=openai      → Whisper via OpenAI      (OPENAI_API_KEY)
//   KAIROS_STT=deepgram    → Deepgram Nova           (DEEPGRAM_API_KEY)    [same-vendor as TTS]
//   KAIROS_STT=apple       → on-device (Swift sidecar); returns null here (no cloud backend)
//
//   KAIROS_STT_MODEL    overrides the provider's default model.
//   KAIROS_STT_LANGUAGE language hint (default "en").

import type { SttBackend } from "./types"
import { WhisperStt } from "./whisperStt"
import { DeepgramStt } from "./deepgramStt"

export * from "./types"
export { WhisperStt } from "./whisperStt"
export { DeepgramStt } from "./deepgramStt"

export type SttProvider = "groq" | "openrouter" | "openai" | "deepgram" | "apple"

/**
 * Build the configured STT backend, or null when KAIROS_STT is "apple"/unset
 * (the caller uses the Swift sidecar's on-device recognizer instead).
 * Throws a clear error if a cloud provider is selected without its key.
 */
export function sttFromEnv(env: Record<string, string | undefined> = process.env): SttBackend | null {
  const provider = (env.KAIROS_STT ?? "").toLowerCase().trim()
  const model = env.KAIROS_STT_MODEL
  const language = env.KAIROS_STT_LANGUAGE ?? "en"

  switch (provider) {
    case "":
    case "apple":
      return null

    case "groq": {
      const apiKey = env.GROQ_API_KEY
      if (!apiKey) throw new Error("[stt] KAIROS_STT=groq but GROQ_API_KEY is not set")
      return new WhisperStt({
        name: "groq",
        baseUrl: "https://api.groq.com/openai/v1",
        apiKey,
        model: model ?? "whisper-large-v3-turbo",
        language,
        appName: "KAIROS",
      })
    }

    case "openrouter": {
      const apiKey = env.OPENROUTER_API_KEY
      if (!apiKey) throw new Error("[stt] KAIROS_STT=openrouter but OPENROUTER_API_KEY is not set")
      return new WhisperStt({
        name: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey,
        model: model ?? "openai/whisper-1",
        language,
        appName: "KAIROS",
        appUrl: "https://kairos.local",
      })
    }

    case "openai": {
      const apiKey = env.OPENAI_API_KEY
      if (!apiKey) throw new Error("[stt] KAIROS_STT=openai but OPENAI_API_KEY is not set")
      return new WhisperStt({
        name: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey,
        model: model ?? "whisper-1",
        language,
      })
    }

    case "deepgram": {
      const apiKey = env.DEEPGRAM_API_KEY
      if (!apiKey) throw new Error("[stt] KAIROS_STT=deepgram but DEEPGRAM_API_KEY is not set")
      return new DeepgramStt({ apiKey, model, language })
    }

    default:
      throw new Error(`[stt] unknown KAIROS_STT="${provider}" (expected groq|openrouter|openai|deepgram|apple)`)
  }
}
