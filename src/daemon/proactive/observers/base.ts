// src/daemon/proactive/observers/base.ts
// Each observer is a long-lived component that watches one channel
// of OS state and publishes events into the bus when state changes.

import type { EventBus, WorldEventInput } from '../eventBus'

export abstract class Observer {
  abstract readonly id: string
  private started = false

  constructor(protected bus: EventBus) {}

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    await this.onStart()
  }

  async stop(): Promise<void> {
    if (!this.started) return
    this.started = false
    await this.onStop()
  }

  protected emit(kind: string, payload: Record<string, unknown>): void {
    this.bus.publish({ source: this.id, kind, payload } satisfies WorldEventInput)
  }

  protected abstract onStart(): void | Promise<void>
  protected abstract onStop(): void | Promise<void>
}
