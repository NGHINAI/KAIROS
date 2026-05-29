// src/daemon/connectors/triggers/metrics.ts (STUB — Task 7 replaces)
import type { Database } from 'bun:sqlite'

const SCHEMA = `CREATE TABLE IF NOT EXISTS trigger_metrics_stub (n INTEGER);`

export class TriggerMetrics {
  constructor(db: Database) { db.exec(SCHEMA) }
  record(_toolkit: string, _rule_slug: string | null, _metric: string, _value: number): void {}
}
