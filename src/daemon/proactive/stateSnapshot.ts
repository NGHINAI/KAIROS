// src/daemon/proactive/stateSnapshot.ts
// Live aggregated view of "what is the user's world right now?".
// Subscribes to all observer events and maintains an in-memory view
// that the narrator (and later, triggers + UI) read.

import type { EventBus, WorldEvent } from './eventBus'

const MAX_RECENT_FILES = 10
const CLIP_PREVIEW_LEN = 300

export type CalendarItem = { title: string; start: number; end?: number }

export type WorldStateView = {
  focus_app: { app: string; title?: string } | null
  open_tabs: string[]
  recent_files: string[]
  clipboard_preview: string | null
  upcoming_events: CalendarItem[]
  updated_at: number
}

export class StateSnapshot {
  private view: WorldStateView = {
    focus_app: null,
    open_tabs: [],
    recent_files: [],
    clipboard_preview: null,
    upcoming_events: [],
    updated_at: Date.now(),
  }

  constructor(private bus: EventBus) {
    bus.subscribe('*', this.handle.bind(this))
  }

  read(): WorldStateView {
    return { ...this.view, recent_files: [...this.view.recent_files], open_tabs: [...this.view.open_tabs] }
  }

  private handle(e: WorldEvent): void {
    this.view.updated_at = e.ts

    switch (e.source) {
      case 'focus-app': {
        const p = e.payload as { app?: string; title?: string }
        if (p.app) this.view.focus_app = { app: p.app, title: p.title }
        break
      }
      case 'browser-tabs': {
        const p = e.payload as { tabs?: string[] }
        if (Array.isArray(p.tabs)) this.view.open_tabs = p.tabs.slice()
        break
      }
      case 'file-events': {
        const p = e.payload as { path?: string }
        if (p.path) {
          this.view.recent_files = [p.path, ...this.view.recent_files.filter(f => f !== p.path)]
            .slice(0, MAX_RECENT_FILES)
        }
        break
      }
      case 'clipboard': {
        const p = e.payload as { text?: string }
        if (typeof p.text === 'string') {
          this.view.clipboard_preview = p.text.slice(0, CLIP_PREVIEW_LEN)
        }
        break
      }
      case 'calendar-local': {
        const p = e.payload as { events?: CalendarItem[] }
        if (Array.isArray(p.events)) this.view.upcoming_events = p.events.slice(0, 10)
        break
      }
    }
  }
}
