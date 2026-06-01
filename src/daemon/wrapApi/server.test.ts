// src/daemon/wrapApi/server.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { startWrapApi, type WrapApiServer } from './server'

describe('WrapApi server', () => {
  let server: WrapApiServer

  beforeEach(async () => {
    server = await startWrapApi({
      port: 0,
      adapters: {
        llm: { complete: async () => ({ text: 'stub-llm-response' }) } as any,
        voice: { chat: async () => ({ text: 'stub-voice-response', speakId: 'spk_x' }) } as any,
        memory: { append: async () => ({}), get: async () => ({}) } as any,
        orders: { add: async () => ({ slug: 'rule-x' }), list: async () => [] } as any,
        composio: {
          listConnections: async () => [],
          connect: async () => ({ ok: true }),
          disconnect: async () => ({ ok: true }),
        } as any,
        settings: { get: async () => ({}), update: async () => ({ updated: [] }) } as any,
      },
    })
  })

  afterEach(async () => { await server.stop() })

  it('health endpoint returns ok', async () => {
    const r = await fetch(`${server.baseUrl}/v1/health`)
    expect(r.status).toBe(200)
    expect(await r.text()).toBe('ok')
  })

  it('POST /v1/llm/complete delegates to llm adapter', async () => {
    const r = await fetch(`${server.baseUrl}/v1/llm/complete`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(r.status).toBe(200)
    expect(((await r.json()) as any).text).toBe('stub-llm-response')
  })

  it('POST /v1/voice/chat delegates to voice adapter', async () => {
    const r = await fetch(`${server.baseUrl}/v1/voice/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ transcript: 'hello', conversationId: 'c1' }),
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as any
    expect(body.text).toBe('stub-voice-response')
    expect(body.speakId).toBe('spk_x')
  })

  it('POST /v1/orders/add returns slug', async () => {
    const r = await fetch(`${server.baseUrl}/v1/orders/add`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rule: {}, via: 'voice' }),
    })
    expect(r.status).toBe(200)
    expect(((await r.json()) as any).slug).toBe('rule-x')
  })

  it('GET /v1/orders/list returns list', async () => {
    const r = await fetch(`${server.baseUrl}/v1/orders/list`)
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual([])
  })

  it('GET /v1/settings/get returns settings', async () => {
    const r = await fetch(`${server.baseUrl}/v1/settings/get`)
    expect(r.status).toBe(200)
  })

  it('unknown endpoint returns 404', async () => {
    const r = await fetch(`${server.baseUrl}/v1/nope`)
    expect(r.status).toBe(404)
  })

  it('POST without content-type returns 415', async () => {
    const r = await fetch(`${server.baseUrl}/v1/llm/complete`, { method: 'POST', body: '{}' })
    expect(r.status).toBe(415)
  })

  it('GET on POST endpoint returns 405', async () => {
    const r = await fetch(`${server.baseUrl}/v1/llm/complete`)
    expect(r.status).toBe(405)
  })

  it('handler throws → 500 with error message', async () => {
    const errServer = await startWrapApi({
      port: 0,
      adapters: {
        llm: { complete: async () => { throw new Error('boom') } } as any,
        voice: { chat: async () => ({}) } as any,
        memory: { append: async () => ({}), get: async () => ({}) } as any,
        orders: { add: async () => ({}), list: async () => [] } as any,
        composio: { listConnections: async () => [], connect: async () => ({}), disconnect: async () => ({}) } as any,
        settings: { get: async () => ({}), update: async () => ({ updated: [] }) } as any,
      },
    })
    try {
      const r = await fetch(`${errServer.baseUrl}/v1/llm/complete`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      })
      expect(r.status).toBe(500)
      const body = (await r.json()) as any
      expect(body.error).toBe('boom')
    } finally {
      await errServer.stop()
    }
  })
})
