// cuaTool.test.ts — the display-INDEPENDENT logic of the CUA backup: orchestration
// (capture → locate → click), the vision prompt, and coord parsing. The real screen
// interaction (screencapture/cliclick) needs a Mac with a display + is validated there.
import { describe, expect, test } from "bun:test"
import { buildCuaTools, buildLocatePrompt, parseCoords, type CuaDeps } from "./cuaTool"

const okDeps = (over: Partial<CuaDeps> = {}): CuaDeps => ({
  capture: async () => ({ dataUrl: "data:image/png;base64,AAAA", width: 1440, height: 900 }),
  locate: async () => ({ x: 700, y: 420 }),
  click: async () => true,
  ...over,
})
const cua = (over?: Partial<CuaDeps>) => buildCuaTools(okDeps(over))[0]!

describe("cuaTool — pure helpers", () => {
  test("buildLocatePrompt embeds the dims + the target + demands JSON-only", () => {
    const p = buildLocatePrompt("the blue Send button", 1440, 900)
    expect(p.system).toContain("1440x900")
    expect(p.system.toLowerCase()).toContain("json")
    expect(p.user).toContain("the blue Send button")
  })

  test("parseCoords parses clean JSON, tolerates markdown, rejects null/out-of-range", () => {
    expect(parseCoords('{"x":120,"y":340}')).toEqual({ x: 120, y: 340 })
    expect(parseCoords('here: {"x": 12.6, "y": 34.2} done')).toEqual({ x: 13, y: 34 })   // extracted + rounded
    expect(parseCoords('{"x":null,"y":null}')).toBeNull()
    expect(parseCoords("no coords here")).toBeNull()
    expect(parseCoords('{"x":-5,"y":10}')).toBeNull()
    expect(parseCoords('{"x":99999,"y":10}', { width: 1440, height: 900 })).toBeNull()   // out of range
  })
})

describe("cuaTool — cua_click orchestration (injected fakes)", () => {
  test("happy path: capture → locate → click → grounded confirmation", async () => {
    const clicks: Array<[number, number]> = []
    const res = await cua({ click: async (x: number, y: number) => { clicks.push([x, y]); return true } }).execute({ target: "the Send button" })
    expect(clicks[0]).toEqual([700, 420])
    expect(res).toContain("Clicked")
    expect(res).toContain("700, 420")
  })

  test("no display / capture fails → tells the model to use the AX tools", async () => {
    const res = await cua({ capture: async () => null }).execute({ target: "x" })
    expect(res).toMatch(/couldn't capture|read_screen/i)
  })

  test("element not visually located → suggests read_screen", async () => {
    const res = await cua({ locate: async () => null }).execute({ target: "ghost button" })
    expect(res).toMatch(/couldn't find|read_screen/i)
  })

  test("located but click fails → reports the click failure (cliclick hint)", async () => {
    const res = await cua({ click: async () => false }).execute({ target: "Send" })
    expect(res).toMatch(/didn't go through|cliclick/i)
  })

  test("empty target is rejected", async () => {
    expect(await cua().execute({ target: "  " })).toMatch(/WHAT to click/i)
  })

  test("locate/click errors are caught (never throw out of execute)", async () => {
    const r1 = await cua({ locate: async () => { throw new Error("vision down") } }).execute({ target: "x" })
    expect(r1).toMatch(/couldn't visually locate|vision/i)
    const r2 = await cua({ click: async () => { throw new Error("cliclick boom") } }).execute({ target: "x" })
    expect(r2).toMatch(/didn't go through|cliclick/i)
  })

  test("the tool advertises itself as an AX fallback (description guides correct use)", () => {
    const t = cua()
    expect(t.name).toBe("cua_click")
    expect(t.description.toLowerCase()).toContain("only when")
    expect(t.description).toContain("read_screen")
  })
})
