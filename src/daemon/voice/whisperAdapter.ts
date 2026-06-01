// src/daemon/voice/whisperAdapter.ts
// DEPRECATED SHIM — superseded by the canonical STT layer in ./stt/.
// Kept so any lingering imports keep compiling. New code should use
// `sttFromEnv()` / `SttBackend` from "./stt" instead.

import { WhisperStt } from "./stt/whisperStt"
import type { SttAudio } from "./stt/types"

/** @deprecated Use WhisperStt from "./stt/whisperStt". */
export class WhisperAdapter {
  private impl: WhisperStt
  constructor(opts: { baseUrl: string; apiKey: string; model: string; language?: string; appName?: string; appUrl?: string; fetchImpl?: typeof fetch }) {
    this.impl = new WhisperStt({ name: "whisper", ...opts })
  }
  async transcribe(buf: Uint8Array | ArrayBuffer): Promise<{ text: string; durationMs: number }> {
    const data = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf
    const audio: SttAudio = { data, format: "wav" }
    const r = await this.impl.transcribe(audio)
    return { text: r.text, durationMs: r.latencyMs ?? 0 }
  }
}

/** @deprecated Use sttFromEnv() from "./stt". */
export function whisperFromEnv(provider: "groq" | "openrouter"): WhisperAdapter | null {
  const customModel = process.env.KAIROS_STT_MODEL
  if (provider === "groq") {
    const apiKey = process.env.GROQ_API_KEY ?? ""
    if (!apiKey) return null
    return new WhisperAdapter({
      baseUrl: "https://api.groq.com/openai/v1", apiKey,
      model: customModel ?? "whisper-large-v3-turbo",
      language: process.env.KAIROS_STT_LANGUAGE ?? "en", appName: "KAIROS",
    })
  }
  const apiKey = process.env.OPENROUTER_API_KEY ?? ""
  if (!apiKey) return null
  return new WhisperAdapter({
    baseUrl: "https://openrouter.ai/api/v1", apiKey,
    model: customModel ?? "openai/whisper-1",
    language: process.env.KAIROS_STT_LANGUAGE ?? "en",
    appName: "KAIROS", appUrl: "https://kairos.local",
  })
}
