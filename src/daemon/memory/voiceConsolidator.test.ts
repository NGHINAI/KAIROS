// src/daemon/memory/voiceConsolidator.test.ts
import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { VoiceConsolidator } from "./voiceConsolidator"

function seedObs(db: Database, rows: Array<{ text: string; ts: number }>) {
  db.exec(`CREATE TABLE IF NOT EXISTS mem_l2_observations (id TEXT PRIMARY KEY, source TEXT, text TEXT, ts INTEGER)`)
  for (const r of rows) db.run(`INSERT INTO mem_l2_observations(id,source,text,ts) VALUES(?,?,?,?)`, [crypto.randomUUID(), "voice", r.text, r.ts])
}

describe("VoiceConsolidator", () => {
  test("distills observations into L3 facts and advances watermark", async () => {
    const db = new Database(":memory:")
    seedObs(db, [
      { text: 'User said: "My project is Husk."', ts: 100 },
      { text: 'User said: "My dog is Pixel."', ts: 200 },
    ])
    const facts: string[] = []
    const vc = new VoiceConsolidator({
      db,
      factWriter: { write: async (text) => { facts.push(text); return {} } },
      llm: { complete: async () => ({ text: '["User project: Husk","User dog: Pixel"]' }) },
    })
    const n = await vc.consolidate()
    expect(n).toBe(2)
    expect(facts).toContain("User project: Husk")

    // Second run with no new observations → 0 (watermark advanced).
    const n2 = await vc.consolidate()
    expect(n2).toBe(0)
  })

  test("only processes observations newer than the watermark", async () => {
    const db = new Database(":memory:")
    seedObs(db, [{ text: "old", ts: 100 }])
    let calls = 0
    const vc = new VoiceConsolidator({
      db,
      factWriter: { write: async () => ({}) },
      llm: { complete: async () => { calls++; return { text: "[]" } } },
    })
    await vc.consolidate() // processes "old", llm called once
    seedObs(db, [{ text: "new", ts: 300 }])
    await vc.consolidate() // processes only "new"
    expect(calls).toBe(2)
  })

  test("llm failure is non-fatal and still advances watermark", async () => {
    const db = new Database(":memory:")
    seedObs(db, [{ text: "x", ts: 50 }])
    const vc = new VoiceConsolidator({
      db,
      factWriter: { write: async () => ({}) },
      llm: { complete: async () => { throw new Error("LLM down") } },
    })
    const n = await vc.consolidate()
    expect(n).toBe(0) // no crash
    // Watermark advanced → next run with no new rows does nothing.
    const n2 = await vc.consolidate()
    expect(n2).toBe(0)
  })

  test("tolerant parse: extracts array from fenced/prose output", async () => {
    const db = new Database(":memory:")
    seedObs(db, [{ text: "y", ts: 10 }])
    const facts: string[] = []
    const vc = new VoiceConsolidator({
      db,
      factWriter: { write: async (text) => { facts.push(text); return {} } },
      llm: { complete: async () => ({ text: 'Here are the facts:\n```json\n["A fact"]\n```' }) },
    })
    await vc.consolidate()
    expect(facts).toEqual(["A fact"])
  })
})
