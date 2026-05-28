import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { OrdersStore } from './store'
import { ReactiveEvaluator } from './reactiveEvaluator'
import { ConditionEvaluator } from './conditionEvaluator'
import { DryRunLogger } from './dryRunLogger'
import type { Rule } from './types'

function mkClipboardRule(slug: string, contains: string, opts: Partial<Rule> = {}): Rule {
  return {
    schema_version: 1, slug,
    when: { state: { clipboard: { contains } } },
    do: [{ action: 'notify', args: { message: 'matched' } }],
    state: 'active', created_by: 'manual', created_at: Date.now(),
    ...opts,
  }
}

function fakeDispatcher() {
  const calls: any[] = []
  return {
    dispatch: async (actions: any, ctx: any) => { calls.push({ actions, ctx }); return { ok: true } },
    calls,
  }
}

describe('ReactiveEvaluator', () => {
  let db: Database, store: OrdersStore, evaluator: ReactiveEvaluator, dispatcher: ReturnType<typeof fakeDispatcher>

  beforeEach(() => {
    db = new Database(':memory:')
    store = new OrdersStore(db)
    dispatcher = fakeDispatcher()
    evaluator = new ReactiveEvaluator({
      store,
      dispatcher: dispatcher as any,
      conditionEvaluator: new ConditionEvaluator(),
      dryRunLogger: new DryRunLogger(store),
      getPersonaState: () => ({ is_in_meeting: false, focus_app: 'Code' }),
    })
  })

  it('fires rule when clipboard event matches', async () => {
    store.upsert(mkClipboardRule('a', 'urgent'))
    await evaluator.handleEvent('clipboard', { text: 'urgent reminder' })
    expect(dispatcher.calls).toHaveLength(1)
  })

  it('does not fire when clipboard does not match', async () => {
    store.upsert(mkClipboardRule('a', 'urgent'))
    await evaluator.handleEvent('clipboard', { text: 'hello' })
    expect(dispatcher.calls).toHaveLength(0)
  })

  it('skips rule when unless persona.is_in_meeting is true', async () => {
    evaluator = new ReactiveEvaluator({
      store, dispatcher: dispatcher as any,
      conditionEvaluator: new ConditionEvaluator(),
      dryRunLogger: new DryRunLogger(store),
      getPersonaState: () => ({ is_in_meeting: true }),
    })
    store.upsert(mkClipboardRule('a', 'urgent', { unless: ['persona.is_in_meeting'] }))
    await evaluator.handleEvent('clipboard', { text: 'urgent x' })
    expect(dispatcher.calls).toHaveLength(0)
  })

  it('fires when if predicate is satisfied', async () => {
    store.upsert(mkClipboardRule('a', 'urgent', { if: ['persona.focus_app == "Code"'] }))
    await evaluator.handleEvent('clipboard', { text: 'urgent x' })
    expect(dispatcher.calls).toHaveLength(1)
  })

  it('skips when if predicate is false', async () => {
    store.upsert(mkClipboardRule('a', 'urgent', { if: ['persona.focus_app == "Slack"'] }))
    await evaluator.handleEvent('clipboard', { text: 'urgent x' })
    expect(dispatcher.calls).toHaveLength(0)
  })

  it('respects cooldown (does not fire twice within window)', async () => {
    store.upsert(mkClipboardRule('a', 'urgent', { cooldown_ms: 10_000 }))
    await evaluator.handleEvent('clipboard', { text: 'urgent x' })
    await evaluator.handleEvent('clipboard', { text: 'urgent y' })
    expect(dispatcher.calls).toHaveLength(1)
  })

  it('records fire timestamp in store', async () => {
    store.upsert(mkClipboardRule('a', 'urgent'))
    await evaluator.handleEvent('clipboard', { text: 'urgent x' })
    expect(store.getState('a')!.fire_count).toBe(1)
  })

  it('uses dry-run path when rule is in dry-run window', async () => {
    const r = mkClipboardRule('a', 'urgent', { state: 'dry_run', dry_run_until: Date.now() + 60_000 })
    store.upsert(r)
    await evaluator.handleEvent('clipboard', { text: 'urgent x' })
    expect(dispatcher.calls).toHaveLength(0)
    expect(store.listDryRunLog('a')).toHaveLength(1)
  })

  it('matches focus_app rule', async () => {
    const r: Rule = {
      schema_version: 1, slug: 'b',
      when: { state: { focus_app: { equals: 'Slack' } } },
      do: [{ action: 'log', args: {} }],
      state: 'active', created_by: 'manual', created_at: Date.now(),
    }
    store.upsert(r)
    await evaluator.handleEvent('focus_app', { app: 'Slack' })
    expect(dispatcher.calls).toHaveLength(1)
    await evaluator.handleEvent('focus_app', { app: 'Code' })
    expect(dispatcher.calls).toHaveLength(1)
  })

  it('matches focus_app.in([...])', async () => {
    const r: Rule = {
      schema_version: 1, slug: 'c',
      when: { state: { focus_app: { in: ['Slack', 'Discord'] } } },
      do: [{ action: 'log', args: {} }],
      state: 'active', created_by: 'manual', created_at: Date.now(),
    }
    store.upsert(r)
    await evaluator.handleEvent('focus_app', { app: 'Discord' })
    expect(dispatcher.calls).toHaveLength(1)
  })

  it('handles event-triggered rules via handleEvent("event", { name, payload })', async () => {
    const r: Rule = {
      schema_version: 1, slug: 'd', when: { event: 'invite_classified' },
      do: [{ action: 'notify', args: { message: 'classified' } }],
      state: 'active', created_by: 'manual', created_at: Date.now(),
    }
    store.upsert(r)
    await evaluator.handleEvent('event', { name: 'invite_classified', payload: { importance: 'high' } })
    expect(dispatcher.calls).toHaveLength(1)
  })

  it('ignores events when no rule matches', async () => {
    await evaluator.handleEvent('clipboard', { text: 'random' })
    expect(dispatcher.calls).toHaveLength(0)
  })
})
