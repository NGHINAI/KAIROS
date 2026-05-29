// src/daemon/orders/v2/reactiveEvaluator.ts
// State-triggered rule evaluation. Called with handleEvent(kind, payload) for
// each perception event. Matches against rules' `when.state` selectors, applies
// if/unless/cooldown, and routes to ActionDispatcher (or DryRunLogger).
//
// "event" kind is special: payload = { name, payload } — handles named-event
// triggered rules emitted via ActionDispatcher → RulesEventBus.

import type { OrdersStore } from './store'
import type { ConditionEvaluator } from './conditionEvaluator'
import type { DryRunLogger } from './dryRunLogger'
import type { Rule, StateSelector, TriggerContext, ActionResult } from './types'

export type ReactiveEvaluatorDeps = {
  store: OrdersStore
  dispatcher: { dispatch(actions: any[], ctx: TriggerContext): Promise<ActionResult> }
  conditionEvaluator: ConditionEvaluator
  dryRunLogger: DryRunLogger
  getPersonaState: () => Record<string, unknown>
  now?: () => number
}

export class ReactiveEvaluator {
  private now: () => number
  constructor(private deps: ReactiveEvaluatorDeps) {
    this.now = deps.now ?? Date.now
  }

  async handleEvent(kind: string, payload: Record<string, unknown>): Promise<void> {
    if (kind === 'event') {
      const eventName = payload.name as string
      await this.handleNamedEvent(eventName, (payload.payload as Record<string, unknown>) ?? {})
      return
    }
    if (kind === 'incoming_event') {
      const env = payload as { payload?: Record<string, unknown> }
      const rules = this.deps.store.listActiveByWhenKind('state')
      for (const r of rules) {
        if (!('state' in r.when)) continue
        if (!this.matchesSelector(r.when.state, kind, payload)) continue
        await this.maybeFire(r, { trigger: payload, payload: env.payload ?? {} })
      }
      return
    }
    const rules = this.deps.store.listActiveByWhenKind('state')
    for (const r of rules) {
      if (!('state' in r.when)) continue
      if (!this.matchesSelector(r.when.state, kind, payload)) continue
      await this.maybeFire(r, { trigger: payload })
    }
  }

  private async handleNamedEvent(name: string, payload: Record<string, unknown>): Promise<void> {
    const rules = this.deps.store.listActiveByWhenKind('event')
    for (const r of rules) {
      if (!('event' in r.when) || r.when.event !== name) continue
      await this.maybeFire(r, { trigger: payload, payload })
    }
  }

  private matchesSelector(sel: StateSelector, kind: string, payload: Record<string, unknown>): boolean {
    if ('clipboard' in sel && kind === 'clipboard') {
      const c = sel.clipboard
      const text = (payload.text as string | undefined) ?? ''
      if (c.contains && !text.toLowerCase().includes(c.contains.toLowerCase())) return false
      if (c.is_url) {
        try { new URL(text) } catch { return false }
      }
      return true
    }
    if ('focus_app' in sel && kind === 'focus_app') {
      const app = (payload.app as string | undefined) ?? ''
      const f = sel.focus_app
      if (f.equals && app !== f.equals) return false
      if (f.in && !f.in.includes(app)) return false
      return true
    }
    if ('calendar' in sel && kind === 'calendar') return true
    if ('file_events' in sel && kind === 'file_events') {
      const path = (payload.path as string | undefined) ?? ''
      const pattern = sel.file_events.path_matches
      if (pattern && !this.globMatch(path, pattern)) return false
      return true
    }
    if ('browser_tabs' in sel && kind === 'browser_tabs') return true
    if ('pattern' in sel && kind === 'pattern') return true
    if ('incoming_event' in sel && kind === 'incoming_event') {
      const ie = sel.incoming_event
      const env = payload as { trigger_slug?: string }
      if (ie.trigger !== env.trigger_slug) return false
      return true
    }
    return false
  }

  private globMatch(path: string, pattern: string): boolean {
    const regex = new RegExp(
      '^' + pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '__DOUBLESTAR__')
        .replace(/\*/g, '[^/]*')
        .replace(/__DOUBLESTAR__/g, '.*') + '$',
    )
    return regex.test(path)
  }

  private async maybeFire(rule: Rule, ctx: TriggerContext): Promise<void> {
    const now = this.now()
    const ev = this.deps.conditionEvaluator
    const evalCtx = { persona: this.deps.getPersonaState(), payload: ctx.payload ?? {}, trigger: ctx.trigger, now }

    if (rule.if && !ev.all(rule.if, evalCtx)) return
    if (rule.unless && ev.any(rule.unless, evalCtx)) return

    if (rule.cooldown_ms) {
      const state = this.deps.store.getState(rule.slug)
      if (state && (now - state.last_fired_at) < rule.cooldown_ms) return
    }

    if (this.deps.dryRunLogger.isDryRun(rule, now)) {
      this.deps.dryRunLogger.logFire(rule, rule.do, ctx, now)
      return
    }

    await this.deps.dispatcher.dispatch(rule.do, ctx)
    this.deps.store.recordFire(rule.slug, now)
  }
}
