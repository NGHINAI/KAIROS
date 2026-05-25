// src/daemon/proactive/observerRegistry.ts
import { log, logError } from '../logger'
import type { EventBus } from './eventBus'
import type { Observer } from './observers/base'

export class ObserverRegistry {
  private observers: Observer[] = []

  constructor(private bus: EventBus) {}

  register(obs: Observer): void {
    if (this.observers.some(o => o.id === obs.id)) {
      log(`ObserverRegistry: ${obs.id} already registered, skipping`, 'warn')
      return
    }
    this.observers.push(obs)
  }

  async startAll(): Promise<void> {
    for (const o of this.observers) {
      try {
        await o.start()
        log(`Observer started: ${o.id}`)
      } catch (err) {
        logError(`Observer ${o.id} failed to start`, err)
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const o of this.observers) {
      try { await o.stop() } catch (err) { logError(`Observer ${o.id} stop failed`, err) }
    }
  }

  list(): string[] {
    return this.observers.map(o => o.id)
  }
}
