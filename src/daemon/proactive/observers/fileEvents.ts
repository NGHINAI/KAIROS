// src/daemon/proactive/observers/fileEvents.ts
import { watch, type FSWatcher } from 'fs'
import { extname, join } from 'path'
import { Observer } from './base'
import type { EventBus } from '../eventBus'

const DEFAULT_IGNORE = ['.log', '.tmp', '.swp', '.DS_Store', '.lock']
const DEFAULT_DEBOUNCE_MS = 500

export type FileEventsOptions = {
  roots?: string[]
  ignoreExt?: string[]
  debounceMs?: number
}

export class FileEventsObserver extends Observer {
  readonly id = 'file-events'
  private watchers: FSWatcher[] = []
  private pending: Map<string, ReturnType<typeof setTimeout>> = new Map()
  private roots: string[]
  private ignoreExt: Set<string>
  private debounceMs: number

  constructor(bus: EventBus, opts?: FileEventsOptions) {
    super(bus)
    this.roots = opts?.roots ?? [join(process.env.HOME ?? '', 'Desktop')]
    this.ignoreExt = new Set(opts?.ignoreExt ?? DEFAULT_IGNORE)
    this.debounceMs = opts?.debounceMs ?? DEFAULT_DEBOUNCE_MS
  }

  protected onStart(): void {
    for (const root of this.roots) {
      try {
        const w = watch(root, { recursive: true }, (event, filename) => {
          if (!filename) return
          const fullPath = join(root, filename.toString())
          if (this.ignoreExt.has(extname(fullPath))) return
          this.debouncedEmit(fullPath, event)
        })
        this.watchers.push(w)
      } catch (err) {
        // root may not exist; skip silently
      }
    }
  }

  protected onStop(): void {
    for (const w of this.watchers) {
      try { w.close() } catch { /* ignore */ }
    }
    this.watchers = []
    for (const t of this.pending.values()) clearTimeout(t)
    this.pending.clear()
  }

  private debouncedEmit(path: string, event: string): void {
    const existing = this.pending.get(path)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.pending.delete(path)
      this.emit(event === 'rename' ? 'renamed' : 'modified', { path, event })
    }, this.debounceMs)
    this.pending.set(path, timer)
  }
}
