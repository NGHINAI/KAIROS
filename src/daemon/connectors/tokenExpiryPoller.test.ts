import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { ConnectionStore } from './connectionStore'
import { TokenExpiryPoller } from './tokenExpiryPoller'

describe('TokenExpiryPoller', () => {
  let db: Database
  let store: ConnectionStore

  beforeEach(() => {
    db = new Database(':memory:')
    store = new ConnectionStore(db)
  })

  it('detects an active connection that dropped (missing in remote list)', async () => {
    store.upsert({ user_id: 'local', toolkit_slug: 'slack', connection_id: 'c1', auth_config_id: 'ac', status: 'active', created_at: 1 })
    const events: any[] = []
    const poller = new TokenExpiryPoller({
      composio: { listConnectedAccounts: async () => [] },
      connectionStore: store,
      onConnectionExpired: (c) => events.push(c),
      userId: 'local',
      intervalMs: 1000,
    })
    await poller.runOnce()
    expect(events.length).toBe(1)
    expect(events[0].toolkit_slug).toBe('slack')
    expect(store.getByToolkit('local', 'slack')?.status).toBe('expired')
  })

  it('does NOT mark expired when remote reports active', async () => {
    store.upsert({ user_id: 'local', toolkit_slug: 'slack', connection_id: 'c1', auth_config_id: 'ac', status: 'active', created_at: 1 })
    const events: any[] = []
    const poller = new TokenExpiryPoller({
      composio: { listConnectedAccounts: async () => [{ id: 'c1', toolkit_slug: 'slack', status: 'ACTIVE', auth_config_id: 'ac' }] },
      connectionStore: store,
      onConnectionExpired: (c) => events.push(c),
      userId: 'local',
      intervalMs: 1000,
    })
    await poller.runOnce()
    expect(events.length).toBe(0)
    expect(store.getByToolkit('local', 'slack')?.status).toBe('active')
  })

  it('updates last_polled_at timestamp for still-active connections', async () => {
    store.upsert({ user_id: 'local', toolkit_slug: 'slack', connection_id: 'c1', auth_config_id: 'ac', status: 'active', created_at: 1, last_polled_at: 1 })
    const poller = new TokenExpiryPoller({
      composio: { listConnectedAccounts: async () => [{ id: 'c1', toolkit_slug: 'slack', status: 'ACTIVE', auth_config_id: 'ac' }] },
      connectionStore: store, onConnectionExpired: () => {},
      userId: 'local', intervalMs: 1000,
    })
    await poller.runOnce()
    expect(store.getByToolkit('local', 'slack')!.last_polled_at).toBeGreaterThan(1)
  })

  it('start() + stop() can be called multiple times safely', async () => {
    const poller = new TokenExpiryPoller({
      composio: { listConnectedAccounts: async () => [] },
      connectionStore: store, onConnectionExpired: () => {},
      userId: 'local', intervalMs: 1_000_000,
    })
    poller.start()
    poller.start()
    poller.stop()
    poller.stop()
  })

  it('distinguishes revoked from expired', async () => {
    store.upsert({ user_id: 'local', toolkit_slug: 'slack', connection_id: 'c1', auth_config_id: 'ac', status: 'active', created_at: 1 })
    const events: any[] = []
    const poller = new TokenExpiryPoller({
      composio: { listConnectedAccounts: async () => [{ id: 'c1', toolkit_slug: 'slack', status: 'REVOKED', auth_config_id: 'ac' }] },
      connectionStore: store,
      onConnectionExpired: (c) => events.push(c),
      userId: 'local', intervalMs: 1000,
    })
    await poller.runOnce()
    expect(store.getByToolkit('local', 'slack')?.status).toBe('revoked')
  })
})
