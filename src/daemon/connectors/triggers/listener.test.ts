// src/daemon/connectors/triggers/listener.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { TriggerEventLog } from './eventLog'
import { TriggerNormalizer } from './normalizer'
import { TriggerListener, type PusherLike, type PusherChannelLike } from './listener'
import { TriggerMetrics } from './metrics'

function fakePusher() {
  const channels: Record<string, { handlers: Record<string, (data?: any) => void> }> = {}
  const connectionHandlers: Record<string, (data?: any) => void> = {}
  let subscribedChannel: string | null = null
  let disconnected = false

  const pusher: PusherLike = {
    subscribe(channelName: string) {
      subscribedChannel = channelName
      const ch: { handlers: Record<string, (data?: any) => void> } = { handlers: {} }
      channels[channelName] = ch
      setTimeout(() => ch.handlers['pusher:subscription_succeeded']?.(), 0)
      return {
        bind(event, handler) { ch.handlers[event] = handler },
      } as PusherChannelLike
    },
    disconnect() { disconnected = true },
    connection: {
      bind(event, handler) { connectionHandlers[event] = handler },
      state: 'connected',
    },
  }

  return {
    pusher,
    deliver(event: any) {
      if (!subscribedChannel) throw new Error('test fake: no channel subscribed yet')
      channels[subscribedChannel]?.handlers['trigger_to_client']?.(event)
    },
    fireConnectionEvent(name: string) {
      connectionHandlers[name]?.()
    },
    getSubscribedChannel: () => subscribedChannel,
    isDisconnected: () => disconnected,
  }
}

function fakeEventBus() {
  const calls: any[] = []
  return {
    publish: (kind: string, payload: any) => calls.push({ kind, payload }),
    calls,
  } as any
}

const FAKE_CREDS = { pusherKey: 'pk-test', pusherCluster: 'mt1', projectId: 'proj-test' }

function makeListener(opts: { fakePusherCtl: ReturnType<typeof fakePusher>; onHealthChange?: any }) {
  const db = new Database(':memory:')
  const eventLog = new TriggerEventLog(db)
  const normalizer = new TriggerNormalizer()
  const metrics = new TriggerMetrics(db)
  const bus = fakeEventBus()
  const listener = new TriggerListener({
    apiKey: 'ak-test',
    eventLog, normalizer, perceptionBus: bus, metrics,
    onHealthChange: opts.onHealthChange,
    fetchCredentials: async () => FAKE_CREDS,
    pusherFactory: async () => opts.fakePusherCtl.pusher,
  })
  return { listener, eventLog, bus, db }
}

describe('TriggerListener', () => {
  let fakeCtl: ReturnType<typeof fakePusher>
  beforeEach(() => { fakeCtl = fakePusher() })

  it('start fetches credentials, builds Pusher, subscribes to project channel', async () => {
    const { listener } = makeListener({ fakePusherCtl: fakeCtl })
    await listener.start()
    expect(fakeCtl.getSubscribedChannel()).toBe('private-proj-test_triggers')
    await listener.stop()
  })

  it('event flows through normalizer → log → bus', async () => {
    const { listener, eventLog, bus } = makeListener({ fakePusherCtl: fakeCtl })
    await listener.start()
    fakeCtl.deliver({ triggerSlug: 'X', toolkitSlug: 'gmail', id: 'e1', data: { from: 'x' } })
    await new Promise(r => setTimeout(r, 20))
    expect(bus.calls).toHaveLength(1)
    expect(bus.calls[0].kind).toBe('incoming_event')
    expect(eventLog.listAll()).toHaveLength(1)
    expect(eventLog.listAll()[0]!.event_id).toBe('e1')
    await listener.stop()
  })

  it('duplicate event_id suppressed at the event log', async () => {
    const { listener, eventLog, bus } = makeListener({ fakePusherCtl: fakeCtl })
    await listener.start()
    fakeCtl.deliver({ triggerSlug: 'X', toolkitSlug: 'gmail', id: 'e1', data: {} })
    fakeCtl.deliver({ triggerSlug: 'X', toolkitSlug: 'gmail', id: 'e1', data: {} })
    await new Promise(r => setTimeout(r, 20))
    expect(bus.calls).toHaveLength(1)
    expect(eventLog.listAll()).toHaveLength(1)
    await listener.stop()
  })

  it('event causing publish error marks log as failed', async () => {
    const db = new Database(':memory:')
    const eventLog = new TriggerEventLog(db)
    const normalizer = new TriggerNormalizer()
    const metrics = new TriggerMetrics(db)
    const bus = { publish: () => { throw new Error('bus crashed') } }
    const listener = new TriggerListener({
      apiKey: 'ak-test',
      eventLog, normalizer, perceptionBus: bus as any, metrics,
      fetchCredentials: async () => FAKE_CREDS,
      pusherFactory: async () => fakeCtl.pusher,
    })
    await listener.start()
    fakeCtl.deliver({ triggerSlug: 'X', toolkitSlug: 'gmail', id: 'e1', data: {} })
    await new Promise(r => setTimeout(r, 20))
    expect(eventLog.listAll()[0]!.status).toBe('failed')
    await listener.stop()
  })

  it('getHealth returns "healthy" by default', () => {
    const { listener } = makeListener({ fakePusherCtl: fakeCtl })
    expect(listener.getHealth()).toBe('healthy')
  })

  it('Pusher connection state events transition health', async () => {
    const healths: string[] = []
    const { listener } = makeListener({
      fakePusherCtl: fakeCtl,
      onHealthChange: (h: any) => healths.push(h),
    })
    await listener.start()
    fakeCtl.fireConnectionEvent('unavailable')
    expect(listener.getHealth()).toBe('degraded')
    fakeCtl.fireConnectionEvent('failed')
    expect(listener.getHealth()).toBe('offline')
    fakeCtl.fireConnectionEvent('connected')
    expect(listener.getHealth()).toBe('healthy')
    expect(healths).toEqual(['degraded', 'offline', 'healthy'])
    await listener.stop()
  })

  it('stop disconnects the Pusher client', async () => {
    const { listener } = makeListener({ fakePusherCtl: fakeCtl })
    await listener.start()
    expect(fakeCtl.isDisconnected()).toBe(false)
    await listener.stop()
    expect(fakeCtl.isDisconnected()).toBe(true)
  })

  it('handles burst of 100 events', async () => {
    const { listener, bus } = makeListener({ fakePusherCtl: fakeCtl })
    await listener.start()
    for (let i = 0; i < 100; i++) {
      fakeCtl.deliver({ triggerSlug: 'X', toolkitSlug: 'gmail', id: 'e-' + i, data: {} })
    }
    await new Promise(r => setTimeout(r, 60))
    expect(bus.calls.length).toBe(100)
    await listener.stop()
  })
})
