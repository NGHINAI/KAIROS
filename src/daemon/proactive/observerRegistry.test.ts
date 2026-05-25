// src/daemon/proactive/observerRegistry.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { EventBus } from './eventBus'
import { ObserverRegistry } from './observerRegistry'
import { Observer } from './observers/base'

class TestObserver extends Observer {
  readonly id = 'test'
  startCount = 0
  stopCount = 0
  protected onStart() { this.startCount++ }
  protected onStop() { this.stopCount++ }
}

describe('ObserverRegistry', () => {
  let db: Database
  let bus: EventBus
  let reg: ObserverRegistry

  beforeEach(() => {
    db = new Database(':memory:')
    bus = new EventBus(db)
    reg = new ObserverRegistry(bus)
  })

  it('starts and stops registered observers', async () => {
    const obs = new TestObserver(bus)
    reg.register(obs)
    await reg.startAll()
    expect(obs.startCount).toBe(1)
    await reg.stopAll()
    expect(obs.stopCount).toBe(1)
  })

  it('returns list of registered observers', () => {
    reg.register(new TestObserver(bus))
    expect(reg.list()).toEqual(['test'])
  })

  it('does not start an observer twice', async () => {
    const obs = new TestObserver(bus)
    reg.register(obs)
    await reg.startAll()
    await reg.startAll()
    expect(obs.startCount).toBe(1)
  })
})
