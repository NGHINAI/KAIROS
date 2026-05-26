// src/daemon/llm/costTracker.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { CostTracker } from './costTracker'

describe('CostTracker', () => {
  let db: Database
  let tracker: CostTracker

  beforeEach(() => {
    db = new Database(':memory:')
    tracker = new CostTracker(db, 50)  // $50/month budget
  })

  it('records a call and returns monthly total', () => {
    tracker.record({
      provider: 'gemini',
      model: 'gemini-2.5-flash-lite',
      input_tokens: 1000,
      output_tokens: 500,
      cost_cents: 12,
      task_type: 'narrative',
    })
    expect(tracker.monthlyCostCents()).toBe(12)
  })

  it('aggregates multiple calls by provider', () => {
    tracker.record({ provider: 'gemini', model: 'g1', input_tokens: 100, output_tokens: 50, cost_cents: 5, task_type: 'narrative' })
    tracker.record({ provider: 'openai', model: 'o1', input_tokens: 100, output_tokens: 50, cost_cents: 10, task_type: 'narrative' })
    tracker.record({ provider: 'gemini', model: 'g1', input_tokens: 100, output_tokens: 50, cost_cents: 5, task_type: 'narrative' })
    const byProvider = tracker.monthlyCostByProvider()
    expect(byProvider.gemini).toBe(10)
    expect(byProvider.openai).toBe(10)
  })

  it('flags over budget once exceeded', () => {
    expect(tracker.isOverBudget()).toBe(false)
    tracker.record({ provider: 'openai', model: 'o1', input_tokens: 1, output_tokens: 1, cost_cents: 5001, task_type: 'source_patch' })
    expect(tracker.isOverBudget()).toBe(true)
  })

  it('records cache metrics and computes cache_hit_rate', () => {
    tracker.record({
      provider: 'anthropic_api',
      model: 'sonnet-4-5',
      task_type: 'agency_judge',
      input_tokens: 6700,
      output_tokens: 200,
      cached_input_tokens: 6000,
      cost_cents: 22,
    })
    const summary = tracker.summaryFor({ window_ms: 24 * 60 * 60 * 1000 })
    expect(summary.total_calls).toBe(1)
    expect(summary.total_input_tokens).toBe(6700)
    expect(summary.total_cached_tokens).toBe(6000)
    expect(summary.cache_hit_rate).toBeCloseTo(6000 / 6700)
    expect(summary.total_cost_cents).toBe(22)
  })

  it('aggregates summaryByProvider with cache data', () => {
    tracker.record({ provider: 'anthropic_api', model: 'sonnet', task_type: 'a', input_tokens: 100, output_tokens: 10, cached_input_tokens: 50, cost_cents: 10 })
    tracker.record({ provider: 'openai', model: 'gpt-4o-mini', task_type: 'b', input_tokens: 200, output_tokens: 20, cached_input_tokens: 100, cost_cents: 5 })
    const byProvider = tracker.summaryByProvider({ window_ms: 24 * 60 * 60 * 1000 })
    expect(byProvider.anthropic_api.total_calls).toBe(1)
    expect(byProvider.anthropic_api.total_cached_tokens).toBe(50)
    expect(byProvider.anthropic_api.cache_hit_rate).toBeCloseTo(50 / 100)
    expect(byProvider.openai.total_calls).toBe(1)
    expect(byProvider.openai.total_cached_tokens).toBe(100)
    expect(byProvider.openai.cache_hit_rate).toBeCloseTo(100 / 200)
  })

  it('projects monthly cost from 24h window', () => {
    // 10 calls × 10 cents each = 100 cents in 24h
    for (let i = 0; i < 10; i++) {
      tracker.record({ provider: 'a', model: 'm', task_type: 't', input_tokens: 100, output_tokens: 10, cached_input_tokens: 50, cost_cents: 10 })
    }
    const proj = tracker.projectedMonthlyCost()
    // 100 cents/day × 30 days = 3000 cents = $30
    expect(proj).toBeCloseTo(3000, 0)
  })
})
