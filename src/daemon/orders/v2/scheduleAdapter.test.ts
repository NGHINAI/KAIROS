import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { OrdersStore } from './store'
import { ScheduleAdapter } from './scheduleAdapter'
import type { Rule } from './types'

function mkCronRule(slug: string, cron: string, opts: Partial<Rule> = {}): Rule {
  return {
    schema_version: 1, slug, when: { cron },
    do: [{ action: 'log', args: { message: 'x' } }],
    state: 'active', created_by: 'manual', created_at: Date.now(),
    ...opts,
  }
}

describe('ScheduleAdapter', () => {
  let db: Database, store: OrdersStore, adapter: ScheduleAdapter, fired: string[]
  beforeEach(() => {
    db = new Database(':memory:')
    store = new OrdersStore(db)
    fired = []
    adapter = new ScheduleAdapter({
      store,
      onFire: async (rule, _ctx) => { fired.push(rule.slug) },
    })
  })
  afterEach(() => { adapter.stopAll() })

  it('register accepts a cron rule', () => {
    const r = mkCronRule('a', '0 9 * * *')
    store.upsert(r)
    adapter.register(r)
    expect(adapter.registeredSlugs()).toContain('a')
  })

  it('unregister clears timer', () => {
    const r = mkCronRule('a', '0 9 * * *')
    store.upsert(r)
    adapter.register(r)
    adapter.unregister('a')
    expect(adapter.registeredSlugs()).not.toContain('a')
  })

  it('refreshAll registers all cron + at rules', () => {
    store.upsert(mkCronRule('a', '0 9 * * *'))
    store.upsert({ ...mkCronRule('b', ''), when: { at: 'in 2 hours' } } as Rule)
    store.upsert({ ...mkCronRule('c', ''), when: { event: 'foo' } } as Rule)   // not time-triggered
    adapter.refreshAll()
    expect(adapter.registeredSlugs().sort()).toEqual(['a', 'b'])
  })

  it('rejects invalid cron expression silently (logs)', () => {
    const r = mkCronRule('bad', 'not a cron')
    store.upsert(r)
    expect(() => adapter.register(r)).not.toThrow()
    expect(adapter.registeredSlugs()).not.toContain('bad')
  })

  it('fires after at: "in 1 second"', async () => {
    const r: Rule = {
      schema_version: 1, slug: 'instant', when: { at: 'in 1 second' },
      do: [{ action: 'log', args: { message: 'x' } }],
      state: 'active', created_by: 'manual', created_at: Date.now(),
    }
    store.upsert(r)
    adapter.register(r)
    await new Promise(res => setTimeout(res, 1200))
    expect(fired).toContain('instant')
  }, 5000)

  it('cron rule registers without throwing', () => {
    const r = mkCronRule('every-min', '* * * * *')
    store.upsert(r)
    adapter.register(r)
    expect(adapter.registeredSlugs()).toContain('every-min')
  })
})
