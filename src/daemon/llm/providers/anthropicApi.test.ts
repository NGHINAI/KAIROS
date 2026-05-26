// src/daemon/llm/providers/anthropicApi.test.ts
import { describe, it, expect } from 'bun:test'
import { AnthropicApiProvider } from './anthropicApi'

/** Minimal valid Anthropic messages response. */
function makeResponse(overrides: Record<string, unknown> = {}): Response {
  const body = {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'ok' }],
    model: 'claude-sonnet-4-6',
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 100,
      output_tokens: 10,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    ...overrides,
  }
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('AnthropicApiProvider', () => {
  it('reports id and tier models', () => {
    const p = new AnthropicApiProvider({ enabled: true, api_key_env: 'ANTHROPIC_API_KEY' })
    expect(p.id).toBe('anthropic_api')
    expect(p.modelsForTier('heavy')).toContain('claude-opus-4-7')
  })

  it('opus is more expensive than haiku', () => {
    const p = new AnthropicApiProvider({ enabled: true, api_key_env: 'ANTHROPIC_API_KEY' })
    expect(p.pricePerMillion('claude-opus-4-7').input)
      .toBeGreaterThan(p.pricePerMillion('claude-haiku-4-5-20251001').input)
  })
})

describe('AnthropicApiProvider caching', () => {
  it('emits cache_control on the last long-cached block and the last short-cached block', async () => {
    let capturedBody: any
    const provider = new AnthropicApiProvider({
      enabled: true,
      api_key_env: 'ANTHROPIC_API_KEY',
      _fetch: async (_url: any, init: any) => {
        capturedBody = JSON.parse(init.body as string)
        return makeResponse()
      },
    })
    await provider.complete('claude-sonnet-4-6', {
      task_type: 'agency_judge' as any,
      system_blocks: [
        { text: 'A', cache_hint: 'long' },
        { text: 'B', cache_hint: 'long' },    // cache_control on this one (last long)
      ],
      context_blocks: [
        { text: 'C', cache_hint: 'short', source: 'L2' },  // and this one (last short)
      ],
      prompt: 'q',
    })
    // system array should have 3 items
    expect(Array.isArray(capturedBody.system)).toBe(true)
    expect(capturedBody.system.length).toBe(3)
    expect(capturedBody.system[0].cache_control).toBeUndefined()
    expect(capturedBody.system[1].cache_control).toEqual({ type: 'ephemeral' })
    expect(capturedBody.system[2].cache_control).toEqual({ type: 'ephemeral' })
  })

  it('reports cached_input_tokens in result', async () => {
    const provider = new AnthropicApiProvider({
      enabled: true,
      api_key_env: 'ANTHROPIC_API_KEY',
      _fetch: async () => makeResponse({
        usage: {
          input_tokens: 200,
          output_tokens: 20,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 1500,
        },
      }),
    })
    const result = await provider.complete('claude-sonnet-4-6', {
      task_type: 'agency_judge' as any,
      system_blocks: [{ text: 'A', cache_hint: 'long' }],
      context_blocks: [],
      prompt: 'q',
    })
    expect(result.cached_input_tokens).toBe(1500)
    expect(result.input_tokens).toBe(200)
  })
})
