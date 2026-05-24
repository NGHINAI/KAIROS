// Task runner: spawns `claude -p` subprocesses to execute WORK decisions.
// Each task gets its own subprocess with the system prompt + work prompt.

import { existsSync, mkdirSync, readFileSync } from 'fs'
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

export class TaskRunner {
  private runningCount = 0
  private systemPrompt: string

  constructor(
    private db: Database,
    private config: Config,
  ) {
    const sysPath = join(config.sandboxDir, 'src', 'prompts', 'system.md')
    this.systemPrompt = existsSync(sysPath)
      ? readFileSync(sysPath, 'utf8')
      : 'You are KAIROS, an autonomous assistant.'

    // Load memory if available
    const memPath = join(config.sandboxDir, 'state', 'MEMORY.md')
    if (existsSync(memPath)) {
      this.systemPrompt += '\n\n# Your memory\n\n' + readFileSync(memPath, 'utf8')
    }
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

    // Mark as running
    queries.updateTaskStatus(this.db, taskId, 'running', {
      startedAt: Date.now(),
    })
    this.runningCount++

    // Build work prompt
    const workPromptTemplate = this.loadWorkPrompt()
    const workPrompt = workPromptTemplate
      .replace('{{TASK_DESCRIPTION}}', task.description)
      .replace('{{WORKING_DIR}}', task.working_dir)
      .replace('{{PRIORITY}}', task.priority)
      .replace('{{PERMISSION_MODE}}', task.permission_mode)

    // Ensure task log directory
    const taskLogDir = join(this.config.sandboxDir, 'state', 'tasks', taskId)
    mkdirSync(taskLogDir, { recursive: true })

    log(`Starting task ${taskId}: "${task.description.slice(0, 60)}"`)

    try {
      // Spawn claude -p
      const args = [
        'claude', '-p',
        '--model', this.config.models.work,
        '--output-format', 'json',
      ]

      // Permission mode mapping
      const modeMap: Record<string, string> = {
        auto: 'auto',
        bypass: 'bypassPermissions',
        trusted: 'dangerouslySkipPermissions',
      }
      const permFlag = modeMap[task.permission_mode] ?? 'auto'
      if (permFlag === 'bypassPermissions') {
        args.push('--permission-mode', 'bypassPermissions')
      } else if (permFlag === 'dangerouslySkipPermissions') {
        args.push('--dangerously-skip-permissions')
      }

      const fullPrompt = `${this.systemPrompt}\n\n---\n\n${workPrompt}`

      // Write prompt to temp file — Blob stdin doesn't reliably pipe to claude -p
      const promptFile = join(this.config.sandboxDir, 'runtime', `work-prompt-${taskId}.txt`)
      const { writeFileSync: writeSync } = await import('fs')
      writeSync(promptFile, fullPrompt)

      const proc = Bun.spawn(args, {
        cwd: task.working_dir,
        stdin: Bun.file(promptFile),
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...process.env,
          KAIROS_SUBPROCESS: '1',  // Prevent recursive MCP loading
          KAIROS_TASK_ID: taskId,
          KAIROS_SANDBOX_DIR: this.config.sandboxDir,
        },
      })

      // Update subprocess PID
      queries.updateTaskStatus(this.db, taskId, 'running', {
        subprocessPid: proc.pid,
      })

      // Set up timeout
      const timeoutHandle = setTimeout(() => {
        log(`Task ${taskId} timed out after ${this.config.task.timeoutMs}ms`, 'warn')
        proc.kill('SIGTERM')
      }, this.config.task.timeoutMs)

      // Wait for completion
      const stdout = await new Response(proc.stdout).text()
      const stderr = await new Response(proc.stderr).text()
      const exitCode = await proc.exited
      clearTimeout(timeoutHandle)

      // Save logs
      await Bun.write(join(taskLogDir, 'stdout.log'), stdout)
      await Bun.write(join(taskLogDir, 'stderr.log'), stderr)
      await Bun.write(join(taskLogDir, 'prompt.txt'), fullPrompt)

      // Parse result
      let resultText = stdout
      let costCents = 0
      try {
        const parsed = JSON.parse(stdout)
        resultText = (parsed.result ?? '') as string
        costCents = Math.round(((parsed.total_cost_usd ?? parsed.cost_usd ?? 0) as number) * 100)
      } catch {
        // Raw text output
      }

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
        queries.updateTaskStatus(this.db, taskId, 'failed', {
          completedAt: Date.now(),
          resultSummary: `Exit code ${exitCode}: ${stderr.slice(0, 500)}`,
        })
        queries.createMessage(this.db, {
          sessionId: task.session_id,
          taskId,
          kind: 'error',
          priority: 'proactive',
          body: `✗ Task "${task.description.slice(0, 50)}" failed (exit ${exitCode}). Check logs: state/tasks/${taskId}/`,
        })
        // Discord notification on failure
        const { notifyTaskResult } = await import('./notify')
        notifyTaskResult({
          taskId,
          description: task.description.slice(0, 60),
          status: 'failed',
          summary: `Exit code ${exitCode}.\n\nstderr:\n${stderr.slice(0, 1500)}`,
        })
        log(`Task ${taskId} failed with exit code ${exitCode}`, 'warn')
        this.runningCount--
        return { taskId, status: 'failed', summary: stderr.slice(0, 500), costCents }
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
    // Spawn a lightweight read-only subprocess
    try {
      const prompt = `You are KAIROS investigating something briefly. Topic: ${topic}

Look into this quickly. Read files, check git status, run non-destructive commands.
Don't modify anything. Report what you find in 2-3 sentences.`

      // Write prompt to temp file (Blob stdin unreliable with claude -p)
      const invFile = join(this.config.sandboxDir, 'runtime', 'investigate-prompt.txt')
      const { writeFileSync: ws } = await import('fs')
      ws(invFile, `${this.systemPrompt}\n\n---\n\n${prompt}`)

      const proc = Bun.spawn([
        'claude', '-p',
        '--output-format', 'json',
      ], {
        stdin: Bun.file(invFile),
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...process.env,
          KAIROS_SUBPROCESS: '1',  // Prevent recursive MCP loading
        },
      })

      const stdout = await new Response(proc.stdout).text()
      await proc.exited

      let result = stdout
      try {
        const parsed = JSON.parse(stdout)
        result = (parsed.result ?? '') as string
      } catch { /* raw text */ }

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
