// src/daemon/orders/v2/dryRunLogger.ts
// Wraps OrdersStore for the dry-run flow. Decides whether a rule is currently
// in its 24h dry-run window, records "would have fired" events, and provides
// an aggregation summary for the inbox prompt builder.

import type { OrdersStore } from './store'
import type { Rule, Action, TriggerContext } from './types'

export type DryRunSummary = {
  slug: string
  fire_count: number
  window_start: number
  window_end: number
  samples: Array<{ fired_at: number; would_do: Action[] }>
}

export class DryRunLogger {
  constructor(private store: OrdersStore) {}

  isDryRun(rule: Rule, now: number): boolean {
    return rule.dry_run_until !== undefined && rule.dry_run_until > now
  }

  logFire(rule: Rule, wouldDo: Action[], ctx: TriggerContext, now: number): void {
    this.store.recordDryRunFire(rule.slug, now, wouldDo, ctx as Record<string, unknown>)
  }

  summarize(rule: Rule, now: number): DryRunSummary {
    const windowStart = rule.created_at
    const samples = this.store.listDryRunLog(rule.slug, 3)
    return {
      slug: rule.slug,
      fire_count: this.store.countDryRunFiresSince(rule.slug, 0),
      window_start: windowStart,
      window_end: rule.dry_run_until ?? now,
      samples: samples.map(s => ({ fired_at: s.fired_at, would_do: s.would_do })),
    }
  }

  /** Returns rules whose dry_run window has expired and still need approval. */
  listReadyForApproval(now: number): Rule[] {
    return this.store.listAll().filter(r => r.state === 'dry_run' && r.dry_run_until !== undefined && r.dry_run_until <= now)
  }
}
