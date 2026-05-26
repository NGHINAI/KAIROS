// src/daemon/perception/tier1Classifier.ts
// Tier 1 — the cheapest gate. Given a batch of recent events, decide
// whether they're worth the user's attention. Returns one of:
//   SIGNIFICANT — pass to Tier 2
//   ROUTINE     — interesting for memory but not for interruption
//   SILENT      — drop entirely
//
// Fail-closed: on router error, return SILENT. Never spam on infra failure.

import { logError } from '../logger'
import type { ModelRouter } from '../llm/router'
import type { WorldEvent } from '../proactive/eventBus'

export type Tier1Verdict = 'SIGNIFICANT' | 'ROUTINE' | 'SILENT'

const SYSTEM_PROMPT = `You are KAIROS's first perception gate. Given a batch of recent events from the user's macOS, decide whether ANY of them are worth interrupting the user about.

Output EXACTLY one word:
- SIGNIFICANT: a message arrived that needs reply, a meeting is starting soon, an error in active work, a clipboard contains something needing action
- ROUTINE: events worth remembering (app switches, file edits, normal work) but not interruption-worthy
- SILENT: noise — repeated focus switches, polling artifacts, things that don't matter

Bias toward SILENT. The user is doing real work — only SIGNIFICANT for things that warrant breaking their flow.`

export class Tier1Classifier {
  constructor(private router: ModelRouter) {}

  async classify(events: WorldEvent[]): Promise<Tier1Verdict> {
    if (events.length === 0) return 'SILENT'

    try {
      const prompt = this.formatEvents(events)
      const result = await this.router.complete({
        task_type: 'classify',
        system_blocks: [{ text: SYSTEM_PROMPT, cache_hint: 'long' }],
        prompt,
        max_output_tokens: 10,
        latency_target: 'realtime',
      })
      return this.normalize(result.text)
    } catch (err) {
      logError('Tier1Classifier: router failure → fail-closed SILENT', err)
      return 'SILENT'
    }
  }

  private formatEvents(events: WorldEvent[]): string {
    const lines = events.map(e => `[${new Date(e.ts).toISOString().slice(11, 19)}] ${e.source}/${e.kind} ${JSON.stringify(e.payload).slice(0, 120)}`)
    return `Recent events (${events.length}):\n${lines.join('\n')}\n\nVerdict?`
  }

  private normalize(text: string): Tier1Verdict {
    const upper = text.toUpperCase()
    if (upper.includes('SIGNIFICANT')) return 'SIGNIFICANT'
    if (upper.includes('ROUTINE')) return 'ROUTINE'
    return 'SILENT'
  }
}
