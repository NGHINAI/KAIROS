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

test('stream() strips inline <think> reasoning from spoken content (tag split across chunks)', async () => {
  const sse = [
    `data: {"choices":[{"delta":{"content":"Hello. <thi"}}]}\n`,
    `data: {"choices":[{"delta":{"content":"nk>secret reasoning about "}}]}\n`,
    `data: {"choices":[{"delta":{"content":"the user</think> Your email is from Amazon."}}]}\n`,
    `data: {"choices":[{"delta":{"content":" Done."}}]}\n`,
    `data: [DONE]\n`,
  ].join('\n')
  const mockFetch = async (): Promise<Response> =>
    new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  const adapter = new OpenRouterAdapter({ apiKey: 'sk-test', defaultModel: 'x', fetchImpl: mockFetch as any })
  const deltas: string[] = []
  let doneText = ''
  for await (const e of adapter.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
    if (e.kind === 'delta') deltas.push(e.text)
    if (e.kind === 'done') doneText = e.text
  }
  const spoken = deltas.join('')
  expect(spoken).not.toContain('secret reasoning') // CoT never spoken
  expect(spoken).not.toContain('<think')
  expect(spoken).toContain('Hello.')
  expect(spoken).toContain('Your email is from Amazon.')
  expect(spoken).toContain('Done.')
  expect(doneText).toBe(spoken) // done text == the clean spoken text
})
