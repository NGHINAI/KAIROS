// memory.test.ts — the dream (memory consolidation) pass runs on the injected
// OpenRouter completer, NOT a `claude -p` Sonnet subprocess.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { initDatabase } from "./db"
import { MemoryStore } from "./memory"
import type { Config } from "./types"

function cfg(dir: string): Config {
  return {
    sandboxDir: dir,
    models: { tick: "a", work: "b", dream: "openai/gpt-4o-mini" },
    dream: { minIntervalMinutes: 0, minCandidates: 1 },
  } as unknown as Config
}

describe("MemoryStore dream via injected completer (no claude)", () => {
  let db: ReturnType<typeof initDatabase>
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kairos-mem-"))
    mkdirSync(join(dir, "state"), { recursive: true })
    db = initDatabase(":memory:")
    db.run("INSERT INTO memory_candidates (category, content, confidence, created_at) VALUES ('observation', 'User prefers morning meetings', 0.8, ?)", [Date.now()])
  })
  afterEach(() => {
    try { db.close() } catch { /* */ }
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* */ }
  })

  test("runDream calls the completer and writes its consolidated text to MEMORY.md", async () => {
    let asked = ""
    const newMemory = "# Memory\n\n## Preferences\n- Morning meetings\n- Concise replies\n- Dark mode\n"
    const llm = { complete: async (b: any) => { asked = b.messages?.[0]?.content ?? b.messages?.map((m: any) => m.content).join("\n") ?? ""; return { text: newMemory } } }
    const store = new MemoryStore(db, cfg(dir), llm)

    await store.runDream()

    expect(asked.length).toBeGreaterThan(0)
    const written = readFileSync(join(dir, "state", "MEMORY.md"), "utf8")
    expect(written).toContain("Morning meetings")
    const dream = db.query("SELECT status FROM dreams ORDER BY dream_id DESC LIMIT 1").get() as { status: string }
    expect(dream.status).toBe("success")
  })
})
