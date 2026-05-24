// src/daemon/proactive/observers/fileEvents.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { EventBus } from '../eventBus'
import { FileEventsObserver } from './fileEvents'

describe('FileEventsObserver', () => {
  let db: Database
  let bus: EventBus
  let dir: string

  beforeEach(() => {
    db = new Database(':memory:')
    bus = new EventBus(db)
    dir = mkdtempSync(join(tmpdir(), 'kairos-fs-'))
  })

  it('emits modified events when files change', async () => {
    const obs = new FileEventsObserver(bus, { roots: [dir], debounceMs: 30 })
    await obs.start()
    await new Promise(r => setTimeout(r, 50))
    writeFileSync(join(dir, 'a.txt'), 'hello')
    await new Promise(r => setTimeout(r, 200))
    await obs.stop()
    const events = bus.recent(10)
    expect(events.length).toBeGreaterThan(0)
    expect((events[0]?.payload as any).path).toContain('a.txt')
    rmSync(dir, { recursive: true })
  })

  it('skips ignored extensions', async () => {
    const obs = new FileEventsObserver(bus, {
      roots: [dir],
      debounceMs: 30,
      ignoreExt: ['.log', '.tmp'],
    })
    await obs.start()
    await new Promise(r => setTimeout(r, 50))
    writeFileSync(join(dir, 'noise.log'), 'x')
    writeFileSync(join(dir, 'real.txt'), 'y')
    await new Promise(r => setTimeout(r, 200))
    await obs.stop()
    const events = bus.recent(10)
    const paths = events.map(e => (e.payload as any).path as string)
    expect(paths.some(p => p.endsWith('.log'))).toBe(false)
    expect(paths.some(p => p.endsWith('.txt'))).toBe(true)
    rmSync(dir, { recursive: true })
  })
})
