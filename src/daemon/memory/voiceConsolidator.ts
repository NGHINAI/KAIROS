// src/daemon/memory/voiceConsolidator.ts
// Bridges the FREE-TEXT memory stores that the MemoryInjector reads:
//   L2 EpisodicStore (mem_l2_observations) → L3 SemanticStore (mem_l3_facts)
//
// The existing Dreamer consolidates the STRUCTURED stores (EpisodicMemory /
// SemanticMemory, tables mem_l2_episodes/mem_l3_semantic), which the injector
// does NOT read. So voice conversations recorded into EpisodicStore were never
// distilled into durable L3 facts. This consolidator closes that gap with the
// same distill pattern (LLM extracts 0-N facts per episode), but over the
// stores the agent actually recalls from.
//
// It tracks a timestamp high-water mark (mem_l3_facts has no "promoted" flag),
// so each run only processes observations newer than the last consolidation.

import type { Database } from "bun:sqlite"

const SYSTEM_PROMPT = `You distill raw conversation observations into durable long-term FACTS about the user. Given recent observations, extract 0-5 facts worth remembering: the user's projects, people, preferences, recurring patterns, or important decisions. Be conservative — most observations yield 0-1 facts. Skip transient chitchat. Output ONLY a JSON array of short fact strings, e.g. ["User's project is called Husk","User has a dog named Pixel"]. Empty array [] if nothing durable.`

const OBS_TABLE = "mem_l2_observations"

export interface VoiceConsolidatorDeps {
  db: Database
  /** Smart-write layer — distilled facts go through contradiction/supersede/confirm
   *  instead of a raw record(), so idle-distilled facts also evolve cleanly. */
  factWriter: { write(factText: string): Promise<unknown> }
  /** LLM completer (OpenRouter adapter shape: complete({messages,...}) → {text}). */
  llm: { complete: (body: any) => Promise<{ text: string }> }
  /** State key store via the db (we use a tiny meta row). */
}

export class VoiceConsolidator {
  private lastTs = 0

  constructor(private deps: VoiceConsolidatorDeps) {
    this.ensureMeta()
    this.lastTs = this.readWatermark()
  }

  private ensureMeta(): void {
    this.deps.db.exec(`CREATE TABLE IF NOT EXISTS mem_voice_consolidator_meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)`)
  }
  private readWatermark(): number {
    try {
      const row = this.deps.db.query(`SELECT v FROM mem_voice_consolidator_meta WHERE k='last_ts'`).get() as { v: number } | undefined
      return row?.v ?? 0
    } catch { return 0 }
  }
  private writeWatermark(ts: number): void {
    this.deps.db.run(`INSERT INTO mem_voice_consolidator_meta(k,v) VALUES('last_ts',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, [ts])
  }

  /**
   * Consolidate observations recorded since the last run into L3 facts.
   * Returns the number of facts created. Safe to call on idle ticks.
   */
  async consolidate(opts?: { maxObservations?: number }): Promise<number> {
    const max = opts?.maxObservations ?? 30
    const rows = this.deps.db.query(
      `SELECT text, ts FROM ${OBS_TABLE} WHERE ts > ? ORDER BY ts ASC LIMIT ?`,
    ).all(this.lastTs, max) as Array<{ text: string; ts: number }>

    if (rows.length === 0) return 0

    const newWatermark = rows[rows.length - 1]!.ts
    const observations = rows.map(r => `- ${r.text}`).join("\n")

    let factsCreated = 0
    try {
      const resp = await this.deps.llm.complete({
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `Recent observations:\n${observations}\n\nExtract durable facts as a JSON array of strings.` },
        ],
        max_tokens: 512,  // headroom for reasoning models (idle distill)
        temperature: 0,
      })
      const facts = parseFactArray(resp.text)
      for (const f of facts) {
        if (f.trim()) { await this.deps.factWriter.write(f.trim()); factsCreated++ }
      }
    } catch (err) {
      // Distillation failure is non-fatal — advance the watermark anyway so we
      // don't re-process the same batch forever, but log it. (L2 still has the
      // raw observations; only the L3 summary is skipped for this batch.)
      console.warn(`[voiceConsolidator] distill failed (skipping batch): ${(err as Error).message}`)
    }

    this.lastTs = newWatermark
    this.writeWatermark(newWatermark)
    return factsCreated
  }
}

/** Tolerant JSON-array parse: handles fenced code, stray prose, or a bare array. */
function parseFactArray(text: string): string[] {
  if (!text) return []
  const start = text.indexOf("[")
  const end = text.lastIndexOf("]")
  if (start === -1 || end === -1 || end < start) return []
  try {
    const arr = JSON.parse(text.slice(start, end + 1))
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : []
  } catch { return [] }
}
