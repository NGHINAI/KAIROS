// The decision engine. Assembles tick prompts, spawns claude -p (Haiku),
// parses the structured decision response.
// If KAIROS_MOCK_DECISIONS=1 env var is set, returns hardcoded decisions
// without calling Claude (for Phase 3 testing / cost-free development).

import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { Database } from 'bun:sqlite'
import * as queries from './db'
import { log, logError } from './logger'
import { buildTickContext } from './tickContext'
import { BudgetTracker } from './budgets'
import type { Config, Decision, TickEvent } from './types'

export class DecisionEngine {
  private systemPrompt = ''
  private tickTemplate = ''
  private budgets: BudgetTracker
  private startedAt = Date.now()

  constructor(
    private db: Database,
    private config: Config,
  ) {
    this.budgets = new BudgetTracker(db, config.budget)
    this.loadPrompts()
  }

  getBudgets(): BudgetTracker {
    return this.budgets
  }

  private loadPrompts(): void {
    const promptsDir = join(this.config.sandboxDir, 'src', 'prompts')

    const systemPath = join(promptsDir, 'system.md')
    if (existsSync(systemPath)) {
      this.systemPrompt = readFileSync(systemPath, 'utf8')
    } else {
      this.systemPrompt = 'You are KAIROS, an autonomous assistant. Be concise.'
    }

    const tickPath = join(promptsDir, 'tick-decision.md')
    if (existsSync(tickPath)) {
      this.tickTemplate = readFileSync(tickPath, 'utf8')
    }
  }

  async decide(event: TickEvent): Promise<Decision> {
    // Mock mode: skip LLM, return hardcoded decisions
    if (process.env.KAIROS_MOCK_DECISIONS === '1') {
      return this.mockDecision(event)
    }

    // Over budget: force sleep
    if (this.budgets.isOverBudget()) {
      return {
        kind: 'SLEEP',
        seconds: 1800,
        reasoning: 'Over budget. Sleeping 30 minutes until budget window resets.',
        costCents: 0,
        model: 'budget-override',
      }
    }

    // Assemble context
    const budget = this.budgets.snapshot()
    const context = buildTickContext({
      db: this.db,
      triggerSource: event.source,
      triggerReason: event.reason,
      budget,
      uptime: Date.now() - this.startedAt,
    })

    // Load memory if exists
    const memoryPath = join(this.config.sandboxDir, 'state', 'MEMORY.md')
    const memory = existsSync(memoryPath)
      ? readFileSync(memoryPath, 'utf8')
      : '(No memory yet — first session.)'

    // Build full system prompt
    const fullSystemPrompt = [
      this.systemPrompt,
      '',
      '# Your memory',
      '',
      memory,
    ].join('\n')

    // Build the task prompt
    const taskPrompt = this.tickTemplate
      ? this.tickTemplate.replace('{{CONTEXT}}', context)
      : `${context}\n\nDecide what to do. Output:\nDECISION: <verb> <args>\nREASONING: <one sentence>`

    // Spawn claude -p for tick decision.
    // Write prompt to temp file and pipe via Bun.file() — Blob stdin doesn't
    // reliably pipe to claude -p subprocess.
    try {
      const promptFile = join(this.config.sandboxDir, 'runtime', 'tick-prompt.txt')
      const { writeFileSync } = await import('fs')
      writeFileSync(promptFile, `${fullSystemPrompt}\n\n---\n\n${taskPrompt}`)

      const proc = Bun.spawn([
        'claude', '-p',
        '--output-format', 'json',
      ], {
        stdin: Bun.file(promptFile),
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...process.env,
          KAIROS_SUBPROCESS: '1',  // Prevent recursive MCP loading
        },
      })

      const stdout = await new Response(proc.stdout).text()
      const exitCode = await proc.exited

      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text()
        logError(`Tick subprocess exited ${exitCode}: ${stderr.slice(0, 200)}`)
        return this.fallbackDecision('Subprocess failed')
      }

      // Parse claude JSON output
      // claude -p --output-format json returns:
      //   { "type": "result", "result": "...", "total_cost_usd": 0.001, ... }
      const parsed = JSON.parse(stdout)
      const text = (parsed.result ?? '') as string
      const costUsd = (parsed.total_cost_usd ?? parsed.cost_usd ?? 0) as number

      if (!text) {
        logError(`Tick subprocess returned empty result. Raw output: ${stdout.slice(0, 200)}`)
        return this.fallbackDecision('Empty result from Claude')
      }

      return this.parseDecision(text, Math.round(costUsd * 100))
    } catch (err) {
      logError('Decision engine error', err)
      return this.fallbackDecision('Exception in decision engine')
    }
  }

  private parseDecision(text: string, costCents: number): Decision {
    const lines = text.trim().split('\n')
    const decisionLine = lines.find(l => l.startsWith('DECISION:'))
    const reasoningLine = lines.find(l => l.startsWith('REASONING:'))

    if (!decisionLine) {
      return this.fallbackDecision(`Could not parse: ${text.slice(0, 100)}`)
    }

    const reasoning = reasoningLine?.replace(/^REASONING:\s*/, '').trim() ?? ''
    const decisionText = decisionLine.replace(/^DECISION:\s*/, '').trim()
    const parts = decisionText.split(/\s+/)
    const verb = parts[0]

    const model = this.config.models.tick

    switch (verb) {
      case 'SLEEP':
        return { kind: 'SLEEP', seconds: parseInt(parts[1] ?? '60') || 60, reasoning, costCents, model }

      case 'WORK':
        return { kind: 'WORK', taskId: parts[1] ?? '', reasoning, costCents, model }

      case 'INVESTIGATE':
        return { kind: 'INVESTIGATE', topic: parts.slice(1).join(' '), reasoning, costCents, model }

      case 'NOTIFY': {
        const sessionId = parts[1] ?? 'broadcast'
        const priority = parts[2] as 'normal' | 'proactive' | 'urgent' ?? 'normal'
        const body = parts.slice(3).join(' ')
        return { kind: 'NOTIFY', body, sessionId, priority, reasoning, costCents, model }
      }

      case 'CONSOLIDATE':
        return { kind: 'CONSOLIDATE', reasoning, costCents, model }

      default:
        return this.fallbackDecision(`Unknown verb: ${verb}`)
    }
  }

  private mockDecision(event: TickEvent): Decision {
    // In mock mode: if there are queued tasks, WORK on the first one.
    // Otherwise SLEEP.
    const queued = queries.getQueuedTasks(this.db)
    if (queued.length > 0) {
      return {
        kind: 'WORK',
        taskId: queued[0]!.task_id,
        reasoning: `[mock] Queue has ${queued.length} task(s), working on first.`,
        costCents: 0,
        model: 'mock',
      }
    }
    return {
      kind: 'SLEEP',
      seconds: 60,
      reasoning: `[mock] Queue empty, sleeping. Trigger: ${event.source}`,
      costCents: 0,
      model: 'mock',
    }
  }

  private fallbackDecision(reason: string): Decision {
    return {
      kind: 'SLEEP',
      seconds: 60,
      reasoning: `Fallback: ${reason}`,
      costCents: 0,
      model: 'fallback',
    }
  }
}
