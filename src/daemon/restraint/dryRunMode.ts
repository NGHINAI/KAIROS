// src/daemon/restraint/dryRunMode.ts
// New STANDING_ORDER triggers run in observation-only mode for 24h. Counts
// would-have-fired events. After 24h, prompts user with the count before
// going live. Prevents "added a rule, got 100 notifications" surprises.

import type { Database } from 'bun:sqlite'
import type { DryRunRecord, RestraintConfig } from './types'

export const DRY_RUN_SCHEMA = `
  CREATE TABLE IF NOT EXISTS restraint_dry_run (
    trigger_id              TEXT PRIMARY KEY,
    started_at              INTEGER NOT NULL,
    ends_at                 INTEGER NOT NULL,
    would_have_fired_count  INTEGER NOT NULL DEFAULT 0,
    sample_events_json      TEXT NOT NULL DEFAULT '[]',
    promoted_at             INTEGER,
    rejected_at             INTEGER
  );
`

type CfgSubset = Pick<RestraintConfig, 'dry_run_duration_hours'>

export class DryRunMode {
  constructor(private db: Database, private config: CfgSubset) {
    db.exec(DRY_RUN_SCHEMA)
  }

  register(triggerId: string): void {
    const now = Date.now()
    this.db.run(
      `INSERT OR IGNORE INTO restraint_dry_run (trigger_id, started_at, ends_at)
       VALUES (?, ?, ?)`,
      [triggerId, now, now + this.config.dry_run_duration_hours * 3600_000],
    )
  }

  isInDryRun(triggerId: string): boolean {
    const row = this.db.query(
      'SELECT ends_at, promoted_at FROM restraint_dry_run WHERE trigger_id = ?',
    ).get(triggerId) as { ends_at: number; promoted_at: number | null } | null
    if (!row || row.promoted_at) return false
    return row.ends_at > Date.now()
  }

  recordWouldFire(triggerId: string, eventSummary: string): void {
    const row = this.db.query(
      'SELECT sample_events_json FROM restraint_dry_run WHERE trigger_id = ?',
    ).get(triggerId) as { sample_events_json: string } | null
    if (!row) return
    const samples = JSON.parse(row.sample_events_json) as string[]
    if (samples.length < 5) samples.push(eventSummary)
    this.db.run(
      `UPDATE restraint_dry_run SET would_have_fired_count = would_have_fired_count + 1, sample_events_json = ? WHERE trigger_id = ?`,
      [JSON.stringify(samples), triggerId],
    )
  }

  get(triggerId: string): DryRunRecord | null {
    const row = this.db.query('SELECT * FROM restraint_dry_run WHERE trigger_id = ?').get(triggerId) as
      { trigger_id: string; started_at: number; ends_at: number;
        would_have_fired_count: number; sample_events_json: string } | null
    if (!row) return null
    return {
      trigger_id: row.trigger_id,
      started_at: row.started_at,
      ends_at: row.ends_at,
      would_have_fired_count: row.would_have_fired_count,
      sample_events: JSON.parse(row.sample_events_json),
    }
  }

  /** Triggers whose dry-run window expired but haven't been promoted/rejected yet. */
  completed(): DryRunRecord[] {
    const now = Date.now()
    const rows = this.db.query(
      `SELECT * FROM restraint_dry_run
       WHERE ends_at < ? AND promoted_at IS NULL AND rejected_at IS NULL`,
    ).all(now) as Array<{ trigger_id: string; started_at: number; ends_at: number;
        would_have_fired_count: number; sample_events_json: string }>
    return rows.map(r => ({
      trigger_id: r.trigger_id, started_at: r.started_at, ends_at: r.ends_at,
      would_have_fired_count: r.would_have_fired_count,
      sample_events: JSON.parse(r.sample_events_json),
    }))
  }

  promote(triggerId: string): void {
    this.db.run('UPDATE restraint_dry_run SET promoted_at = ? WHERE trigger_id = ?', [Date.now(), triggerId])
  }

  reject(triggerId: string): void {
    this.db.run('UPDATE restraint_dry_run SET rejected_at = ? WHERE trigger_id = ?', [Date.now(), triggerId])
  }
}
