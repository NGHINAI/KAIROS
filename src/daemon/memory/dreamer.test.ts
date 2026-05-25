// src/daemon/memory/dreamer.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { initMemorySchema } from './schema'
import { EpisodicMemory } from './episodicMemory'
import { SemanticMemory } from './semanticMemory'
import { Dreamer } from './dreamer'
import type { ModelRouter } from '../llm/router'
import type { CompletionResult } from '../llm/types'

function fakeRouter(text: string): ModelRouter {
  return {
    complete: async (): Promise<CompletionResult> => ({
      text, parsed: tryParse(text),
      provider: 'gemini', model: 'g', cost_cents: 0, latency_ms: 1,
      fallback_count: 0, input_tokens: 1, output_tokens: 1,
    }),
  } as unknown as ModelRouter
}

function tryParse(s: string): unknown { try { return JSON.parse(s) } catch { return undefined } }

describe('Dreamer', () => {
  let db: Database
  let ep: EpisodicMemory
  let sem: SemanticMemory

  beforeEach(() => {
    db = new Database(':memory:')
    initMemorySchema(db)
    ep = new EpisodicMemory(db)
    sem = new SemanticMemory(db)
  })

  it('scores episodes using the Hermes formula', () => {
    const d = new Dreamer(db, ep, sem, fakeRouter(''), { embedder: async () => new Array(768).fill(0) })
    const score = d.score({
      id: 1, started_at: Date.now() - 60_000, ended_at: Date.now() - 60_000,
      episode_type: 'work_session', title: 't', summary: 's',
      event_ids: [1, 2, 3, 4, 5], importance: 0.5,
      promoted_l3: 0, created_at: 0,
    })
    expect(score).toBeGreaterThan(0)
    expect(score).toBeLessThanOrEqual(1)
  })

  it('consolidates unpromoted episodes into L3 facts and marks promoted', async () => {
    ep.writeEpisode({
      started_at: Date.now() - 60_000, ended_at: Date.now() - 30_000,
      episode_type: 'work_session', title: 'Editing auth.ts',
      summary: 'Refactored session middleware', event_ids: [1, 2, 3], importance: 0.8,
    })
    const router = fakeRouter(JSON.stringify({
      facts: [
        { kind: 'fact', subject: 'auth.ts', body: 'session middleware was refactored', importance: 0.7 },
      ],
    }))
    const d = new Dreamer(db, ep, sem, router, { embedder: async () => new Array(768).fill(0).map((_, i) => i / 768) })
    const consolidated = await d.consolidate({ maxEpisodes: 10 })
    expect(consolidated).toBe(1)
    expect(sem.allActive().length).toBe(1)
    expect(ep.unpromoted(10).length).toBe(0)
  })

  it('does not double-promote already-consolidated episodes', async () => {
    const id = ep.writeEpisode({
      started_at: 1, ended_at: 2, episode_type: 'x', title: 't', summary: 's',
      event_ids: [], importance: 0.9,
    })
    ep.markPromoted(id)
    const d = new Dreamer(db, ep, sem, fakeRouter('{"facts":[]}'), { embedder: async () => new Array(768).fill(0) })
    const consolidated = await d.consolidate({ maxEpisodes: 10 })
    expect(consolidated).toBe(0)
  })
})
