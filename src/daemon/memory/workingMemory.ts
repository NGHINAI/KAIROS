// src/daemon/memory/workingMemory.ts
// L1 — working memory. An in-memory ring buffer of the last N minutes of
// events (or last K events, whichever is smaller). This is what the
// perception pipeline reads to decide if "something just happened".

import type { EventBus, WorldEvent } from '../proactive/eventBus'

export type WorkingMemoryOptions = {
  windowMs?: number
  maxEvents?: number
}

export class WorkingMemory {
  private events: WorldEvent[] = []
  private windowMs: number
  private maxEvents: number

  constructor(bus: EventBus, opts?: WorkingMemoryOptions) {
    this.windowMs = opts?.windowMs ?? 10 * 60_000
    this.maxEvents = opts?.maxEvents ?? 500
    bus.subscribe('*', e => this.ingest(e))
  }

  snapshot(): WorldEvent[] {
    this.evictOld()
    return this.events.slice()
  }

  groupedBySource(): Record<string, WorldEvent[]> {
    this.evictOld()
    const groups: Record<string, WorldEvent[]> = {}
    for (const e of this.events) {
      ;(groups[e.source] ?? (groups[e.source] = [])).push(e)
    }
    return groups
  }

  countSince(tsMs: number): number {
    this.evictOld()
    return this.events.filter(e => e.ts >= tsMs).length
  }

  private ingest(e: WorldEvent): void {
    this.events.push(e)
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents)
    }
    this.evictOld()
  }

  private evictOld(): void {
    const cutoff = Date.now() - this.windowMs
    let i = 0
    while (i < this.events.length && this.events[i]!.ts < cutoff) i++
    if (i > 0) this.events.splice(0, i)
  }
}
