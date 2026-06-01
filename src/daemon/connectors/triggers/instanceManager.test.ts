import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { TriggerInstanceManager } from './instanceManager'

function fakeComposio(state: { instances?: any[] } = {}) {
  const created: any[] = []
  const deleted: string[] = []
  return {
    composio: {
      triggers: {
        // Real Composio API shape: positional (userId, slug, body)
        create: async (userId: string, slug: string, body?: any) => {
          const id = 'ti_' + Math.random().toString(36).slice(2, 8)
          const inst = { triggerId: id, slug, userId, ...body }
          created.push(inst)
          ;(state.instances ??= []).push(inst)
          return { triggerId: id }
        },
        listActive: async () => ({ items: state.instances ?? [] }),
        delete: async (id: string) => { deleted.push(id); state.instances = (state.instances ?? []).filter((i: any) => i.triggerId !== id) },
      },
    },
    created, deleted,
  } as any
}

describe('TriggerInstanceManager', () => {
  let db: Database, mgr: TriggerInstanceManager, fake: ReturnType<typeof fakeComposio>

  beforeEach(() => {
    db = new Database(':memory:')
    fake = fakeComposio()
    mgr = new TriggerInstanceManager({ db, composio: fake.composio, userId: 'local' })
  })

  it('acquireForRule creates a new instance', async () => {
    const id = await mgr.acquireForRule('rule-a', 'GMAIL_NEW_GMAIL_MESSAGE', {}, 'ca_1')
    expect(id).toMatch(/^ti_/)
    expect(fake.created).toHaveLength(1)
  })

  it('acquireForRule reuses existing instance with same config', async () => {
    const id1 = await mgr.acquireForRule('rule-a', 'X', { repo: 'r' }, 'ca_1')
    const id2 = await mgr.acquireForRule('rule-b', 'X', { repo: 'r' }, 'ca_1')
    expect(id1).toBe(id2)
    expect(fake.created).toHaveLength(1)
  })

  it('acquireForRule creates separate instance for different config', async () => {
    const id1 = await mgr.acquireForRule('rule-a', 'X', { repo: 'r1' }, 'ca_1')
    const id2 = await mgr.acquireForRule('rule-b', 'X', { repo: 'r2' }, 'ca_1')
    expect(id1).not.toBe(id2)
  })

  it('refcount increments on acquire', async () => {
    await mgr.acquireForRule('a', 'X', {}, 'ca_1')
    await mgr.acquireForRule('b', 'X', {}, 'ca_1')
    const rows = mgr.listInstances()
    expect(rows[0]!.rule_count).toBe(2)
  })

  it('releaseForRule decrements; deletes instance at 0', async () => {
    const id = await mgr.acquireForRule('a', 'X', {}, 'ca_1')
    await mgr.releaseForRule('a', id)
    expect(fake.deleted).toContain(id)
    expect(mgr.listInstances()).toHaveLength(0)
  })

  it('releaseForRule keeps instance when refcount > 0', async () => {
    const id = await mgr.acquireForRule('a', 'X', {}, 'ca_1')
    await mgr.acquireForRule('b', 'X', {}, 'ca_1')
    await mgr.releaseForRule('a', id)
    expect(fake.deleted).toHaveLength(0)
    expect(mgr.listInstances()[0]!.rule_count).toBe(1)
  })

  it('reconcile detects orphaned local instances (deleted remotely)', async () => {
    await mgr.acquireForRule('a', 'X', {}, 'ca_1')
    fake.composio.triggers.listActive = async () => ({ items: [] })
    const report = await mgr.reconcile()
    expect(report.orphaned_local).toHaveLength(1)
  })

  it('reconcile detects orphaned remote instances (no local rules)', async () => {
    fake.composio.triggers.listActive = async () => ({ items: [{ triggerId: 'ti_remote', slug: 'X' }] })
    const report = await mgr.reconcile()
    expect(report.orphaned_remote).toContain('ti_remote')
    expect(fake.deleted).toContain('ti_remote')
  })

  it('reconcile reads the canonical `id` field from listActive (not triggerId)', async () => {
    // Per @composio/core@0.10.0 TriggerInstanceListActiveResponseItemSchema,
    // the trigger instance ID field is `id`, not `triggerId`. Earlier code
    // only checked triggerId/trigger_id, which silently classified ALL remote
    // triggers as orphans and tried to delete them.
    const localId = await mgr.acquireForRule('rule-a', 'X', {}, 'ca_1')
    fake.composio.triggers.listActive = async () => ({
      items: [
        { id: localId, slug: 'X', connectedAccountId: 'ca_1', state: 'active' }, // matches local
        { id: 'ti_other_remote', slug: 'Y', connectedAccountId: 'ca_1', state: 'active' }, // remote-only
      ],
    })
    const report = await mgr.reconcile()
    expect(report.orphaned_local).toEqual([]) // local is NOT orphaned — id matched
    expect(report.orphaned_remote).toEqual(['ti_other_remote'])
  })

  it('listRulesForInstance returns linked rule_slugs', async () => {
    const id = await mgr.acquireForRule('a', 'X', {}, 'ca_1')
    await mgr.acquireForRule('b', 'X', {}, 'ca_1')
    const rules = mgr.listRulesForInstance(id)
    expect(rules.sort()).toEqual(['a', 'b'])
  })

  it('config_hash is deterministic for equivalent configs (key order)', async () => {
    const id1 = await mgr.acquireForRule('a', 'X', { repo: 'r', owner: 'o' }, 'ca_1')
    const id2 = await mgr.acquireForRule('b', 'X', { owner: 'o', repo: 'r' }, 'ca_1')
    expect(id1).toBe(id2)
  })
})
