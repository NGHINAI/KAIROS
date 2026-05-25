import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { EventBus } from './eventBus'
import { StateSnapshot } from './stateSnapshot'
import { Narrator } from './narrator'
import type { ModelRouter } from '../llm/router'
import type { CompletionRequest, CompletionResult } from '../llm/types'

function fakeRouter(text: string): ModelRouter {
  return {
    complete: async (req: CompletionRequest): Promise<CompletionResult> => ({
      text,
      provider: 'gemini',
      model: 'gemini-2.5-flash-lite',
      cost_cents: 0,
      latency_ms: 10,
      fallback_count: 0,
      input_tokens: 100,
      output_tokens: 30,
    }),
  } as unknown as ModelRouter
}

describe('Narrator', () => {
  let db: Database
  let bus: EventBus
  let snap: StateSnapshot

  beforeEach(() => {
    db = new Database(':memory:')
    bus = new EventBus(db)
    snap = new StateSnapshot(bus)
  })

  it('produces and publishes a narrative from snapshot', async () => {
    bus.publish({ source: 'focus-app', kind: 'app_changed', payload: { app: 'VS Code' } })
    const narrator = new Narrator(bus, snap, fakeRouter('User is editing code in VS Code.'))
    await narrator.tick()
    const r = bus.recent(10)
    const narrative = r.find(e => e.source === 'narrator')
    expect(narrative).toBeDefined()
    expect((narrative!.payload as any).text).toBe('User is editing code in VS Code.')
  })

  it('skips when snapshot is empty (no observations yet)', async () => {
    const narrator = new Narrator(bus, snap, fakeRouter('should not fire'))
    await narrator.tick()
    expect(bus.recent(10).find(e => e.source === 'narrator')).toBeUndefined()
  })

  it('start() schedules periodic ticks and stop() halts them', async () => {
    bus.publish({ source: 'focus-app', kind: 'app_changed', payload: { app: 'X' } })
    let calls = 0
    const router = {
      complete: async (): Promise<CompletionResult> => {
        calls++
        return {
          text: `tick ${calls}`,
          provider: 'gemini', model: 'g', cost_cents: 0, latency_ms: 1,
          fallback_count: 0, input_tokens: 1, output_tokens: 1,
        }
      },
    } as unknown as ModelRouter
    const narrator = new Narrator(bus, snap, router, { intervalMs: 40 })
    await narrator.start()
    await new Promise(r => setTimeout(r, 130))
    await narrator.stop()
    expect(calls).toBeGreaterThanOrEqual(2)
  })
})
