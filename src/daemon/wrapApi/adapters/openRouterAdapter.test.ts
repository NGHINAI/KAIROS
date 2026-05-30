// src/daemon/wrapApi/adapters/openRouterAdapter.test.ts
import { test, expect } from 'bun:test'
import { OpenRouterAdapter } from './openRouterAdapter'

test('stream() emits tool_use event when LLM returns tool_calls', async () => {
  // Mock fetch that returns an SSE stream with a tool_call split across 2 chunks
  const ssePayload = [
    `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_weather","arguments":"{\\"loc"}}]}}]}\n`,
    `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\":\\"NYC\\"}"}}]}}]}\n`,
    `data: [DONE]\n`,
  ].join('\n')

  const mockFetch = async (_url: string, _init: any): Promise<Response> => {
    return new Response(ssePayload, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }

  const adapter = new OpenRouterAdapter({
    apiKey: 'sk-test',
    defaultModel: 'openai/gpt-4o-mini',
    fetchImpl: mockFetch as any,
  })

  const events: any[] = []
  for await (const e of adapter.stream({ messages: [{ role: 'user', content: 'weather?' }] })) {
    events.push(e)
  }

  const toolUse = events.find((e) => e.kind === 'tool_use')
  expect(toolUse).toBeDefined()
  expect(toolUse.name).toBe('get_weather')
  expect(toolUse.args_json).toBe('{"loc":"NYC"}')
})
