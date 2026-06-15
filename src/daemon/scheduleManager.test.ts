// scheduleManager.test.ts — the natural-language → cron LLM fallback runs on the
// injected OpenRouter completer, NOT a `claude -p` Haiku subprocess.
import { describe, expect, test } from "bun:test"
import { initDatabase } from "./db"
import { ScheduleManager } from "./scheduleManager"
import type { Config } from "./types"

const cfg = { sandboxDir: process.cwd(), models: { tick: "openai/gpt-4o-mini", work: "x", dream: "y" } } as unknown as Config

describe("ScheduleManager NL→cron via injected completer (no claude)", () => {
  test("an unparseable phrase falls through to the LLM completer and returns its cron", async () => {
    let asked = ""
    const llm = { complete: async (b: any) => { asked = b.messages?.[0]?.content ?? ""; return { text: "0 12 * * 2" } } }
    const db = initDatabase(":memory:")
    const mgr = new ScheduleManager(db, cfg, llm)

    // A phrase the regex/relative parsers can't handle → LLM fallback.
    const r = await mgr.parseSchedule("on alternating Tuesdays around lunchtime")

    expect(asked).toContain("alternating Tuesdays")
    expect(r.cronParsed).toBe("0 12 * * 2")
    db.close()
  })
})
