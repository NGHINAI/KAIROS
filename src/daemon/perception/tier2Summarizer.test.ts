// src/daemon/perception/tier2Summarizer.test.ts
import { describe, it, expect } from 'bun:test'
import { Tier2Summarizer } from './tier2Summarizer'
import type { ModelRouter } from '../llm/router'
import type { CompletionResult } from '../llm/types'
import type { WorldEvent } from '../proactive/eventBus'

function fakeRouter(payload: object): ModelRouter {
  return {
    complete: async (): Promise<CompletionResult> => ({
      text: JSON.stringify(payload),
      parsed: payload,
      provider: 'gemini', model: 'gemini-2.5-flash',
      cost_cents: 0, latency_ms: 50, fallback_count: 0,
      input_tokens: 300, output_tokens: 50,
    }),
  } as unknown as ModelRouter
}

const E = (source: string, kind: string, payload: Record<string, unknown>): WorldEvent =>
  ({ id: 1, ts: Date.now(), source, kind, payload })

describe('Tier2Summarizer', () => {
  it('produces a description + score from a batch', async () => {
    const router = fakeRouter({ description: 'User just got 2 Slack DMs', score: 0.85, episode_type: 'communication' })
    const s = new Tier2Summarizer(router)
    const result = await s.summarize([E('focus-app', 'app_changed', { app: 'Slack' })], '')
    expect(result.description).toContain('Slack')
    expect(result.score).toBe(0.85)
    expect(result.episode_type).toBe('communication')
  })

  it('clamps score to 0-1 range', async () => {
    const s = new Tier2Summarizer(fakeRouter({ description: 'x', score: 1.5, episode_type: 'x' }))
    const r = await s.summarize([E('s', 'k', {})], '')
    expect(r.score).toBe(1)

    const s2 = new Tier2Summarizer(fakeRouter({ description: 'y', score: -0.3, episode_type: 'x' }))
    const r2 = await s2.summarize([E('s', 'k', {})], '')
    expect(r2.score).toBe(0)
  })

  it('returns score 0 on router error (fail-closed)', async () => {
    const router = { complete: async () => { throw new Error('boom') } } as unknown as ModelRouter
    const s = new Tier2Summarizer(router)
    const r = await s.summarize([E('s', 'k', {})], '')
    expect(r.score).toBe(0)
    expect(r.description).toBe('')
  })

  it('accepts standing orders text without crashing', async () => {
    const s = new Tier2Summarizer(fakeRouter({ description: 'standup in 8 min', score: 0.5, episode_type: 'reminder' }))
    const ordersText = '- If I have a calendar event starting in 10 min, remind me'
    const r = await s.summarize([E('calendar-local', 'upcoming', { events: [{ title: 'Standup' }] })], ordersText)
    expect(r.description).toBe('standup in 8 min')
  })
})
