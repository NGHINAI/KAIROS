// src/daemon/connectors/triggers/listener.ts
// Wraps composio.triggers.subscribe(). Each received event flows:
//   raw → normalizer → log (idempotent) → perception bus → metrics.
// Provides health monitoring; reconnect delegated to underlying SDK.

import type { TriggerEventLog } from './eventLog'
import type { TriggerNormalizer } from './normalizer'
import type { TriggerMetrics } from './metrics'
import type { ListenerHealth } from './types'

export type TriggerListenerDeps = {
  composio: {
    triggers: {
      subscribe(
        callback: (event: any) => void,
        opts?: any,
      ): Promise<{ unsubscribe: () => void }>
    }
  }
  eventLog: TriggerEventLog
  normalizer: TriggerNormalizer
  perceptionBus: { publish(kind: string, payload: any): void }
  metrics: TriggerMetrics
  onHealthChange?: (health: ListenerHealth) => void
}

export class TriggerListener {
  private subscription: { unsubscribe: () => void } | null = null
  private health: ListenerHealth = 'healthy'

  constructor(private deps: TriggerListenerDeps) {}

  async start(): Promise<void> {
    this.subscription = await this.deps.composio.triggers.subscribe((rawEvent: any) => {
      void this.handleEvent(rawEvent)
    })
    this.setHealth('healthy')
  }

  async stop(): Promise<void> {
    if (this.subscription) {
      try { this.subscription.unsubscribe() } catch { /* swallow */ }
      this.subscription = null
    }
  }

  getHealth(): ListenerHealth {
    return this.health
  }

  private setHealth(next: ListenerHealth): void {
    if (this.health === next) return
    this.health = next
    this.deps.onHealthChange?.(next)
  }

  private async handleEvent(raw: any): Promise<void> {
    const t0 = Date.now()
    let envelope
    try {
      envelope = this.deps.normalizer.normalize(raw)
    } catch (err) {
      this.deps.metrics.record('unknown', null, 'failed', 1)
      return
    }
    const inserted = this.deps.eventLog.record(envelope)
    if (!inserted) return   // duplicate — suppress

    try {
      this.deps.perceptionBus.publish('incoming_event', envelope)
      this.deps.eventLog.markProcessed(envelope.toolkit, envelope.event_id)
      this.deps.metrics.record(envelope.toolkit, null, 'received', 1)
      this.deps.metrics.record(envelope.toolkit, null, 'latency_ms', Date.now() - t0)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.deps.eventLog.markFailed(envelope.toolkit, envelope.event_id, msg)
      this.deps.metrics.record(envelope.toolkit, null, 'failed', 1)
    }
  }
}
