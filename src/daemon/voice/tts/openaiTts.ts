// src/daemon/voice/tts/openaiTts.ts
// OpenAI gpt-4o-mini-tts adapter. The /v1/audio/speech endpoint supports chunked
// transfer (audio begins before the full file is generated, TTFB ≈300-600ms).
// response_format=pcm yields 24kHz signed 16-bit mono LE == our canonical, so we
// forward bytes with zero resampling.
//
// Bonus the others lack: `instructions` steers affect/tone ("warm, upbeat,
// speaking quickly"). We pass TtsSynthesisOptions.instructions straight through.
//
// Docs: https://developers.openai.com/api/docs/models/gpt-4o-mini-tts
//   POST https://api.openai.com/v1/audio/speech
//   { model, voice, input, response_format: "pcm", instructions? }

import { CANONICAL_SAMPLE_RATE, type TtsBackend, type TtsChunk, type TtsSynthesisOptions } from "./types"

export interface OpenAiTtsOpts {
  apiKey: string
  /** TTS model. Default gpt-4o-mini-tts (cheapest steerable model). */
  model?: string
  /** Default voice, e.g. "alloy", "ash", "ballad", "coral", "sage", "verse". */
  voice?: string
  baseUrl?: string
  fetchImpl?: typeof fetch
}

const DEFAULT_MODEL = "gpt-4o-mini-tts"
const DEFAULT_VOICE = "coral"

export class OpenAiTts implements TtsBackend {
  readonly name = "openai"
  readonly sampleRate = CANONICAL_SAMPLE_RATE
  readonly streaming = true

  private apiKey: string
  private model: string
  private voice: string
  private baseUrl: string
  private fetchImpl: typeof fetch

  constructor(opts: OpenAiTtsOpts) {
    if (!opts.apiKey) throw new Error("[tts:openai] apiKey required")
    this.apiKey = opts.apiKey
    this.model = opts.model ?? DEFAULT_MODEL
    this.voice = opts.voice ?? DEFAULT_VOICE
    this.baseUrl = opts.baseUrl ?? "https://api.openai.com"
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  async *synthesize(text: string, opts: TtsSynthesisOptions = {}): AsyncIterable<TtsChunk> {
    const safe = typeof text === "string" ? text.trim() : ""
    if (!safe) return

    const body: Record<string, unknown> = {
      model: this.model,
      voice: opts.voice ?? this.voice,
      input: safe,
      response_format: "pcm", // 24kHz s16le mono == canonical
    }
    if (opts.instructions) body.instructions = opts.instructions
    if (typeof opts.speed === "number") body.speed = opts.speed

    const resp = await this.fetchImpl(`${this.baseUrl}/v1/audio/speech`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    })

    if (!resp.ok || !resp.body) {
      const detail = await safeText(resp)
      throw new Error(`[tts:openai] HTTP ${resp.status}${detail ? ` — ${detail}` : ""}`)
    }

    const reader = resp.body.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value && value.byteLength > 0) yield { pcm: trimToEven(value) }
      }
    } finally {
      try { reader.releaseLock() } catch { /* noop */ }
    }
  }
}

function trimToEven(buf: Uint8Array): Uint8Array {
  return buf.byteLength % 2 === 0 ? buf : buf.subarray(0, buf.byteLength - 1)
}

async function safeText(resp: Response): Promise<string> {
  try { return (await resp.text()).slice(0, 200) } catch { return "" }
}
