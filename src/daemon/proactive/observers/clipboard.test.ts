// src/daemon/proactive/observers/clipboard.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { EventBus } from '../eventBus'
import { ClipboardObserver } from './clipboard'

describe('ClipboardObserver', () => {
  let db: Database
  let bus: EventBus

  beforeEach(() => {
    db = new Database(':memory:')
    bus = new EventBus(db)
  })

  it('emits on clipboard content change', async () => {
    let content = 'first'
    const obs = new ClipboardObserver(bus, { pollMs: 30, probe: async () => content })
    await obs.start()
    await new Promise(r => setTimeout(r, 60))
    content = 'second'
    await new Promise(r => setTimeout(r, 60))
    await obs.stop()
    const r = bus.recent(10)
    expect(r.length).toBe(2)
    expect((r[0]?.payload as any).text).toBe('second')
  })

  it('skips empty clipboard', async () => {
    const obs = new ClipboardObserver(bus, { pollMs: 20, probe: async () => '' })
    await obs.start()
    await new Promise(r => setTimeout(r, 80))
    await obs.stop()
    expect(bus.recent(10).length).toBe(0)
  })
})
