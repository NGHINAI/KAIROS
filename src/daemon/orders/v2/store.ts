// src/daemon/orders/v2/store.ts
// SQLite-backed store for v2 standing orders.

import type { Database } from 'bun:sqlite'
import type { Rule, Action, When, LifecycleState } from './types'

export const ORDERS_V2_SCHEMA = `
CREATE TABLE IF NOT EXISTS orders_rules (
  slug          TEXT PRIMARY KEY,
  when_kind     TEXT NOT NULL,
  rule_json     TEXT NOT NULL,
  state         TEXT NOT NULL,
  dry_run_until INTEGER,
  cooldown_ms   INTEGER,
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_v2_when_kind ON orders_rules(when_kind);
CREATE INDEX IF NOT EXISTS idx_orders_v2_state ON orders_rules(state);

CREATE TABLE IF NOT EXISTS orders_rule_state (
  slug            TEXT PRIMARY KEY,
  last_fired_at   INTEGER NOT NULL DEFAULT 0,
  fire_count      INTEGER NOT NULL DEFAULT 0,
  last_dry_run_at INTEGER NOT NULL DEFAULT 0,
  dry_run_count   INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  FOREIGN KEY (slug) REFERENCES orders_rules(slug) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS orders_dry_run_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT NOT NULL,
  fired_at    INTEGER NOT NULL,
  would_do    TEXT NOT NULL,
  trigger_ctx TEXT,
  FOREIGN KEY (slug) REFERENCES orders_rules(slug) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_dry_run_slug_time ON orders_dry_run_log(slug, fired_at);
`

export type RuleStateRow = {
  slug: string
  last_fired_at: number
  fire_count: number
  last_dry_run_at: number
  dry_run_count: number
  last_error?: string
}

export type DryRunLogRow = {
  id: number
  slug: string
  fired_at: number
  would_do: Action[]
  trigger_ctx?: Record<string, unknown>
}

export type WhenKind = 'cron' | 'at' | 'event' | 'state'

export class OrdersStore {
  constructor(private db: Database) {
    db.exec(ORDERS_V2_SCHEMA)
  }

  upsert(rule: Rule): void {
    const whenKind = this.whenKindOf(rule.when)
    const now = Date.now()
    this.db.run(
      `INSERT INTO orders_rules (slug, when_kind, rule_json, state, dry_run_until, cooldown_ms, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET
         when_kind = excluded.when_kind,
         rule_json = excluded.rule_json,
         state = excluded.state,
         dry_run_until = excluded.dry_run_until,
         cooldown_ms = excluded.cooldown_ms,
         updated_at = excluded.updated_at`,
      [rule.slug, whenKind, JSON.stringify(rule), rule.state, rule.dry_run_until ?? null,
       rule.cooldown_ms ?? null, rule.created_by, rule.created_at, now],
    )
  }

  replaceAll(rules: Rule[]): void {
    const incoming = new Set(rules.map(r => r.slug))
    const existing = this.listAll().map(r => r.slug)
    for (const slug of existing) if (!incoming.has(slug)) this.remove(slug)
    for (const r of rules) this.upsert(r)
  }

  get(slug: string): Rule | null {
    const row = this.db.query(`SELECT rule_json FROM orders_rules WHERE slug = ?`).get(slug) as { rule_json: string } | null
    return row ? JSON.parse(row.rule_json) as Rule : null
  }

  listAll(): Rule[] {
    const rows = this.db.query(`SELECT rule_json FROM orders_rules ORDER BY slug`).all() as Array<{ rule_json: string }>
    return rows.map(r => JSON.parse(r.rule_json) as Rule)
  }

  listActiveByWhenKind(kind: WhenKind): Rule[] {
    const rows = this.db.query(
      `SELECT rule_json FROM orders_rules WHERE when_kind = ? AND state IN ('active', 'dry_run')`,
    ).all(kind) as Array<{ rule_json: string }>
    return rows.map(r => JSON.parse(r.rule_json) as Rule)
  }

  remove(slug: string): void {
    this.db.run(`DELETE FROM orders_rules WHERE slug = ?`, [slug])
  }

  recordFire(slug: string, firedAt: number): void {
    this.db.run(
      `INSERT INTO orders_rule_state (slug, last_fired_at, fire_count)
       VALUES (?, ?, 1)
       ON CONFLICT(slug) DO UPDATE SET
         last_fired_at = excluded.last_fired_at,
         fire_count = orders_rule_state.fire_count + 1`,
      [slug, firedAt],
    )
  }

  recordDryRunFire(slug: string, firedAt: number, wouldDo: Action[], triggerCtx: Record<string, unknown>): void {
    this.db.run(
      `INSERT INTO orders_dry_run_log (slug, fired_at, would_do, trigger_ctx) VALUES (?, ?, ?, ?)`,
      [slug, firedAt, JSON.stringify(wouldDo), JSON.stringify(triggerCtx)],
    )
    this.db.run(
      `INSERT INTO orders_rule_state (slug, last_dry_run_at, dry_run_count)
       VALUES (?, ?, 1)
       ON CONFLICT(slug) DO UPDATE SET
         last_dry_run_at = excluded.last_dry_run_at,
         dry_run_count = orders_rule_state.dry_run_count + 1`,
      [slug, firedAt],
    )
  }

  recordError(slug: string, error: string): void {
    this.db.run(
      `INSERT INTO orders_rule_state (slug, last_error) VALUES (?, ?)
       ON CONFLICT(slug) DO UPDATE SET last_error = excluded.last_error`,
      [slug, error],
    )
  }

  getState(slug: string): RuleStateRow | null {
    const r = this.db.query(`SELECT * FROM orders_rule_state WHERE slug = ?`).get(slug) as any
    return r ? { ...r, last_error: r.last_error ?? undefined } : null
  }

  countDryRunFiresSince(slug: string, sinceMs: number): number {
    const r = this.db.query(
      `SELECT COUNT(*) AS n FROM orders_dry_run_log WHERE slug = ? AND fired_at >= ?`,
    ).get(slug, sinceMs) as { n: number }
    return r.n
  }

  listDryRunLog(slug: string, limit = 100): DryRunLogRow[] {
    const rows = this.db.query(
      `SELECT * FROM orders_dry_run_log WHERE slug = ? ORDER BY fired_at DESC LIMIT ?`,
    ).all(slug, limit) as any[]
    return rows.map(r => ({
      id: r.id,
      slug: r.slug,
      fired_at: r.fired_at,
      would_do: JSON.parse(r.would_do),
      trigger_ctx: r.trigger_ctx ? JSON.parse(r.trigger_ctx) : undefined,
    }))
  }

  private whenKindOf(when: When): WhenKind {
    if ('cron' in when) return 'cron'
    if ('at' in when) return 'at'
    if ('event' in when) return 'event'
    return 'state'
  }
}
