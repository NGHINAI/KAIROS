// src/daemon/llm/costTracker.ts
// Persistent per-provider cost + cache ledger. Lives in the main daemon DB.
// Every CompletionResult is recorded; aggregate rollups answer
// "are we over budget?", "what's the cache hit rate?", and "which provider is consuming the most?".

import type { Database } from 'bun:sqlite'
import type { ProviderId, TaskType } from './types'

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS llm_call_log (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts                      INTEGER NOT NULL,
    provider                TEXT    NOT NULL,
    model                   TEXT    NOT NULL,
    task_type               TEXT    NOT NULL,
    input_tokens            INTEGER NOT NULL,
    output_tokens           INTEGER NOT NULL,
    cached_input_tokens     INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens   INTEGER NOT NULL DEFAULT 0,
    cost_cents              INTEGER NOT NULL,
    fallback_count          INTEGER NOT NULL DEFAULT 0,
    latency_ms              INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_llm_call_log_ts ON llm_call_log(ts);
  CREATE INDEX IF NOT EXISTS idx_llm_call_log_provider ON llm_call_log(provider, ts);
`

export type CostRecord = {
  provider: ProviderId
  model: string
  input_tokens: number
  output_tokens: number
  cost_cents: number
  task_type: TaskType
  fallback_count?: number
  latency_ms?: number
  cached_input_tokens?: number
  cache_creation_tokens?: number
}

export type Summary = {
  total_calls: number
  total_input_tokens: number
  total_output_tokens: number
  total_cached_tokens: number
  cache_hit_rate: number       // 0..1
  total_cost_cents: number
}

export class CostTracker {
  constructor(
    private db: Database,
    private monthlyBudgetUsd: number,
  ) {
    db.exec(SCHEMA)
  }

  record(r: CostRecord): void {
    this.db.run(
      `INSERT INTO llm_call_log
         (ts, provider, model, task_type, input_tokens, output_tokens, cached_input_tokens, cache_creation_tokens, cost_cents, fallback_count, latency_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        Date.now(),
        r.provider,
        r.model,
        r.task_type,
        r.input_tokens,
        r.output_tokens,
        r.cached_input_tokens ?? 0,
        r.cache_creation_tokens ?? 0,
        r.cost_cents,
        r.fallback_count ?? 0,
        r.latency_ms ?? null,
      ],
    )
  }

  monthlyCostCents(): number {
    const since = this.monthStartMs()
    const row = this.db
      .query('SELECT COALESCE(SUM(cost_cents), 0) AS total FROM llm_call_log WHERE ts >= ?')
      .get(since) as { total: number }
    return row.total
  }

  monthlyCostByProvider(): Record<string, number> {
    const since = this.monthStartMs()
    const rows = this.db
      .query('SELECT provider, COALESCE(SUM(cost_cents),0) AS total FROM llm_call_log WHERE ts >= ? GROUP BY provider')
      .all(since) as Array<{ provider: string; total: number }>
    return Object.fromEntries(rows.map(r => [r.provider, r.total]))
  }

  isOverBudget(): boolean {
    return this.monthlyCostCents() >= this.monthlyBudgetUsd * 100
  }

  /** Returns aggregated metrics for calls in the given window (milliseconds from now). */
  summaryFor(opts: { window_ms: number }): Summary {
    const since = Date.now() - opts.window_ms
    const row = this.db
      .query(`
        SELECT
          COUNT(*) AS total_calls,
          COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
          COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
          COALESCE(SUM(cached_input_tokens), 0) AS total_cached_tokens,
          COALESCE(SUM(cost_cents), 0) AS total_cost_cents
        FROM llm_call_log WHERE ts >= ?
      `)
      .get(since) as {
        total_calls: number
        total_input_tokens: number
        total_output_tokens: number
        total_cached_tokens: number
        total_cost_cents: number
      }

    const cache_hit_rate = row.total_input_tokens > 0
      ? row.total_cached_tokens / row.total_input_tokens
      : 0

    return {
      total_calls: row.total_calls,
      total_input_tokens: row.total_input_tokens,
      total_output_tokens: row.total_output_tokens,
      total_cached_tokens: row.total_cached_tokens,
      cache_hit_rate,
      total_cost_cents: row.total_cost_cents,
    }
  }

  /** Returns per-provider summaries for calls in the given window. */
  summaryByProvider(opts: { window_ms: number }): Record<string, Summary> {
    const since = Date.now() - opts.window_ms
    const rows = this.db
      .query(`
        SELECT
          provider,
          COUNT(*) AS total_calls,
          COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
          COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
          COALESCE(SUM(cached_input_tokens), 0) AS total_cached_tokens,
          COALESCE(SUM(cost_cents), 0) AS total_cost_cents
        FROM llm_call_log WHERE ts >= ?
        GROUP BY provider
      `)
      .all(since) as Array<{
        provider: string
        total_calls: number
        total_input_tokens: number
        total_output_tokens: number
        total_cached_tokens: number
        total_cost_cents: number
      }>

    return Object.fromEntries(rows.map(row => [
      row.provider,
      {
        total_calls: row.total_calls,
        total_input_tokens: row.total_input_tokens,
        total_output_tokens: row.total_output_tokens,
        total_cached_tokens: row.total_cached_tokens,
        cache_hit_rate: row.total_input_tokens > 0
          ? row.total_cached_tokens / row.total_input_tokens
          : 0,
        total_cost_cents: row.total_cost_cents,
      },
    ]))
  }

  /** Projects monthly cost (in cents) from the last 24 hours of activity.
   *  Returns 0 if no activity in the past 24h.
   */
  projectedMonthlyCost(): number {
    const dailySummary = this.summaryFor({ window_ms: 24 * 60 * 60 * 1000 })
    // extrapolate: 1 day → 30 days
    return dailySummary.total_cost_cents * 30
  }

  private monthStartMs(): number {
    const d = new Date()
    return new Date(d.getFullYear(), d.getMonth(), 1).getTime()
  }
}
