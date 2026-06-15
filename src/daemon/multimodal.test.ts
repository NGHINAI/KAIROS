// multimodal.test.ts — image analysis runs on the injected OpenRouter VISION
// completer (image sent as a base64 data-URL via image_url), NOT a `claude -p`
// Sonnet subprocess that relied on Claude's Read tool.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { MultiModalAnalyzer } from "./multimodal"
import type { Config } from "./types"

describe("MultiModalAnalyzer vision via injected completer (no claude)", () => {
  let dir: string
  let png: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kairos-mm-"))
    png = join(dir, "shot.png")
    writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) // PNG magic, enough for the test
  })
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* */ } })

  test("sends the image as image_url data-URL to the completer and returns its analysis", async () => {
    let body: any = null
    const llm = { complete: async (b: any) => { body = b; return { text: "A red error dialog saying 'connection refused'." } } }
    const mm = new MultiModalAnalyzer({ sandboxDir: dir, models: { tick: "a", work: "b", dream: "c" } } as unknown as Config, llm)

    const res = await mm.analyzeImage({ image: { source: "file", data: png, mime_type: "image/png" }, prompt: "what error?" })

    expect(res.ok).toBe(true)
    expect(res.description).toContain("connection refused")
    // The completer was handed multimodal content with an image_url data URL.
    const content = body?.messages?.[0]?.content
    expect(Array.isArray(content)).toBe(true)
    const imgPart = content.find((p: any) => p.type === "image_url")
    expect(imgPart?.image_url?.url).toContain("data:image/png;base64,")
  })
})
