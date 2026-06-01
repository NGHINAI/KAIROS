// src/daemon/voice/tts/deepgramTts.ts
// Deepgram Aura-2 streaming TTS adapter. REST streaming endpoint returns chunked
// audio as it's generated (TTFB ≈90ms), which we forward as canonical PCM with
// zero resampling: we ask Deepgram for linear16 @ 24kHz mono = our canonical.
//
// Docs: https://developers.deepgram.com/docs/text-to-speech
//   POST https://api.deepgram.com/v1/speak?model=...&encoding=linear16&sample_rate=24000&container=none
//   Authorization: Token <DEEPGRAM_API_KEY>
//   body: { "text": "<phrase>" }

import { CANONICAL_SAMPLE_RATE, type TtsBackend, type TtsChunk, type TtsSynthesisOptions } from "./types"

export interface DeepgramTtsOpts {
  apiKey: string
  /** Aura-2 voice model, e.g. "aura-2-thalia-en". Overridable per-call via voice. */
  model?: string
  /** Override base URL (tests). */
  baseUrl?: string
  /** Injectable fetch (tests). */
  fetchImpl?: typeof fetch
}

const DEFAULT_MODEL = "aura-2-thalia-en"

export class DeepgramTts implements TtsBackend {
  readonly name = "deepgram"
  readonly sampleRate = CANONICAL_SAMPLE_RATE
  readonly streaming = true

  private apiKey: string
  private model: string
  private baseUrl: string
  private fetchImpl: typeof fetch

  constructor(opts: DeepgramTtsOpts) {
    if (!opts.apiKey) throw new Error("[tts:deepgram] apiKey required")
    this.apiKey = opts.apiKey
    this.model = opts.model ?? DEFAULT_MODEL
    this.baseUrl = opts.baseUrl ?? "https://api.deepgram.com"
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  async *synthesize(text: string, opts: TtsSynthesisOptions = {}): AsyncIterable<TtsChunk> {
    const safe = typeof text === "string" ? text.trim() : ""
    if (!safe) return

    // Deepgram voice is the model id. Caller's `voice` overrides the default.
    const model = opts.voice ?? this.model
    const url =
      `${this.baseUrl}/v1/speak` +
      `?model=${encodeURIComponent(model)}` +
      `&encoding=linear16&sample_rate=${CANONICAL_SAMPLE_RATE}&container=none`

    const resp = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Token ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: safe }),
      signal: opts.signal,
    })

    if (!resp.ok || !resp.body) {
      const detail = await safeText(resp)
      throw new Error(`[tts:deepgram] HTTP ${resp.status}${detail ? ` — ${detail}` : ""}`)
    }

    const reader = resp.body.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value && value.byteLength > 0) {
          // Deepgram with container=none returns raw linear16 == canonical.
          yield { pcm: trimToEven(value) }
        }
      }
    } finally {
      try { reader.releaseLock() } catch { /* noop */ }
    }
  }
}

/** PCM samples are 2 bytes; never hand a downstream a half-sample. */
function trimToEven(buf: Uint8Array): Uint8Array {
  return buf.byteLength % 2 === 0 ? buf : buf.subarray(0, buf.byteLength - 1)
}

async function safeText(resp: Response): Promise<string> {
  try { return (await resp.text()).slice(0, 200) } catch { return "" }
}
