// Rolling-window budget tracking for subprocess calls, proactive messages, and cost.
// Reads from the ticks/messages tables — no separate tracking state needed.

import type { Database } from 'bun:sqlite'
import type { Config } from './types'

export type BudgetSnapshot = {
  subprocessCalls: number
  subprocessBudget: number
  proactiveMsgs: number
  proactiveBudget: number
  costCents: number
  costBudget: number
  percentUsed: number
}

export class BudgetTracker {
  constructor(
    private db: Database,
    private budgetConfig: Config['budget'],
  ) {}

  snapshot(): BudgetSnapshot {
    const oneHourAgo = Date.now() - 3_600_000

    const calls = this.db
      .query('SELECT COUNT(*) as n FROM ticks WHERE fired_at > ? AND decision != ?')
      .get(oneHourAgo, 'SLEEP') as { n: number }

    const msgs = this.db
      .query("SELECT COUNT(*) as n FROM messages WHERE created_at > ? AND priority = 'proactive'")
      .get(oneHourAgo) as { n: number }

    const cost = this.db
      .query('SELECT COALESCE(SUM(cost_cents), 0) as total FROM ticks WHERE fired_at > ?')
      .get(oneHourAgo) as { total: number }

    const subprocessCalls = calls.n
    const proactiveMsgs = msgs.n
    const costCents = cost.total

    const maxPct = Math.max(
      subprocessCalls / this.budgetConfig.maxSubprocessPerHour,
      proactiveMsgs / this.budgetConfig.maxProactiveMsgsPerHour,
      costCents / this.budgetConfig.maxCostCentsPerHour,
    )

    return {
      subprocessCalls,
      subprocessBudget: this.budgetConfig.maxSubprocessPerHour,
      proactiveMsgs,
      proactiveBudget: this.budgetConfig.maxProactiveMsgsPerHour,
      costCents,
      costBudget: this.budgetConfig.maxCostCentsPerHour,
      percentUsed: Math.round(maxPct * 100),
    }
  }

  isOverBudget(): boolean {
    return this.snapshot().percentUsed >= 100
  }

  recordSubprocess(opts: { costCents: number }): void {
    // Cost is already tracked via the ticks table (logTickRow).
    // This method exists as a hook for Phase 5+ when task runner
    // needs to add cost from work subprocesses (which don't go through ticks).
    // For now it's a no-op — the ticks table cost_cents field handles it.
    void opts
  }
}
