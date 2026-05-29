// src/daemon/connectors/triggers/metrics.ts
// Per-minute-bucket aggregated metrics. Latency observations stored individually
// (one row per observed value) so percentiles work.

import type { Database } from 'bun:sqlite'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS trigger_metrics (
  toolkit TEXT NOT NULL,
  rule_slug TEXT,
  metric TEXT NOT NULL,
  value INTEGER NOT NULL,
  bucket_start INTEGER NOT NULL,
  PRIMARY KEY (toolkit, rule_slug, metric, bucket_start)
);
CREATE INDEX IF NOT EXISTS idx_trigger_metrics_time ON trigger_metrics(bucket_start, metric);
`

export type MetricsRow = {
  toolkit: string
  rule_slug: string | null
  metric: string
  value: number
  bucket_start: number
}

const BUCKET_MS = 60 * 1000

export class TriggerMetrics {
  constructor(private db: Database) {
    db.exec(SCHEMA)
  }

  record(toolkit: string, rule_slug: string | null, metric: string, value: number): void {
    const bucket = Math.floor(Date.now() / BUCKET_MS) * BUCKET_MS
    if (metric === 'latency_ms') {
      // One row per latency observation, keyed by value, so we can compute percentiles
      const metricKey = `latency_ms:${value}`
      this.db.run(
        `INSERT INTO trigger_metrics (toolkit, rule_slug, metric, value, bucket_start)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(toolkit, rule_slug, metric, bucket_start) DO UPDATE SET value = trigger_metrics.value + 1`,
        [toolkit, rule_slug, metricKey, 1, bucket],
      )
    } else {
      this.db.run(
        `INSERT INTO trigger_metrics (toolkit, rule_slug, metric, value, bucket_start)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(toolkit, rule_slug, metric, bucket_start) DO UPDATE SET value = trigger_metrics.value + ?`,
        [toolkit, rule_slug, metric, value, bucket, value],
      )
    }
  }

  query(opts: { from: number; to: number; metric?: string; toolkit?: string }): MetricsRow[] {
    let q = `SELECT toolkit, rule_slug, metric, value, bucket_start FROM trigger_metrics WHERE bucket_start >= ? AND bucket_start <= ?`
    const args: any[] = [opts.from, opts.to]
    if (opts.metric) { q += ` AND metric = ?`; args.push(opts.metric) }
    if (opts.toolkit) { q += ` AND toolkit = ?`; args.push(opts.toolkit) }
    q += ` ORDER BY bucket_start`
    const rows = this.db.query(q).all(...args) as any[]
    return rows.map(r => ({ ...r, rule_slug: r.rule_slug ?? null }))
  }

  percentiles(metric: string, opts: { from: number; to: number; toolkit?: string }): { p50: number; p99: number } {
    let q = `SELECT metric, value FROM trigger_metrics WHERE bucket_start >= ? AND bucket_start <= ? AND metric LIKE ?`
    const args: any[] = [opts.from, opts.to, metric + ':%']
    if (opts.toolkit) { q += ` AND toolkit = ?`; args.push(opts.toolkit) }
    const rows = this.db.query(q).all(...args) as Array<{ metric: string; value: number }>
    const values: number[] = []
    for (const r of rows) {
      const v = parseFloat(r.metric.split(':')[1] ?? '0')
      // Each row represents `r.value` observations of latency `v`
      for (let i = 0; i < r.value; i++) values.push(v)
    }
    values.sort((a, b) => a - b)
    if (values.length === 0) return { p50: 0, p99: 0 }
    const p50 = values[Math.floor(values.length * 0.5)] ?? 0
    const p99 = values[Math.floor(values.length * 0.99)] ?? 0
    return { p50, p99 }
  }
}
