// src/daemon/llm/costTracker.ts
// Persistent per-provider cost ledger. Lives in the main daemon DB.
// Every CompletionResult is recorded; aggregate rollups answer
// "are we over budget?" and "which provider is consuming the most?".

import type { Database } from 'bun:sqlite'
import type { ProviderId, TaskType } from './types'

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS llm_call_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ts              INTEGER NOT NULL,
    provider        TEXT    NOT NULL,
    model           TEXT    NOT NULL,
    task_type       TEXT    NOT NULL,
    input_tokens    INTEGER NOT NULL,
    output_tokens   INTEGER NOT NULL,
    cost_cents      INTEGER NOT NULL,
    fallback_count  INTEGER NOT NULL DEFAULT 0,
    latency_ms      INTEGER
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
         (ts, provider, model, task_type, input_tokens, output_tokens, cost_cents, fallback_count, latency_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        Date.now(),
        r.provider,
        r.model,
        r.task_type,
        r.input_tokens,
        r.output_tokens,
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

  private monthStartMs(): number {
    const d = new Date()
    return new Date(d.getFullYear(), d.getMonth(), 1).getTime()
  }
}
