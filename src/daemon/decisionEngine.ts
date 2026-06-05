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
    // The tick "brain". Inject the OpenRouter completer (same one the conductor
    // uses) so autonomous decisions run on KAIROS's configured models — NOT the
    // unauthenticated `claude -p` CLI subprocess (which 401'd every tick).
    private llm?: { complete: (body: any) => Promise<{ text: string }> },
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

    // Run the tick decision through the injected OpenRouter completer (the tick
    // model — KAIROS_TICK_MODEL → KAIROS_FAST_MODEL). Replaces the old `claude -p`
    // subprocess, which 401'd on every tick because the Claude CLI wasn't
    // authenticated (and Anthropic is removed from the cloud path by design).
    if (!this.llm) {
      logError('Decision engine has no LLM completer wired — sleeping')
      return this.fallbackDecision('No tick LLM configured')
    }
    try {
      const resp = await this.llm.complete({
        messages: [
          { role: 'system', content: fullSystemPrompt },
          { role: 'user', content: taskPrompt },
        ],
        // 512, not 200: reasoning models (gpt-oss/nemotron) spend tokens in their
        // reasoning channel and return empty content if the budget is too small.
        max_tokens: Math.max(512, Number(process.env.KAIROS_FAST_MAX_TOKENS) || 0),
        temperature: 0,
      })
      const text = (resp.text ?? '').trim()
      if (!text) {
        logError('Tick LLM returned empty result')
        return this.fallbackDecision('Empty result from tick LLM')
      }
      // Cost is tracked centrally by the ModelRouter/CostTracker; pass 0 here.
      return this.parseDecision(text, 0)
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
