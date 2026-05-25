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
})
