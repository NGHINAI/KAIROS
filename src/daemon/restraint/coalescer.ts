// src/daemon/restraint/coalescer.ts
// Collapses repeated events from the same source within a short window into
// one composite event. Reduces 100 git-related file-events to one batch.

type EventLike = {
  source: string
  kind: string
  payload: Record<string, unknown>
}

export type CoalescedBatch = {
  source: string
  count: number
  events: EventLike[]
  summary: string
  common_prefix?: string
}

export type CoalescerOptions = {
  windowMs?: number   // default 60_000
}

type FlushCallback = (batch: CoalescedBatch) => void

export class Coalescer {
  private buffers: Map<string, EventLike[]> = new Map()
  private timers: Map<string, ReturnType<typeof setTimeout>> = new Map()
  private flushCallbacks: FlushCallback[] = []
  private windowMs: number

  constructor(opts?: CoalescerOptions) {
    this.windowMs = opts?.windowMs ?? 60_000
  }

  onFlush(cb: FlushCallback): void {
    this.flushCallbacks.push(cb)
  }

  add(event: EventLike): void {
    const buf = this.buffers.get(event.source) ?? []
    buf.push(event)
    this.buffers.set(event.source, buf)
    // Reset timer for this source — flush after windowMs of silence
    const existing = this.timers.get(event.source)
    if (existing) clearTimeout(existing)
    const t = setTimeout(() => this.flushSource(event.source), this.windowMs)
    this.timers.set(event.source, t)
  }

  private flushSource(source: string): void {
    const buf = this.buffers.get(source)
    if (!buf || buf.length === 0) return
    this.buffers.delete(source)
    this.timers.delete(source)

    const batch: CoalescedBatch = {
      source,
      count: buf.length,
      events: buf,
      summary: `${buf.length} events from ${source}`,
      common_prefix: this.findCommonPrefix(buf),
    }
    for (const cb of this.flushCallbacks) {
      try { cb(batch) } catch { /* ignore */ }
    }
  }

  private findCommonPrefix(events: EventLike[]): string | undefined {
    const paths = events
      .map(e => (e.payload as any).path)
      .filter((p): p is string => typeof p === 'string')
    if (paths.length === 0) return undefined
    let prefix = paths[0]!
    for (const p of paths.slice(1)) {
      while (!p.startsWith(prefix) && prefix.length > 0) {
        prefix = prefix.slice(0, -1)
      }
      if (prefix.length === 0) break
    }
    return prefix || undefined
  }
}
