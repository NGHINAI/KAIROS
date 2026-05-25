import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { EventBus } from '../proactive/eventBus'
import { ClipboardPatternWatcher } from './clipboardPatternWatcher'

describe('ClipboardPatternWatcher', () => {
  let db: Database
  let bus: EventBus

  beforeEach(() => {
    db = new Database(':memory:')
    bus = new EventBus(db)
  })

  it('resolves when clipboard matches pattern', async () => {
    const watcher = new ClipboardPatternWatcher(bus)
    const promise = watcher.waitFor(/ghp_[a-zA-Z0-9]{36}/, 5000)
    await new Promise(r => setTimeout(r, 50))
    bus.publish({ source: 'clipboard', kind: 'changed', payload: { text: 'ghp_AbCdEf1234567890ZyXwVuTsRqPo12345678' } })
    const match = await promise
    expect(match).toMatch(/^ghp_/)
  })

  it('ignores clipboard events that do not match', async () => {
    const watcher = new ClipboardPatternWatcher(bus)
    const promise = watcher.waitFor(/^EXPECTED-/, 200)
    await new Promise(r => setTimeout(r, 50))
    bus.publish({ source: 'clipboard', kind: 'changed', payload: { text: 'random text' } })
    await expect(promise).rejects.toThrow(/timeout/i)
  })

  it('honors timeout', async () => {
    const watcher = new ClipboardPatternWatcher(bus)
    const start = Date.now()
    await expect(watcher.waitFor(/never/, 100)).rejects.toThrow(/timeout/i)
    expect(Date.now() - start).toBeGreaterThanOrEqual(90)
  })

  it('can be cancelled', async () => {
    const watcher = new ClipboardPatternWatcher(bus)
    const promise = watcher.waitFor(/x/, 5000)
    await new Promise(r => setTimeout(r, 50))
    watcher.cancel()
    await expect(promise).rejects.toThrow(/cancel/i)
  })
})
