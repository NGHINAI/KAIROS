import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { ConnectionStore } from './connectionStore'

describe('ConnectionStore', () => {
  let db: Database
  let store: ConnectionStore

  beforeEach(() => {
    db = new Database(':memory:')
    store = new ConnectionStore(db)
  })

  it('creates and retrieves a connection', () => {
    store.upsert({
      user_id: 'local', toolkit_slug: 'slack', connection_id: 'c_abc',
      auth_config_id: 'ac_slack', status: 'active', created_at: 1000,
    })
    const got = store.getByToolkit('local', 'slack')
    expect(got?.connection_id).toBe('c_abc')
    expect(got?.status).toBe('active')
  })

  it('upsert replaces existing connection for same (user, toolkit)', () => {
    store.upsert({ user_id: 'local', toolkit_slug: 'slack', connection_id: 'c_old', auth_config_id: 'ac', status: 'expired', created_at: 100 })
    store.upsert({ user_id: 'local', toolkit_slug: 'slack', connection_id: 'c_new', auth_config_id: 'ac', status: 'active', created_at: 200 })
    expect(store.listByUser('local').length).toBe(1)
    expect(store.getByToolkit('local', 'slack')?.connection_id).toBe('c_new')
  })

  it('listByUser returns only that user', () => {
    store.upsert({ user_id: 'a', toolkit_slug: 'slack', connection_id: 'c1', auth_config_id: 'ac', status: 'active', created_at: 1 })
    store.upsert({ user_id: 'b', toolkit_slug: 'gmail', connection_id: 'c2', auth_config_id: 'ac', status: 'active', created_at: 2 })
    expect(store.listByUser('a').map(c => c.toolkit_slug)).toEqual(['slack'])
    expect(store.listByUser('b').map(c => c.toolkit_slug)).toEqual(['gmail'])
  })

  it('markStatus updates only the status + timestamp', () => {
    store.upsert({ user_id: 'local', toolkit_slug: 'slack', connection_id: 'c', auth_config_id: 'ac', status: 'active', created_at: 1 })
    store.markStatus('local', 'slack', 'expired')
    const got = store.getByToolkit('local', 'slack')!
    expect(got.status).toBe('expired')
    expect(got.expired_at).toBeGreaterThan(0)
  })

  it('remove deletes the row', () => {
    store.upsert({ user_id: 'local', toolkit_slug: 'slack', connection_id: 'c', auth_config_id: 'ac', status: 'active', created_at: 1 })
    store.remove('local', 'slack')
    expect(store.getByToolkit('local', 'slack')).toBeNull()
  })

  it('listActive returns only status=active', () => {
    store.upsert({ user_id: 'local', toolkit_slug: 'slack', connection_id: 'c1', auth_config_id: 'ac', status: 'active', created_at: 1 })
    store.upsert({ user_id: 'local', toolkit_slug: 'gmail', connection_id: 'c2', auth_config_id: 'ac', status: 'expired', created_at: 2 })
    expect(store.listActive('local').map(c => c.toolkit_slug)).toEqual(['slack'])
  })
})
