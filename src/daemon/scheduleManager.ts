// Schedule manager: CRUD for recurring/one-shot scheduled tasks,
// fire logic, and startup recomputation.

import type { Database } from 'bun:sqlite'
import * as queries from './db'
import { log, logError } from './logger'
import { isValidCronExpr, nextCronFire, parseRelativeTime, parseSimpleCron } from './cronParser'
import { notifyScheduleFired } from './notify'
import type { Config, ScheduleRow } from './types'

export class ScheduleManager {
  constructor(
    private db: Database,
    private config: Config,
    // The NL→cron fallback brain. Injected OpenRouter completer (the tick/fast
    // model) — replaces the old `claude -p` Haiku subprocess. No claude at runtime.
    private llm?: { complete: (body: any) => Promise<{ text: string }> },
  ) {}

  /**
   * Parse a natural language schedule into a cron expression.
   * Tries regex first (free), then LLM fallback (costs ~$0.0003).
   * Returns { cronParsed, nextFireAt, isOneShot }.
   */
  async parseSchedule(humanText: string): Promise<{
    cronParsed: string | null
    nextFireAt: number | null
    isOneShot: boolean
  }> {
    // 1. Check for relative time ("in 2 hours")
    const relativeMs = parseRelativeTime(humanText)
    if (relativeMs !== null) {
      return { cronParsed: null, nextFireAt: relativeMs, isOneShot: true }
    }

    // 2. Try regex parsing (free, handles 90% of cases)
    const parsed = parseSimpleCron(humanText)
    if (parsed && isValidCronExpr(parsed)) {
      const next = nextCronFire(parsed)
      return { cronParsed: parsed, nextFireAt: next.getTime(), isOneShot: false }
    }

    // 3. Check if it's already a valid cron expression
    if (isValidCronExpr(humanText.trim())) {
      const next = nextCronFire(humanText.trim())
      return { cronParsed: humanText.trim(), nextFireAt: next.getTime(), isOneShot: false }
    }

    // 4. LLM fallback: ask the injected completer (tick/fast model) to parse.
    if (!this.llm) return { cronParsed: null, nextFireAt: null, isOneShot: false }
    try {
      const resp = await this.llm.complete({
        messages: [{
          role: 'user',
          content:
            `Convert this natural language schedule into a standard 5-field cron expression (minute hour day-of-month month day-of-week).\n\n` +
            `Input: "${humanText}"\n\n` +
            `Output ONLY the cron expression on a single line, nothing else. Example: 0 9 * * 1-5`,
        }],
        max_tokens: 32,
      })
      const result = (resp.text ?? '').trim()

      // Extract cron from response (might have extra text)
      const cronMatch = result.match(/([\d\*\-\,\/]+(?:\s+[\d\*\-\,\/]+){4})/)
      if (cronMatch && isValidCronExpr(cronMatch[1]!)) {
        const cron = cronMatch[1]!
        const next = nextCronFire(cron)
        return { cronParsed: cron, nextFireAt: next.getTime(), isOneShot: false }
      }
    } catch (err) {
      logError('LLM cron parsing failed', err)
    }

    // All methods failed
    return { cronParsed: null, nextFireAt: null, isOneShot: false }
  }

  /**
   * Create a new schedule.
   */
  async create(params: {
    description: string
    schedule: string
    taskTemplate?: string
    workingDir: string
    priority?: string
    permissionMode?: string
    sessionId?: string
  }): Promise<{ scheduleId: string; nextFireAt: number | null; error?: string }> {
    // Check limit
    const active = queries.getActiveSchedules(this.db)
    if (active.length >= this.config.schedule.maxActiveSchedules) {
      return { scheduleId: '', nextFireAt: null, error: `Max ${this.config.schedule.maxActiveSchedules} active schedules reached.` }
    }

    // Parse the schedule
    const { cronParsed, nextFireAt, isOneShot } = await this.parseSchedule(params.schedule)

    if (nextFireAt === null) {
      return { scheduleId: '', nextFireAt: null, error: `Could not parse schedule: "${params.schedule}". Try a simpler format like "every weekday at 9am" or a cron expression "0 9 * * 1-5".` }
    }

    const scheduleId = queries.createSchedule(this.db, {
      description: params.description,
      cronHuman: params.schedule,
      cronParsed,
      taskTemplate: params.taskTemplate ?? params.description,
      workingDir: params.workingDir,
      priority: params.priority,
      permissionMode: params.permissionMode,
      oneShot: isOneShot,
      nextFireAt,
      createdBySession: params.sessionId,
    })

    log(`Schedule ${scheduleId} created: "${params.description}" → next fire at ${new Date(nextFireAt).toLocaleString()}`)
    return { scheduleId, nextFireAt }
  }

  /**
   * Check for and fire due schedules. Called on every tick.
   * Returns task IDs of newly created tasks.
   */
  fireDueSchedules(): string[] {
    const due = queries.getDueSchedules(this.db)
    const firedTaskIds: string[] = []

    for (const schedule of due) {
      try {
        // Create task from the schedule template.
        // Scheduled tasks always get 'high' priority minimum — the user
        // set this up specifically, so the result should always trigger
        // a macOS notification (taskRunner treats high/urgent as proactive).
        const effectivePriority = schedule.priority === 'low' || schedule.priority === 'normal'
          ? 'high'
          : schedule.priority
        const taskId = queries.createTask(this.db, {
          description: `[Scheduled] ${schedule.task_template}`,
          sessionId: schedule.created_by_session,
          priority: effectivePriority,
          permissionMode: schedule.permission_mode,
          workingDir: schedule.working_dir,
        })

        // Compute next fire time
        let nextFireAt: number | null = null
        if (schedule.one_shot) {
          queries.deactivateSchedule(this.db, schedule.schedule_id)
        } else if (schedule.cron_parsed) {
          nextFireAt = nextCronFire(schedule.cron_parsed).getTime()
        }

        queries.updateScheduleAfterFire(this.db, schedule.schedule_id, nextFireAt)

        // Write confirmation message — always proactive priority so it
        // triggers a macOS notification. User scheduled this intentionally.
        queries.createMessage(this.db, {
          sessionId: schedule.created_by_session,
          taskId,
          kind: 'notification',
          priority: 'proactive',
          body: `⏰ Scheduled task fired: "${schedule.description}". Working on it now.`,
        })

        // Discord notification (replaces macOS osascript)
        void notifyScheduleFired({
          scheduleId: schedule.schedule_id,
          description: schedule.description,
        })

        firedTaskIds.push(taskId)
        log(`Schedule ${schedule.schedule_id} fired → task ${taskId}`)
      } catch (err) {
        logError(`Schedule ${schedule.schedule_id} fire failed`, err)
      }
    }

    return firedTaskIds
  }

  /**
   * Recompute all next_fire_at values on daemon startup.
   * Handles overdue schedules: fire if < 1hr overdue, skip if > 1hr.
   */
  recomputeOnStartup(): void {
    const active = queries.getActiveSchedules(this.db)
    const oneHourAgo = Date.now() - 3_600_000

    for (const schedule of active) {
      if (schedule.one_shot && schedule.next_fire_at && schedule.next_fire_at < Date.now()) {
        // One-shot that's overdue — fire if < 1hr overdue
        if (schedule.next_fire_at > oneHourAgo) {
          log(`Schedule ${schedule.schedule_id} is overdue (one-shot, <1hr). Will fire on next tick.`)
          // Leave next_fire_at as is — it's in the past, getDueSchedules will pick it up
        } else {
          log(`Schedule ${schedule.schedule_id} is overdue by >1hr (one-shot). Deactivating.`, 'warn')
          queries.deactivateSchedule(this.db, schedule.schedule_id)
        }
      } else if (!schedule.one_shot && schedule.cron_parsed) {
        // Recurring — recompute next fire from now
        const next = nextCronFire(schedule.cron_parsed)
        this.db.run(
          'UPDATE schedules SET next_fire_at = ? WHERE schedule_id = ?',
          [next.getTime(), schedule.schedule_id],
        )
      }
    }

    log(`Recomputed next_fire_at for ${active.length} active schedule(s)`)
  }
}
