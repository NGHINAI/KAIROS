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
})
