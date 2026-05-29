// src/daemon/orders/v2/pendingEdits.ts
// SQLite-backed queue of speech edits that failed to compile (LLM unreachable).
// Processor retries periodically with exponential backoff. After max retries,
// row is marked 'failed' and surfaced to the user via the inbox.

import type { Database } from 'bun:sqlite'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS orders_pending_edits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  speech TEXT NOT NULL,
  enqueued_at INTEGER NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER NOT NULL,
  last_error TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS idx_pending_status ON orders_pending_edits(status, next_retry_at);
`

export const MAX_RETRIES = 10
export const BASE_RETRY_DELAY_MS = 5 * 60 * 1000          // 5 min
export const MAX_RETRY_DELAY_MS = 60 * 60 * 1000          // 1 hour cap
export const MAX_PENDING_ROWS = 50

export type PendingRow = {
  id: number
  speech: string
  enqueued_at: number
  retry_count: number
  next_retry_at: number
  last_error?: string
  status: 'pending' | 'failed' | 'done'
}

export type PendingEditsQueueOpts = { now?: () => number }

export class PendingEditsQueue {
  private now: () => number
  constructor(private db: Database, opts: PendingEditsQueueOpts = {}) {
    db.exec(SCHEMA)
    this.now = opts.now ?? Date.now
  }

  enqueue(speech: string): number {
    const t = this.now()
    const r = this.db.run(
      `INSERT INTO orders_pending_edits (speech, enqueued_at, next_retry_at) VALUES (?, ?, ?)`,
      [speech, t, t + BASE_RETRY_DELAY_MS],
    )
    return Number(r.lastInsertRowid)
  }

  listReadyForRetry(now: number = this.now()): PendingRow[] {
    const rows = this.db.query(
      `SELECT * FROM orders_pending_edits WHERE status = 'pending' AND next_retry_at <= ? ORDER BY enqueued_at LIMIT 10`,
    ).all(now) as any[]
    return rows.map(this.rowFromDb)
  }

  listAll(): PendingRow[] {
    const rows = this.db.query(`SELECT * FROM orders_pending_edits ORDER BY enqueued_at`).all() as any[]
    return rows.map(this.rowFromDb)
  }

  markRetried(id: number, error: string, baseTime: number = this.now()): void {
    const row = this.db.query(`SELECT * FROM orders_pending_edits WHERE id = ?`).get(id) as any
    if (!row) return
    const nextCount = row.retry_count + 1
    if (nextCount >= MAX_RETRIES) {
      this.db.run(
        `UPDATE orders_pending_edits SET retry_count = ?, last_error = ?, status = 'failed' WHERE id = ?`,
        [nextCount, error, id],
      )
      return
    }
    const backoff = Math.min(MAX_RETRY_DELAY_MS, BASE_RETRY_DELAY_MS * Math.pow(2, nextCount))
    this.db.run(
      `UPDATE orders_pending_edits SET retry_count = ?, last_error = ?, next_retry_at = ? WHERE id = ?`,
      [nextCount, error, baseTime + backoff, id],
    )
  }

  markDone(id: number): void {
    this.db.run(`UPDATE orders_pending_edits SET status = 'done' WHERE id = ?`, [id])
  }

  enforceCapacityCap(max: number = MAX_PENDING_ROWS): void {
    const count = (this.db.query(`SELECT COUNT(*) AS n FROM orders_pending_edits WHERE status = 'pending'`).get() as { n: number }).n
    if (count <= max) return
    const overflow = count - max
    const ids = this.db.query(
      `SELECT id FROM orders_pending_edits WHERE status = 'pending' ORDER BY enqueued_at ASC LIMIT ?`,
    ).all(overflow) as Array<{ id: number }>
    for (const r of ids) this.db.run(`DELETE FROM orders_pending_edits WHERE id = ?`, [r.id])
  }

  private rowFromDb = (r: any): PendingRow => ({
    id: r.id,
    speech: r.speech,
    enqueued_at: r.enqueued_at,
    retry_count: r.retry_count,
    next_retry_at: r.next_retry_at,
    last_error: r.last_error ?? undefined,
    status: r.status,
  })
}
