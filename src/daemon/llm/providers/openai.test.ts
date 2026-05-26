// src/daemon/llm/providers/openai.test.ts
import { describe, it, expect } from 'bun:test'
import { OpenAIProvider } from './openai'
import type { OpenAIProviderConfig } from './openai'

describe('OpenAIProvider', () => {
  it('reports openai id when used as openai', () => {
    const p = new OpenAIProvider('openai', { enabled: true, api_key_env: 'OPENAI_API_KEY' })
    expect(p.id).toBe('openai')
    expect(p.modelsForTier('ultra_cheap')).toContain('gpt-4o-mini')
    expect(p.modelsForTier('heavy')).toContain('gpt-5')
  })

  it('serves Kimi via base_url override', () => {
    const p = new OpenAIProvider('kimi', { enabled: true, api_key_env: 'MOONSHOT_API_KEY', base_url: 'https://api.moonshot.cn/v1' })
    expect(p.id).toBe('kimi')
    expect(p.modelsForTier('ultra_cheap')).toContain('moonshot-v1-8k')
  })

  it('serves Ollama via base_url override (no auth)', () => {
    const p = new OpenAIProvider('ollama', { enabled: true, base_url: 'http://localhost:11434/v1' })
    expect(p.id).toBe('ollama')
    expect(p.pricePerMillion('qwen3:8b').input).toBe(0)
  })

  it('isConfigured requires api key env when no base_url-only mode', () => {
    const p = new OpenAIProvider('openai', { enabled: true, api_key_env: 'NEVER_SET_THIS' })
    expect(p.isConfigured()).toBe(false)
  })

  it('isConfigured ok for ollama without env (base_url only)', () => {
    const p = new OpenAIProvider('ollama', { enabled: true, base_url: 'http://localhost:11434/v1' })
    expect(p.isConfigured()).toBe(true)
  })
})

describe('OpenAI caching', () => {
  it('places long-cached blocks before short before volatile in system message', async () => {
    let capturedBody: any
    const cfg: OpenAIProviderConfig = {
      enabled: true,
      api_key_env: 'OPENAI_API_KEY',
      _fetch: async (_url: any, init: any) => {
        capturedBody = JSON.parse((init as RequestInit).body as string)
        return new Response(JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          created: 1700000000,
          model: 'gpt-4o-mini',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 0 } },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      },
    }
    const provider = new OpenAIProvider('openai', cfg)
    await provider.complete('gpt-4o-mini', {
      task_type: 'agency_judge' as any,
      system_blocks: [
        { text: 'LONG_A', cache_hint: 'long' },
        { text: 'LONG_B', cache_hint: 'long' },
      ],
      context_blocks: [
        { text: 'SHORT_C', cache_hint: 'short', source: 'L2' },
        { text: 'VOLATILE_D', cache_hint: 'none', source: 'observation' },
      ],
      prompt: 'q',
    })
    const sysContent = capturedBody.messages[0].content as string
    // LONG_A before LONG_B before SHORT_C
    expect(sysContent.indexOf('LONG_A')).toBeLessThan(sysContent.indexOf('LONG_B'))
    expect(sysContent.indexOf('LONG_B')).toBeLessThan(sysContent.indexOf('SHORT_C'))
    // VOLATILE_D must not appear in system; must appear in user message
    expect(sysContent).not.toContain('VOLATILE_D')
    expect((capturedBody.messages[1].content as string)).toContain('VOLATILE_D')
  })

  it('reports cached_input_tokens from prompt_tokens_details.cached_tokens', async () => {
    const cfg: OpenAIProviderConfig = {
      enabled: true,
      api_key_env: 'OPENAI_API_KEY',
      _fetch: async () => new Response(JSON.stringify({
        id: 'chatcmpl-test2',
        object: 'chat.completion',
        created: 1700000000,
        model: 'gpt-4o-mini',
        choices: [{ index: 0, message: { role: 'assistant', content: 'r' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 200, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 1500 } },
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    }
    const provider = new OpenAIProvider('openai', cfg)
    const result = await provider.complete('gpt-4o-mini', {
      task_type: 'agency_judge' as any,
      system_blocks: [{ text: 'A', cache_hint: 'long' }],
      context_blocks: [],
      prompt: 'q',
    })
    expect(result.cached_input_tokens).toBe(1500)
  })
})
