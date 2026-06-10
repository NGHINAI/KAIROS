// src/daemon/perception/perceptionPipeline.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { EventBus } from '../proactive/eventBus'
import { StateSnapshot } from '../proactive/stateSnapshot'
import { WorkingMemory } from '../memory/workingMemory'
import { initMemorySchema } from '../memory/schema'
import { EpisodicMemory } from '../memory/episodicMemory'
import { Narrator } from '../proactive/narrator'
import { Tier1Classifier } from './tier1Classifier'
import { Tier2Summarizer } from './tier2Summarizer'
import { PerceptionPipeline, PERCEPTION_LOG_SCHEMA } from './perceptionPipeline'
import type { ModelRouter } from '../llm/router'
import type { CompletionResult } from '../llm/types'

function makeRouter(t1Verdict: 'SIGNIFICANT' | 'ROUTINE' | 'SILENT', t2: any = { description: 'd', score: 0.8, episode_type: 'work_session' }): ModelRouter {
  return {
    complete: async (req: any): Promise<CompletionResult> => {
      if (req.task_type === 'classify') {
        return { text: t1Verdict, provider: 'g', model: 'g', cost_cents: 0, latency_ms: 1, fallback_count: 0, input_tokens: 1, output_tokens: 1 }
      }
      if (req.task_type === 'action_compose') {
        return { text: JSON.stringify(t2), parsed: t2, provider: 'g', model: 'g', cost_cents: 0, latency_ms: 1, fallback_count: 0, input_tokens: 1, output_tokens: 1 }
      }
      // narrative
      return { text: 'narrative text', provider: 'g', model: 'g', cost_cents: 0, latency_ms: 1, fallback_count: 0, input_tokens: 1, output_tokens: 1 }
    },
  } as unknown as ModelRouter
}

describe('PerceptionPipeline', () => {
  let db: Database
  let bus: EventBus
  let snap: StateSnapshot
  let working: WorkingMemory
  let episodic: EpisodicMemory

  beforeEach(() => {
    db = new Database(':memory:')
    initMemorySchema(db)
    db.exec(PERCEPTION_LOG_SCHEMA)
    bus = new EventBus(db)
    snap = new StateSnapshot(bus)
    working = new WorkingMemory(bus, { windowMs: 60_000, maxEvents: 100 })
    episodic = new EpisodicMemory(db)
  })

  it('SILENT verdict short-circuits — no Tier 2, no narrator, no episode', async () => {
    const r = makeRouter('SILENT')
    const t1 = new Tier1Classifier(r)
    const t2 = new Tier2Summarizer(r)
    const narrator = new Narrator(bus, snap, r, { intervalMs: Number.MAX_SAFE_INTEGER })
    const pipeline = new PerceptionPipeline(db, working, t1, t2, narrator, episodic, () => '')
    bus.publish({ source: 'focus-app', kind: 'app_changed', payload: { app: 'X' } })
    await pipeline.evaluateNow()
    expect(episodic.recent(10).length).toBe(0)
    const log = db.query('SELECT * FROM perception_log').all() as any[]
    expect(log.length).toBe(1)
    expect(log[0]?.verdict_tier1).toBe('SILENT')
  })

  it('ROUTINE writes a routine episode but does not invoke narrator', async () => {
    const r = makeRouter('ROUTINE')
    const t1 = new Tier1Classifier(r)
    const t2 = new Tier2Summarizer(r)
    const narrator = new Narrator(bus, snap, r, { intervalMs: Number.MAX_SAFE_INTEGER })
    const pipeline = new PerceptionPipeline(db, working, t1, t2, narrator, episodic, () => '')
    bus.publish({ source: 'focus-app', kind: 'app_changed', payload: { app: 'X' } })
    await pipeline.evaluateNow()
    const eps = episodic.recent(10)
    expect(eps.length).toBe(1)
    expect(eps[0]?.episode_type).toBe('routine')
    const log = db.query('SELECT narrator_fired FROM perception_log').get() as any
    expect(log.narrator_fired).toBe(0)
  })

  it('SIGNIFICANT + high Tier 2 score writes episode + invokes narrator', async () => {
    const r = makeRouter('SIGNIFICANT', { description: 'big news', score: 0.9, episode_type: 'communication' })
    const t1 = new Tier1Classifier(r)
    const t2 = new Tier2Summarizer(r)
    const narrator = new Narrator(bus, snap, r, { intervalMs: Number.MAX_SAFE_INTEGER })
    const pipeline = new PerceptionPipeline(db, working, t1, t2, narrator, episodic, () => '')
    bus.publish({ source: 'clipboard', kind: 'changed', payload: { text: 'something' } })
    bus.publish({ source: 'focus-app', kind: 'app_changed', payload: { app: 'Slack' } })
    await pipeline.evaluateNow()
    const eps = episodic.recent(10)
    expect(eps.length).toBe(1)
    expect(eps[0]?.episode_type).toBe('communication')
    expect(eps[0]?.importance).toBe(0.9)
    const log = db.query('SELECT narrator_fired FROM perception_log').get() as any
    expect(log.narrator_fired).toBe(1)
  })

  it('SIGNIFICANT + low Tier 2 score writes episode but skips narrator', async () => {
    const r = makeRouter('SIGNIFICANT', { description: 'meh', score: 0.3, episode_type: 'work_session' })
    const t1 = new Tier1Classifier(r)
    const t2 = new Tier2Summarizer(r)
    const narrator = new Narrator(bus, snap, r, { intervalMs: Number.MAX_SAFE_INTEGER })
    const pipeline = new PerceptionPipeline(db, working, t1, t2, narrator, episodic, () => '')
    bus.publish({ source: 'focus-app', kind: 'app_changed', payload: { app: 'X' } })
    await pipeline.evaluateNow()
    const eps = episodic.recent(10)
    expect(eps.length).toBe(1)
    expect(eps[0]?.importance).toBe(0.3)
    const log = db.query('SELECT narrator_fired FROM perception_log').get() as any
    expect(log.narrator_fired).toBe(0)
  })

  it('empty working memory does nothing (no log row, no episode)', async () => {
    const r = makeRouter('SILENT')
    const t1 = new Tier1Classifier(r)
    const t2 = new Tier2Summarizer(r)
    const narrator = new Narrator(bus, snap, r, { intervalMs: Number.MAX_SAFE_INTEGER })
    const pipeline = new PerceptionPipeline(db, working, t1, t2, narrator, episodic, () => '')
    await pipeline.evaluateNow()
    expect(episodic.recent(10).length).toBe(0)
    expect((db.query('SELECT * FROM perception_log').all() as any[]).length).toBe(0)
  })

  it('each sweep reviews only events SINCE the last sweep (no re-classifying, no duplicate episodes)', async () => {
    const r = makeRouter('ROUTINE')
    const t1 = new Tier1Classifier(r)
    const t2 = new Tier2Summarizer(r)
    const narrator = new Narrator(bus, snap, r, { intervalMs: Number.MAX_SAFE_INTEGER })
    const pipeline = new PerceptionPipeline(db, working, t1, t2, narrator, episodic, () => '')
    bus.publish({ source: 'focus-app', kind: 'app_changed', payload: { app: 'A' } })
    await pipeline.evaluateNow()
    expect(episodic.recent(10).length).toBe(1)
    // Sweep again with NOTHING new — the old event must not be re-reviewed.
    await pipeline.evaluateNow()
    expect(episodic.recent(10).length).toBe(1)                 // no duplicate episode
    const logs = db.query('SELECT event_count FROM perception_log').all() as any[]
    expect(logs.length).toBe(1)                                // second sweep was a no-op
    // A new event after the sweep IS picked up by the next one.
    bus.publish({ source: 'clipboard', kind: 'changed', payload: { text: 'new' } })
    await pipeline.evaluateNow()
    expect(episodic.recent(10).length).toBe(2)
  })

  it('adaptive cadence: busy window → min interval, quiet → max, normal → base', async () => {
    const r = makeRouter('SILENT')
    const t1 = new Tier1Classifier(r)
    const t2 = new Tier2Summarizer(r)
    const narrator = new Narrator(bus, snap, r, { intervalMs: Number.MAX_SAFE_INTEGER })
    const pipeline = new PerceptionPipeline(db, working, t1, t2, narrator, episodic, () => '', {
      pollMs: 30 * 60_000, minPollMs: 10 * 60_000, maxPollMs: 60 * 60_000, busyEvents: 10, quietEvents: 2,
    })
    // Quiet: 1 event (≤2) → stretch to max.
    bus.publish({ source: 'focus-app', kind: 'app_changed', payload: { app: 'A' } })
    await pipeline.evaluateNow()
    expect(pipeline.nextDelay()).toBe(60 * 60_000)
    // Busy: 12 new events (≥10) → tighten to min.
    for (let i = 0; i < 12; i++) bus.publish({ source: 'clipboard', kind: 'changed', payload: { i } })
    await pipeline.evaluateNow()
    expect(pipeline.nextDelay()).toBe(10 * 60_000)
    // Normal: 5 new events (between bands) → base.
    for (let i = 0; i < 5; i++) bus.publish({ source: 'focus-app', kind: 'app_changed', payload: { i } })
    await pipeline.evaluateNow()
    expect(pipeline.nextDelay()).toBe(30 * 60_000)
  })
})
