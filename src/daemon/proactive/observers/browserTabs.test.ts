// src/daemon/proactive/observers/browserTabs.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { EventBus } from '../eventBus'
import { BrowserTabsObserver } from './browserTabs'

describe('BrowserTabsObserver', () => {
  let db: Database
  let bus: EventBus

  beforeEach(() => {
    db = new Database(':memory:')
    bus = new EventBus(db)
  })

  it('emits tabs_changed when tab set changes', async () => {
    let probeResult = { browser: 'Arc', tabs: ['https://a.com', 'https://b.com'] }
    const obs = new BrowserTabsObserver(bus, {
      pollMs: 40,
      probe: async () => probeResult,
    })
    await obs.start()
    await new Promise(r => setTimeout(r, 100))
    probeResult = { browser: 'Arc', tabs: ['https://c.com'] }
    await new Promise(r => setTimeout(r, 100))
    await obs.stop()
    const recent = bus.recent(10)
    expect(recent.length).toBe(2)
    expect((recent[0]?.payload as any).tabs).toEqual(['https://c.com'])
  })

  it('does not re-emit when tab set is unchanged', async () => {
    const obs = new BrowserTabsObserver(bus, {
      pollMs: 30,
      probe: async () => ({ browser: 'Arc', tabs: ['https://same.com'] }),
    })
    await obs.start()
    await new Promise(r => setTimeout(r, 150))
    await obs.stop()
    expect(bus.recent(10).length).toBe(1)
  })
})
