// src/daemon/memory/episodicMemory.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { initMemorySchema } from './schema'
import { EpisodicMemory } from './episodicMemory'

describe('EpisodicMemory', () => {
  let db: Database
  let mem: EpisodicMemory

  beforeEach(() => {
    db = new Database(':memory:')
    initMemorySchema(db)
    mem = new EpisodicMemory(db)
  })

  it('writes an episode and returns the row id', () => {
    const id = mem.writeEpisode({
      started_at: 1700000000000,
      ended_at: 1700000600000,
      episode_type: 'work_session',
      title: 'Editing auth.ts',
      summary: 'Refactored session middleware in src/auth.ts',
      event_ids: [1, 2, 3],
      importance: 0.7,
    })
    expect(id).toBeGreaterThan(0)
  })

  it('retrieves recent episodes ordered newest-first', () => {
    mem.writeEpisode({ started_at: 1000, ended_at: 2000, episode_type: 'x', title: 'a', summary: 's', event_ids: [], importance: 0.5 })
    mem.writeEpisode({ started_at: 3000, ended_at: 4000, episode_type: 'x', title: 'b', summary: 's', event_ids: [], importance: 0.5 })
    const recent = mem.recent(10)
    expect(recent.length).toBe(2)
    expect(recent[0]?.title).toBe('b')
  })

  it('lists unpromoted episodes for the dreamer', () => {
    const id1 = mem.writeEpisode({ started_at: 1, ended_at: 2, episode_type: 'x', title: 'a', summary: 's', event_ids: [], importance: 0.8 })
    const id2 = mem.writeEpisode({ started_at: 3, ended_at: 4, episode_type: 'x', title: 'b', summary: 's', event_ids: [], importance: 0.3 })
    mem.markPromoted(id1)
    const unpromoted = mem.unpromoted(10)
    expect(unpromoted.length).toBe(1)
    expect(unpromoted[0]?.id).toBe(id2)
  })

  it('filters by episode_type', () => {
    mem.writeEpisode({ started_at: 1, ended_at: 2, episode_type: 'work_session', title: 'a', summary: 's', event_ids: [], importance: 0.5 })
    mem.writeEpisode({ started_at: 3, ended_at: 4, episode_type: 'communication', title: 'b', summary: 's', event_ids: [], importance: 0.5 })
    const work = mem.byType('work_session', 10)
    expect(work.length).toBe(1)
    expect(work[0]?.title).toBe('a')
  })
})
