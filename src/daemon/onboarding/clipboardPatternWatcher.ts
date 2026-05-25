// Waits for a specific regex pattern to appear in clipboard via EventBus.
// Returns the matched text or rejects on timeout/cancel.

import type { EventBus } from '../proactive/eventBus'

export class ClipboardPatternWatcher {
  private cancelRequested = false

  constructor(private bus: EventBus) {}

  async waitFor(pattern: RegExp, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      let resolved = false
      const cleanup: Array<() => void> = []

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true
          cleanup.forEach(c => c())
          reject(new Error(`ClipboardPatternWatcher: timeout after ${timeoutMs}ms waiting for ${pattern}`))
        }
      }, timeoutMs)
      cleanup.push(() => clearTimeout(timeout))

      const cancelPoll = setInterval(() => {
        if (this.cancelRequested && !resolved) {
          resolved = true
          cleanup.forEach(c => c())
          reject(new Error(`ClipboardPatternWatcher: cancelled`))
        }
      }, 50)
      cleanup.push(() => clearInterval(cancelPoll))

      const unsubscribe = this.bus.subscribe('clipboard', (e: any) => {
        if (resolved) return
        const text = e?.payload?.text
        if (typeof text !== 'string') return
        const match = text.match(pattern)
        if (match) {
          resolved = true
          cleanup.forEach(c => c())
          resolve(match[0])
        }
      })
      cleanup.push(unsubscribe)
    })
  }

  cancel(): void {
    this.cancelRequested = true
  }
}
