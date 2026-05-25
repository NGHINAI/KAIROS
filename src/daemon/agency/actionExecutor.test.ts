// src/daemon/agency/actionExecutor.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { randomUUID } from 'crypto'
import { ActionExecutor, EXECUTOR_SCHEMA, type ActionContext } from './actionExecutor'
import { IntentRegistry } from './intentRegistry'
import { TrajectoryLog, TRAJECTORY_SCHEMA } from './trajectoryLog'
import { InboxSurface, INBOX_SCHEMA } from './inboxSurface'
import { NativeNotifier } from './nativeNotifier'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ActionRequest } from './types'

describe('ActionExecutor', () => {
  let db: Database
  let registry: IntentRegistry
  let traj: TrajectoryLog
  let inbox: InboxSurface
  let executor: ActionExecutor
  let tmp: string
  let ctx: ActionContext
  let notifyCalls: Array<{ title: string; body: string }>

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(TRAJECTORY_SCHEMA)
    db.exec(INBOX_SCHEMA)
    db.exec(EXECUTOR_SCHEMA)
    db.exec(`CREATE TABLE IF NOT EXISTS agency_scheduled_reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, body TEXT, fire_at INTEGER, fired INTEGER
    )`)
    db.exec(`CREATE TABLE IF NOT EXISTS agency_suspend_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT, until_ms INTEGER, reason TEXT
    )`)
    registry = new IntentRegistry()
    traj = new TrajectoryLog(db)
    tmp = mkdtempSync(join(tmpdir(), 'kairos-exec-'))
    inbox = new InboxSurface(db, join(tmp, 'inbox.md'))
    notifyCalls = []
    const notifier = new NativeNotifier({
      probe: async (args) => { notifyCalls.push(args) },
    })

    ctx = {
      db,
      notifier,
      embedder: { embed: async () => new Array(768).fill(0) } as any,
      semantic: { reinforceOrWrite: () => 1 } as any,
    }

    registry.register(
      { id: 'test-green', description: 'green test', tier: 'GREEN', argSchema: { msg: 'string' } },
      async (args, _ctx) => ({ status: 'success', details: `green: ${args.msg}` }),
    )
    registry.register(
      { id: 'test-orange', description: 'orange test', tier: 'ORANGE', argSchema: { msg: 'string' } },
      async (args, _ctx) => ({ status: 'success', details: `orange: ${args.msg}` }),
    )
    executor = new ActionExecutor(db, registry, traj, inbox, ctx)
  })

  function req(intent: string, args: Record<string, unknown>, reasoning = 'test'): ActionRequest {
    return {
      request_id: randomUUID(),
      intent_id: intent,
      args,
      reasoning,
      requested_at: Date.now(),
    }
  }

  it('executes GREEN actions immediately and writes a success trajectory', async () => {
    const result = await executor.dispatch(req('test-green', { msg: 'hi' }))
    expect(result.status).toBe('completed')
    expect(traj.recent(5).length).toBe(1)
    expect(traj.recent(5)[0]?.outcome).toBe('success')
    rmSync(tmp, { recursive: true })
  })

  it('queues ORANGE actions to inbox with status awaiting_approval', async () => {
    const result = await executor.dispatch(req('test-orange', { msg: 'maybe' }))
    expect(result.status).toBe('awaiting_approval')
    expect(inbox.pending().length).toBe(1)
    expect(inbox.pending()[0]?.tier).toBe('ORANGE')
    rmSync(tmp, { recursive: true })
  })

  it('returns failed when intent does not exist', async () => {
    const result = await executor.dispatch(req('nonexistent', {}))
    expect(result.status).toBe('failed')
    rmSync(tmp, { recursive: true })
  })

  it('dedupes within an idempotency window when intent provides a key', async () => {
    registry.register(
      { id: 'idem-green', description: 'idem', tier: 'GREEN', argSchema: { id: 'string' },
        idempotencyKey: (args) => `idem:${args.id}` },
      async () => ({ status: 'success', details: 'ok' }),
    )
    const r1 = await executor.dispatch(req('idem-green', { id: 'X' }))
    const r2 = await executor.dispatch(req('idem-green', { id: 'X' }))
    expect(r1.status).toBe('completed')
    expect(r2.status).toBe('completed')
    expect(r2.details).toMatch(/dedup/i)
    rmSync(tmp, { recursive: true })
  })

  it('approveItem causes a queued ORANGE action to execute', async () => {
    const result = await executor.dispatch(req('test-orange', { msg: 'now go' }))
    const itemId = result.inbox_item_id!
    const exec = await executor.approveItem(itemId)
    expect(exec.status).toBe('completed')
    expect(inbox.pending().length).toBe(0)
    rmSync(tmp, { recursive: true })
  })

  it('dismissItem cancels without execution', async () => {
    const result = await executor.dispatch(req('test-orange', { msg: 'nope' }))
    const itemId = result.inbox_item_id!
    await executor.dismissItem(itemId, 'user said no')
    expect(inbox.pending().length).toBe(0)
    const trajRows = traj.recent(5)
    const cancelled = trajRows.find(t => t.outcome === 'user_override')
    expect(cancelled?.override_reason).toBe('user said no')
    rmSync(tmp, { recursive: true })
  })

  it('REGRESSION C.1.5: restraint pipeline can suppress dispatch entirely', async () => {
    const fakePipeline = {
      evaluate: async () => ({ mode: 'suppressed' as const, score: null, reason: 'test suppression' }),
      recordDelivered: () => {},
    }
    const exec = new ActionExecutor(db, registry, traj, inbox, ctx, fakePipeline as any)
    const result = await exec.dispatch(req('test-green', { msg: 'hi' }))
    expect(result.status).toBe('suppressed')
    expect(notifyCalls.length).toBe(0)   // handler NOT called
    rmSync(tmp, { recursive: true })
  })

  it('REGRESSION C.1.5: restraint dry_run skips handler but records trajectory', async () => {
    const fakePipeline = {
      evaluate: async () => ({ mode: 'dry_run' as const, score: null, reason: 'in observation window' }),
      recordDelivered: () => {},
    }
    const exec = new ActionExecutor(db, registry, traj, inbox, ctx, fakePipeline as any)
    const result = await exec.dispatch(req('test-green', { msg: 'hi' }))
    expect(result.status).toBe('dry_run')
    expect(notifyCalls.length).toBe(0)
    // Trajectory should still be recorded
    const trajRows = traj.recent(5)
    expect(trajRows.length).toBeGreaterThanOrEqual(1)
    rmSync(tmp, { recursive: true })
  })
})
