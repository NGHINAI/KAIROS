// src/daemon/persona/dailyNarrative.test.ts
import { describe, it, expect } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { DailyNarrativeWriter } from "./dailyNarrative"

function seedTurns(db: Database, rows: Array<{ role: string; text: string; at: number }>) {
  db.exec(`CREATE TABLE IF NOT EXISTS voice_turns (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT, role TEXT, text TEXT, at INTEGER)`)
  for (const r of rows) db.run(`INSERT INTO voice_turns(conversation_id,role,text,at) VALUES('c',?,?,?)`, [r.role, r.text, r.at])
}

describe("DailyNarrativeWriter (Unit 4)", () => {
  it("summarizes a day's turns into a narrative file + recent() reads it back", async () => {
    const db = new Database(":memory:")
    const today = new Date().toISOString().slice(0, 10)
    const base = Date.parse(today + "T10:00:00.000Z")
    seedTurns(db, [
      { role: "user", text: "My project is Husk.", at: base },
      { role: "agent", text: "Got it.", at: base + 1000 },
      { role: "user", text: "Add a login page.", at: base + 2000 },
    ])
    const dir = mkdtempSync(join(tmpdir(), "kairos-daily-"))
    const writer = new DailyNarrativeWriter({
      db,
      dir,
      llm: { complete: async () => ({ text: "Today the user worked on Husk and asked to add a login page." }) },
    })
    const narrative = await writer.writeForDay()
    expect(narrative).toMatch(/Husk/)
    const recent = writer.recent(1)
    expect(recent.length).toBe(1)
    expect(recent[0].day).toBe(today)
    expect(recent[0].text).toMatch(/Husk/)
  })

  it("returns null when there are no turns for the day", async () => {
    const db = new Database(":memory:")
    db.exec(`CREATE TABLE IF NOT EXISTS voice_turns (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT, role TEXT, text TEXT, at INTEGER)`)
    const dir = mkdtempSync(join(tmpdir(), "kairos-daily-"))
    const writer = new DailyNarrativeWriter({ db, dir, llm: { complete: async () => ({ text: "x" }) } })
    expect(await writer.writeForDay()).toBeNull()
  })

  it("LLM failure is non-fatal (returns null, no throw)", async () => {
    const db = new Database(":memory:")
    const today = new Date().toISOString().slice(0, 10)
    seedTurns(db, [{ role: "user", text: "hi", at: Date.parse(today + "T10:00:00.000Z") }])
    const dir = mkdtempSync(join(tmpdir(), "kairos-daily-"))
    const writer = new DailyNarrativeWriter({ db, dir, llm: { complete: async () => { throw new Error("down") } } })
    expect(await writer.writeForDay()).toBeNull()
  })
})
