// src/daemon/restraint/karma.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { KarmaStore, KARMA_SCHEMA } from './karma'

describe('KarmaStore', () => {
  let db: Database
  let store: KarmaStore

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(KARMA_SCHEMA)
    store = new KarmaStore(db, { auto_suspend_after_dismissals: 3, dismissal_window_days: 7 } as any)
  })

  it('records a fire and creates a karma record', () => {
    store.recordFire('trig-1')
    const k = store.get('trig-1')
    expect(k?.fires).toBe(1)
    expect(k?.dismissed).toBe(0)
  })

  it('tracks deliveries and dismissals separately', () => {
    store.recordFire('trig-1')
    store.recordDelivery('trig-1')
    store.recordDismissal('trig-1')
    const k = store.get('trig-1')
    expect(k?.delivered).toBe(1)
    expect(k?.dismissed).toBe(1)
    expect(k?.last_dismissed_at).toBeGreaterThan(0)
  })

  it('auto-suspends after 3 dismissals in window', () => {
    store.recordDismissal('trig-1')
    store.recordDismissal('trig-1')
    expect(store.isSuspended('trig-1')).toBe(false)
    store.recordDismissal('trig-1')
    expect(store.isSuspended('trig-1')).toBe(true)
  })

  it('does not auto-suspend if dismissals are spread beyond window', () => {
    const oneWeekAgo = Date.now() - 8 * 24 * 3600_000
    store.recordDismissalAt('trig-1', oneWeekAgo)
    store.recordDismissalAt('trig-1', oneWeekAgo)
    store.recordDismissal('trig-1')   // most recent
    // Only 1 dismissal in window → not suspended
    expect(store.isSuspended('trig-1')).toBe(false)
  })

  it('dismissal penalty grows with recent dismissals', () => {
    expect(store.dismissalPenalty('trig-1')).toBe(0)
    store.recordDismissal('trig-1')
    expect(store.dismissalPenalty('trig-1')).toBeCloseTo(0.2, 1)
    store.recordDismissal('trig-1')
    store.recordDismissal('trig-1')
    expect(store.dismissalPenalty('trig-1')).toBeCloseTo(0.6, 1)
  })

  it('listSuspended returns currently-suspended trigger ids', () => {
    store.recordDismissal('a'); store.recordDismissal('a'); store.recordDismissal('a')
    store.recordDismissal('b')
    expect(store.listSuspended()).toContain('a')
    expect(store.listSuspended()).not.toContain('b')
  })

  it('clearSuspension reactivates a trigger', () => {
    store.recordDismissal('a'); store.recordDismissal('a'); store.recordDismissal('a')
    expect(store.isSuspended('a')).toBe(true)
    store.clearSuspension('a')
    expect(store.isSuspended('a')).toBe(false)
  })
})
