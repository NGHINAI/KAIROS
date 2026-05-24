// Feedback collector: gathers implicit signals from user behavior,
// computes effectiveness metrics, and feeds learnings into the dream system.
// This is what makes KAIROS self-evolving — it gets smarter over time.

import type { Database } from 'bun:sqlite'
import * as queries from './db'
import { log } from './logger'
import type { Config, EffectivenessMetrics } from './types'

export class FeedbackCollector {
  private tickCounter = 0
  private lastScanAt = 0

  constructor(
    private db: Database,
    private config: Config,
  ) {
    this.lastScanAt = Date.now() - 3_600_000 // Start scanning from 1 hour ago
  }

  /**
   * Run implicit feedback collection. Called periodically from the scheduler.
   * Returns true if new feedback was collected.
   */
  collect(): boolean {
    this.tickCounter++
    if (this.tickCounter % this.config.feedback.collectionIntervalTicks !== 0) {
      return false
    }

    let collected = 0

    // 1. Messages read quickly (within 2 min) → positive signal
    collected += this.collectReadMessages()

    // 2. Messages ignored (unread for > 2 hours) → negative signal
    collected += this.collectIgnoredMessages()

    // 3. Tasks cancelled quickly (< 1 min after creation) → negative signal
    collected += this.collectCancelledTasks()

    // 4. Tasks completed and result read → positive signal
    collected += this.collectCompletedTasks()

    // 5. Observations dismissed → negative signal
    collected += this.collectDismissedObservations()

    // 6. Observations acted on → strong positive signal
    collected += this.collectActedOnObservations()

    if (collected > 0) {
      log(`Feedback collected: ${collected} new signal(s)`)
    }

    this.lastScanAt = Date.now()
    return collected > 0
  }

  // ─── Signal collectors ────────────────────────────────────────────

  private collectReadMessages(): number {
    const messages = queries.getUnprocessedReadMessages(this.db, this.lastScanAt)
    let count = 0

    for (const msg of messages) {
      if (!msg.read_at || !msg.created_at) continue
      if (queries.hasExistingFeedback(this.db, msg.message_id)) continue

      const readTimeMs = msg.read_at - msg.created_at
      let kind: string
      let strength: number

      if (readTimeMs < 120_000) {
        // Read within 2 minutes — strong positive
        kind = 'read_fast'
        strength = 0.8
      } else if (readTimeMs < 1_800_000) {
        // Read within 30 minutes — mild positive
        kind = 'read_slow'
        strength = 0.3
      } else {
        // Read after 30 min — weak positive (still read eventually)
        kind = 'read_slow'
        strength = 0.1
      }

      queries.createFeedback(this.db, {
        messageId: msg.message_id,
        taskId: msg.task_id,
        feedbackKind: kind,
        signalStrength: strength,
        source: 'auto',
        contextJson: JSON.stringify({
          timeOfDay: this.getTimeOfDay(),
          readTimeMs,
          kind: msg.kind,
        }),
      })
      count++
    }

    return count
  }

  private collectIgnoredMessages(): number {
    const twoHoursMs = 7_200_000
    const messages = queries.getIgnoredMessages(this.db, twoHoursMs)
    let count = 0

    for (const msg of messages) {
      if (queries.hasExistingFeedback(this.db, msg.message_id)) continue

      queries.createFeedback(this.db, {
        messageId: msg.message_id,
        taskId: msg.task_id,
        feedbackKind: 'ignored',
        signalStrength: -0.5,
        source: 'auto',
        contextJson: JSON.stringify({
          timeOfDay: this.getTimeOfDay(),
          ageMs: Date.now() - msg.created_at,
          kind: msg.kind,
        }),
      })
      count++
    }

    return count
  }

  private collectCancelledTasks(): number {
    const tasks = this.db.query(`
      SELECT task_id, created_at, completed_at FROM tasks
      WHERE status = 'cancelled' AND completed_at > ?
      AND task_id NOT IN (SELECT task_id FROM feedback WHERE task_id IS NOT NULL AND feedback_kind = 'cancelled')
    `).all(this.lastScanAt) as { task_id: string; created_at: number; completed_at: number }[]

    let count = 0
    for (const task of tasks) {
      const ageMs = task.completed_at - task.created_at
      // Quick cancellation = strong negative; slow = mild negative
      const strength = ageMs < 60_000 ? -0.9 : -0.4

      queries.createFeedback(this.db, {
        taskId: task.task_id,
        feedbackKind: 'cancelled',
        signalStrength: strength,
        source: 'auto',
        contextJson: JSON.stringify({
          timeOfDay: this.getTimeOfDay(),
          ageMs,
        }),
      })
      count++
    }

    return count
  }

  private collectCompletedTasks(): number {
    // Tasks that completed AND whose result message was read
    const tasks = this.db.query(`
      SELECT t.task_id, m.message_id, m.read_at, m.created_at
      FROM tasks t
      JOIN messages m ON m.task_id = t.task_id AND m.kind = 'task_result'
      WHERE t.status = 'done' AND m.read_at IS NOT NULL AND m.read_at > ?
      AND t.task_id NOT IN (SELECT task_id FROM feedback WHERE task_id IS NOT NULL AND feedback_kind = 'completed')
    `).all(this.lastScanAt) as { task_id: string; message_id: string; read_at: number; created_at: number }[]

    let count = 0
    for (const t of tasks) {
      queries.createFeedback(this.db, {
        taskId: t.task_id,
        messageId: t.message_id,
        feedbackKind: 'completed',
        signalStrength: 0.7,
        source: 'auto',
        contextJson: JSON.stringify({
          timeOfDay: this.getTimeOfDay(),
          readTimeMs: t.read_at - t.created_at,
        }),
      })
      count++
    }

    return count
  }

  private collectDismissedObservations(): number {
    const dismissed = this.db.query(`
      SELECT observation_id FROM observations
      WHERE dismissed_at IS NOT NULL AND dismissed_at > ?
      AND observation_id NOT IN (SELECT observation_id FROM feedback WHERE observation_id IS NOT NULL AND feedback_kind = 'dismissed')
    `).all(this.lastScanAt) as { observation_id: string }[]

    let count = 0
    for (const obs of dismissed) {
      queries.createFeedback(this.db, {
        observationId: obs.observation_id,
        feedbackKind: 'dismissed',
        signalStrength: -0.6,
        source: 'auto',
        contextJson: JSON.stringify({ timeOfDay: this.getTimeOfDay() }),
      })
      count++
    }

    return count
  }

  private collectActedOnObservations(): number {
    const acted = this.db.query(`
      SELECT observation_id FROM observations
      WHERE acted_on_at IS NOT NULL AND acted_on_at > ?
      AND observation_id NOT IN (SELECT observation_id FROM feedback WHERE observation_id IS NOT NULL AND feedback_kind = 'acted_on')
    `).all(this.lastScanAt) as { observation_id: string }[]

    let count = 0
    for (const obs of acted) {
      queries.createFeedback(this.db, {
        observationId: obs.observation_id,
        feedbackKind: 'acted_on',
        signalStrength: 0.9,
        source: 'auto',
        contextJson: JSON.stringify({ timeOfDay: this.getTimeOfDay() }),
      })
      count++
    }

    return count
  }

  // ─── Effectiveness metrics ────────────────────────────────────────

  /**
   * Compute effectiveness metrics from feedback data.
   * Used by the dream system to write learnings into MEMORY.md.
   */
  computeMetrics(): EffectivenessMetrics {
    const windowMs = this.config.feedback.metricsWindowHours * 3_600_000
    const since = Date.now() - windowMs

    // By observation category
    const byCategory = this.db.query(`
      SELECT o.category,
             COUNT(*) as total,
             AVG(f.signal_strength) as avg_strength,
             SUM(CASE WHEN f.feedback_kind = 'acted_on' THEN 1 ELSE 0 END) * 1.0 / COUNT(*) as action_rate
      FROM feedback f
      JOIN observations o ON f.observation_id = o.observation_id
      WHERE f.created_at > ? AND f.observation_id IS NOT NULL
      GROUP BY o.category
    `).all(since) as { category: string; total: number; avg_strength: number; action_rate: number }[]

    // By decision type (kind of message)
    const byDecisionType = this.db.query(`
      SELECT m.kind as decision_type,
             COUNT(*) as total,
             AVG(f.signal_strength) as avg_strength
      FROM feedback f
      JOIN messages m ON f.message_id = m.message_id
      WHERE f.created_at > ? AND f.message_id IS NOT NULL
      GROUP BY m.kind
    `).all(since) as { decision_type: string; total: number; avg_strength: number }[]

    // By time of day
    const byTimeOfDay = this.db.query(`
      SELECT json_extract(f.context_json, '$.timeOfDay') as time_of_day,
             COUNT(*) as total,
             AVG(f.signal_strength) as avg_strength
      FROM feedback f
      WHERE f.created_at > ? AND f.context_json IS NOT NULL
      GROUP BY json_extract(f.context_json, '$.timeOfDay')
    `).all(since) as { time_of_day: string; total: number; avg_strength: number }[]

    // Build metrics
    const catMap: Record<string, { totalSignals: number; avgStrength: number; actionRate: number }> = {}
    const suppressed: string[] = []
    const boosted: string[] = []

    const safeCategories = new Set(['test_failing', 'merge_conflicts'])

    for (const c of byCategory) {
      catMap[c.category] = {
        totalSignals: c.total,
        avgStrength: c.avg_strength,
        actionRate: c.action_rate,
      }
      if (c.total >= 3) {
        if (c.avg_strength < -0.2 && !safeCategories.has(c.category)) {
          suppressed.push(c.category)
        }
        if (c.avg_strength > 0.6 || c.action_rate > 0.8) {
          boosted.push(c.category)
        }
      }
    }

    const dtMap: Record<string, { totalSignals: number; avgStrength: number }> = {}
    for (const d of byDecisionType) {
      dtMap[d.decision_type] = { totalSignals: d.total, avgStrength: d.avg_strength }
    }

    const todMap: Record<string, { totalSignals: number; avgStrength: number }> = {}
    for (const t of byTimeOfDay) {
      if (t.time_of_day) {
        todMap[t.time_of_day] = { totalSignals: t.total, avgStrength: t.avg_strength }
      }
    }

    return {
      byCategory: catMap,
      byDecisionType: dtMap,
      byTimeOfDay: todMap,
      suppressedCategories: suppressed,
      boostedCategories: boosted,
    }
  }

  /**
   * Format metrics as human-readable text for the dream prompt.
   */
  formatMetricsForDream(): string {
    const metrics = this.computeMetrics()
    const lines: string[] = ['## Feedback metrics (last 7 days)', '']

    // Category effectiveness
    if (Object.keys(metrics.byCategory).length > 0) {
      lines.push('### By observation category')
      for (const [cat, data] of Object.entries(metrics.byCategory)) {
        const pct = Math.round(data.avgStrength * 100)
        const action = Math.round(data.actionRate * 100)
        lines.push(`- ${cat}: avg signal ${pct > 0 ? '+' : ''}${pct}%, action rate ${action}% (${data.totalSignals} signals)`)
      }
      lines.push('')
    }

    // Suppressed/boosted
    if (metrics.suppressedCategories.length > 0) {
      lines.push(`### Suppressed (user doesn't find useful): ${metrics.suppressedCategories.join(', ')}`)
    }
    if (metrics.boostedCategories.length > 0) {
      lines.push(`### Boosted (user finds very useful): ${metrics.boostedCategories.join(', ')}`)
    }

    // Time of day
    if (Object.keys(metrics.byTimeOfDay).length > 0) {
      lines.push('')
      lines.push('### By time of day')
      for (const [tod, data] of Object.entries(metrics.byTimeOfDay)) {
        const pct = Math.round(data.avgStrength * 100)
        lines.push(`- ${tod}: avg signal ${pct > 0 ? '+' : ''}${pct}% (${data.totalSignals} signals)`)
      }
    }

    return lines.join('\n')
  }

  /**
   * Record explicit feedback from the user (via kairos_feedback MCP tool).
   */
  recordExplicit(params: {
    messageId?: string
    observationId?: string
    rating: 'good' | 'bad' | 'useless' | 'perfect'
    comment?: string
  }): void {
    const ratingMap: Record<string, { kind: string; strength: number }> = {
      perfect: { kind: 'explicit_positive', strength: 1.0 },
      good: { kind: 'explicit_positive', strength: 0.7 },
      bad: { kind: 'explicit_negative', strength: -0.7 },
      useless: { kind: 'explicit_negative', strength: -1.0 },
    }

    const { kind, strength } = ratingMap[params.rating]!

    queries.createFeedback(this.db, {
      messageId: params.messageId,
      observationId: params.observationId,
      feedbackKind: kind,
      signalStrength: strength,
      source: 'explicit',
      contextJson: JSON.stringify({
        timeOfDay: this.getTimeOfDay(),
        comment: params.comment,
        rating: params.rating,
      }),
    })

    log(`Explicit feedback recorded: ${params.rating} (${strength > 0 ? '+' : ''}${strength})`)
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  private getTimeOfDay(): string {
    const hour = new Date().getHours()
    if (hour >= 6 && hour < 12) return 'morning'
    if (hour >= 12 && hour < 17) return 'afternoon'
    if (hour >= 17 && hour < 22) return 'evening'
    return 'night'
  }
}
