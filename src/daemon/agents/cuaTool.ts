// cuaTool.ts — CUA (computer-use) VISION/PIXEL backup, additive on top of the AX-first
// guide/act tools. When read_screen/click_element (AX, by element NUMBER) can't find or
// resolve a target, the model can fall back to cua_click({target}): screenshot the screen
// → ask a vision model for the pixel center of the described element → click that pixel.
//
// Pure-TS, no Swift: capture = macOS `screencapture`, locate = a vision model via the
// hidden /brain proxy, click = `cliclick`. All three are INJECTED (defaults below) so the
// orchestration + prompt + coord-parsing are unit-testable WITHOUT a display; the real
// screen interaction is validated on a Mac with a display (the headless agent can't).

import type { ToolDef } from "./types"

export interface CuaDeps {
  /** Screenshot the screen → a PNG data URL + its pixel dims. null = no display / failed. */
  capture: () => Promise<{ dataUrl: string; width: number; height: number } | null>
  /** Vision-ground: pixel center of `target` in the screenshot, or null if not visible. */
  locate: (o: { dataUrl: string; target: string; width: number; height: number }) => Promise<{ x: number; y: number } | null>
  /** Click a pixel. false = the click failed (e.g. cliclick missing). */
  click: (x: number, y: number) => Promise<boolean>
  log?: (m: string) => void
}

const CUA_DESC =
  "VISION-based fallback click on the user's screen, by visual description. Use this ONLY when the AX path " +
  "fails — i.e. read_screen does NOT list the element you need, or click_element by NUMBER can't resolve it. " +
  "ALWAYS try read_screen + click_element first (they're exact + fast); cua_click screenshots the screen and " +
  "uses vision to find the element, which is slower and approximate. Give a precise visual description " +
  "(e.g. 'the blue Send button at the bottom right', 'the red close circle top-left of the window')."

/** The vision prompt asking for the pixel center of `target`. Pure (testable). */
export function buildLocatePrompt(target: string, width: number, height: number): { system: string; user: string } {
  return {
    system:
      "You are a precise screen-grounding model. You are given a screenshot of a macOS screen that is " +
      `${width}x${height} pixels. Return ONLY strict JSON: {\"x\": <int>, \"y\": <int>} for the pixel CENTER of the ` +
      "described UI element, using the screenshot's own pixel coordinate space (origin top-left). If the element " +
      "is NOT visible, return {\"x\": null, \"y\": null}. No prose, no markdown — JSON only.",
    user: `Find this element and return its pixel center as JSON: ${target}`,
  }
}

/** Parse {x,y} from a vision model's response. Tolerant of markdown/extra text. Returns
 *  null when not found / out of range. Pure (testable). */
export function parseCoords(text: string, max = { width: 100000, height: 100000 }): { x: number; y: number } | null {
  if (!text) return null
  const m = text.match(/\{[^}]*\}/)
  let obj: any
  try { obj = JSON.parse(m ? m[0] : text) } catch { return null }
  if (obj?.x == null || obj?.y == null) return null   // {"x":null} = not visible (Number(null) is 0, so guard first)
  const x = Number(obj.x), y = Number(obj.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  if (x < 0 || y < 0 || x > max.width || y > max.height) return null
  return { x: Math.round(x), y: Math.round(y) }
}

/** The CUA tool surface (one tool: cua_click). Exposed via buildActionToolset (step 7). */
export function buildCuaTools(deps: CuaDeps): ToolDef[] {
  const log = deps.log ?? (() => {})
  return [{
    name: "cua_click",
    description: CUA_DESC,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["target"],
      properties: { target: { type: "string", description: "Precise visual description of the element to click." } },
    },
    // A write (acts on the screen) — runs serially, not flagged concurrencySafe.
    execute: async (args: any) => {
      const target = String(args?.target ?? "").trim()
      if (!target) return "Tell cua_click WHAT to click — a precise visual description of the element."
      let cap
      try { cap = await deps.capture() } catch (e) { log(`cua capture error: ${String((e as Error)?.message ?? e)}`); cap = null }
      if (!cap) return "Couldn't capture the screen (no display, or screen-recording permission is off). Use read_screen + click_element instead."
      let coords
      try { coords = await deps.locate({ dataUrl: cap.dataUrl, target, width: cap.width, height: cap.height }) }
      catch (e) { log(`cua locate error: ${String((e as Error)?.message ?? e)}`); return `Couldn't visually locate "${target}" (vision lookup failed). Try read_screen to see the labeled elements.` }
      if (!coords) return `Couldn't find "${target}" on screen visually. Call read_screen to see what's actually there, or rephrase the description.`
      let ok = false
      try { ok = await deps.click(coords.x, coords.y) } catch (e) { log(`cua click error: ${String((e as Error)?.message ?? e)}`); ok = false }
      return ok
        ? `Clicked "${target}" at (${coords.x}, ${coords.y}) via vision.`
        : `Found "${target}" at (${coords.x}, ${coords.y}) but the click didn't go through (is cliclick installed? brew install cliclick).`
    },
  }]
}

// ── default (display/network-dependent) implementations — validated on a real Mac ──────

/** screencapture → PNG → { dataUrl, width, height } (dims parsed from the PNG IHDR). */
export function makeScreencaptureCapture(opts: { tmpDir?: string; log?: (m: string) => void } = {}): CuaDeps["capture"] {
  const tmp = opts.tmpDir ?? "/tmp"
  return async () => {
    const path = `${tmp}/kairos-cua-${Math.floor(performance.now())}.png`
    const proc = Bun.spawn(["screencapture", "-x", "-t", "png", path], { stdout: "ignore", stderr: "ignore" })
    const code = await proc.exited
    if (code !== 0) { opts.log?.(`screencapture exit ${code}`); return null }
    try {
      const buf = await Bun.file(path).bytes()
      // PNG IHDR: 8-byte sig, then length(4)+"IHDR"(4), width @16..20, height @20..24 (BE).
      const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
      const width = dv.getUint32(16), height = dv.getUint32(20)
      const b64 = Buffer.from(buf).toString("base64")
      return { dataUrl: `data:image/png;base64,${b64}`, width, height }
    } catch (e) { opts.log?.(`capture read failed: ${String((e as Error)?.message ?? e)}`); return null }
  }
}

/** Vision-ground via an OpenAI-compatible chat/completions endpoint (the hidden /brain
 *  proxy by default) using an image_url content part. */
export function makeVisionLocate(opts: { baseURL: string; apiKey: string; model: string; fetchImpl?: typeof fetch; log?: (m: string) => void }): CuaDeps["locate"] {
  const doFetch = opts.fetchImpl ?? fetch
  return async ({ dataUrl, target, width, height }) => {
    const p = buildLocatePrompt(target, width, height)
    const res = await doFetch(`${opts.baseURL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: opts.model,
        messages: [
          { role: "system", content: p.system },
          { role: "user", content: [{ type: "text", text: p.user }, { type: "image_url", image_url: { url: dataUrl } }] },
        ],
        temperature: 0, max_tokens: 60,
      }),
    })
    if (!res.ok) { opts.log?.(`vision locate HTTP ${res.status}`); return null }
    const j: any = await res.json()
    const text = j?.choices?.[0]?.message?.content ?? ""
    return parseCoords(typeof text === "string" ? text : JSON.stringify(text), { width, height })
  }
}

/** Pixel click via cliclick (brew install cliclick). */
export function makeCliclickClick(opts: { log?: (m: string) => void } = {}): CuaDeps["click"] {
  return async (x, y) => {
    try {
      const proc = Bun.spawn(["cliclick", `c:${x},${y}`], { stdout: "ignore", stderr: "ignore" })
      return (await proc.exited) === 0
    } catch (e) { opts.log?.(`cliclick failed: ${String((e as Error)?.message ?? e)}`); return false }
  }
}
