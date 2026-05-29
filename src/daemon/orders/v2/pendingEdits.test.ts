import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { PendingEditsQueue } from './pendingEdits'

describe('PendingEditsQueue', () => {
  let db: Database
  let q: PendingEditsQueue

  beforeEach(() => {
    db = new Database(':memory:')
    q = new PendingEditsQueue(db, { now: () => 1_000_000 })
  })

  it('enqueue creates a pending row', () => {
    const id = q.enqueue('remind me at 5pm')
    expect(id).toBeGreaterThan(0)
    const rows = q.listReadyForRetry(1_000_001)
    expect(rows).toHaveLength(0)   // next_retry_at = enqueued + 5min, not yet ready
  })

  it('listReadyForRetry returns rows whose next_retry_at <= now', () => {
    q.enqueue('a')
    const fiveMinLater = 1_000_000 + 5 * 60 * 1000
    const rows = q.listReadyForRetry(fiveMinLater)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.speech).toBe('a')
  })

  it('markRetried records error + applies exponential backoff', () => {
    const id = q.enqueue('b')
    q.markRetried(id, 'LLM 500', 1_000_000 + 5 * 60 * 1000)
    const rows = q.listAll()
    expect(rows[0]!.retry_count).toBe(1)
    expect(rows[0]!.last_error).toBe('LLM 500')
    // Backoff: 5min * 2^1 = 10min
    expect(rows[0]!.next_retry_at).toBe(1_000_000 + 5 * 60 * 1000 + 10 * 60 * 1000)
  })

  it('backoff caps at 1 hour', () => {
    const id = q.enqueue('c')
    // Force retry_count high to trigger cap
    for (let i = 0; i < 10; i++) q.markRetried(id, 'fail', 1_000_000)
    const row = q.listAll()[0]!
    expect(row.next_retry_at - 1_000_000).toBeLessThanOrEqual(60 * 60 * 1000 + 1)
  })

  it('markRetried at retry_count >= 10 sets status=failed', () => {
    const id = q.enqueue('d')
    for (let i = 0; i < 10; i++) q.markRetried(id, 'fail', 1_000_000)
    const row = q.listAll()[0]!
    expect(row.status).toBe('failed')
  })

  it('markDone marks row done (no longer pending)', () => {
    const id = q.enqueue('e')
    q.markDone(id)
    const rows = q.listAll().filter(r => r.status === 'pending')
    expect(rows).toHaveLength(0)
  })

  it('persists across new Database connections (file-backed)', async () => {
    const { mkdtempSync } = await import('fs')
    const { tmpdir } = await import('os')
    const { join } = await import('path')
    const tmp = mkdtempSync(join(tmpdir(), 'pending-edits-'))
    const path = join(tmp, 'd.sqlite')
    const dbA = new Database(path)
    const qA = new PendingEditsQueue(dbA, { now: () => 1_000_000 })
    qA.enqueue('persistent')
    dbA.close()
    const dbB = new Database(path)
    const qB = new PendingEditsQueue(dbB, { now: () => 1_000_000 })
    expect(qB.listAll()).toHaveLength(1)
    expect(qB.listAll()[0]!.speech).toBe('persistent')
    dbB.close()
  })

  it('cap: when > 50 pending rows, oldest pending is dropped', () => {
    for (let i = 0; i < 52; i++) q.enqueue(`speech-${i}`)
    q.enforceCapacityCap(50)
    expect(q.listAll().length).toBeLessThanOrEqual(50)
    const speeches = q.listAll().map(r => r.speech)
    expect(speeches).not.toContain('speech-0')
    expect(speeches).not.toContain('speech-1')
    expect(speeches).toContain('speech-51')
  })
})
