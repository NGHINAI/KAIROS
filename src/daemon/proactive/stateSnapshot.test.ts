// src/daemon/proactive/stateSnapshot.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { EventBus } from './eventBus'
import { StateSnapshot } from './stateSnapshot'

describe('StateSnapshot', () => {
  let db: Database
  let bus: EventBus
  let snap: StateSnapshot

  beforeEach(() => {
    db = new Database(':memory:')
    bus = new EventBus(db)
    snap = new StateSnapshot(bus)
  })

  it('starts empty', () => {
    const view = snap.read()
    expect(view.focus_app).toBeNull()
    expect(view.open_tabs).toEqual([])
    expect(view.recent_files).toEqual([])
    expect(view.clipboard_preview).toBeNull()
    expect(view.upcoming_events).toEqual([])
  })

  it('tracks the most recent focus_app', () => {
    bus.publish({ source: 'focus-app', kind: 'app_changed', payload: { app: 'VS Code', title: 'kairos' } })
    bus.publish({ source: 'focus-app', kind: 'app_changed', payload: { app: 'Slack',   title: 'general' } })
    expect(snap.read().focus_app).toEqual({ app: 'Slack', title: 'general' })
  })

  it('replaces open_tabs with the latest tab list', () => {
    bus.publish({ source: 'browser-tabs', kind: 'tabs_changed', payload: { browser: 'Arc', tabs: ['a', 'b'] } })
    expect(snap.read().open_tabs).toEqual(['a', 'b'])
    bus.publish({ source: 'browser-tabs', kind: 'tabs_changed', payload: { browser: 'Arc', tabs: ['c'] } })
    expect(snap.read().open_tabs).toEqual(['c'])
  })

  it('keeps the last N recent_files (newest first)', () => {
    for (let i = 0; i < 12; i++) {
      bus.publish({ source: 'file-events', kind: 'modified', payload: { path: `/f${i}` } })
    }
    const view = snap.read()
    expect(view.recent_files.length).toBe(10)
    expect(view.recent_files[0]).toBe('/f11')
  })

  it('truncates clipboard preview to 300 chars', () => {
    const long = 'x'.repeat(1000)
    bus.publish({ source: 'clipboard', kind: 'changed', payload: { text: long } })
    expect(snap.read().clipboard_preview?.length).toBe(300)
  })

  it('stores upcoming_events from calendar events', () => {
    bus.publish({
      source: 'calendar-local',
      kind: 'upcoming',
      payload: { events: [{ title: 'Standup', start: 1700000000000 }] },
    })
    expect(snap.read().upcoming_events.length).toBe(1)
    expect(snap.read().upcoming_events[0]?.title).toBe('Standup')
  })
})
