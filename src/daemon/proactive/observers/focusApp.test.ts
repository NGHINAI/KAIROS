// src/daemon/proactive/observers/focusApp.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { EventBus } from '../eventBus'
import { FocusAppObserver } from './focusApp'

describe('FocusAppObserver', () => {
  let db: Database
  let bus: EventBus

  beforeEach(() => {
    db = new Database(':memory:')
    bus = new EventBus(db)
  })

  it('emits app_changed when app differs from last', async () => {
    let nextApp = { app: 'Safari', title: 'home' }
    const obs = new FocusAppObserver(bus, {
      pollMs: 50,
      probe: async () => nextApp,
    })
    await obs.start()
    await new Promise(r => setTimeout(r, 120))
    nextApp = { app: 'Slack', title: 'general' }
    await new Promise(r => setTimeout(r, 120))
    await obs.stop()
    const recent = bus.recent(10)
    const apps = recent.map(e => (e.payload as any).app)
    expect(apps).toEqual(['Slack', 'Safari'])
  })

  it('does not re-emit when app is unchanged', async () => {
    const obs = new FocusAppObserver(bus, {
      pollMs: 30,
      probe: async () => ({ app: 'Same', title: 't' }),
    })
    await obs.start()
    await new Promise(r => setTimeout(r, 150))
    await obs.stop()
    expect(bus.recent(10).length).toBe(1)
  })
})
