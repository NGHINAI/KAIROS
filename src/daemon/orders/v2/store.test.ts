// src/daemon/orders/v2/store.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { OrdersStore } from './store'
import type { Rule } from './types'

function mkRule(slug: string, overrides: Partial<Rule> = {}): Rule {
  return {
    schema_version: 1,
    slug,
    when: { event: 'foo' },
    do: [{ action: 'log', args: { message: 'x' } }],
    state: 'active',
    created_by: 'manual',
    created_at: Date.now(),
    ...overrides,
  }
}

describe('OrdersStore', () => {
  let db: Database
  let store: OrdersStore

  beforeEach(() => {
    db = new Database(':memory:')
    store = new OrdersStore(db)
  })

  it('upsert + get round-trip preserves shape', () => {
    const r = mkRule('test-rule', { cooldown_ms: 30_000 })
    store.upsert(r)
    const got = store.get('test-rule')
    expect(got).not.toBeNull()
    expect(got!.slug).toBe('test-rule')
    expect(got!.cooldown_ms).toBe(30_000)
    expect(got!.do[0]!.action).toBe('log')
  })

  it('upsert is idempotent (second upsert updates)', () => {
    store.upsert(mkRule('x', { state: 'pending' }))
    store.upsert(mkRule('x', { state: 'active' }))
    expect(store.get('x')!.state).toBe('active')
    expect(store.listAll()).toHaveLength(1)
  })

  it('listActiveByWhenKind filters by when kind', () => {
    store.upsert(mkRule('a', { when: { cron: '* * * * *' } }))
    store.upsert(mkRule('b', { when: { event: 'foo' } }))
    store.upsert(mkRule('c', { when: { state: { clipboard: { contains: 'x' } } } }))
    expect(store.listActiveByWhenKind('cron').map(r => r.slug)).toEqual(['a'])
    expect(store.listActiveByWhenKind('state').map(r => r.slug)).toEqual(['c'])
    expect(store.listActiveByWhenKind('event').map(r => r.slug)).toEqual(['b'])
  })

  it('listActiveByWhenKind ignores suspended', () => {
    store.upsert(mkRule('a', { when: { event: 'foo' }, state: 'suspended' }))
    expect(store.listActiveByWhenKind('event')).toHaveLength(0)
  })

  it('replaceAll deletes missing rules', () => {
    store.upsert(mkRule('a'))
    store.upsert(mkRule('b'))
    store.replaceAll([mkRule('a'), mkRule('c')])
    expect(store.listAll().map(r => r.slug).sort()).toEqual(['a', 'c'])
  })

  it('recordFire updates last_fired_at and increments fire_count', () => {
    store.upsert(mkRule('x'))
    const now = Date.now()
    store.recordFire('x', now)
    const s = store.getState('x')
    expect(s!.last_fired_at).toBe(now)
    expect(s!.fire_count).toBe(1)
    store.recordFire('x', now + 1000)
    expect(store.getState('x')!.fire_count).toBe(2)
  })

  it('recordDryRunFire logs to dry_run table', () => {
    store.upsert(mkRule('x'))
    const now = Date.now()
    store.recordDryRunFire('x', now, [{ action: 'log', args: { m: 'y' } }], { trigger: { foo: 1 } })
    const logs = store.listDryRunLog('x')
    expect(logs).toHaveLength(1)
    expect(logs[0]!.fired_at).toBe(now)
  })

  it('countDryRunFiresSince counts within window', () => {
    store.upsert(mkRule('x'))
    const now = Date.now()
    store.recordDryRunFire('x', now - 1000, [], {})
    store.recordDryRunFire('x', now - 100, [], {})
    expect(store.countDryRunFiresSince('x', now - 500)).toBe(1)
    expect(store.countDryRunFiresSince('x', now - 2000)).toBe(2)
  })
})
