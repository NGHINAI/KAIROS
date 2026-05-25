// src/daemon/memory/dreamer.ts
// Hermes-Dreaming-inspired consolidation. Scores L2 episodes,
// uses LLM to extract facts, writes/reinforces L3 via reinforceOrWrite.

import type { Database } from 'bun:sqlite'
import { logError, log } from '../logger'
import type { EpisodicMemory, Episode } from './episodicMemory'
import type { SemanticMemory } from './semanticMemory'
import type { ModelRouter } from '../llm/router'

const SCORE_THRESHOLD = 0.4

const SYSTEM_PROMPT = `You consolidate raw work-session episodes into durable semantic facts. Given one episode summary, extract 0-5 facts worth remembering long-term about: the user's projects, people they interact with, preferences, recurring patterns, or important decisions. Be conservative — most episodes have 0-2 facts. Trivial/transient observations are not facts.

Output strict JSON:
{
  "facts": [
    { "kind": "fact" | "preference" | "person" | "project" | "pattern", "subject": "...", "body": "...", "importance": 0.0-1.0 }
  ]
}`

export type DreamerOptions = {
  embedder: (text: string) => Promise<number[]>
}

export class Dreamer {
  constructor(
    private db: Database,
    private episodic: EpisodicMemory,
    private semantic: SemanticMemory,
    private router: ModelRouter,
    private opts: DreamerOptions,
  ) {}

  score(e: Episode): number {
    const w_relevance  = 0.25
    const w_frequency  = 0.15
    const w_recency    = 0.20
    const w_diversity  = 0.10
    const w_richness   = 0.20
    const w_dup        = 0.10

    const ageHours = (Date.now() - e.ended_at) / 3_600_000
    const recency = Math.max(0, Math.min(1, 1 - ageHours / 168))
    const richness = Math.min(1, e.event_ids.length / 10)
    const relevance = e.importance
    const frequency = 0.5
    const diversity = 0.5
    const duplication = 0

    return w_relevance * relevance + w_frequency * frequency + w_recency * recency
         + w_diversity * diversity + w_richness * richness - w_dup * duplication
  }

  async consolidate(opts?: { maxEpisodes?: number }): Promise<number> {
    const max = opts?.maxEpisodes ?? 50
    const candidates = this.episodic.unpromoted(max)
    const dreamLogId = this.startDreamLog(candidates.length)
    let factsCreated = 0

    for (const ep of candidates) {
      const s = this.score(ep)
      if (s < SCORE_THRESHOLD) {
        this.episodic.markPromoted(ep.id)
        continue
      }

      try {
        const result = await this.router.complete({
          task_type: 'dream',
          system: SYSTEM_PROMPT,
          prompt: `Episode:\nType: ${ep.episode_type}\nTitle: ${ep.title}\nSummary: ${ep.summary}\nDuration: ${(ep.ended_at - ep.started_at) / 60_000}min`,
          structured: true,
          max_output_tokens: 400,
        })

        const parsed = result.parsed as { facts?: Array<{ kind: string; subject: string; body: string; importance: number }> } | undefined
        const facts = parsed?.facts ?? []

        for (const f of facts) {
          const emb = await this.opts.embedder(`${f.subject}: ${f.body}`)
          this.semantic.reinforceOrWrite({
            kind: f.kind as any,
            subject: f.subject,
            body: f.body,
            embedding: emb,
            importance: f.importance,
            source_episodes: [ep.id],
          })
          factsCreated++
        }

        this.episodic.markPromoted(ep.id)
      } catch (err) {
        logError(`Dreamer: episode ${ep.id} consolidation failed`, err)
      }
    }

    this.completeDreamLog(dreamLogId, candidates.length, factsCreated)
    log(`Dreamer: consolidated ${candidates.length} episodes → ${factsCreated} facts`)
    return factsCreated
  }

  private startDreamLog(episodeCount: number): number {
    const info = this.db.run(
      'INSERT INTO mem_dream_log (started_at, episodes_in) VALUES (?, ?)',
      [Date.now(), episodeCount],
    )
    return Number(info.lastInsertRowid)
  }

  private completeDreamLog(id: number, episodesIn: number, factsOut: number): void {
    this.db.run(
      'UPDATE mem_dream_log SET completed_at = ?, episodes_in = ?, facts_out = ? WHERE id = ?',
      [Date.now(), episodesIn, factsOut, id],
    )
  }
}
