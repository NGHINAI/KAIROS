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

function fmtMs(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)}min` : `${ms / 1000}s`
}

export type PerceptionPipelineOptions = {
  /** Base sweep interval. Default 30 min (KAIROS_PERCEPTION_POLL_MS). */
  pollMs?: number
  /** ADAPTIVE bounds: a busy window sweeps again sooner (min), a quiet one stretches
   *  out (max). Defaults: min 10 min, max 60 min — env-tunable. */
  minPollMs?: number
  maxPollMs?: number
  /** Event-count bands that pick the next interval. Defaults: busy ≥60, quiet ≤5. */
  busyEvents?: number
  quietEvents?: number
}

export class PerceptionPipeline {
  private timer: ReturnType<typeof setTimeout> | null = null
  private pollMs: number
  private minPollMs: number
  private maxPollMs: number
  private busyEvents: number
  private quietEvents: number
  private evaluating = false
  private stopped = true
  /** Each sweep reviews only what arrived SINCE the last one — so adaptive (overlapping-
   *  window) cadences never re-classify the same events or double-write episodes. Cursor
   *  is the bus's AUTOINCREMENT event id (strictly monotonic — exact, unlike a ms clock). */
  private lastSeenEventId = 0
  private lastSweepCount = 0

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
    // Base = 30 MIN (matches config.perception.pipelinePollMs / KAIROS_PERCEPTION_POLL_MS):
    // each sweep reviews the FULL window since the last one — the chief-of-staff "catch up"
    // cadence — instead of a 30s blip check. ADAPTIVE: a busy period tightens the next
    // sweep toward minPollMs, a quiet one stretches it toward maxPollMs. Urgent real-time
    // events still interrupt via the bus→TriggerEngine/UrgencyFloor path, independent of
    // this poll.
    this.pollMs = opts?.pollMs ?? 30 * 60_000
    this.minPollMs = opts?.minPollMs ?? (Number(process.env.KAIROS_PERCEPTION_POLL_MIN_MS) || 10 * 60_000)
    this.maxPollMs = opts?.maxPollMs ?? (Number(process.env.KAIROS_PERCEPTION_POLL_MAX_MS) || 60 * 60_000)
    this.busyEvents = opts?.busyEvents ?? (Number(process.env.KAIROS_PERCEPTION_BUSY_EVENTS) || 60)
    this.quietEvents = opts?.quietEvents ?? (Number(process.env.KAIROS_PERCEPTION_QUIET_EVENTS) || 5)
    db.exec(PERCEPTION_LOG_SCHEMA)
  }

  start(): void {
    this.stopped = false
    this.scheduleNext(this.pollMs)
    log(`PerceptionPipeline: armed (adaptive sweep — base ${fmtMs(this.pollMs)}, busy→${fmtMs(this.minPollMs)}, quiet→${fmtMs(this.maxPollMs)})`)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
  }

  // Self-chaining timeout (never setInterval): the next sweep is scheduled only AFTER the
  // previous one completes, so slow LLM sweeps can't overlap, and the delay adapts to how
  // busy the just-swept window was.
  private scheduleNext(delayMs: number): void {
    if (this.stopped) return
    this.timer = setTimeout(async () => {
      await this.evaluateNow()
      this.scheduleNext(this.nextDelay())
    }, delayMs)
  }

  /** Adaptive cadence: busy window → sweep again sooner; quiet → stretch out. */
  nextDelay(): number {
    if (this.lastSweepCount >= this.busyEvents) return this.minPollMs
    if (this.lastSweepCount <= this.quietEvents) return this.maxPollMs
    return this.pollMs
  }

  async evaluateNow(): Promise<void> {
    if (this.evaluating) return
    this.evaluating = true
    try {
      // Only what arrived since the last sweep — the "catch up on what's new" window.
      // (First sweep sees the whole WorkingMemory ring.) Keeps adaptive cadences from
      // re-reviewing events a prior sweep already classified.
      const events = this.working.snapshot().filter(e => e.id > this.lastSeenEventId)
      this.lastSweepCount = events.length
      if (events.length === 0) return
      this.lastSeenEventId = Math.max(...events.map(e => e.id))

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
