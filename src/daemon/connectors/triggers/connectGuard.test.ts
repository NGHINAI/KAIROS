import { describe, it, expect } from 'bun:test'
import { ConnectGuard } from './connectGuard'

function fakeConnectionStore(connected: string[]) {
  return {
    listActive: (_userId: string) => connected.map(slug => ({ toolkit_slug: slug })),
  } as any
}

function fakeConnectionFlow(linkResult: any = { url: 'https://composio.dev/oauth/x' }) {
  const calls: any[] = []
  return {
    link: async (toolkit: string) => { calls.push(toolkit); return linkResult },
    calls,
  } as any
}

function fakeInbox() {
  const items: any[] = []
  return { add: (item: any) => items.push(item), items } as any
}

function fakeNotifier() {
  const notifs: any[] = []
  return { notify: async (msg: string) => notifs.push(msg), notifs } as any
}

describe('ConnectGuard', () => {
  it('returns "ready" when toolkit already connected', async () => {
    const guard = new ConnectGuard({
      connectionStore: fakeConnectionStore(['gmail']),
      connectionFlow: fakeConnectionFlow(),
      inbox: fakeInbox(), nativeNotifier: fakeNotifier(),
      onConnectionComplete: () => {},
      userId: 'local',
    })
    const out = await guard.ensureConnected('gmail', 'rule-x')
    expect(out).toBe('ready')
  })

  it('returns "pending" when toolkit not connected; surfaces inbox + notif', async () => {
    const inbox = fakeInbox()
    const notifier = fakeNotifier()
    const flow = fakeConnectionFlow()
    const guard = new ConnectGuard({
      connectionStore: fakeConnectionStore([]),
      connectionFlow: flow, inbox, nativeNotifier: notifier,
      onConnectionComplete: () => {},
      userId: 'local',
    })
    const out = await guard.ensureConnected('gmail', 'rule-x')
    expect(out).toBe('pending')
    expect(inbox.items).toHaveLength(1)
    expect(inbox.items[0]!.title).toContain('gmail')
    expect(notifier.notifs.length).toBeGreaterThan(0)
    expect(flow.calls).toContain('gmail')
  })

  it('does not call connectionFlow.link more than once for the same toolkit (in-flight dedup)', async () => {
    const flow = fakeConnectionFlow()
    const guard = new ConnectGuard({
      connectionStore: fakeConnectionStore([]),
      connectionFlow: flow, inbox: fakeInbox(), nativeNotifier: fakeNotifier(),
      onConnectionComplete: () => {},
      userId: 'local',
    })
    await guard.ensureConnected('gmail', 'rule-a')
    await guard.ensureConnected('gmail', 'rule-b')
    expect(flow.calls.length).toBe(1)
  })

  it('inbox prompt includes the rule slug', async () => {
    const inbox = fakeInbox()
    const guard = new ConnectGuard({
      connectionStore: fakeConnectionStore([]),
      connectionFlow: fakeConnectionFlow(), inbox, nativeNotifier: fakeNotifier(),
      onConnectionComplete: () => {},
      userId: 'local',
    })
    await guard.ensureConnected('gmail', 'mark-cuban-email')
    expect(inbox.items[0]!.body).toContain('mark-cuban-email')
  })

  it('handles connectionFlow throwing — still returns pending', async () => {
    const guard = new ConnectGuard({
      connectionStore: fakeConnectionStore([]),
      connectionFlow: { link: async () => { throw new Error('oauth start failed') } } as any,
      inbox: fakeInbox(), nativeNotifier: fakeNotifier(),
      onConnectionComplete: () => {},
      userId: 'local',
    })
    const out = await guard.ensureConnected('gmail', 'rule-x')
    expect(out).toBe('pending')
  })

  it('notifyComplete fires onConnectionComplete callback', async () => {
    const completed: string[] = []
    const guard = new ConnectGuard({
      connectionStore: fakeConnectionStore([]),
      connectionFlow: fakeConnectionFlow(), inbox: fakeInbox(), nativeNotifier: fakeNotifier(),
      onConnectionComplete: (toolkit) => completed.push(toolkit),
      userId: 'local',
    })
    await guard.ensureConnected('gmail', 'rule-x')
    guard.notifyComplete('gmail')
    expect(completed).toEqual(['gmail'])
  })
})
