// Multi-modal: image analysis via claude -p (Sonnet/Opus support vision).
// Used by: Discord (image attachments), skills (input_type=image), and the
// ANALYZE_IMAGE action verb.

import { existsSync, mkdirSync, statSync } from 'fs'
import { join } from 'path'
import { log, logError } from './logger'
import type { Config } from './types'

export type ImageInput = {
  source: 'url' | 'file' | 'base64'
  data: string  // URL, file path, or base64
  mime_type?: string  // e.g. 'image/png'
}

export type AnalysisRequest = {
  image: ImageInput
  prompt: string  // What to look for / analyze
  detail?: 'brief' | 'detailed'  // Output verbosity
}

export type AnalysisResult = {
  ok: boolean
  description: string
  cost_cents: number
  model: string
  duration_ms: number
  error?: string
}

const VISION_PROMPT_TEMPLATE = `You are KAIROS analyzing an image for the user.

User's question/instruction:
{{PROMPT}}

Analyze the image and respond:
- {{DETAIL_INSTRUCTION}}
- Be specific. Reference what you actually see (text, UI elements, errors, code, etc.)
- If the image is a screenshot of an error/bug/UI: identify the problem and suggest a fix
- If it's a chart/graph: extract key numbers and patterns
- If it's a photo: describe what's relevant to the user's question
- Never say "I'll analyze" — just give the analysis

Reply naturally, in KAIROS's voice (witty, concise, no corporate filler).`

export class MultiModalAnalyzer {
  private cacheDir: string

  constructor(
    private config: Config,
    // The vision brain. Injected OpenRouter completer pointed at a vision-capable
    // model — replaces the old `claude -p` Sonnet subprocess. No claude at runtime.
    private llm?: { complete: (body: any) => Promise<{ text: string }> },
  ) {
    this.cacheDir = join(config.sandboxDir, 'state', 'multimodal-cache')
    mkdirSync(this.cacheDir, { recursive: true })
  }

  /**
   * Analyze an image via claude -p with vision support.
   * Uses Sonnet by default since Haiku may not support all vision capabilities.
   */
  async analyzeImage(req: AnalysisRequest): Promise<AnalysisResult> {
    const startMs = Date.now()
    log(`Image analysis: "${req.prompt.slice(0, 60)}" (source: ${req.image.source})`)

    // Resolve image to a usable form for claude -p
    const imagePath = await this.resolveImagePath(req.image)
    if (!imagePath) {
      return {
        ok: false,
        description: '',
        cost_cents: 0,
        model: 'n/a',
        duration_ms: Date.now() - startMs,
        error: 'Could not resolve image source',
      }
    }

    // Build the prompt
    const detailInstruction = req.detail === 'brief'
      ? 'Reply in 1-2 sentences max'
      : 'Reply in 2-4 sentences with concrete details'

    const fullPrompt = VISION_PROMPT_TEMPLATE
      .replace('{{PROMPT}}', req.prompt)
      .replace('{{DETAIL_INSTRUCTION}}', detailInstruction)

    // Send the image inline as a base64 data-URL via the standard OpenAI/OpenRouter
    // multimodal `image_url` content part — the vision model sees the pixels directly
    // (no Read-tool round-trip, no claude). For raw bytes we read the resolved local
    // file; remote URLs are fetched to cache by resolveImagePath first.
    if (!this.llm) {
      return { ok: false, description: '', cost_cents: 0, model: 'n/a', duration_ms: Date.now() - startMs, error: 'No vision LLM configured' }
    }
    const dataUrl = await this.toDataUrl(imagePath, req.image.mime_type)
    if (!dataUrl) {
      return { ok: false, description: '', cost_cents: 0, model: 'n/a', duration_ms: Date.now() - startMs, error: 'Could not read image bytes' }
    }

    try {
      const resp = await this.llm.complete({
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: fullPrompt },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        }],
      })

      const description = (resp.text ?? '').trim()
      const costCents = 0  // spend metered in the LLM ledger via the completer's adapter

      return {
        ok: true,
        description,
        cost_cents: costCents,
        model: 'vision',
        duration_ms: Date.now() - startMs,
      }
    } catch (err) {
      return {
        ok: false,
        description: '',
        cost_cents: 0,
        model: 'vision',
        duration_ms: Date.now() - startMs,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  /** Read a resolved local image file into a base64 data-URL for the vision model. */
  private async toDataUrl(path: string, mimeHint?: string): Promise<string | null> {
    try {
      const bytes = new Uint8Array(await Bun.file(path).arrayBuffer())
      if (bytes.byteLength === 0) return null
      const mime = mimeHint || this.guessMime(path)
      const b64 = Buffer.from(bytes).toString('base64')
      return `data:${mime};base64,${b64}`
    } catch (err) {
      logError('Failed to read image bytes for vision', err)
      return null
    }
  }

  /** Best-effort mime from a file extension (defaults to image/png). */
  private guessMime(path: string): string {
    const p = path.toLowerCase()
    if (p.endsWith('.jpg') || p.endsWith('.jpeg')) return 'image/jpeg'
    if (p.endsWith('.gif')) return 'image/gif'
    if (p.endsWith('.webp')) return 'image/webp'
    return 'image/png'
  }

  /**
   * Convert any ImageInput to a local file path.
   * - URL → download to cache dir
   * - file → return as is (with safety check)
   * - base64 → decode to cache dir
   */
  private async resolveImagePath(image: ImageInput): Promise<string | null> {
    try {
      switch (image.source) {
        case 'file': {
          if (!existsSync(image.data)) return null
          // Safety: must be a regular file, not too large
          const stats = statSync(image.data)
          if (!stats.isFile()) return null
          if (stats.size > 20 * 1024 * 1024) {  // 20 MB cap
            log(`Image too large: ${stats.size} bytes`, 'warn')
            return null
          }
          return image.data
        }

        case 'url': {
          // Download to cache
          const ext = this.guessExtension(image.data, image.mime_type)
          const filename = `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`
          const cachePath = join(this.cacheDir, filename)
          const response = await fetch(image.data, { signal: AbortSignal.timeout(15_000) })
          if (!response.ok) {
            log(`Image fetch failed: HTTP ${response.status}`, 'warn')
            return null
          }
          const blob = await response.arrayBuffer()
          if (blob.byteLength > 20 * 1024 * 1024) {
            log(`Downloaded image too large: ${blob.byteLength} bytes`, 'warn')
            return null
          }
          await Bun.write(cachePath, new Uint8Array(blob))
          log(`Downloaded image → ${cachePath}`)
          return cachePath
        }

        case 'base64': {
          const ext = this.guessExtension('', image.mime_type)
          const filename = `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`
          const cachePath = join(this.cacheDir, filename)
          const buffer = Buffer.from(image.data, 'base64')
          if (buffer.length > 20 * 1024 * 1024) {
            return null
          }
          await Bun.write(cachePath, buffer)
          return cachePath
        }
      }
    } catch (err) {
      logError('Failed to resolve image', err)
      return null
    }
  }

  private guessExtension(url: string, mime?: string): string {
    if (mime?.includes('png')) return '.png'
    if (mime?.includes('jpeg') || mime?.includes('jpg')) return '.jpg'
    if (mime?.includes('webp')) return '.webp'
    if (mime?.includes('gif')) return '.gif'
    if (url.match(/\.png(\?|$)/i)) return '.png'
    if (url.match(/\.jpe?g(\?|$)/i)) return '.jpg'
    if (url.match(/\.webp(\?|$)/i)) return '.webp'
    if (url.match(/\.gif(\?|$)/i)) return '.gif'
    return '.png'  // safe default
  }
}
