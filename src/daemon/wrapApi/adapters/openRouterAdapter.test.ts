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

test('reasoningEffort → reasoning:{exclude,effort} when thinking is ON (per-task effort budget)', async () => {
  let sentBody: any = null
  const mockFetch = async (_url: string, init: any): Promise<Response> => {
    sentBody = JSON.parse(String(init.body))
    return new Response(`data: [DONE]\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  const adapter = new OpenRouterAdapter({ apiKey: 'sk-test', defaultModel: 'x', reasoningEffort: 'high', fetchImpl: mockFetch as any })
  for await (const _ of adapter.stream({ messages: [{ role: 'user', content: 'hi' }] })) { /* drain */ }
  expect(sentBody.reasoning).toEqual({ exclude: true, effort: 'high' })  // think at the chosen effort, CoT hidden
})

test('reasoningEffort is ignored when disableThinking wins (thinking OFF)', async () => {
  let sentBody: any = null
  const mockFetch = async (_url: string, init: any): Promise<Response> => {
    sentBody = JSON.parse(String(init.body))
    return new Response(`data: [DONE]\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  const adapter = new OpenRouterAdapter({ apiKey: 'sk-test', defaultModel: 'x', disableThinking: true, reasoningEffort: 'high', fetchImpl: mockFetch as any })
  for await (const _ of adapter.stream({ messages: [{ role: 'user', content: 'hi' }] })) { /* drain */ }
  expect(sentBody.reasoning).toEqual({ exclude: true, max_tokens: 0 })   // OFF takes precedence
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

test('every call reports ONCE to the global usage hook with exact provider tokens', async () => {
  const sse = [
    `data: {"choices":[{"delta":{"content":"Hi there."}}]}\n`,
    `data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":321,"completion_tokens":12}}\n`,
    `data: [DONE]\n`,
  ].join('\n')
  const mockFetch = async (): Promise<Response> =>
    new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  const calls: any[] = []
  ;(globalThis as any).__kairosLlmUsage = (u: any) => calls.push(u)
  try {
    const adapter = new OpenRouterAdapter({ apiKey: 'sk-test', defaultModel: 'openai/gpt-4o-mini', usageLabel: 'voice_fast', fetchImpl: mockFetch as any })
    await adapter.complete({ messages: [{ role: 'user', content: 'hi' }] })
    expect(calls.length).toBe(1)
    expect(calls[0].label).toBe('voice_fast')
    expect(calls[0].model).toBe('openai/gpt-4o-mini')
    expect(calls[0].tokensIn).toBe(321)
    expect(calls[0].tokensOut).toBe(12)
    expect(calls[0].estimated).toBe(false)
  } finally { delete (globalThis as any).__kairosLlmUsage }
})

test('a stream without provider usage still meters with a chars/4 estimate', async () => {
  const sse = [
    `data: {"choices":[{"delta":{"content":"Twelve chars"}}]}\n`,
    `data: [DONE]\n`,
  ].join('\n')
  const mockFetch = async (): Promise<Response> =>
    new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  const calls: any[] = []
  ;(globalThis as any).__kairosLlmUsage = (u: any) => calls.push(u)
  try {
    const adapter = new OpenRouterAdapter({ apiKey: 'sk-test', defaultModel: 'x', fetchImpl: mockFetch as any })
    await adapter.complete({ messages: [{ role: 'user', content: 'hello world question' }] })
    expect(calls.length).toBe(1)
    expect(calls[0].estimated).toBe(true)
    expect(calls[0].tokensIn).toBeGreaterThan(0)
    expect(calls[0].tokensOut).toBe(3)   // "Twelve chars" = 12 chars / 4
  } finally { delete (globalThis as any).__kairosLlmUsage }
})

test('a broken usage hook never breaks the completion', async () => {
  const sse = [
    `data: {"choices":[{"delta":{"content":"Fine."}}]}\n`,
    `data: [DONE]\n`,
  ].join('\n')
  const mockFetch = async (): Promise<Response> =>
    new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  ;(globalThis as any).__kairosLlmUsage = () => { throw new Error('ledger on fire') }
  try {
    const adapter = new OpenRouterAdapter({ apiKey: 'sk-test', defaultModel: 'x', fetchImpl: mockFetch as any })
    const r = await adapter.complete({ messages: [{ role: 'user', content: 'hi' }] })
    expect(r.text).toBe('Fine.')
  } finally { delete (globalThis as any).__kairosLlmUsage }
})
