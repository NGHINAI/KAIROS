// src/daemon/restraint/rateLimiter.ts
import type { Database } from 'bun:sqlite'
import type { RestraintConfig, DeliveryMode } from './types'

export const RATE_LIMITER_SCHEMA = `
  CREATE TABLE IF NOT EXISTS restraint_delivery_log (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    mode  TEXT NOT NULL,
    ts    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_delivery_log_ts ON restraint_delivery_log(ts, mode);
`

type CfgSubset = Pick<RestraintConfig,
  'max_interrupts_per_day' | 'max_interrupts_per_hour' | 'max_surfaces_per_hour'>

export class RateLimiter {
  constructor(private db: Database, private config: CfgSubset) {
    db.exec(RATE_LIMITER_SCHEMA)
  }

  canDeliver(mode: DeliveryMode, urgent: boolean): boolean {
    if (urgent) return true
    if (mode === 'log_only' || mode === 'dry_run' || mode === 'suppressed') return true
    if (mode === 'digest') return true  // digest path has its own scheduling, not capped here

    const now = Date.now()
    const oneHourAgo = now - 3600_000
    const oneDayAgo = now - 24 * 3600_000

    if (mode === 'interrupt') {
      const dayCount = this.count('interrupt', oneDayAgo)
      if (dayCount >= this.config.max_interrupts_per_day) return false
      const hourCount = this.count('interrupt', oneHourAgo)
      if (hourCount >= this.config.max_interrupts_per_hour) return false
    } else if (mode === 'surface') {
      const hourCount = this.count('surface', oneHourAgo)
      if (hourCount >= this.config.max_surfaces_per_hour) return false
    }

    return true
  }

  recordDelivery(mode: DeliveryMode): void {
    this.db.run('INSERT INTO restraint_delivery_log (mode, ts) VALUES (?, ?)', [mode, Date.now()])
  }

  private count(mode: string, sinceTs: number): number {
    return (this.db.query(
      'SELECT COUNT(*) as n FROM restraint_delivery_log WHERE mode = ? AND ts > ?',
    ).get(mode, sinceTs) as { n: number }).n
  }
}
