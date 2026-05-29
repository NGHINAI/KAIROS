// src/daemon/connectors/triggers/eventLog.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { TriggerEventLog } from './eventLog'
import type { NormalizedEvent } from './types'

function mkEvent(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    trigger_slug: 'GMAIL_NEW_GMAIL_MESSAGE',
    toolkit: 'gmail',
    payload: { from: 'a@b.c', subject: 'hi' },
    raw: { id: '1', from: 'a@b.c', subject: 'hi' },
    received_at: Date.now(),
    event_id: 'evt-1',
    ...overrides,
  }
}

describe('TriggerEventLog', () => {
  let db: Database, log: TriggerEventLog

  beforeEach(() => {
    db = new Database(':memory:')
    log = new TriggerEventLog(db)
  })

  it('record returns true for new event', () => {
    expect(log.record(mkEvent())).toBe(true)
  })

  it('record returns false for duplicate (idempotent)', () => {
    log.record(mkEvent())
    expect(log.record(mkEvent())).toBe(false)
  })

  it('different toolkit + same event_id allowed', () => {
    log.record(mkEvent({ toolkit: 'gmail', event_id: 'x' }))
    expect(log.record(mkEvent({ toolkit: 'slack', event_id: 'x' }))).toBe(true)
  })

  it('markProcessed updates status + processed_at', () => {
    log.record(mkEvent())
    log.markProcessed('gmail', 'evt-1')
    const rows = log.listAll()
    expect(rows[0]!.status).toBe('processed')
    expect(rows[0]!.processed_at).toBeGreaterThan(0)
  })

  it('markFailed updates status + last_error', () => {
    log.record(mkEvent())
    log.markFailed('gmail', 'evt-1', 'router crashed')
    const rows = log.listAll()
    expect(rows[0]!.status).toBe('failed')
    expect(rows[0]!.last_error).toBe('router crashed')
  })

  it('listUnprocessed returns received rows in order', () => {
    log.record(mkEvent({ event_id: 'a', received_at: 100 }))
    log.record(mkEvent({ event_id: 'b', received_at: 200 }))
    log.markProcessed('gmail', 'a')
    const u = log.listUnprocessed(10)
    expect(u).toHaveLength(1)
    expect(u[0]!.event_id).toBe('b')
  })

  it('prune deletes processed rows older than threshold', () => {
    log.record(mkEvent({ event_id: 'a', received_at: 100 }))
    log.markProcessed('gmail', 'a')
    log.record(mkEvent({ event_id: 'b', received_at: Date.now() }))
    log.markProcessed('gmail', 'b')
    const deleted = log.prune(Date.now() - 1000)
    expect(deleted).toBe(1)
  })

  it('persists across new Database connections (file-backed)', async () => {
    const { mkdtempSync } = await import('fs')
    const { tmpdir } = await import('os')
    const { join } = await import('path')
    const tmp = mkdtempSync(join(tmpdir(), 'tel-'))
    const path = join(tmp, 'db.sqlite')
    const dbA = new Database(path)
    const logA = new TriggerEventLog(dbA)
    logA.record(mkEvent({ event_id: 'pers' }))
    dbA.close()
    const dbB = new Database(path)
    const logB = new TriggerEventLog(dbB)
    expect(logB.listAll()).toHaveLength(1)
    dbB.close()
  })
})
