// src/daemon/voice/stt/deepgramStt.ts
// Deepgram STT (Nova) adapter — lets you run STT and TTS on the SAME vendor
// (KAIROS_STT=deepgram + KAIROS_TTS=deepgram = one key, one provider). Deepgram's
// prerecorded endpoint takes raw audio bytes with the content-type set; we send
// the canonical WAV/PCM straight through.
//
// Docs: https://developers.deepgram.com/docs/pre-recorded-audio
//   POST https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&language=en
//   Authorization: Token <DEEPGRAM_API_KEY>;  body: raw audio bytes

import { STT_SAMPLE_RATE, type SttAudio, type SttBackend, type SttResult, type SttTranscribeOptions } from "./types"

export interface DeepgramSttOpts {
  apiKey: string
  model?: string
  language?: string
  baseUrl?: string
  fetchImpl?: typeof fetch
}

export class DeepgramStt implements SttBackend {
  readonly name = "deepgram"
  readonly sampleRate = STT_SAMPLE_RATE
  private apiKey: string
  private model: string
  private language: string
  private baseUrl: string
  private fetchImpl: typeof fetch

  constructor(opts: DeepgramSttOpts) {
    if (!opts.apiKey) throw new Error("[stt:deepgram] apiKey required")
    this.apiKey = opts.apiKey
    this.model = opts.model ?? "nova-2"
    this.language = opts.language ?? "en"
    this.baseUrl = opts.baseUrl ?? "https://api.deepgram.com"
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  async transcribe(audio: SttAudio, opts: SttTranscribeOptions = {}): Promise<SttResult> {
    const t0 = Date.now()
    // For raw PCM we must tell Deepgram the encoding; WAV is self-describing.
    const isPcm = audio.format === "pcm"
    const sr = audio.sampleRate ?? STT_SAMPLE_RATE
    const params = new URLSearchParams({
      model: this.model,
      smart_format: "true",
      language: opts.language ?? this.language,
    })
    if (isPcm) {
      params.set("encoding", "linear16")
      params.set("sample_rate", String(sr))
      params.set("channels", "1")
    }
    const contentType = isPcm ? "audio/raw" : "audio/wav"
    const url = `${this.baseUrl}/v1/listen?${params.toString()}`

    const resp = await this.fetchImpl(url, {
      method: "POST",
      headers: { Authorization: `Token ${this.apiKey}`, "Content-Type": contentType },
      body: audio.data,
      signal: opts.signal,
    })
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "")
      throw new Error(`[stt:deepgram] HTTP ${resp.status}: ${detail.slice(0, 200)}`)
    }
    const json: any = await resp.json()
    const alt = json?.results?.channels?.[0]?.alternatives?.[0]
    return {
      text: String(alt?.transcript ?? "").trim(),
      confidence: typeof alt?.confidence === "number" ? alt.confidence : undefined,
      isFinal: true,
      latencyMs: Date.now() - t0,
    }
  }
}
