// src/daemon/perception/perceptionPipeline.ts
// The orchestrator. Every N seconds, evaluate working memory through
// Tier 1 → Tier 2 → Narrator gates. Record every evaluation to
// perception_log for tuning.

import { log, logError } from '../logger'
import type { Database } from 'bun:sqlite'
import type { WorkingMemory } from '../memory/workingMemory'
import type { EpisodicMemory } from '../memory/episodicMemory'
import type { Tier1Classifier } from './tier1Classifier'
import type { Tier2Summarizer } from './tier2Summarizer'
import type { Narrator } from '../proactive/narrator'
import { PERCEPTION_LOG_SCHEMA } from './perceptionLog'

export { PERCEPTION_LOG_SCHEMA }

const NARRATOR_SCORE_THRESHOLD = 0.6

export type PerceptionPipelineOptions = {
  pollMs?: number
}

export class PerceptionPipeline {
  private timer: ReturnType<typeof setInterval> | null = null
  private pollMs: number
  private evaluating = false

  constructor(
    private db: Database,
    private working: WorkingMemory,
    private tier1: Tier1Classifier,
    private tier2: Tier2Summarizer,
    private narrator: Narrator,
    private episodic: EpisodicMemory,
    private ordersText: () => string,
    opts?: PerceptionPipelineOptions,
  ) {
    this.pollMs = opts?.pollMs ?? 30_000
    db.exec(PERCEPTION_LOG_SCHEMA)
  }

  start(): void {
    this.timer = setInterval(() => { void this.evaluateNow() }, this.pollMs)
    log(`PerceptionPipeline: armed (poll ${this.pollMs / 1000}s)`)
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }

  async evaluateNow(): Promise<void> {
    if (this.evaluating) return
    this.evaluating = true
    try {
      const events = this.working.snapshot()
      if (events.length === 0) return

      const verdict1 = await this.tier1.classify(events)

      if (verdict1 === 'SILENT') {
        this.recordLog({ event_count: events.length, verdict_tier1: 'SILENT', tier2_score: null, narrator_fired: 0, episode_id: null })
        return
      }

      if (verdict1 === 'ROUTINE') {
        const eventIds = events.map(e => e.id)
        const epId = this.episodic.writeEpisode({
          started_at: events[0]!.ts,
          ended_at: events[events.length - 1]!.ts,
          episode_type: 'routine',
          title: `${events.length} routine events`,
          summary: `${events.length} events across ${new Set(events.map(e => e.source)).size} sources`,
          event_ids: eventIds,
          importance: 0.3,
        })
        this.recordLog({ event_count: events.length, verdict_tier1: 'ROUTINE', tier2_score: null, narrator_fired: 0, episode_id: epId })
        return
      }

      // SIGNIFICANT — promote to Tier 2.
      const t2 = await this.tier2.summarize(events, this.ordersText())

      const eventIds = events.map(e => e.id)
      const epId = this.episodic.writeEpisode({
        started_at: events[0]!.ts,
        ended_at: events[events.length - 1]!.ts,
        episode_type: t2.episode_type,
        title: t2.description.slice(0, 80),
        summary: t2.description,
        event_ids: eventIds,
        importance: t2.score,
      })

      let narratorFired = 0
      if (t2.score >= NARRATOR_SCORE_THRESHOLD) {
        await this.narrator.tick()
        narratorFired = 1
      }

      this.recordLog({
        event_count: events.length,
        verdict_tier1: 'SIGNIFICANT',
        tier2_score: t2.score,
        narrator_fired: narratorFired,
        episode_id: epId,
      })
    } catch (err) {
      logError('PerceptionPipeline.evaluateNow failed', err)
    } finally {
      this.evaluating = false
    }
  }

  private recordLog(r: { event_count: number; verdict_tier1: string; tier2_score: number | null; narrator_fired: number; episode_id: number | null }): void {
    this.db.run(
      `INSERT INTO perception_log (ts, event_count, verdict_tier1, tier2_score, narrator_fired, episode_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [Date.now(), r.event_count, r.verdict_tier1, r.tier2_score, r.narrator_fired, r.episode_id],
    )
  }
}
