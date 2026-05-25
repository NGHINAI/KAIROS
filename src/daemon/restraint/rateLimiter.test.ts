// src/daemon/restraint/rateLimiter.test.ts
import { describe, it, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { RateLimiter, RATE_LIMITER_SCHEMA } from './rateLimiter'

describe('RateLimiter', () => {
  it('allows interrupts up to daily cap', () => {
    const db = new Database(':memory:')
    db.exec(RATE_LIMITER_SCHEMA)
    const limiter = new RateLimiter(db, { max_interrupts_per_day: 3, max_interrupts_per_hour: 10, max_surfaces_per_hour: 100 } as any)
    expect(limiter.canDeliver('interrupt', false)).toBe(true)
    limiter.recordDelivery('interrupt')
    expect(limiter.canDeliver('interrupt', false)).toBe(true)
    limiter.recordDelivery('interrupt')
    expect(limiter.canDeliver('interrupt', false)).toBe(true)
    limiter.recordDelivery('interrupt')
    expect(limiter.canDeliver('interrupt', false)).toBe(false)   // hit daily cap
  })

  it('urgent bypasses daily cap', () => {
    const db = new Database(':memory:')
    db.exec(RATE_LIMITER_SCHEMA)
    const limiter = new RateLimiter(db, { max_interrupts_per_day: 1, max_interrupts_per_hour: 10, max_surfaces_per_hour: 100 } as any)
    limiter.recordDelivery('interrupt')
    expect(limiter.canDeliver('interrupt', false)).toBe(false)
    expect(limiter.canDeliver('interrupt', true)).toBe(true)   // urgent bypasses
  })

  it('enforces per-hour cap separately', () => {
    const db = new Database(':memory:')
    db.exec(RATE_LIMITER_SCHEMA)
    const limiter = new RateLimiter(db, { max_interrupts_per_day: 100, max_interrupts_per_hour: 2, max_surfaces_per_hour: 100 } as any)
    limiter.recordDelivery('interrupt')
    limiter.recordDelivery('interrupt')
    expect(limiter.canDeliver('interrupt', false)).toBe(false)   // hour cap hit
  })

  it('surface tier has its own cap', () => {
    const db = new Database(':memory:')
    db.exec(RATE_LIMITER_SCHEMA)
    const limiter = new RateLimiter(db, { max_interrupts_per_day: 100, max_interrupts_per_hour: 100, max_surfaces_per_hour: 2 } as any)
    limiter.recordDelivery('surface')
    limiter.recordDelivery('surface')
    expect(limiter.canDeliver('surface', false)).toBe(false)
    expect(limiter.canDeliver('interrupt', false)).toBe(true)   // interrupt unaffected
  })

  it('counts reset based on time window', () => {
    const db = new Database(':memory:')
    db.exec(RATE_LIMITER_SCHEMA)
    const limiter = new RateLimiter(db, { max_interrupts_per_day: 1, max_interrupts_per_hour: 1, max_surfaces_per_hour: 100 } as any)
    // Insert a delivery from 2 days ago directly
    db.run("INSERT INTO restraint_delivery_log (mode, ts) VALUES ('interrupt', ?)", [Date.now() - 3 * 24 * 3600_000])
    expect(limiter.canDeliver('interrupt', false)).toBe(true)   // old delivery doesn't count
  })
})
