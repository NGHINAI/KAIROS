import { describe, it, expect } from 'bun:test'
import { ComposioSessionManager } from './composioSessionManager'

function makeFakeSdk(behavior: any = {}) {
  return {
    create: async (_userId: string, opts: any) => {
      behavior.lastCreateOpts = opts
      return {
        id: behavior.session_id ?? 'sess_xyz',
        session_id: behavior.session_id ?? 'sess_xyz',
        mcp: {
          url: behavior.mcp_url ?? 'https://backend.composio.dev/tool_router/' + (behavior.session_id ?? 'sess_xyz') + '/mcp',
          headers: behavior.mcp_headers ?? { 'x-api-key': 'k' },
        },
        update: async (newOpts: any) => { behavior.updated = newOpts },
      }
    },
    use: async (sessionId: string) => ({
      id: sessionId,
      session_id: sessionId,
      mcp: { url: `https://backend.composio.dev/tool_router/${sessionId}/mcp`, headers: { 'x-api-key': 'k' } },
      update: async (newOpts: any) => { behavior.updated = newOpts },
    }),
  }
}

describe('ComposioSessionManager', () => {
  it('creates a new session on first init when no cached session_id', async () => {
    const sdk = makeFakeSdk()
    const m = new ComposioSessionManager({ sdk, userId: 'local', toolkits: ['slack'] })
    await m.init()
    expect(m.getMcpUrl()).toMatch(/sess_xyz/)
  })

  it('resumes an existing session if cachedSessionId is provided', async () => {
    const behavior: any = {}
    const sdk = makeFakeSdk(behavior)
    const m = new ComposioSessionManager({ sdk, userId: 'local', toolkits: ['slack'], cachedSessionId: 'sess_resumed' })
    await m.init()
    expect(m.getMcpUrl()).toMatch(/sess_resumed/)
  })

  it('addToolkit triggers session.update with the full toolkit set', async () => {
    const behavior: any = {}
    const sdk = makeFakeSdk(behavior)
    const m = new ComposioSessionManager({ sdk, userId: 'local', toolkits: ['slack'] })
    await m.init()
    await m.addToolkit('gmail')
    expect(behavior.updated).toEqual({ toolkits: ['slack', 'gmail'] })
    expect(m.getToolkits()).toEqual(['slack', 'gmail'])
  })

  it('removeToolkit calls session.update with the remaining set', async () => {
    const behavior: any = {}
    const sdk = makeFakeSdk(behavior)
    const m = new ComposioSessionManager({ sdk, userId: 'local', toolkits: ['slack', 'gmail'] })
    await m.init()
    await m.removeToolkit('slack')
    expect(behavior.updated).toEqual({ toolkits: ['gmail'] })
  })

  it('getMcpUrl + getMcpHeaders before init throws', () => {
    const m = new ComposioSessionManager({ sdk: makeFakeSdk(), userId: 'local', toolkits: [] })
    expect(() => m.getMcpUrl()).toThrow(/init/)
    expect(() => m.getMcpHeaders()).toThrow(/init/)
  })

  it('CRITICAL: always passes workbench.enable: false to composio.create()', async () => {
    const behavior: any = {}
    const sdk = makeFakeSdk(behavior)
    const m = new ComposioSessionManager({ sdk, userId: 'local', toolkits: ['slack'] })
    await m.init()
    expect(behavior.lastCreateOpts.workbench).toEqual({ enable: false })
  })

  it('CRITICAL: passes manageConnections: true by default (enables in-chat auth)', async () => {
    const behavior: any = {}
    const sdk = makeFakeSdk(behavior)
    const m = new ComposioSessionManager({ sdk, userId: 'local', toolkits: ['slack'] })
    await m.init()
    expect(behavior.lastCreateOpts.manageConnections).toBe(true)
  })

  it('addToolkit is idempotent — duplicate slug does not call update', async () => {
    const behavior: any = {}
    const sdk = makeFakeSdk(behavior)
    const m = new ComposioSessionManager({ sdk, userId: 'local', toolkits: ['slack'] })
    await m.init()
    behavior.updated = undefined
    await m.addToolkit('slack')   // already in set
    expect(behavior.updated).toBeUndefined()
  })
})
