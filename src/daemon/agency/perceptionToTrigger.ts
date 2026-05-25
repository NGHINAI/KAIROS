// src/daemon/agency/perceptionToTrigger.ts
// Glue: after PerceptionPipeline writes an episode, this bridge publishes
// a synthetic 'episode-written' event back into the bus so the
// TriggerEngine can react to it like any other observer event.
//
// We track last-republished episode id in memory; on daemon restart the
// caller seeds it via setHighWaterMark(epId) so we don't re-fire triggers
// for episodes the user has already seen.

import { log } from '../logger'
import type { EventBus } from '../proactive/eventBus'
import type { EpisodicMemory } from '../memory/episodicMemory'

export class PerceptionToTrigger {
  private highWater: number = 0

  constructor(private bus: EventBus, private episodic: EpisodicMemory) {}

  setHighWaterMark(epId: number): void {
    this.highWater = epId
  }

  async republishLatest(): Promise<void> {
    const recent = this.episodic.recent(20)
    const fresh = recent.filter(e => e.id > this.highWater)
    if (fresh.length === 0) return

    // recent() returns newest-first. Republish chronologically (oldest first)
    // so trigger evaluation order matches episode creation order.
    for (const ep of [...fresh].reverse()) {
      this.bus.publish({
        source: 'episode-written',
        kind: ep.episode_type,
        payload: {
          episode_id: ep.id,
          title: ep.title,
          summary: ep.summary,
          importance: ep.importance,
          event_ids: ep.event_ids,
        },
      })
      this.highWater = Math.max(this.highWater, ep.id)
    }
    log(`PerceptionToTrigger: republished ${fresh.length} episode(s) up to id ${this.highWater}`)
  }
}
