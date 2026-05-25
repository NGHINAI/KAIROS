// src/daemon/proactive/eventBus.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { EventBus } from './eventBus'

describe('EventBus', () => {
  let db: Database
  let bus: EventBus

  beforeEach(() => {
    db = new Database(':memory:')
    bus = new EventBus(db)
  })

  it('persists a published event', () => {
    bus.publish({ source: 'focus-app', kind: 'app_changed', payload: { app: 'Slack' } })
    const recent = bus.recent(10)
    expect(recent.length).toBe(1)
    expect(recent[0]?.source).toBe('focus-app')
    expect(recent[0]?.payload).toEqual({ app: 'Slack' })
  })

  it('delivers events to subscribers in order', () => {
    const received: string[] = []
    bus.subscribe('focus-app', e => received.push(e.kind))
    bus.publish({ source: 'focus-app', kind: 'app_changed', payload: { app: 'A' } })
    bus.publish({ source: 'focus-app', kind: 'app_changed', payload: { app: 'B' } })
    bus.publish({ source: 'clipboard', kind: 'changed', payload: {} })
    expect(received).toEqual(['app_changed', 'app_changed'])
  })

  it('wildcard subscribers receive all events', () => {
    const received: string[] = []
    bus.subscribe('*', e => received.push(e.source))
    bus.publish({ source: 'focus-app', kind: 'a', payload: {} })
    bus.publish({ source: 'clipboard', kind: 'b', payload: {} })
    expect(received).toEqual(['focus-app', 'clipboard'])
  })

  it('recent() returns latest events newest-first', () => {
    bus.publish({ source: 's', kind: 'a', payload: { n: 1 } })
    bus.publish({ source: 's', kind: 'a', payload: { n: 2 } })
    bus.publish({ source: 's', kind: 'a', payload: { n: 3 } })
    const r = bus.recent(2)
    expect(r.length).toBe(2)
    expect((r[0]?.payload as any).n).toBe(3)
    expect((r[1]?.payload as any).n).toBe(2)
  })

  it('since() filters by timestamp', async () => {
    bus.publish({ source: 's', kind: 'a', payload: { n: 1 } })
    const cutoff = Date.now()
    await new Promise(r => setTimeout(r, 5))
    bus.publish({ source: 's', kind: 'a', payload: { n: 2 } })
    const r = bus.since(cutoff)
    expect(r.length).toBe(1)
    expect((r[0]?.payload as any).n).toBe(2)
  })
})
