// src/daemon/agency/triggerEngine.ts
// Consumes EventBus events. For each event, reads compiled triggers
// from Phase B's orders compiler and evaluates which match.
// Emits ActionRequest records via the dispatcher callback.
//
// C.1 evaluator supports a small grammar — enough for validation
// scenarios. C.4 upgrades to the full when_match DSL with conditional
// branches, time-of-day scoping, cooldowns, and cross-rule chaining.

import { randomUUID } from 'crypto'
import type { Database } from 'bun:sqlite'
import { log, logError } from '../logger'
import type { EventBus, WorldEvent } from '../proactive/eventBus'
import type { ActionRequest } from './types'

type DispatchFn = (req: ActionRequest) => Promise<{ status: string }>

type CompiledTriggerRow = {
  id: string
  when_kind: string
  when_match: string
  condition: string | null
  action: string
  source_rule: string
}

export class TriggerEngine {
  private unsubscribe: (() => void) | null = null

  constructor(
    private db: Database,
    private bus: EventBus,
    private dispatch: DispatchFn,
  ) {}

  start(): void {
    this.unsubscribe = this.bus.subscribe('*', e => { void this.evaluateEvent(e) })
    log('TriggerEngine armed')
  }

  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe()
      this.unsubscribe = null
    }
  }

  listTriggers(): CompiledTriggerRow[] {
    return this.db.query('SELECT * FROM compiled_orders_triggers').all() as CompiledTriggerRow[]
  }

  async evaluateEvent(event: WorldEvent): Promise<void> {
    if (this.isSuspended(event.source)) return

    const triggers = this.listTriggers()
    for (const t of triggers) {
      if (t.when_kind !== event.source) continue
      if (!this.matchesPayload(t.when_match, event.payload)) continue
      if (t.condition && !this.evaluateCondition(t.condition, event)) continue

      try {
        const req: ActionRequest = {
          request_id: randomUUID(),
          intent_id: t.action,
          args: this.buildArgsFromEvent(t, event),
          source_trigger_id: t.id,
          reasoning: `trigger ${t.id} matched (rule: ${t.source_rule.slice(0, 60)})`,
          requested_at: Date.now(),
        }
        await this.dispatch(req)
      } catch (err) {
        logError(`TriggerEngine: dispatch failed for ${t.id}`, err)
      }
    }
  }

  private isSuspended(source: string): boolean {
    const now = Date.now()
    try {
      const rows = this.db.query(
        'SELECT scope FROM agency_suspend_state WHERE until_ms > ?',
      ).all(now) as Array<{ scope: string }>
      return rows.some(r => r.scope === 'all' || r.scope === source || r.scope === 'triggers')
    } catch {
      return false
    }
  }

  /**
   * C.1 evaluator. Supports:
   *   "*"                        — always match
   *   "text.contains('foo')"     — payload.text includes 'foo'
   *   "text.isURL()"             — payload.text matches a URL regex
   *   "app.equals('Slack')"      — payload.app equals 'Slack'
   *   "path.endsWith('.ts')"     — payload.path ends with '.ts'
   *
   * FAIL-CLOSED: unsupported predicates (compound expressions, pattern.repeats,
   * event.startsIn, etc) return false — the trigger does not fire.
   *
   * History: this used to return true on fallthrough, which caused a 2026-05-25
   * incident where the LLM compiler emitted `pattern.repeats(3, 10min, sameFile)`
   * for a file-events trigger. Our evaluator didn't know that predicate so it
   * fell through to true, matching every file change. Result: 4,454 macOS
   * notifications in 2 hours. The fail-closed default makes unsupported
   * predicates SAFE (they never fire) instead of DANGEROUS (they always fire).
   *
   * C.4 expands the supported predicate DSL.
   */
  private matchesPayload(whenMatch: string, payload: Record<string, unknown>): boolean {
    if (!whenMatch || whenMatch.trim() === '*') return true

    const contains = whenMatch.match(/^text\.contains\(['"](.+)['"]\)$/)
    if (contains) {
      return typeof payload.text === 'string' && payload.text.includes(contains[1]!)
    }

    if (whenMatch === 'text.isURL()') {
      return typeof payload.text === 'string' && /https?:\/\/\S+/.test(payload.text)
    }

    const appEq = whenMatch.match(/^app\.equals\(['"](.+)['"]\)$/)
    if (appEq) return (payload as any).app === appEq[1]

    const pathEnds = whenMatch.match(/^path\.endsWith\(['"](.+)['"]\)$/)
    if (pathEnds) {
      return typeof payload.path === 'string' && payload.path.endsWith(pathEnds[1]!)
    }

    return false   // fail-closed
  }

  /** Stub for C.1 — just true. C.4 adds NOT focus_app.is_video etc. */
  private evaluateCondition(_condition: string, _event: WorldEvent): boolean {
    return true
  }

  private buildArgsFromEvent(t: CompiledTriggerRow, event: WorldEvent): Record<string, unknown> {
    switch (t.action) {
      case 'notify':
        return {
          title: `Trigger fired: ${t.id}`,
          body: `${event.source}/${event.kind}: ${JSON.stringify(event.payload).slice(0, 100)}`,
        }
      case 'log':
        return { message: `${t.source_rule} → ${event.source}/${event.kind}` }
      case 'add_to_memory':
        return {
          kind: 'fact',
          subject: event.source,
          body: JSON.stringify(event.payload).slice(0, 200),
          importance: 0.5,
        }
      default:
        return event.payload
    }
  }
}
