// Task runner: executes proactive WORK decisions through KAIROS's OWN in-house
// agent runner (runWork — the background sub-agent: our deep model on OpenRouter,
// with the user's memory/skills/Composio tools + approval gating). It used to
// spawn `claude -p` subprocesses; that path is GONE — the runtime must never call
// a claude model. runWork is injected (see index.ts → backgroundSub.manager
// .spawnAndWait), so the lane stays testable without booting the daemon.

import { mkdirSync } from 'fs'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { Database } from 'bun:sqlite'
import * as queries from './db'
import { log, logError } from './logger'
import type { Config } from './types'

export type TaskResult = {
  taskId: string
  status: 'success' | 'failed' | 'blocked'
  summary: string
  blockedApprovalId?: string
  costCents: number
}

/** Runs a goal to completion on KAIROS's own agent loop (deep model + tools +
 *  approval), returning the final spoken-style report. Wired to the background
 *  sub-agent manager's spawnAndWait. costCents is metered in the LLM ledger via
 *  the sub-agent's adapter, so it is not returned here (returns 0 below). */
export type RunWorkFn = (
  goal: string,
  opts: { conversationId?: string | null },
) => Promise<{ finalText: string; ok: boolean }>

export interface TaskRunnerDeps {
  runWork?: RunWorkFn
}

export class TaskRunner {
  private runningCount = 0
  private runWork?: RunWorkFn

  constructor(
    private db: Database,
    private config: Config,
    deps: TaskRunnerDeps = {},
  ) {
    this.runWork = deps.runWork
  }

  getRunningCount(): number {
    return this.runningCount
  }

  async runTask(taskId: string): Promise<TaskResult> {
    const task = queries.getTask(this.db, taskId)
    if (!task) {
      logError(`Task ${taskId} not found`)
      return { taskId, status: 'failed', summary: 'Task not found', costCents: 0 }
    }

    // Check concurrency limit
    if (this.runningCount >= this.config.task.maxConcurrent) {
      log(`Task ${taskId} waiting — concurrency limit (${this.config.task.maxConcurrent}) reached`)
      return { taskId, status: 'failed', summary: 'Concurrency limit reached', costCents: 0 }
    }

    if (!this.runWork) {
      // No in-house runner wired — fail loudly. We deliberately do NOT fall back
      // to a `claude -p` subprocess: the runtime must never invoke a claude model.
      logError(`Task ${taskId} cannot run — no work runner (background sub-agent) configured`)
      queries.updateTaskStatus(this.db, taskId, 'failed', {
        completedAt: Date.now(),
        resultSummary: 'No work runner configured',
      })
      return { taskId, status: 'failed', summary: 'No work runner configured — background agent unavailable', costCents: 0 }
    }

    // Mark as running
    queries.updateTaskStatus(this.db, taskId, 'running', {
      startedAt: Date.now(),
    })
    this.runningCount++

    // Build the work goal (the sub-agent's system prompt — persona/memory/skills —
    // is assembled by buildContext inside the runner, so we pass only the framing).
    const workPromptTemplate = this.loadWorkPrompt()
    const workPrompt = workPromptTemplate
      .replace('{{TASK_DESCRIPTION}}', task.description)
      .replace('{{WORKING_DIR}}', task.working_dir)
      .replace('{{PRIORITY}}', task.priority)
      .replace('{{PERMISSION_MODE}}', task.permission_mode)

    // Ensure task log directory
    const taskLogDir = join(this.config.sandboxDir, 'state', 'tasks', taskId)
    try { mkdirSync(taskLogDir, { recursive: true }) } catch { /* */ }

    log(`Starting task ${taskId}: "${task.description.slice(0, 60)}"`)

    try {
      // Run on KAIROS's OWN agent loop (deep model on OpenRouter + tools + approval
      // gating). A soft timeout bounds the wait; the sub-agent has its own lifecycle
      // (caps + cancel) so a slow run self-reports later rather than hanging the lane.
      const timeoutMs = this.config.task.timeoutMs
      let timedOut = false
      const work = this.runWork(workPrompt, { conversationId: task.session_id })
      const result = await Promise.race([
        work,
        new Promise<{ finalText: string; ok: boolean }>((resolve) =>
          setTimeout(() => { timedOut = true; resolve({ finalText: `Task exceeded ${Math.round(timeoutMs / 60000)}m and was left running in the background.`, ok: false }) }, timeoutMs),
        ),
      ])

      const resultText = result.finalText ?? ''
      // Spend is metered in the LLM ledger by the sub-agent's adapter, not returned here.
      const costCents = 0
      const exitCode = result.ok && !timedOut ? 0 : 1

      // Save a log of what was produced (debugging parity with the old stdout.log).
      try {
        await Bun.write(join(taskLogDir, 'goal.txt'), workPrompt)
        await Bun.write(join(taskLogDir, 'result.txt'), resultText)
      } catch { /* logging must never break the lane */ }

      // Check for blocked sentinel
      const blockedMatch = resultText.match(/STOP_NEEDS_APPROVAL:([\w-]+)/)
      if (blockedMatch) {
        const approvalId = blockedMatch[1]!
        queries.updateTaskStatus(this.db, taskId, 'blocked', {
          blockReason: 'Push-protection hook blocked a command',
          blockApprovalId: approvalId,
        })
        // Write inbox message
        queries.createMessage(this.db, {
          sessionId: task.session_id,
          taskId,
          kind: 'approval_request',
          priority: 'urgent',
          body: `🛡️ Task "${task.description.slice(0, 50)}" hit a push wall. Approval needed: ${approvalId}. Check the details with kairos_tasks(task_id="${taskId}").`,
        })
        log(`Task ${taskId} blocked on approval ${approvalId}`)
        this.runningCount--
        return { taskId, status: 'blocked', summary: resultText, blockedApprovalId: approvalId, costCents }
      }

      if (exitCode === 0) {
        // Increment tick count
        this.db.run('UPDATE tasks SET tick_count = tick_count + 1 WHERE task_id = ?', [taskId])

        const isWatching = task.watch === 1
        const isProactive = isWatching || task.priority === 'high' || task.priority === 'urgent'

        if (isWatching) {
          // ─── WATCHING TASK: re-queue for next check ─────────────
          // Don't mark as 'done' — set back to 'queued' so the scheduler
          // picks it up again after tick_interval seconds.
          // The task stays alive forever until the user explicitly cancels it.
          const interval = task.tick_interval ?? 300 // default 5 min
          queries.updateTaskStatus(this.db, taskId, 'queued', {
            resultSummary: resultText.slice(0, 2000),
            costCents: task.cost_cents + costCents,
            subprocessPid: null,
            // Use started_at as a "next eligible" marker:
            // scheduler should skip this task until Date.now() > started_at + tick_interval
            startedAt: Date.now(),
          })

          // Only notify if there's something interesting to report
          // (not every "nothing changed" check needs a message)
          const hasNews = resultText.length > 50 &&
            !resultText.toLowerCase().includes('no new') &&
            !resultText.toLowerCase().includes('nothing new') &&
            !resultText.toLowerCase().includes('no changes') &&
            !resultText.toLowerCase().includes('still the same')

          if (hasNews) {
            queries.createMessage(this.db, {
              sessionId: task.session_id,
              taskId,
              kind: 'task_result',
              priority: 'urgent',
              body: resultText.slice(0, 1000),
            })
            // Discord notification with richer embed
            const { notifyTaskResult } = await import('./notify')
            notifyTaskResult({
              taskId,
              description: `Watch: ${task.description.slice(0, 60)}`,
              status: 'success',
              summary: resultText,
            })
          }

          log(`Watch task ${taskId} check #${task.tick_count + 1} done. Re-queued (next in ${interval}s). Cost: $${(costCents / 100).toFixed(4)}`)
          this.runningCount--
          return { taskId, status: 'success', summary: resultText, costCents }
        }

        // ─── ONE-SHOT TASK: mark as done ──────────────────────────
        queries.updateTaskStatus(this.db, taskId, 'done', {
          completedAt: Date.now(),
          resultSummary: resultText.slice(0, 2000),
          costCents: task.cost_cents + costCents,
        })

        queries.createMessage(this.db, {
          sessionId: task.session_id,
          taskId,
          kind: 'task_result',
          priority: isProactive ? 'urgent' : 'normal',
          body: resultText.slice(0, 1000) || `✓ Task "${task.description.slice(0, 50)}" completed.`,
        })

        // Discord notification for high-priority one-shot results
        if (isProactive) {
          const { notifyTaskResult } = await import('./notify')
          notifyTaskResult({
            taskId,
            description: task.description.slice(0, 60),
            status: 'success',
            summary: resultText || `Task "${task.description.slice(0, 50)}" completed.`,
          })
        }

        // Add memory candidate
        this.db.run(
          `INSERT INTO memory_candidates (category, content, confidence, source_task_id, created_at)
           VALUES ('task_outcome', ?, 0.6, ?, ?)`,
          [`Completed: ${task.description}. Result: ${resultText.slice(0, 200)}`, taskId, Date.now()],
        )

        log(`Task ${taskId} done. Cost: $${(costCents / 100).toFixed(4)}`)
        this.runningCount--
        return { taskId, status: 'success', summary: resultText, costCents }
      } else {
        // The sub-agent didn't complete cleanly (ok:false or it timed out). Its
        // finalText is the human-readable reason.
        const reason = resultText.slice(0, 500) || 'The task did not complete.'
        queries.updateTaskStatus(this.db, taskId, 'failed', {
          completedAt: Date.now(),
          resultSummary: reason,
        })
        queries.createMessage(this.db, {
          sessionId: task.session_id,
          taskId,
          kind: 'error',
          priority: 'proactive',
          body: `✗ Task "${task.description.slice(0, 50)}" didn't complete. ${reason}`,
        })
        // Discord notification on failure
        const { notifyTaskResult } = await import('./notify')
        notifyTaskResult({
          taskId,
          description: task.description.slice(0, 60),
          status: 'failed',
          summary: reason,
        })
        log(`Task ${taskId} failed: ${reason.slice(0, 120)}`, 'warn')
        this.runningCount--
        return { taskId, status: 'failed', summary: reason, costCents }
      }
    } catch (err) {
      logError(`Task ${taskId} exception`, err)
      queries.updateTaskStatus(this.db, taskId, 'failed', {
        completedAt: Date.now(),
        resultSummary: `Exception: ${err instanceof Error ? err.message : String(err)}`,
      })
      this.runningCount--
      return {
        taskId,
        status: 'failed',
        summary: err instanceof Error ? err.message : String(err),
        costCents: 0,
      }
    }
  }

  async investigate(topic: string): Promise<void> {
    log(`Investigating: ${topic}`)
    if (!this.runWork) {
      logError('Investigate skipped — no work runner (background sub-agent) configured')
      return
    }
    // Run a lightweight, read-only investigation on KAIROS's own agent loop.
    try {
      const prompt = `You are KAIROS investigating something briefly. Topic: ${topic}

Look into this quickly. Read files, check git status, run non-destructive (read-only) commands.
Don't modify anything. Report what you find in 2-3 sentences.`

      const { finalText } = await this.runWork(prompt, { conversationId: null })
      const result = finalText ?? ''

      // Store as memory candidate
      this.db.run(
        `INSERT INTO memory_candidates (category, content, confidence, created_at)
         VALUES ('observation', ?, 0.4, ?)`,
        [`Investigation: ${topic} → ${result.slice(0, 300)}`, Date.now()],
      )
      log(`Investigation complete: ${result.slice(0, 100)}`)
    } catch (err) {
      logError('Investigation failed', err)
    }
  }

  private loadWorkPrompt(): string {
    const path = join(this.config.sandboxDir, 'src', 'prompts', 'work-prompt.md')
    if (existsSync(path)) {
      return readFileSync(path, 'utf8')
    }
    return 'Task: {{TASK_DESCRIPTION}}\nWorking dir: {{WORKING_DIR}}\nDo the work and summarize when done.'
  }
}
