// sourceEvolution.test.ts — patch generation runs on the injected OpenRouter
// completer, NOT `claude -p`. We assert the completer is called and its marker
// output is parsed (the REJECT path avoids touching the compile/validate stage).
import { describe, expect, test } from "bun:test"
import { initDatabase } from "./db"
import { SourceEvolution } from "./sourceEvolution"
import type { Config } from "./types"

const cfg = { sandboxDir: process.cwd(), models: { tick: "a", work: "minimax/minimax-m3", dream: "c" } } as unknown as Config

describe("SourceEvolution patch gen via injected completer (no claude)", () => {
  test("calls the completer and parses a ===REJECT=== response", async () => {
    let asked = ""
    const llm = { complete: async (b: any) => { asked = b.messages?.[0]?.content ?? ""; return { text: "===REJECT===\nToo risky to touch the scheduler.\n===END===" } } }
    const db = initDatabase(":memory:")
    const evo = new SourceEvolution(db, cfg, llm)

    // Target a file that exists under src/daemon so the early existence guard passes.
    const res = await evo.proposePatch({ targetFile: "src/daemon/scheduleManager.ts", reason: "tidy up" })

    expect(asked.length).toBeGreaterThan(0)
    expect(res.ok).toBe(false)
    expect(res.error).toContain("declined")
    db.close()
  })
})
