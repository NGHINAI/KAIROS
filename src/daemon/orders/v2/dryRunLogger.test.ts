import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { OrdersStore } from './store'
import { DryRunLogger } from './dryRunLogger'
import type { Rule } from './types'

function mkRule(slug: string, dry_run_until: number): Rule {
  return {
    schema_version: 1, slug, when: { event: 'foo' },
    do: [{ action: 'notify', args: { message: 'x' } }],
    state: 'dry_run', created_by: 'voice', created_at: Date.now(),
    dry_run_until,
  }
}

describe('DryRunLogger', () => {
  let db: Database, store: OrdersStore, logger: DryRunLogger
  beforeEach(() => {
    db = new Database(':memory:')
    store = new OrdersStore(db)
    logger = new DryRunLogger(store)
  })

  it('isDryRun returns true if dry_run_until > now', () => {
    const r = mkRule('x', Date.now() + 1000)
    expect(logger.isDryRun(r, Date.now())).toBe(true)
  })

  it('isDryRun returns false if dry_run_until <= now', () => {
    const r = mkRule('x', Date.now() - 1000)
    expect(logger.isDryRun(r, Date.now())).toBe(false)
  })

  it('logFire records to store', () => {
    const r = mkRule('x', Date.now() + 1000)
    store.upsert(r)
    logger.logFire(r, [{ action: 'notify', args: {} }], { trigger: { foo: 1 } }, Date.now())
    expect(store.listDryRunLog('x')).toHaveLength(1)
  })

  it('summarize returns counts + samples', () => {
    const r = mkRule('x', Date.now() + 1000)
    store.upsert(r)
    const t0 = Date.now() - 30 * 60 * 1000
    for (let i = 0; i < 5; i++) {
      logger.logFire(r, [{ action: 'notify', args: {} }], { trigger: { i } }, t0 + i * 1000)
    }
    const summary = logger.summarize(r, Date.now())
    expect(summary.fire_count).toBe(5)
    expect(summary.samples.length).toBeGreaterThan(0)
    expect(summary.samples.length).toBeLessThanOrEqual(5)
  })

  it('listReadyForApproval returns rules whose dry_run window expired', () => {
    const rA = mkRule('a', Date.now() - 1000)   // expired
    const rB = mkRule('b', Date.now() + 1000)   // still in window
    store.upsert(rA); store.upsert(rB)
    const ready = logger.listReadyForApproval(Date.now())
    expect(ready.map(r => r.slug)).toEqual(['a'])
  })

  it('listReadyForApproval ignores rules without dry_run_until', () => {
    const r: Rule = { ...mkRule('a', 0), dry_run_until: undefined, state: 'active' }
    store.upsert(r)
    expect(logger.listReadyForApproval(Date.now())).toHaveLength(0)
  })
})
