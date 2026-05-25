// src/daemon/proactive/observers/activityWatch.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { EventBus } from '../eventBus'
import { ActivityWatchObserver } from './activityWatch'

describe('ActivityWatchObserver', () => {
  let db: Database
  let bus: EventBus

  beforeEach(() => {
    db = new Database(':memory:')
    bus = new EventBus(db)
  })

  it('emits window_focus_duration events from probe', async () => {
    const obs = new ActivityWatchObserver(bus, {
      pollMs: 40,
      probe: async () => ({
        afk: false,
        currentApp: { app: 'Slack', title: 'general', durationSec: 47 },
        tabDwell: [],
      }),
    })
    await obs.start()
    await new Promise(r => setTimeout(r, 80))
    await obs.stop()
    const r = bus.recent(10)
    expect(r.some(e => e.kind === 'window_focus_duration')).toBe(true)
  })

  it('emits afk events when state changes', async () => {
    let afk = false
    const obs = new ActivityWatchObserver(bus, {
      pollMs: 30,
      probe: async () => ({ afk, currentApp: null, tabDwell: [] }),
    })
    await obs.start()
    await new Promise(r => setTimeout(r, 50))
    afk = true
    await new Promise(r => setTimeout(r, 80))
    await obs.stop()
    expect(bus.recent(20).some(e => e.kind === 'afk' && (e.payload as any).state === true)).toBe(true)
  })

  it('emits tab_dwell events only for tabs > 60 seconds', async () => {
    const obs = new ActivityWatchObserver(bus, {
      pollMs: 40,
      probe: async () => ({
        afk: false,
        currentApp: null,
        tabDwell: [
          { url: 'https://short.com', durationSec: 30 },
          { url: 'https://long.com', durationSec: 120 },
        ],
      }),
    })
    await obs.start()
    await new Promise(r => setTimeout(r, 80))
    await obs.stop()
    const tabs = bus.recent(20).filter(e => e.kind === 'tab_dwell').map(e => (e.payload as any).url as string)
    expect(tabs).toContain('https://long.com')
    expect(tabs).not.toContain('https://short.com')
  })

  it('disables gracefully when ActivityWatch is unreachable', async () => {
    const obs = new ActivityWatchObserver(bus, {
      pollMs: 30,
      probe: async () => { throw new Error('ECONNREFUSED') },
    })
    await obs.start()
    await new Promise(r => setTimeout(r, 80))
    await obs.stop()
    expect(bus.recent(10).filter(e => e.source === 'activity-watch').length).toBe(0)
  })
})
