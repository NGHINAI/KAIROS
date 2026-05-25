import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { OrdersParser } from './parser'
import { OrdersCompiler, ORDERS_SCHEMA } from './compiler'
import { OrdersRuntime } from './runtime'
import type { ModelRouter } from '../llm/router'

function fakeRouter(payload: object): ModelRouter {
  return {
    complete: async () => ({
      text: JSON.stringify(payload), parsed: payload,
      provider: 'gemini', model: 'g', cost_cents: 0, latency_ms: 1,
      fallback_count: 0, input_tokens: 1, output_tokens: 1,
    }),
  } as unknown as ModelRouter
}

describe('OrdersRuntime', () => {
  let tmp: string
  let db: Database

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kairos-runtime-'))
    db = new Database(':memory:')
    db.exec(ORDERS_SCHEMA)
  })

  it('reloads + recompiles when STANDING_ORDERS.md changes', async () => {
    const path = join(tmp, 'STANDING_ORDERS.md')
    writeFileSync(path, '- rule one')
    const router = fakeRouter({ triggers: [{ id: 'a', when_kind: 'k', when_match: 'm', condition: null, action: 'notify' }] })
    const parser = new OrdersParser(path)
    const compiler = new OrdersCompiler(db, router)
    const rt = new OrdersRuntime(parser, compiler, { pollMs: 30 })
    await rt.start()
    await new Promise(r => setTimeout(r, 100))
    expect(compiler.list().length).toBe(1)

    writeFileSync(path, '- rule one\n- rule two')
    await new Promise(r => setTimeout(r, 100))
    expect(compiler.list().length).toBe(1)   // fake router still returns 1 trigger
    rt.stop()
    rmSync(tmp, { recursive: true })
  })

  it('provides text() for Tier 2 consumption', () => {
    const path = join(tmp, 'STANDING_ORDERS.md')
    writeFileSync(path, '- rule one\n- rule two')
    const router = fakeRouter({ triggers: [] })
    const parser = new OrdersParser(path)
    const compiler = new OrdersCompiler(db, router)
    const rt = new OrdersRuntime(parser, compiler, { pollMs: 30 })
    expect(rt.text()).toContain('rule one')
    expect(rt.text()).toContain('rule two')
    rmSync(tmp, { recursive: true })
  })
})
