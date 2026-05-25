import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { OrdersCompiler, ORDERS_SCHEMA } from './compiler'
import type { ModelRouter } from '../llm/router'
import type { CompletionResult } from '../llm/types'

function fakeRouter(payload: object): ModelRouter {
  return {
    complete: async (): Promise<CompletionResult> => ({
      text: JSON.stringify(payload), parsed: payload,
      provider: 'gemini', model: 'gemini-2.5-flash',
      cost_cents: 0, latency_ms: 50, fallback_count: 0,
      input_tokens: 200, output_tokens: 100,
    }),
  } as unknown as ModelRouter
}

describe('OrdersCompiler', () => {
  let db: Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(ORDERS_SCHEMA)
  })

  it('compiles plain English rules into structured triggers', async () => {
    const router = fakeRouter({
      triggers: [
        { id: 't1', when_kind: 'calendar', when_match: 'event.startsIn(10min)', condition: 'NOT focus_app.is_video', action: 'notify' },
        { id: 't2', when_kind: 'clipboard', when_match: 'text.isURL()', condition: null, action: 'fetch_title_add_to_memory' },
      ],
    })
    const comp = new OrdersCompiler(db, router)
    const rules = ['If I have a calendar event starting in 10 min and I am not on a video call, remind me.', 'If I copy a URL to the clipboard, fetch its title.']
    const result = await comp.compile(rules, 'hash1')
    expect(result.triggers.length).toBe(2)
    expect(comp.list().length).toBe(2)
  })

  it('skips recompile when source hash unchanged', async () => {
    const router = fakeRouter({ triggers: [{ id: 'x', when_kind: 'k', when_match: 'm', condition: null, action: 'notify' }] })
    const comp = new OrdersCompiler(db, router)
    const r1 = await comp.compile(['rule a'], 'hashA')
    expect(r1.skipped).toBe(false)
    const r2 = await comp.compile(['rule a — changed body but same hash for test'], 'hashA')
    expect(r2.skipped).toBe(true)
    expect(comp.list().length).toBe(1)
  })

  it('replaces compiled triggers when hash changes', async () => {
    const router1 = fakeRouter({ triggers: [{ id: 'a', when_kind: 'k', when_match: 'm', condition: null, action: 'notify' }] })
    const comp1 = new OrdersCompiler(db, router1)
    await comp1.compile(['rule one'], 'hash1')
    expect(comp1.list().length).toBe(1)

    const router2 = fakeRouter({ triggers: [
      { id: 'b', when_kind: 'k', when_match: 'm', condition: null, action: 'notify' },
      { id: 'c', when_kind: 'k', when_match: 'm', condition: null, action: 'notify' },
    ] })
    const comp2 = new OrdersCompiler(db, router2)
    await comp2.compile(['rule two', 'rule three'], 'hash2')
    expect(comp2.list().length).toBe(2)
  })
})
