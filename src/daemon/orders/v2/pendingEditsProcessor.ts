// src/daemon/orders/v2/pendingEditsProcessor.ts
// Periodically drains PendingEditsQueue. Each ready row → handleSpeechDirect.
// Success → markDone. Failure → markRetried (queue handles backoff + max-retries).

import type { PendingEditsQueue } from './pendingEdits'

export type PendingEditsProcessorDeps = {
  queue: PendingEditsQueue
  author: { handleSpeechDirect(text: string): Promise<{ created_slug: string | null; similar_existing?: string }> }
  now?: () => number
  onFailed?: (speech: string, lastError: string) => void
}

export class PendingEditsProcessor {
  private timer: ReturnType<typeof setInterval> | null = null
  private now: () => number

  constructor(private deps: PendingEditsProcessorDeps) {
    this.now = deps.now ?? Date.now
  }

  async runOnce(): Promise<void> {
    const ready = this.deps.queue.listReadyForRetry(this.now())
    for (const row of ready) {
      try {
        await this.deps.author.handleSpeechDirect(row.speech)
        this.deps.queue.markDone(row.id)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        this.deps.queue.markRetried(row.id, msg, this.now())
        const refreshed = this.deps.queue.listAll().find(r => r.id === row.id)
        if (refreshed?.status === 'failed') this.deps.onFailed?.(row.speech, msg)
      }
    }
  }

  start(intervalMs: number = 5 * 60 * 1000): void {
    if (this.timer) return
    this.timer = setInterval(() => { this.runOnce().catch(() => {}) }, intervalMs)
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }
}
