// src/daemon/agency/perceptionToTrigger.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { EventBus } from '../proactive/eventBus'
import { initMemorySchema } from '../memory/schema'
import { EpisodicMemory } from '../memory/episodicMemory'
import { PerceptionToTrigger } from './perceptionToTrigger'

describe('PerceptionToTrigger bridge', () => {
  let db: Database
  let bus: EventBus
  let ep: EpisodicMemory

  beforeEach(() => {
    db = new Database(':memory:')
    initMemorySchema(db)
    bus = new EventBus(db)
    ep = new EpisodicMemory(db)
  })

  it('republishes a recent episode as an episode-written event', async () => {
    const captured: Array<{ source: string; kind: string }> = []
    bus.subscribe('episode-written', e => { captured.push({ source: e.source, kind: e.kind }) })

    const bridge = new PerceptionToTrigger(bus, ep)
    ep.writeEpisode({
      started_at: 1, ended_at: 2, episode_type: 'work_session',
      title: 't', summary: 's', event_ids: [], importance: 0.8,
    })
    await bridge.republishLatest()
    expect(captured.length).toBe(1)
    expect(captured[0]?.source).toBe('episode-written')
    expect(captured[0]?.kind).toBe('work_session')
  })

  it('does not republish episodes it has already republished', async () => {
    const bridge = new PerceptionToTrigger(bus, ep)
    ep.writeEpisode({
      started_at: 1, ended_at: 2, episode_type: 'x', title: 'a', summary: 's',
      event_ids: [], importance: 0.5,
    })
    await bridge.republishLatest()
    await bridge.republishLatest()
    const after = bus.recent(10).filter(e => e.source === 'episode-written')
    expect(after.length).toBe(1)
  })

  it('republishes multiple new episodes in chronological order', async () => {
    const bridge = new PerceptionToTrigger(bus, ep)
    ep.writeEpisode({ started_at: 1, ended_at: 2, episode_type: 'a', title: 'first', summary: 's', event_ids: [], importance: 0.5 })
    ep.writeEpisode({ started_at: 3, ended_at: 4, episode_type: 'b', title: 'second', summary: 's', event_ids: [], importance: 0.5 })
    ep.writeEpisode({ started_at: 5, ended_at: 6, episode_type: 'c', title: 'third', summary: 's', event_ids: [], importance: 0.5 })
    await bridge.republishLatest()
    const captured = bus.recent(10).filter(e => e.source === 'episode-written')
    expect(captured.length).toBe(3)
    // newest first in bus.recent(); we want chronological titles in publish order
    expect((captured[0]?.payload as any).title).toBe('third')
    expect((captured[2]?.payload as any).title).toBe('first')
  })

  it('honors setHighWaterMark to skip episodes the daemon already saw on restart', async () => {
    const id1 = ep.writeEpisode({ started_at: 1, ended_at: 2, episode_type: 'x', title: 'old', summary: 's', event_ids: [], importance: 0.5 })
    const bridge = new PerceptionToTrigger(bus, ep)
    bridge.setHighWaterMark(id1)   // tell the bridge this id is already processed
    await bridge.republishLatest()
    expect(bus.recent(10).filter(e => e.source === 'episode-written').length).toBe(0)

    ep.writeEpisode({ started_at: 3, ended_at: 4, episode_type: 'y', title: 'new', summary: 's', event_ids: [], importance: 0.5 })
    await bridge.republishLatest()
    expect(bus.recent(10).filter(e => e.source === 'episode-written').length).toBe(1)
  })
})
