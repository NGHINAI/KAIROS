// src/daemon/connectors/triggers/eventLog.ts
// SQLite-backed event log with idempotency via UNIQUE(toolkit, event_id).
// Boot-time replay supported via listUnprocessed.

import type { Database } from 'bun:sqlite'
import type { NormalizedEvent } from './types'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS composio_trigger_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  toolkit TEXT NOT NULL,
  trigger_slug TEXT NOT NULL,
  event_id TEXT NOT NULL,
  connected_account_id TEXT,
  user_id TEXT,
  raw_payload TEXT NOT NULL,
  payload TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  processed_at INTEGER,
  failed_at INTEGER,
  last_error TEXT,
  status TEXT NOT NULL DEFAULT 'received',
  UNIQUE(toolkit, event_id)
);
CREATE INDEX IF NOT EXISTS idx_trigger_events_status ON composio_trigger_events(status, received_at);
`

export type EventLogRow = NormalizedEvent & {
  id: number
  status: 'received' | 'processed' | 'failed'
  processed_at?: number
  failed_at?: number
  last_error?: string
}

export class TriggerEventLog {
  constructor(private db: Database) {
    db.exec(SCHEMA)
  }

  /** Returns true if newly inserted; false if duplicate (idempotent). */
  record(env: NormalizedEvent): boolean {
    try {
      this.db.run(
        `INSERT INTO composio_trigger_events
         (toolkit, trigger_slug, event_id, connected_account_id, user_id, raw_payload, payload, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [env.toolkit, env.trigger_slug, env.event_id, env.connected_account_id ?? null,
         env.user_id ?? null, JSON.stringify(env.raw), JSON.stringify(env.payload), env.received_at],
      )
      return true
    } catch (err) {
      if (String(err).includes('UNIQUE')) return false
      throw err
    }
  }

  markProcessed(toolkit: string, event_id: string): void {
    this.db.run(
      `UPDATE composio_trigger_events SET status = 'processed', processed_at = ? WHERE toolkit = ? AND event_id = ?`,
      [Date.now(), toolkit, event_id],
    )
  }

  markFailed(toolkit: string, event_id: string, error: string): void {
    this.db.run(
      `UPDATE composio_trigger_events SET status = 'failed', failed_at = ?, last_error = ? WHERE toolkit = ? AND event_id = ?`,
      [Date.now(), error.slice(0, 500), toolkit, event_id],
    )
  }

  listUnprocessed(limit: number): EventLogRow[] {
    const rows = this.db.query(
      `SELECT * FROM composio_trigger_events WHERE status = 'received' ORDER BY received_at LIMIT ?`,
    ).all(limit) as any[]
    return rows.map(this.rowFromDb)
  }

  listAll(): EventLogRow[] {
    const rows = this.db.query(`SELECT * FROM composio_trigger_events ORDER BY received_at`).all() as any[]
    return rows.map(this.rowFromDb)
  }

  prune(olderThan: number): number {
    const r = this.db.run(
      `DELETE FROM composio_trigger_events WHERE status = 'processed' AND received_at < ?`,
      [olderThan],
    )
    return Number(r.changes ?? 0)
  }

  private rowFromDb = (r: any): EventLogRow => ({
    id: r.id,
    toolkit: r.toolkit,
    trigger_slug: r.trigger_slug,
    event_id: r.event_id,
    connected_account_id: r.connected_account_id ?? undefined,
    user_id: r.user_id ?? undefined,
    raw: JSON.parse(r.raw_payload),
    payload: JSON.parse(r.payload),
    received_at: r.received_at,
    status: r.status,
    processed_at: r.processed_at ?? undefined,
    failed_at: r.failed_at ?? undefined,
    last_error: r.last_error ?? undefined,
  })
}
