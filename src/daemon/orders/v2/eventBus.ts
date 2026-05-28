// src/daemon/orders/v2/eventBus.ts
// In-process typed pub/sub for rule chaining. Per-emit depth counter prevents
// infinite chain loops (cap = 10 hops). Not persisted; restarts reset state.

export type EventHandler = (payload: Record<string, unknown>) => void

const MAX_CHAIN_DEPTH = 10

export class RulesEventBus {
  private listeners = new Map<string, Set<EventHandler>>()
  private currentDepth = 0

  on(event: string, handler: EventHandler): void {
    let s = this.listeners.get(event)
    if (!s) { s = new Set(); this.listeners.set(event, s) }
    s.add(handler)
  }

  off(event: string, handler: EventHandler): void {
    this.listeners.get(event)?.delete(handler)
  }

  emit(event: string, payload: Record<string, unknown>): void {
    if (this.currentDepth >= MAX_CHAIN_DEPTH) return
    this.currentDepth++
    try {
      const handlers = this.listeners.get(event)
      if (!handlers) return
      for (const h of handlers) {
        try { h(payload) } catch {/* swallow per-listener errors */}
      }
    } finally {
      this.currentDepth--
    }
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0
  }
}
