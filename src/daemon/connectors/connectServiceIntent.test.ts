import { describe, it, expect } from 'bun:test'
import { createConnectServiceIntent } from './connectServiceIntent'

describe('connectServiceIntent', () => {
  it('has expected metadata (id=connect_service, tier=GREEN)', () => {
    const intent = createConnectServiceIntent({
      connectionFlow: { connect: async () => ({ status: 'success', toolkit_slug: 'slack', duration_ms: 1, connection_id: 'c' }) },
      sessionManager: { addToolkit: async () => {} },
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
    } as any)
    await expect(intent.handler({} as any)).rejects.toThrow(/toolkit_slug/i)
    await expect(intent.handler({ toolkit_slug: '' } as any)).rejects.toThrow(/toolkit_slug/i)
  })

  it('does NOT call sessionManager.addToolkit when connection failed', async () => {
    const calls: string[] = []
    const intent = createConnectServiceIntent({
      connectionFlow: { connect: async () => ({ status: 'failed', toolkit_slug: 'slack', duration_ms: 1, error: 'oops' }) },
      sessionManager: { addToolkit: async (slug: string) => { calls.push(slug) } },
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
      userId: 'custom_user',
    } as any)
    await intent.handler({ toolkit_slug: 'slack' })
    expect(capturedUserId).toBe('custom_user')
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
    } as any)
    await intent.handler({ toolkit_slug: 'slack' })
    expect(capturedUserId).toBe('local')
  })
})
