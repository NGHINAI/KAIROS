// src/daemon/perception/tier1Classifier.test.ts
import { describe, it, expect } from 'bun:test'
import { Tier1Classifier } from './tier1Classifier'
import type { ModelRouter } from '../llm/router'
import type { CompletionResult } from '../llm/types'
import type { WorldEvent } from '../proactive/eventBus'

function fakeRouter(verdict: string): ModelRouter {
  return {
    complete: async (): Promise<CompletionResult> => ({
      text: verdict, provider: 'gemini', model: 'gemini-2.5-flash-lite',
      cost_cents: 0, latency_ms: 10, fallback_count: 0,
      input_tokens: 100, output_tokens: 5,
    }),
  } as unknown as ModelRouter
}

function makeEvent(source: string, kind: string, payload: Record<string, unknown>): WorldEvent {
  return { id: 1, ts: Date.now(), source, kind, payload }
}

describe('Tier1Classifier', () => {
  it('returns SIGNIFICANT verdict for important event batch', async () => {
    const t1 = new Tier1Classifier(fakeRouter('SIGNIFICANT'))
    const verdict = await t1.classify([makeEvent('focus-app', 'app_changed', { app: 'Slack' })])
    expect(verdict).toBe('SIGNIFICANT')
  })

  it('returns SILENT for trivial event batch', async () => {
    const t1 = new Tier1Classifier(fakeRouter('SILENT'))
    const verdict = await t1.classify([makeEvent('focus-app', 'app_changed', { app: 'Same' })])
    expect(verdict).toBe('SILENT')
  })

  it('returns SILENT for empty event batch without calling router', async () => {
    let calls = 0
    const router = { complete: async () => { calls++; return { text: 'SIGNIFICANT' } as any } } as unknown as ModelRouter
    const t1 = new Tier1Classifier(router)
    const verdict = await t1.classify([])
    expect(verdict).toBe('SILENT')
    expect(calls).toBe(0)
  })

  it('returns SILENT if router throws (fail-closed)', async () => {
    const router = { complete: async () => { throw new Error('router down') } } as unknown as ModelRouter
    const t1 = new Tier1Classifier(router)
    const verdict = await t1.classify([makeEvent('clipboard', 'changed', { text: 'x' })])
    expect(verdict).toBe('SILENT')
  })

  it('normalizes verbose router output to one of three verdicts', async () => {
    const t1 = new Tier1Classifier(fakeRouter('SIGNIFICANT — user just received an urgent slack'))
    const verdict = await t1.classify([makeEvent('s', 'k', {})])
    expect(verdict).toBe('SIGNIFICANT')
  })

  it('returns ROUTINE when router says routine', async () => {
    const t1 = new Tier1Classifier(fakeRouter('ROUTINE'))
    const verdict = await t1.classify([makeEvent('s', 'k', {})])
    expect(verdict).toBe('ROUTINE')
  })

  it('includes the FULL recent window — all events, not an arbitrary last-N (per-event slice bounds size)', async () => {
    let captured = ''
    const router = { complete: async (req: any) => { captured = req.prompt; return { text: 'SILENT', provider: 'g', model: 'm', cost_cents: 0, latency_ms: 1, fallback_count: 0, input_tokens: 1, output_tokens: 1 } } } as unknown as ModelRouter
    const now = Date.now()
    // 100 events spread across the last ~16 min (all inside the 60-min window).
    const recent = Array.from({ length: 100 }, (_, i) => ({ id: i, ts: now - i * 10_000, source: 'focus-app', kind: 'app_changed', payload: { app: `App${i}`, blob: 'x'.repeat(300) } as Record<string, unknown> }))
    await new Tier1Classifier(router).classify(recent)
    // ALL 100 are included (the old code capped at 40) — full context for the window.
    expect(captured.split('\n').filter(l => l.startsWith('[')).length).toBe(100)
    expect(captured).toContain('Events in the last 60 min (100)')
    expect(captured).not.toContain('of 100')                                  // not truncated
  })

  it('drops events older than the window (safety bound = the longest sweep gap, 60 min)', async () => {
    let captured = ''
    const router = { complete: async (req: any) => { captured = req.prompt; return { text: 'SILENT', provider: 'g', model: 'm', cost_cents: 0, latency_ms: 1, fallback_count: 0, input_tokens: 1, output_tokens: 1 } } } as unknown as ModelRouter
    const now = Date.now()
    const fresh = { id: 1, ts: now - 60_000, source: 'focus-app', kind: 'app_changed', payload: { app: 'Fresh' } as Record<string, unknown> }       // 1 min ago
    const stale = { id: 2, ts: now - 90 * 60_000, source: 'focus-app', kind: 'app_changed', payload: { app: 'Stale' } as Record<string, unknown> }   // 90 min ago
    await new Tier1Classifier(router).classify([stale, fresh])
    expect(captured).toContain('Fresh')
    expect(captured).not.toContain('Stale')                                   // outside the 60-min window
  })
})
