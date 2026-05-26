// The daemon's running internal monologue. Every N minutes, reads the
// live StateSnapshot, asks the cheapest LLM in the catalog for a ≤200-
// word natural-language summary, publishes it as a 'narrative' event.

import { log, logError } from '../logger'
import type { EventBus } from './eventBus'
import type { StateSnapshot } from './stateSnapshot'
import type { ModelRouter } from '../llm/router'

const SYSTEM_PROMPT = `You are KAIROS's inner narrator. You are given a JSON snapshot of the user's current world state. Produce a concise natural-language summary (≤200 words) describing what the user is doing right now, what's open, what's recent, and any notable patterns. Be observational, not prescriptive. No suggestions, no actions — just describe.`

export type NarratorOptions = {
  intervalMs?: number
}

export class Narrator {
  private timer: ReturnType<typeof setInterval> | null = null
  private intervalMs: number

  constructor(
    private bus: EventBus,
    private snapshot: StateSnapshot,
    private router: ModelRouter,
    opts?: NarratorOptions,
  ) {
    this.intervalMs = opts?.intervalMs ?? 5 * 60_000
  }

  async start(): Promise<void> {
    log(`Narrator armed; tick every ${this.intervalMs / 1000}s`)
    await this.tick()
    this.timer = setInterval(() => { void this.tick() }, this.intervalMs)
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  async tick(): Promise<void> {
    const view = this.snapshot.read()
    if (!view.focus_app && view.open_tabs.length === 0 && view.recent_files.length === 0) {
      return
    }

    try {
      const result = await this.router.complete({
        task_type: 'narrative',
        system_blocks: [{ text: SYSTEM_PROMPT, cache_hint: 'long' }],
        prompt: `Current world state:\n${JSON.stringify(view, null, 2)}`,
        max_output_tokens: 300,
        latency_target: 'background',
      })
      this.bus.publish({
        source: 'narrator',
        kind: 'summary',
        payload: {
          text: result.text,
          provider: result.provider,
          model: result.model,
          cost_cents: result.cost_cents,
        },
      })
    } catch (err) {
      logError('Narrator tick failed', err)
    }
  }
}
