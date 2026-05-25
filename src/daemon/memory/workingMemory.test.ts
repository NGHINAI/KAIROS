// src/daemon/memory/workingMemory.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { EventBus } from '../proactive/eventBus'
import { WorkingMemory } from './workingMemory'

describe('WorkingMemory', () => {
  let db: Database
  let bus: EventBus
  let mem: WorkingMemory

  beforeEach(() => {
    db = new Database(':memory:')
    bus = new EventBus(db)
    mem = new WorkingMemory(bus, { windowMs: 60_000, maxEvents: 200 })
  })

  it('subscribes to bus and captures events into the window', () => {
    bus.publish({ source: 'focus-app', kind: 'app_changed', payload: { app: 'X' } })
    bus.publish({ source: 'clipboard', kind: 'changed', payload: { text: 'hi' } })
    expect(mem.snapshot().length).toBe(2)
  })

  it('evicts events older than the window', async () => {
    const m = new WorkingMemory(bus, { windowMs: 50, maxEvents: 200 })
    bus.publish({ source: 's', kind: 'k', payload: {} })
    expect(m.snapshot().length).toBe(1)
    await new Promise(r => setTimeout(r, 80))
    bus.publish({ source: 's', kind: 'k', payload: {} })
    expect(m.snapshot().length).toBe(1)
  })

  it('caps at maxEvents even if window allows more', () => {
    const m = new WorkingMemory(bus, { windowMs: 60_000, maxEvents: 3 })
    for (let i = 0; i < 10; i++) {
      bus.publish({ source: 's', kind: 'k', payload: { n: i } })
    }
    expect(m.snapshot().length).toBe(3)
    expect((m.snapshot()[2]?.payload as any).n).toBe(9)
  })
})
