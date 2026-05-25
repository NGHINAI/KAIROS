// src/daemon/restraint/digestComposer.ts
import type { Database } from 'bun:sqlite'
import type { Digest } from './types'
import type { AutonomyTier } from '../agency/types'

export const DIGEST_SCHEMA = `
  CREATE TABLE IF NOT EXISTS restraint_digest_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    slot        TEXT NOT NULL,
    request_id  TEXT NOT NULL,
    title       TEXT NOT NULL,
    summary     TEXT NOT NULL,
    tier        TEXT NOT NULL,
    queued_at   INTEGER NOT NULL,
    delivered_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_digest_pending ON restraint_digest_items(slot, delivered_at);
`

export type DigestItemInput = {
  request_id: string
  title: string
  summary: string
  tier: AutonomyTier
}

export class DigestComposer {
  constructor(private db: Database) {
    db.exec(DIGEST_SCHEMA)
  }

  queue(slot: 'morning' | 'lunch' | 'evening', item: DigestItemInput): void {
    this.db.run(
      `INSERT INTO restraint_digest_items (slot, request_id, title, summary, tier, queued_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [slot, item.request_id, item.title, item.summary, item.tier, Date.now()],
    )
  }

  pendingFor(slot: 'morning' | 'lunch' | 'evening'): Array<DigestItemInput & { queued_at: number }> {
    const rows = this.db.query(
      `SELECT request_id, title, summary, tier, queued_at FROM restraint_digest_items
       WHERE slot = ? AND delivered_at IS NULL`,
    ).all(slot) as Array<DigestItemInput & { queued_at: number }>
    return rows
  }

  flush(slot: 'morning' | 'lunch' | 'evening'): Digest | null {
    const items = this.pendingFor(slot)
    if (items.length === 0) return null

    const now = Date.now()
    this.db.run(
      'UPDATE restraint_digest_items SET delivered_at = ? WHERE slot = ? AND delivered_at IS NULL',
      [now, slot],
    )

    return {
      slot,
      scheduled_for: now,
      items: items.map(i => ({
        request_id: i.request_id,
        title: i.title,
        summary: i.summary,
        tier: i.tier,
        queued_at: i.queued_at,
      })),
      delivered_at: now,
    }
  }
}
