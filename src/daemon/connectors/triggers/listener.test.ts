// src/daemon/connectors/triggers/listener.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { TriggerEventLog } from './eventLog'
import { TriggerNormalizer } from './normalizer'
import { TriggerListener } from './listener'
import { TriggerMetrics } from './metrics'

function fakeComposio() {
  let callback: ((event: any) => void) | null = null
  return {
    triggers: {
      subscribe: async (cb: (event: any) => void, _opts?: any) => {
        callback = cb
        return { unsubscribe: () => { callback = null } }
      },
    },
    deliver: (event: any) => callback?.(event),
    isSubscribed: () => callback !== null,
  } as any
}

function fakeEventBus() {
  const calls: any[] = []
  return {
    publish: (kind: string, payload: any) => calls.push({ kind, payload }),
    subscribe: () => {},
    calls,
  } as any
}

describe('TriggerListener', () => {
  let db: Database, log: TriggerEventLog, normalizer: TriggerNormalizer, metrics: TriggerMetrics, bus: ReturnType<typeof fakeEventBus>, composio: any, listener: TriggerListener

  beforeEach(() => {
    db = new Database(':memory:')
    log = new TriggerEventLog(db)
    normalizer = new TriggerNormalizer()
    metrics = new TriggerMetrics(db)
    bus = fakeEventBus()
    composio = fakeComposio()
  })

  it('start subscribes to composio.triggers', async () => {
    listener = new TriggerListener({ composio, eventLog: log, normalizer, perceptionBus: bus, metrics })
    await listener.start()
    expect(composio.isSubscribed()).toBe(true)
    await listener.stop()
  })

  it('event flows through log → normalizer → perception bus', async () => {
    listener = new TriggerListener({ composio, eventLog: log, normalizer, perceptionBus: bus, metrics })
    await listener.start()
    composio.deliver({ triggerSlug: 'X', toolkitSlug: 'gmail', id: 'e1', data: { from: 'x' } })
    await new Promise(r => setTimeout(r, 50))
    expect(bus.calls).toHaveLength(1)
    expect(bus.calls[0].kind).toBe('incoming_event')
    expect(log.listAll()).toHaveLength(1)
    expect(log.listAll()[0]!.event_id).toBe('e1')
    await listener.stop()
  })

  it('duplicate event is suppressed at the event log (not re-published)', async () => {
    listener = new TriggerListener({ composio, eventLog: log, normalizer, perceptionBus: bus, metrics })
    await listener.start()
    composio.deliver({ triggerSlug: 'X', toolkitSlug: 'gmail', id: 'e1', data: { from: 'x' } })
    composio.deliver({ triggerSlug: 'X', toolkitSlug: 'gmail', id: 'e1', data: { from: 'x' } })
    await new Promise(r => setTimeout(r, 50))
    expect(bus.calls).toHaveLength(1)
    await listener.stop()
  })

  it('event causing publish error marks log as failed', async () => {
    bus.publish = () => { throw new Error('bus crashed') }
    listener = new TriggerListener({ composio, eventLog: log, normalizer, perceptionBus: bus, metrics })
    await listener.start()
    composio.deliver({ triggerSlug: 'X', toolkitSlug: 'gmail', id: 'e1', data: {} })
    await new Promise(r => setTimeout(r, 50))
    expect(log.listAll()[0]!.status).toBe('failed')
    await listener.stop()
  })

  it('getHealth returns "healthy" by default', () => {
    listener = new TriggerListener({ composio, eventLog: log, normalizer, perceptionBus: bus, metrics })
    expect(listener.getHealth()).toBe('healthy')
  })

  it('stop unsubscribes from composio', async () => {
    listener = new TriggerListener({ composio, eventLog: log, normalizer, perceptionBus: bus, metrics })
    await listener.start()
    expect(composio.isSubscribed()).toBe(true)
    await listener.stop()
    expect(composio.isSubscribed()).toBe(false)
  })

  it('onHealthChange callback fires when health changes', async () => {
    const healths: string[] = []
    listener = new TriggerListener({
      composio, eventLog: log, normalizer, perceptionBus: bus, metrics,
      onHealthChange: (h) => healths.push(h),
    })
    await listener.start()
    // Force health change via internal API (test-only)
    ;(listener as any).setHealth('degraded')
    expect(healths).toEqual(['degraded'])
    await listener.stop()
  })

  it('handles burst of 100 events', async () => {
    listener = new TriggerListener({ composio, eventLog: log, normalizer, perceptionBus: bus, metrics })
    await listener.start()
    for (let i = 0; i < 100; i++) {
      composio.deliver({ triggerSlug: 'X', toolkitSlug: 'gmail', id: 'e-' + i, data: {} })
    }
    await new Promise(r => setTimeout(r, 100))
    expect(bus.calls.length).toBe(100)
    await listener.stop()
  })
})
