// src/daemon/orders/v2/scheduleAdapter.ts
// Wraps cronParser.ts: for each cron/at rule, computes next fire timestamp
// and arms setTimeout. Re-arms after firing (cron) or removes (at).

import type { OrdersStore } from './store'
import type { Rule, TriggerContext } from './types'
import { parseSimpleCron, nextCronFire, parseRelativeTime, isValidCronExpr } from '../../cronParser'
import { log, logError } from '../../logger'

export type ScheduleAdapterDeps = {
  store: OrdersStore
  onFire: (rule: Rule, ctx: TriggerContext) => Promise<void>
  now?: () => number
}

export class ScheduleAdapter {
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private now: () => number

  constructor(private deps: ScheduleAdapterDeps) {
    this.now = deps.now ?? Date.now
  }

  register(rule: Rule): void {
    const slug = rule.slug
    this.unregister(slug)
    if ('cron' in rule.when) {
      const rawExpr = rule.when.cron
      // parseSimpleCron normalises human-readable shortcuts; fall back to raw if valid
      const expr = parseSimpleCron(rawExpr) ?? (isValidCronExpr(rawExpr) ? rawExpr : null)
      if (!expr) {
        log(`[orders-v2] invalid cron expr for ${slug}: ${rawExpr}`, 'warn')
        return
      }
      this.armCron(rule, expr)
    } else if ('at' in rule.when) {
      const atVal = rule.when.at
      // parseRelativeTime returns an epoch-ms timestamp for "in N second/min/hour/day"
      const fireAt = parseRelativeTime(atVal) ?? Date.parse(atVal)
      if (!fireAt || Number.isNaN(fireAt)) {
        log(`[orders-v2] invalid at: for ${slug}: ${atVal}`, 'warn')
        return
      }
      this.armAt(rule, fireAt)
    }
  }

  unregister(slug: string): void {
    const t = this.timers.get(slug)
    if (t) {
      clearTimeout(t)
      this.timers.delete(slug)
    }
  }

  refreshAll(): void {
    this.stopAll()
    for (const r of this.deps.store.listAll()) {
      if ('cron' in r.when || 'at' in r.when) this.register(r)
    }
  }

  stopAll(): void {
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }

  registeredSlugs(): string[] {
    return Array.from(this.timers.keys())
  }

  private armCron(rule: Rule, expr: string): void {
    // nextCronFire accepts a Date as second arg
    const fireDate = nextCronFire(expr, new Date(this.now()))
    const fireAt = fireDate.getTime()
    const delay = Math.max(0, fireAt - this.now())
    const timer = setTimeout(async () => {
      try {
        await this.deps.onFire(rule, { trigger: { fired_at: this.now() } })
      } catch (err) {
        logError(`[orders-v2] cron fire failed for ${rule.slug}`, err)
      }
      const fresh = this.deps.store.get(rule.slug)
      if (fresh) this.armCron(fresh, expr)
    }, delay)
    this.timers.set(rule.slug, timer)
  }

  private armAt(rule: Rule, fireAt: number): void {
    const delay = Math.max(0, fireAt - this.now())
    const timer = setTimeout(async () => {
      try {
        await this.deps.onFire(rule, { trigger: { fired_at: this.now() } })
      } catch (err) {
        logError(`[orders-v2] at fire failed for ${rule.slug}`, err)
      }
      this.timers.delete(rule.slug)
    }, delay)
    this.timers.set(rule.slug, timer)
  }
}
