import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { TriggerMetrics } from './metrics'

describe('TriggerMetrics', () => {
  let db: Database, m: TriggerMetrics

  beforeEach(() => {
    db = new Database(':memory:')
    m = new TriggerMetrics(db)
  })

  it('record + query returns the row', () => {
    m.record('gmail', null, 'received', 1)
    const r = m.query({ from: 0, to: Date.now() + 10000, metric: 'received' })
    expect(r.length).toBeGreaterThan(0)
    expect(r[0]!.value).toBe(1)
  })

  it('aggregates within same minute bucket', () => {
    m.record('gmail', null, 'received', 1)
    m.record('gmail', null, 'received', 1)
    m.record('gmail', null, 'received', 1)
    const r = m.query({ from: 0, to: Date.now() + 10000, metric: 'received' })
    const total = r.reduce((s, x) => s + x.value, 0)
    expect(total).toBe(3)
  })

  it('percentiles computes p50/p99 from latency values', () => {
    for (let i = 1; i <= 100; i++) m.record('gmail', null, 'latency_ms', i)
    const p = m.percentiles('latency_ms', { from: 0, to: Date.now() + 10000 })
    expect(p.p50).toBeGreaterThanOrEqual(40)
    expect(p.p50).toBeLessThanOrEqual(60)
    expect(p.p99).toBeGreaterThanOrEqual(95)
  })

  it('toolkit filter works', () => {
    m.record('gmail', null, 'received', 1)
    m.record('slack', null, 'received', 1)
    const r = m.query({ from: 0, to: Date.now() + 10000, toolkit: 'gmail' })
    expect(r.every(x => x.toolkit === 'gmail')).toBe(true)
  })
})
