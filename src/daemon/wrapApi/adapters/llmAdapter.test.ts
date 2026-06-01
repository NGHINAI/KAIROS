// src/daemon/wrapApi/adapters/llmAdapter.test.ts
import { describe, it, expect } from 'bun:test'
import { LLMAdapter } from './llmAdapter'

describe('LLMAdapter', () => {
  function fakeClient(handler: (req: any, opts?: any) => Promise<any>) {
    return { messages: { create: handler } }
  }

  it('complete() calls Anthropic with default Haiku 4.5 model', async () => {
    let receivedReq: any
    const adapter = new LLMAdapter({
      client: fakeClient(async (req) => { receivedReq = req; return { content: [{ type: 'text', text: 'sup' }] } }) as any,
      defaultModel: 'claude-haiku-4-5',
    })
    const r = await adapter.complete({ messages: [{ role: 'user', content: 'hi' }] })
    expect(receivedReq.model).toBe('claude-haiku-4-5')
    expect(r.text).toBe('sup')
  })

  it('complete() honors per-call model override', async () => {
    let receivedReq: any
    const adapter = new LLMAdapter({
      client: fakeClient(async (req) => { receivedReq = req; return { content: [{ type: 'text', text: 'x' }] } }) as any,
      defaultModel: 'claude-haiku-4-5',
    })
    await adapter.complete({ messages: [{ role: 'user', content: 'x' }], model: 'claude-sonnet-4-6' })
    expect(receivedReq.model).toBe('claude-sonnet-4-6')
  })

  it('complete() passes system prompt when provided', async () => {
    let receivedReq: any
    const adapter = new LLMAdapter({
      client: fakeClient(async (req) => { receivedReq = req; return { content: [{ type: 'text', text: 'x' }] } }) as any,
    })
    await adapter.complete({ messages: [{ role: 'user', content: 'x' }], system: 'You are KAIROS' })
    expect(receivedReq.system).toBe('You are KAIROS')
  })

  it('complete() does NOT include system when undefined', async () => {
    let receivedReq: any
    const adapter = new LLMAdapter({
      client: fakeClient(async (req) => { receivedReq = req; return { content: [{ type: 'text', text: 'x' }] } }) as any,
    })
    await adapter.complete({ messages: [{ role: 'user', content: 'x' }] })
    expect(receivedReq.system).toBeUndefined()
  })

  it('complete() propagates LLM errors', async () => {
    const adapter = new LLMAdapter({
      client: fakeClient(async () => { throw new Error('Anthropic 500') }) as any,
    })
    await expect(adapter.complete({ messages: [{ role: 'user', content: 'x' }] }))
      .rejects.toThrow('Anthropic 500')
  })

  it('complete() returns usage tokens when present', async () => {
    const adapter = new LLMAdapter({
      client: fakeClient(async () => ({
        content: [{ type: 'text', text: 'hi' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      })) as any,
    })
    const r = await adapter.complete({ messages: [{ role: 'user', content: 'hi' }] })
    expect(r.tokensIn).toBe(10)
    expect(r.tokensOut).toBe(5)
  })

  it('complete() concatenates multiple text content blocks', async () => {
    const adapter = new LLMAdapter({
      client: fakeClient(async () => ({
        content: [
          { type: 'text', text: 'first ' },
          { type: 'text', text: 'second' },
        ],
      })) as any,
    })
    const r = await adapter.complete({ messages: [{ role: 'user', content: 'x' }] })
    expect(r.text).toBe('first second')
  })
})
