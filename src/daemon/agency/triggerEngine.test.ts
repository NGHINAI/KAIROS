// src/daemon/agency/triggerEngine.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { EventBus } from '../proactive/eventBus'
import { ORDERS_SCHEMA } from '../orders/compiler'
import { TriggerEngine } from './triggerEngine'

describe('TriggerEngine', () => {
  let db: Database
  let bus: EventBus
  let engine: TriggerEngine
  let dispatched: Array<{ intent_id: string; args: Record<string, unknown> }>

  beforeEach(() => {
    db = new Database(':memory:')
    bus = new EventBus(db)
    db.exec(ORDERS_SCHEMA)
    dispatched = []
    engine = new TriggerEngine(db, bus, async (req) => {
      dispatched.push({ intent_id: req.intent_id, args: req.args })
      return { status: 'completed' } as any
    })
  })

  function addTrigger(t: Partial<{
    id: string; when_kind: string; when_match: string;
    condition: string | null; action: string; source_rule: string;
  }>) {
    db.run(
      `INSERT INTO compiled_orders_triggers (id, when_kind, when_match, condition, action, source_rule, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [t.id ?? 't1', t.when_kind ?? 'focus-app', t.when_match ?? '*', t.condition ?? null,
       t.action ?? 'notify', t.source_rule ?? 'test', Date.now()],
    )
  }

  it('fires when event source matches a trigger', async () => {
    addTrigger({ when_kind: 'clipboard', when_match: '*', action: 'log' })
    await engine.evaluateEvent({ id: 1, ts: Date.now(), source: 'clipboard', kind: 'changed', payload: { text: 'hi' } } as any)
    expect(dispatched.length).toBe(1)
    expect(dispatched[0]?.intent_id).toBe('log')
  })

  it('does not fire when source does not match', async () => {
    addTrigger({ when_kind: 'clipboard', when_match: '*', action: 'log' })
    await engine.evaluateEvent({ id: 1, ts: Date.now(), source: 'focus-app', kind: 'app_changed', payload: { app: 'X' } } as any)
    expect(dispatched.length).toBe(0)
  })

  it('respects suspended scope', async () => {
    db.exec(`CREATE TABLE IF NOT EXISTS agency_suspend_state (id INTEGER PRIMARY KEY, scope TEXT, until_ms INTEGER, reason TEXT)`)
    db.run(`INSERT INTO agency_suspend_state (scope, until_ms, reason) VALUES ('all', ?, 'quiet hours')`, [Date.now() + 60_000])
    addTrigger({ when_kind: 'clipboard', action: 'log' })
    await engine.evaluateEvent({ id: 1, ts: Date.now(), source: 'clipboard', kind: 'changed', payload: {} } as any)
    expect(dispatched.length).toBe(0)
  })

  it('lists all triggers from compiled orders', () => {
    addTrigger({ id: 'a' })
    addTrigger({ id: 'b' })
    expect(engine.listTriggers().length).toBe(2)
  })

  it('matchesPayload supports text.contains() predicate', async () => {
    addTrigger({ when_kind: 'clipboard', when_match: "text.contains('http')", action: 'add_to_memory' })
    await engine.evaluateEvent({ id: 1, ts: Date.now(), source: 'clipboard', kind: 'changed', payload: { text: 'https://foo' } } as any)
    expect(dispatched.length).toBe(1)

    await engine.evaluateEvent({ id: 2, ts: Date.now(), source: 'clipboard', kind: 'changed', payload: { text: 'nope' } } as any)
    expect(dispatched.length).toBe(1)
  })

  it('matchesPayload supports app.equals() predicate', async () => {
    addTrigger({ when_kind: 'focus-app', when_match: "app.equals('Slack')", action: 'notify' })
    await engine.evaluateEvent({ id: 1, ts: Date.now(), source: 'focus-app', kind: 'app_changed', payload: { app: 'Slack' } } as any)
    expect(dispatched.length).toBe(1)
    await engine.evaluateEvent({ id: 2, ts: Date.now(), source: 'focus-app', kind: 'app_changed', payload: { app: 'Notes' } } as any)
    expect(dispatched.length).toBe(1)
  })

  it('matchesPayload supports path.endsWith() predicate', async () => {
    addTrigger({ when_kind: 'file-events', when_match: "path.endsWith('.ts')", action: 'log' })
    await engine.evaluateEvent({ id: 1, ts: Date.now(), source: 'file-events', kind: 'modified', payload: { path: '/foo.ts' } } as any)
    await engine.evaluateEvent({ id: 2, ts: Date.now(), source: 'file-events', kind: 'modified', payload: { path: '/foo.txt' } } as any)
    expect(dispatched.length).toBe(1)
  })
})
