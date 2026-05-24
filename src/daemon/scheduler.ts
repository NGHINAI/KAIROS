// The tick scheduler. Single-consumer queue, time + event triggered.
// Fires ticks to the decision engine and dispatches the decisions.

import type { Database } from 'bun:sqlite'
import * as queries from './db'
import { log, logTick } from './logger'
import type { Config, Decision, TickEvent, TickSource } from './types'

export type DecisionHandler = (event: TickEvent) => Promise<Decision>

export class Scheduler {
  private timer: ReturnType<typeof setTimeout> | null = null
  private queue: TickEvent[] = []
  private processing = false
  private currentSleepMs: number
  private paused = false
  private startedAt = Date.now()

  constructor(
    private decisionHandler: DecisionHandler,
    private db: Database,
    private config: Config,
    private onWork?: (taskId: string) => void,
    private onInvestigate?: (topic: string) => void,
    private onNotify?: (body: string, sessionId: string, priority: string) => void,
    private onDream?: () => void,
    private onSuggest?: (observationId: string, body: string, severity: string) => void,
    // Pre-decision hooks for the self-evolving features
    private preTickHooks?: {
      checkSchedules?: () => string[]  // returns fired task IDs
      runScan?: () => Promise<boolean>  // returns true if suggestions created
      collectFeedback?: () => boolean   // returns true if feedback collected
    },
  ) {
    this.currentSleepMs = config.tick.defaultIntervalMs
  }

  start(): void {
    log(`Tick scheduler armed. First tick in ${this.currentSleepMs / 1000}s.`)
    this.scheduleNextTick(this.currentSleepMs)
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    log('Tick scheduler stopped.')
  }

  pause(): void {
    this.paused = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    log('Tick scheduler paused.')
  }

  resume(): void {
    this.paused = false
    this.scheduleNextTick(this.currentSleepMs)
    log('Tick scheduler resumed.')
  }

  triggerImmediateTick(event: TickEvent): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.enqueue(event)
  }

  state(): 'thinking' | 'sleeping' | 'paused' {
    if (this.paused) return 'paused'
    return this.processing ? 'thinking' : 'sleeping'
  }

  uptime(): number {
    return Date.now() - this.startedAt
  }

  private enqueue(event: TickEvent): void {
    // Coalesce: keep max 3 in queue
    if (this.queue.length >= 3) {
      this.queue.shift()
    }
    this.queue.push(event)
    void this.drain()
  }

  private async drain(): Promise<void> {
    if (this.processing || this.paused) return
    this.processing = true

    while (this.queue.length > 0) {
      const event = this.queue.shift()!
      try {
        await this.processTick(event)
      } catch (err) {
        log(`Tick failed: ${err instanceof Error ? err.message : String(err)}`, 'error')
      }
    }

    this.processing = false
    if (!this.paused) {
      this.scheduleNextTick(this.currentSleepMs)
    }
  }

  private async processTick(event: TickEvent): Promise<void> {
    const startMs = Date.now()

    // ─── Pre-decision hooks (self-evolving features) ──────────────
    // These run BEFORE the decision engine so that:
    //   - Newly-fired scheduled tasks are in the queue when WORK decisions happen
    //   - Fresh observations are in the context when the tick prompt is assembled
    //   - Feedback is collected so effectiveness metrics are current
    if (this.preTickHooks) {
      try {
        const firedTaskIds = this.preTickHooks.checkSchedules?.() ?? []
        if (firedTaskIds.length > 0) {
          log(`Schedules fired: ${firedTaskIds.join(', ')}`)
        }
        await this.preTickHooks.runScan?.()
        this.preTickHooks.collectFeedback?.()
      } catch (err) {
        log(`Pre-tick hook error: ${err instanceof Error ? err.message : String(err)}`, 'warn')
      }
    }

    // Get decision from handler (mock or real Haiku)
    const decision = await this.decisionHandler(event)
    if (decision == null) {
      log('Decision handler returned nullish; skipping tick', 'warn')
      return
    }

    const durationMs = Date.now() - startMs

    // Log to DB
    queries.logTickRow(this.db, {
      decision: decision.kind + (decision.kind === 'SLEEP' ? ` ${decision.seconds}` : decision.kind === 'WORK' ? ` ${decision.taskId}` : ''),
      reasoning: decision.reasoning,
      taskId: decision.kind === 'WORK' ? decision.taskId : null,
      durationMs,
      costCents: decision.costCents,
      model: decision.model,
      sleepSeconds: decision.kind === 'SLEEP' ? decision.seconds : null,
    })

    logTick(`${decision.kind}${decision.kind === 'SLEEP' ? ' ' + decision.seconds + 's' : decision.kind === 'WORK' ? ' ' + decision.taskId : ''} — ${decision.reasoning} (${durationMs}ms, $${(decision.costCents / 100).toFixed(4)})`)

    // Execute the decision
    switch (decision.kind) {
      case 'SLEEP':
        this.currentSleepMs = this.adaptSleep(decision.seconds * 1000)
        break

      case 'WORK':
        this.onWork?.(decision.taskId)
        this.currentSleepMs = 60_000 // Check back in 1 min
        break

      case 'INVESTIGATE':
        this.onInvestigate?.(decision.topic)
        this.currentSleepMs = 60_000
        break

      case 'NOTIFY': {
        this.onNotify?.(decision.body, decision.sessionId, decision.priority)
        this.currentSleepMs = 60_000
        break
      }

      case 'SUGGEST':
        this.onSuggest?.(decision.observationId, decision.body, decision.severity)
        this.currentSleepMs = 60_000
        break

      case 'CONSOLIDATE':
        this.onDream?.()
        this.currentSleepMs = 300_000 // Dream takes time
        break
    }
  }

  private adaptSleep(requestedMs: number): number {
    let ms = requestedMs
    const cfg = this.config.tick

    // Active tasks → check more frequently
    const running = queries.getRunningTasks(this.db)
    if (running.length > 0) ms = Math.min(ms, 60_000)

    // Hard caps
    ms = Math.max(ms, cfg.minSleepMs)
    ms = Math.min(ms, cfg.maxSleepMs)

    return ms
  }

  private scheduleNextTick(ms: number): void {
    this.timer = setTimeout(() => {
      this.enqueue({ source: 'time', reason: 'scheduled tick' })
    }, ms)
  }
}
