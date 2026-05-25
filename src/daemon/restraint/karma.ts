// src/daemon/restraint/karma.ts
// Per-trigger karma store. Every fire, delivery, dismissal, action gets recorded.
// Karma feeds into the action scorer (dismissal penalty) and auto-suspends triggers
// that the user has dismissed too many times recently.

import type { Database } from 'bun:sqlite'
import type { KarmaRecord, RestraintConfig } from './types'

export const KARMA_SCHEMA = `
  CREATE TABLE IF NOT EXISTS restraint_karma (
    trigger_id          TEXT PRIMARY KEY,
    fires               INTEGER NOT NULL DEFAULT 0,
    delivered           INTEGER NOT NULL DEFAULT 0,
    acted_on            INTEGER NOT NULL DEFAULT 0,
    dismissed           INTEGER NOT NULL DEFAULT 0,
    ignored             INTEGER NOT NULL DEFAULT 0,
    last_dismissed_at   INTEGER,
    last_acted_at       INTEGER,
    current_score       REAL NOT NULL DEFAULT 0.5,
    suspended_until     INTEGER
  );
  CREATE TABLE IF NOT EXISTS restraint_dismissal_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    trigger_id  TEXT NOT NULL,
    ts          INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_dismissal_recent ON restraint_dismissal_log(trigger_id, ts);
`

type CfgSubset = Pick<RestraintConfig, 'auto_suspend_after_dismissals' | 'dismissal_window_days'>

export class KarmaStore {
  constructor(private db: Database, private config: CfgSubset) {
    db.exec(KARMA_SCHEMA)
  }

  recordFire(triggerId: string): void {
    this.upsert(triggerId)
    this.db.run('UPDATE restraint_karma SET fires = fires + 1 WHERE trigger_id = ?', [triggerId])
  }

  recordDelivery(triggerId: string): void {
    this.upsert(triggerId)
    this.db.run('UPDATE restraint_karma SET delivered = delivered + 1 WHERE trigger_id = ?', [triggerId])
  }

  recordAction(triggerId: string): void {
    this.upsert(triggerId)
    this.db.run(
      'UPDATE restraint_karma SET acted_on = acted_on + 1, last_acted_at = ? WHERE trigger_id = ?',
      [Date.now(), triggerId],
    )
  }

  recordIgnored(triggerId: string): void {
    this.upsert(triggerId)
    this.db.run('UPDATE restraint_karma SET ignored = ignored + 1 WHERE trigger_id = ?', [triggerId])
  }

  recordDismissal(triggerId: string): void {
    this.recordDismissalAt(triggerId, Date.now())
  }

  recordDismissalAt(triggerId: string, ts: number): void {
    this.upsert(triggerId)
    this.db.run('INSERT INTO restraint_dismissal_log (trigger_id, ts) VALUES (?, ?)', [triggerId, ts])
    this.db.run(
      'UPDATE restraint_karma SET dismissed = dismissed + 1, last_dismissed_at = ? WHERE trigger_id = ?',
      [ts, triggerId],
    )
    this.maybeAutoSuspend(triggerId)
  }

  isSuspended(triggerId: string): boolean {
    const row = this.db.query(
      'SELECT suspended_until FROM restraint_karma WHERE trigger_id = ?',
    ).get(triggerId) as { suspended_until: number | null } | null
    if (!row || !row.suspended_until) return false
    return row.suspended_until > Date.now()
  }

  /** Dismissal penalty = 0.2 per dismissal in past N days, capped at 0.8 */
  dismissalPenalty(triggerId: string): number {
    const cutoff = Date.now() - this.config.dismissal_window_days * 24 * 3600_000
    const row = this.db.query(
      'SELECT COUNT(*) as n FROM restraint_dismissal_log WHERE trigger_id = ? AND ts > ?',
    ).get(triggerId, cutoff) as { n: number }
    return Math.min(0.8, row.n * 0.2)
  }

  get(triggerId: string): KarmaRecord | null {
    return this.db.query('SELECT * FROM restraint_karma WHERE trigger_id = ?').get(triggerId) as KarmaRecord | null
  }

  listSuspended(): string[] {
    const now = Date.now()
    const rows = this.db.query(
      'SELECT trigger_id FROM restraint_karma WHERE suspended_until IS NOT NULL AND suspended_until > ?',
    ).all(now) as Array<{ trigger_id: string }>
    return rows.map(r => r.trigger_id)
  }

  clearSuspension(triggerId: string): void {
    this.db.run('UPDATE restraint_karma SET suspended_until = NULL WHERE trigger_id = ?', [triggerId])
  }

  private upsert(triggerId: string): void {
    this.db.run(
      'INSERT OR IGNORE INTO restraint_karma (trigger_id) VALUES (?)',
      [triggerId],
    )
  }

  private maybeAutoSuspend(triggerId: string): void {
    const cutoff = Date.now() - this.config.dismissal_window_days * 24 * 3600_000
    const recent = (this.db.query(
      'SELECT COUNT(*) as n FROM restraint_dismissal_log WHERE trigger_id = ? AND ts > ?',
    ).get(triggerId, cutoff) as { n: number }).n

    if (recent < this.config.auto_suspend_after_dismissals) return

    // Safeguard 2: karma protection. If the trigger has been ACTED ON
    // enough times to justify continued firing, don't suspend even when
    // dismissal threshold is crossed. Net-valuable triggers must survive
    // sporadic dismissals.
    //
    // Rule: auto_suspend_if (dismissed_in_window >= 3) AND (acted_on_total < dismissed_in_window × 2)
    // i.e. if acted_on_total >= recent * 2 → high-value trigger, do NOT suspend.
    const k = this.get(triggerId)
    const actedOnTotal = k?.acted_on ?? 0
    if (actedOnTotal >= recent * 2) {
      // High-value trigger — don't suspend. Log a "reviewed" flag for
      // tuning visibility but allow continued firing.
      return
    }

    // Suspend for 7 days; user can manually clear via CLI/HUD/reactivation
    // prompt (Safeguard 4) surfaces in inbox.
    const suspendUntil = Date.now() + 7 * 24 * 3600_000
    this.db.run('UPDATE restraint_karma SET suspended_until = ? WHERE trigger_id = ?', [suspendUntil, triggerId])
  }
}
