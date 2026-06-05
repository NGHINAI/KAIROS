import { describe, it, expect } from 'bun:test'
import { createConnectServiceIntent, registerConnectServiceIntent } from './connectServiceIntent'
import { IntentRegistry } from '../agency/intentRegistry'

// A fake ToolkitResolver. `map` is phrase → resolve result. An exact slug not in
// the map resolves to itself with score 1 (mirrors the real exact-slug path).
function fakeResolver(map: Record<string, any> = {}) {
  return {
    resolve: async (phrase: string) => {
      if (map[phrase]) return map[phrase]
      // default: treat the phrase as an exact slug.
      return { best: phrase, matches: [{ slug: phrase, name: phrase, score: 1 }] }
    },
  }
}

describe('connect_service slug resolution (replaces normalizeToolkitSlug)', () => {
  it('resolves a fuzzy phrase to the exact slug before connecting (calendar → googlecalendar)', async () => {
    let connectedWith = ''
    const intent = createConnectServiceIntent({
      connectionFlow: { connect: async (a: any) => { connectedWith = a.toolkitSlug; return { status: 'success', toolkit_slug: a.toolkitSlug, duration_ms: 1, connection_id: 'c' } } },
      sessionManager: { addToolkit: async () => {} },
      toolkitResolver: fakeResolver({
        calendar: { best: 'googlecalendar', matches: [{ slug: 'googlecalendar', name: 'Google Calendar', score: 0.9 }] },
      }),
    } as any)
    await intent.handler({ toolkit_slug: 'calendar' as any })
    expect(connectedWith).toBe('googlecalendar') // not the literal "calendar" that 404s
  })

  it('an exact slug still connects directly (backward compatible)', async () => {
    let connectedWith = ''
    const intent = createConnectServiceIntent({
      connectionFlow: { connect: async (a: any) => { connectedWith = a.toolkitSlug; return { status: 'success', toolkit_slug: a.toolkitSlug, duration_ms: 1, connection_id: 'c' } } },
      sessionManager: { addToolkit: async () => {} },
      toolkitResolver: fakeResolver(), // 'slack' → itself, score 1
    } as any)
    await intent.handler({ toolkit_slug: 'slack' })
    expect(connectedWith).toBe('slack')
  })

  it('a unique high-confidence match connects (does not stall) and addToolkit uses the resolved slug', async () => {
    let connectedWith = ''
    let added = ''
    const intent = createConnectServiceIntent({
      connectionFlow: { connect: async (a: any) => { connectedWith = a.toolkitSlug; return { status: 'success', toolkit_slug: a.toolkitSlug, duration_ms: 1, connection_id: 'c' } } },
      sessionManager: { addToolkit: async (s: string) => { added = s } },
      toolkitResolver: fakeResolver({
        gcal: { best: 'googlecalendar', matches: [{ slug: 'googlecalendar', name: 'Google Calendar', score: 0.95 }] },
      }),
    } as any)
    await intent.handler({ toolkit_slug: 'gcal' as any })
    expect(connectedWith).toBe('googlecalendar')
    expect(added).toBe('googlecalendar')
  })

  it('near-tied low-confidence candidates → needs_disambiguation (does NOT connect)', async () => {
    let connectCalled = false
    const intent = createConnectServiceIntent({
      connectionFlow: { connect: async () => { connectCalled = true; return { status: 'success', toolkit_slug: 'x', duration_ms: 1 } } },
      sessionManager: { addToolkit: async () => {} },
      toolkitResolver: fakeResolver({
        tickets: {
          best: 'linear',
          matches: [
            { slug: 'linear', name: 'Linear', score: 0.5 },
            { slug: 'zendesk', name: 'Zendesk', score: 0.45 },
          ],
        },
      }),
    } as any)
    const result: any = await intent.handler({ toolkit_slug: 'tickets' as any })
    expect(result.status).toBe('needs_disambiguation')
    expect(result.candidates.map((c: any) => c.slug)).toEqual(['linear', 'zendesk'])
    expect(connectCalled).toBe(false)
  })

  it('falls back to a slugified phrase when the resolver finds nothing', async () => {
    let connectedWith = ''
    const intent = createConnectServiceIntent({
      connectionFlow: { connect: async (a: any) => { connectedWith = a.toolkitSlug; return { status: 'success', toolkit_slug: a.toolkitSlug, duration_ms: 1, connection_id: 'c' } } },
      sessionManager: { addToolkit: async () => {} },
      toolkitResolver: { resolve: async () => ({ matches: [] }) },
    } as any)
    await intent.handler({ toolkit_slug: 'Some Unknown App' as any })
    expect(connectedWith).toBe('someunknownapp')
  })
})

describe('connectServiceIntent', () => {
  it('has expected metadata (id=connect_service, tier=GREEN)', () => {
    const intent = createConnectServiceIntent({
      connectionFlow: { connect: async () => ({ status: 'success', toolkit_slug: 'slack', duration_ms: 1, connection_id: 'c' }) },
      sessionManager: { addToolkit: async () => {} },
      toolkitResolver: fakeResolver(),
    } as any)
    expect(intent.id).toBe('connect_service')
    expect(intent.tier).toBe('GREEN')
    expect(typeof intent.description).toBe('string')
  })

  it('runs the full pipeline on success — connectionFlow then sessionManager.addToolkit', async () => {
    const calls: any[] = []
    const intent = createConnectServiceIntent({
      connectionFlow: {
        connect: async (args: any) => { calls.push({ stage: 'connect', args }); return { status: 'success', toolkit_slug: args.toolkitSlug, duration_ms: 1, connection_id: 'c' } },
      },
      sessionManager: {
        addToolkit: async (slug: string) => { calls.push({ stage: 'addToolkit', slug }) },
      },
      toolkitResolver: fakeResolver(),
    } as any)
    const result = await intent.handler({ toolkit_slug: 'slack' })
    expect(result.status).toBe('success')
    expect(calls[0].stage).toBe('connect')
    expect(calls[1].stage).toBe('addToolkit')
    expect(calls[1].slug).toBe('slack')
  })

  it('throws when toolkit_slug is missing or empty', async () => {
    const intent = createConnectServiceIntent({
      connectionFlow: { connect: async () => { throw new Error('should not be called') } },
      sessionManager: { addToolkit: async () => {} },
      toolkitResolver: fakeResolver(),
    } as any)
    await expect(intent.handler({} as any)).rejects.toThrow(/toolkit_slug/i)
    await expect(intent.handler({ toolkit_slug: '' } as any)).rejects.toThrow(/toolkit_slug/i)
  })

  it('does NOT call sessionManager.addToolkit when connection failed', async () => {
    const calls: string[] = []
    const intent = createConnectServiceIntent({
      connectionFlow: { connect: async () => ({ status: 'failed', toolkit_slug: 'slack', duration_ms: 1, error: 'oops' }) },
      sessionManager: { addToolkit: async (slug: string) => { calls.push(slug) } },
      toolkitResolver: fakeResolver(),
    } as any)
    const result = await intent.handler({ toolkit_slug: 'slack' })
    expect(result.status).toBe('failed')
    expect(calls.length).toBe(0)
  })

  it('uses configured userId when provided', async () => {
    let capturedUserId: string | null = null
    const intent = createConnectServiceIntent({
      connectionFlow: {
        connect: async (args: any) => {
          capturedUserId = args.userId
          return { status: 'success', toolkit_slug: args.toolkitSlug, duration_ms: 1, connection_id: 'c' }
        },
      },
      sessionManager: { addToolkit: async () => {} },
      toolkitResolver: fakeResolver(),
      userId: 'custom_user',
    } as any)
    await intent.handler({ toolkit_slug: 'slack' })
    expect(capturedUserId as string | null).toBe('custom_user')
  })

  it('defaults to userId="local" when not provided', async () => {
    let capturedUserId: string | null = null
    const intent = createConnectServiceIntent({
      connectionFlow: {
        connect: async (args: any) => {
          capturedUserId = args.userId
          return { status: 'success', toolkit_slug: args.toolkitSlug, duration_ms: 1, connection_id: 'c' }
        },
      },
      sessionManager: { addToolkit: async () => {} },
      toolkitResolver: fakeResolver(),
    } as any)
    await intent.handler({ toolkit_slug: 'slack' })
    expect(capturedUserId as string | null).toBe('local')
  })
})

describe('registerConnectServiceIntent', () => {
  it('reports needs_disambiguation as an awaiting status with a candidate list', async () => {
    const reg = new IntentRegistry()
    registerConnectServiceIntent(reg, {
      connectionFlow: { connect: async () => ({ status: 'success', toolkit_slug: 'x', duration_ms: 1 }) },
      sessionManager: { addToolkit: async () => {} },
      toolkitResolver: fakeResolver({
        tickets: {
          best: 'linear',
          matches: [
            { slug: 'linear', name: 'Linear', score: 0.5 },
            { slug: 'zendesk', name: 'Zendesk', score: 0.45 },
          ],
        },
      }),
    } as any)
    const out = await reg.get('connect_service')!.handler({ toolkit_slug: 'tickets' }, {} as any)
    expect(out.status).toBe('awaiting')
    expect(out.details).toContain('linear')
    expect(out.details).toContain('zendesk')
  })
})
