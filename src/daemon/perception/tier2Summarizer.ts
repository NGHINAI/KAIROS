// src/daemon/perception/tier2Summarizer.ts
// Tier 2 — runs only when Tier 1 said SIGNIFICANT.
// Produces a short description + significance score (0-1) +
// episode_type. The score is what gates Tier 3 (narrator).

import { logError } from '../logger'
import type { ModelRouter } from '../llm/router'
import type { WorldEvent } from '../proactive/eventBus'

const SYSTEM_PROMPT = `You are KAIROS's Tier-2 perception layer. Given recent events + the user's standing orders, produce:
- description: 1-2 sentences naming what happened
- score: 0.0-1.0 significance (0 = noise, 1 = drop-everything urgent)
- episode_type: one of work_session | communication | browsing | system | reminder | other

If events match a standing order, score >= 0.7 baseline.
If events are mundane (app switching, normal clipboard, file edits in current work), score < 0.5.
If events suggest something urgent (incoming message, calendar conflict, error, password in clipboard), score >= 0.8.

Output strict JSON:
{ "description": "...", "score": 0.X, "episode_type": "..." }`

export type Tier2Result = {
  description: string
  score: number
  episode_type: string
}

export class Tier2Summarizer {
  constructor(private router: ModelRouter) {}

  async summarize(events: WorldEvent[], standingOrdersText: string): Promise<Tier2Result> {
    try {
      const eventLines = events.map(e => `[${new Date(e.ts).toISOString().slice(11, 19)}] ${e.source}/${e.kind} ${JSON.stringify(e.payload).slice(0, 200)}`).join('\n')
      const prompt = `Standing orders:\n${standingOrdersText || '(none)'}\n\nRecent events:\n${eventLines}\n\nProduce the JSON.`
      const result = await this.router.complete({
        task_type: 'action_compose',
        system_blocks: [{ text: SYSTEM_PROMPT, cache_hint: 'long' }],
        prompt,
        structured: true,
        max_output_tokens: 300,
        latency_target: 'standard',
      })
      const parsed = result.parsed as { description?: string; score?: number; episode_type?: string } | undefined
      return {
        description: parsed?.description ?? 'unknown',
        score: clamp(parsed?.score ?? 0, 0, 1),
        episode_type: parsed?.episode_type ?? 'other',
      }
    } catch (err) {
      logError('Tier2Summarizer: router failure → fail-closed score 0', err)
      return { description: '', score: 0, episode_type: 'other' }
    }
  }
}

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo
  if (n > hi) return hi
  return n
}
