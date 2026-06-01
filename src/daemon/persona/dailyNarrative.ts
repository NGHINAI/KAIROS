// src/daemon/persona/dailyNarrative.ts
// memU/OpenClaw-style daily narrative memory: a human-readable diary of what
// happened + what KAIROS learned about the user, one file per day at
// ~/.kairos/daily/YYYY-MM-DD.md. Generated on the deep dream cycle by summarizing
// the day's conversation turns via LLM. This is a NARRATIVE view for humans (and
// optional re-injection), separate from the structured L2/L3 stores.

import { homedir } from "os"
import { join } from "path"
import { mkdirSync, existsSync, writeFileSync, readFileSync, readdirSync } from "fs"
import type { Database } from "bun:sqlite"

const SYSTEM_PROMPT = `Write a brief, warm first-person diary entry (as the user's AI assistant) summarizing today's conversations. 3-6 sentences. Capture: what the user worked on or asked about, any decisions, and anything you learned about them (preferences, people, projects). Skip trivia. Write naturally, no bullet lists, no preamble.`

export interface DailyNarrativeDeps {
  db: Database
  llm: { complete: (body: any) => Promise<{ text: string }> }
  dir?: string
  log?: (msg: string) => void
}

export class DailyNarrativeWriter {
  private dir: string
  constructor(private deps: DailyNarrativeDeps) {
    this.dir = deps.dir ?? join(homedir(), ".kairos", "daily")
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
  }

  /** Day string for a ms timestamp (local-ish; uses ISO date). */
  private dayOf(ts: number): string { return new Date(ts).toISOString().slice(0, 10) }
  private fileFor(day: string): string { return join(this.dir, `${day}.md`) }

  /** Summarize the given day's (default: today's) conversation turns into a
   *  narrative file. Overwrites that day's file with the latest summary.
   *  Returns the narrative text, or null if there were no turns / on failure. */
  async writeForDay(day?: string): Promise<string | null> {
    const targetDay = day ?? this.dayOf(Date.now())
    const startMs = Date.parse(targetDay + "T00:00:00.000Z")
    const endMs = startMs + 24 * 3600_000
    let turns: Array<{ role: string; text: string }> = []
    try {
      turns = this.deps.db.query(
        `SELECT role, text FROM voice_turns WHERE at >= ? AND at < ? ORDER BY at ASC`,
      ).all(startMs, endMs) as any[]
    } catch (e) { this.deps.log?.(`[dailyNarrative] query failed: ${(e as Error).message}`); return null }

    if (turns.length === 0) return null
    const transcript = turns.map(t => `${t.role === "agent" ? "KAIROS" : "User"}: ${t.text}`).join("\n").slice(0, 6000)

    try {
      const resp = await this.deps.llm.complete({
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `Today's conversation (${targetDay}):\n${transcript}` },
        ],
        max_tokens: 512,  // headroom for reasoning models (daily summary)
        temperature: 0.3,
      })
      const narrative = (resp.text ?? "").trim()
      if (!narrative) return null
      const content = `---\nday: ${targetDay}\nturns: ${turns.length}\ngenerated_at: ${new Date().toISOString()}\n---\n\n${narrative}\n`
      writeFileSync(this.fileFor(targetDay), content)
      this.deps.log?.(`[dailyNarrative] wrote ${targetDay} (${turns.length} turns)`)
      return narrative
    } catch (e) {
      this.deps.log?.(`[dailyNarrative] summarize failed: ${(e as Error).message}`)
      return null
    }
  }

  /** Read the most recent N daily narratives (newest first) for re-injection / tools. */
  recent(n = 3): Array<{ day: string; text: string }> {
    try {
      const files = readdirSync(this.dir).filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().reverse().slice(0, n)
      return files.map(f => {
        const raw = readFileSync(join(this.dir, f), "utf8")
        const body = raw.split(/\n---\n/).slice(1).join("\n---\n").trim() || raw
        return { day: f.replace(/\.md$/, ""), text: body }
      })
    } catch { return [] }
  }
}
