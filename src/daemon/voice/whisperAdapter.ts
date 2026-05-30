// src/daemon/voice/whisperAdapter.ts
//
// Unified OpenAI-compatible Whisper transcription client. Works for:
//   - Groq         (https://api.groq.com/openai/v1, model: whisper-large-v3-turbo)
//   - OpenRouter   (https://openrouter.ai/api/v1, model: openai/whisper-1)
//   - OpenAI       (https://api.openai.com/v1, model: whisper-1)
//
// All three accept the same multipart/form-data POST to /audio/transcriptions.
// We swap baseUrl + apiKey + model via env var; no code branches needed.

export interface WhisperAdapterOpts {
  baseUrl: string
  apiKey: string
  model: string
  /** Optional override for fetch — useful for tests. */
  fetchImpl?: typeof fetch
  /** Optional language hint, e.g. "en". Helps accuracy + speed. */
  language?: string
  /** Optional referer + title for OpenRouter attribution. */
  appName?: string
  appUrl?: string
}

export interface TranscribeResult {
  text: string
  durationMs: number
}

export class WhisperAdapter {
  constructor(private opts: WhisperAdapterOpts) {}

  /**
   * Transcribe a WAV audio blob.
   * @param wavBuffer Raw WAV bytes (16kHz mono int16 recommended for size).
   * @param mimeType MIME type — defaults to audio/wav.
   * @param filename Filename hint sent with multipart upload — affects how some
   *                 providers detect format. Default 'audio.wav'.
   */
  async transcribe(
    wavBuffer: Uint8Array | ArrayBuffer,
    mimeType: string = 'audio/wav',
    filename: string = 'audio.wav',
  ): Promise<TranscribeResult> {
    if (!this.opts.apiKey) {
      throw new Error(`Whisper adapter: missing API key for ${this.opts.baseUrl}`)
    }
    const t0 = Date.now()
    const bytes = wavBuffer instanceof ArrayBuffer ? new Uint8Array(wavBuffer) : wavBuffer
    const blob = new Blob([bytes], { type: mimeType })
    const form = new FormData()
    form.append('file', blob, filename)
    form.append('model', this.opts.model)
    form.append('response_format', 'json')
    if (this.opts.language) form.append('language', this.opts.language)

    const headers: Record<string, string> = {
      authorization: `Bearer ${this.opts.apiKey}`,
    }
    // OpenRouter attribution (ignored by Groq/OpenAI)
    if (this.opts.appUrl) headers['http-referer'] = this.opts.appUrl
    if (this.opts.appName) headers['x-title'] = this.opts.appName

    const url = `${this.opts.baseUrl.replace(/\/$/, '')}/audio/transcriptions`
    const fetchFn = this.opts.fetchImpl ?? fetch
    const resp = await fetchFn(url, {
      method: 'POST',
      headers,
      body: form,
    })
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '')
      throw new Error(`STT [${this.opts.model} @ ${this.opts.baseUrl}] ${resp.status}: ${errText.slice(0, 300)}`)
    }
    const json = (await resp.json()) as { text?: string }
    return { text: String(json.text ?? '').trim(), durationMs: Date.now() - t0 }
  }
}

/**
 * Construct a WhisperAdapter for a named provider using env vars.
 * Returns null if the chosen provider's credentials are missing.
 *
 * Env vars:
 *   KAIROS_STT             - apple | groq | openrouter (selector; not used here)
 *   KAIROS_STT_MODEL       - override the default model for the chosen provider
 *   GROQ_API_KEY           - required for groq
 *   OPENROUTER_API_KEY     - required for openrouter (already used for LLM)
 */
export function whisperFromEnv(provider: 'groq' | 'openrouter'): WhisperAdapter | null {
  const customModel = process.env.KAIROS_STT_MODEL
  if (provider === 'groq') {
    const apiKey = process.env.GROQ_API_KEY ?? ''
    if (!apiKey) return null
    return new WhisperAdapter({
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey,
      model: customModel ?? 'whisper-large-v3-turbo',
      language: process.env.KAIROS_STT_LANGUAGE ?? 'en',
      appName: 'KAIROS',
    })
  }
  if (provider === 'openrouter') {
    const apiKey = process.env.OPENROUTER_API_KEY ?? ''
    if (!apiKey) return null
    return new WhisperAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey,
      model: customModel ?? 'openai/whisper-1',
      language: process.env.KAIROS_STT_LANGUAGE ?? 'en',
      appName: 'KAIROS',
      appUrl: 'https://kairos.local',
    })
  }
  return null
}
