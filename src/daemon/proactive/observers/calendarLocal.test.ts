// src/daemon/proactive/observers/calendarLocal.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { EventBus } from '../eventBus'
import { CalendarLocalObserver } from './calendarLocal'

describe('CalendarLocalObserver', () => {
  let db: Database
  let bus: EventBus

  beforeEach(() => {
    db = new Database(':memory:')
    bus = new EventBus(db)
  })

  it('emits upcoming events from probe', async () => {
    const obs = new CalendarLocalObserver(bus, {
      pollMs: 50,
      probe: async () => [
        { title: 'Standup',   start: 1700000000000 },
        { title: 'Lunch',     start: 1700100000000 },
      ],
    })
    await obs.start()
    await new Promise(r => setTimeout(r, 80))
    await obs.stop()
    const r = bus.recent(10)
    expect(r.length).toBeGreaterThanOrEqual(1)
    const payload = r[0]?.payload as any
    expect(payload.events.length).toBe(2)
    expect(payload.events[0].title).toBe('Standup')
  })

  it('does not re-emit when event set is unchanged', async () => {
    const events = [{ title: 'Static', start: 1700000000000 }]
    const obs = new CalendarLocalObserver(bus, { pollMs: 30, probe: async () => events })
    await obs.start()
    await new Promise(r => setTimeout(r, 150))
    await obs.stop()
    expect(bus.recent(10).length).toBe(1)
  })
})
