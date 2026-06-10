// src/daemon/voice/stt/whisperStt.ts
// OpenAI-compatible Whisper STT adapter (Groq, OpenRouter, OpenAI). All three
// accept the same multipart POST to /audio/transcriptions — swap baseUrl+key+model.
// Conforms to the canonical SttBackend so the daemon never branches on provider.
//
// This supersedes the older whisperAdapter.ts (kept as a thin re-export shim).

import { STT_SAMPLE_RATE, type SttAudio, type SttBackend, type SttResult, type SttTranscribeOptions } from "./types"

export interface WhisperSttOpts {
  name: string
  baseUrl: string
  apiKey: string
  model: string
  language?: string
  fetchImpl?: typeof fetch
  /** OpenRouter attribution headers (ignored by Groq/OpenAI). */
  appName?: string
  appUrl?: string
}

export class WhisperStt implements SttBackend {
  readonly name: string
  readonly sampleRate = STT_SAMPLE_RATE
  private opts: WhisperSttOpts
  private fetchImpl: typeof fetch

  constructor(opts: WhisperSttOpts) {
    if (!opts.apiKey) throw new Error(`[stt:${opts.name}] apiKey required`)
    this.opts = opts
    this.name = opts.name
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  async transcribe(audio: SttAudio, opts: SttTranscribeOptions = {}): Promise<SttResult> {
    const t0 = Date.now()
    const blob = new Blob([audio.data], { type: audio.format === "pcm" ? "audio/pcm" : "audio/wav" })
    const form = new FormData()
    form.append("file", blob, audio.format === "pcm" ? "audio.pcm" : "audio.wav")
    form.append("model", this.opts.model)
    form.append("response_format", "json")
    const lang = opts.language ?? this.opts.language
    if (lang) form.append("language", lang)

    const headers: Record<string, string> = { authorization: `Bearer ${this.opts.apiKey}` }
    if (this.opts.appUrl) headers["http-referer"] = this.opts.appUrl
    if (this.opts.appName) headers["x-title"] = this.opts.appName

    const url = `${this.opts.baseUrl.replace(/\/$/, "")}/audio/transcriptions`
    const resp = await this.fetchImpl(url, { method: "POST", headers, body: form, signal: opts.signal })
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "")
      throw new Error(`[stt:${this.name}] HTTP ${resp.status}: ${detail.slice(0, 200)}`)
    }
    const json = (await resp.json()) as { text?: string; duration?: number }
    // Usage metering (record-only): Whisper responses may carry duration (verbose
    // formats); fall back to PCM/WAV math (s16le mono → bytes / (sampleRate · 2)).
    try {
      const bytes = (audio.data as any)?.byteLength ?? 0
      const sr = audio.sampleRate ?? STT_SAMPLE_RATE
      const seconds = typeof json.duration === "number" ? json.duration : bytes > 0 ? bytes / (sr * 2) : 0
      ;(globalThis as any).__kairosVoiceUsage?.({ kind: "stt", provider: this.name, seconds })
    } catch { /* metering must never break a transcription */ }
    return {
      text: String(json.text ?? "").trim(),
      isFinal: true,
      latencyMs: Date.now() - t0,
    }
  }
}
