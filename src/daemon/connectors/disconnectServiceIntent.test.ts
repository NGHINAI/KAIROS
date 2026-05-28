import { describe, it, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { ConnectionStore } from './connectionStore'
import { createDisconnectServiceIntent } from './disconnectServiceIntent'

function makeDeps(overrides: any = {}) {
  const db = new Database(':memory:')
  const store = new ConnectionStore(db)
  return {
    composio: { deleteConnection: async (_id: string) => {} },
    connectionStore: store,
    sessionManager: { removeToolkit: async (_slug: string) => {} },
    ...overrides,
  }
}

describe('disconnectServiceIntent', () => {
  it('has expected metadata (id=disconnect_service, tier=GREEN)', () => {
    const intent = createDisconnectServiceIntent(makeDeps() as any)
    expect(intent.id).toBe('disconnect_service')
    expect(intent.tier).toBe('GREEN')
  })

  it('throws when toolkit_slug is missing', async () => {
    const intent = createDisconnectServiceIntent(makeDeps() as any)
    await expect(intent.handler({} as any)).rejects.toThrow(/toolkit_slug/i)
  })

  it('returns ok=false when no active connection for that toolkit', async () => {
    const intent = createDisconnectServiceIntent(makeDeps() as any)
    const result = await intent.handler({ toolkit_slug: 'slack' })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/no active connection/i)
  })

  it('full pipeline: deleteConnection → store.remove → sessionManager.removeToolkit', async () => {
    const calls: string[] = []
    const deps = makeDeps({
      composio: { deleteConnection: async (id: string) => { calls.push('deleteConnection:' + id) } },
      sessionManager: { removeToolkit: async (slug: string) => { calls.push('removeToolkit:' + slug) } },
    })
    deps.connectionStore.upsert({
      user_id: 'local', toolkit_slug: 'slack', connection_id: 'c_abc',
      auth_config_id: 'ac', status: 'active', created_at: 1,
    })
    const intent = createDisconnectServiceIntent(deps as any)
    const result = await intent.handler({ toolkit_slug: 'slack' })
    expect(result.ok).toBe(true)
    expect(calls).toEqual(['deleteConnection:c_abc', 'removeToolkit:slack'])
    expect(deps.connectionStore.getByToolkit('local', 'slack')).toBeNull()
  })

  it('still removes local row if Composio deleteConnection fails (best-effort)', async () => {
    const deps = makeDeps({
      composio: { deleteConnection: async () => { throw new Error('NETWORK') } },
    })
    deps.connectionStore.upsert({
      user_id: 'local', toolkit_slug: 'slack', connection_id: 'c_abc',
      auth_config_id: 'ac', status: 'active', created_at: 1,
    })
    const intent = createDisconnectServiceIntent(deps as any)
    const result = await intent.handler({ toolkit_slug: 'slack' })
    // Local store no longer has a stale row pointing at a now-revoked Composio side
    expect(deps.connectionStore.getByToolkit('local', 'slack')).toBeNull()
  })
})
