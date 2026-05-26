// src/daemon/llm/providers/gemini.test.ts
import { describe, it, expect } from 'bun:test'
import { GeminiProvider, GeminiApiProvider } from './gemini'

describe('GeminiProvider', () => {
  it('reports id and tier models', () => {
    const p = new GeminiProvider({ enabled: true, api_key_env: 'GEMINI_API_KEY' })
    expect(p.id).toBe('gemini')
    expect(p.modelsForTier('ultra_cheap')).toContain('gemini-2.5-flash-lite')
    expect(p.modelsForTier('mid')).toContain('gemini-2.5-flash')
    expect(p.modelsForTier('heavy')).toContain('gemini-2.5-pro')
  })

  it('flash-lite has the cheapest pricing', () => {
    const p = new GeminiProvider({ enabled: true, api_key_env: 'GEMINI_API_KEY' })
    const lite = p.pricePerMillion('gemini-2.5-flash-lite')
    const pro  = p.pricePerMillion('gemini-2.5-pro')
    expect(lite.input).toBeLessThan(pro.input)
  })

  it('isConfigured requires API key env to be set', () => {
    expect(new GeminiProvider({ enabled: true, api_key_env: 'NEVER_SET_THIS' }).isConfigured()).toBe(false)
  })
})

describe('GeminiProvider caching', () => {
  it('creates a cachedContents resource for long-hint blocks ≥4096 tokens on first call', async () => {
    const httpCalls: string[] = []
    const provider = new GeminiApiProvider({
      apiKey: 'test',
      _fetch: async (url: any, init: any) => {
        const u = url.toString()
        httpCalls.push((init?.method ?? 'GET') + ' ' + u)
        if (u.includes('cachedContents')) {
          return new Response(JSON.stringify({ name: 'cachedContents/abc123' }), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'ok' }] } }],
          usageMetadata: { promptTokenCount: 5000, candidatesTokenCount: 10, cachedContentTokenCount: 4500 },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      },
    } as any)
    await provider.complete({
      task_type: 'agency_judge' as any,
      system_blocks: [{ text: 'A'.repeat(20000), cache_hint: 'long' }],   // ~5000 tokens, exceeds 4096 threshold
      context_blocks: [],
      prompt: 'q',
    })
    expect(httpCalls.some(c => c.includes('POST') && c.includes('cachedContents'))).toBe(true)
  })

  it('reuses an existing cachedContents resource within TTL', async () => {
    const cacheCreations: string[] = []
    const provider = new GeminiApiProvider({
      apiKey: 'test',
      _fetch: async (url: any, init: any) => {
        const u = url.toString()
        if (u.includes('cachedContents') && init?.method === 'POST') {
          cacheCreations.push(u)
          return new Response(JSON.stringify({ name: 'cachedContents/xyz' }), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'ok' }] } }],
          usageMetadata: { promptTokenCount: 5000, candidatesTokenCount: 10, cachedContentTokenCount: 4500 },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      },
    } as any)
    const sameSkill = { system_blocks: [{ text: 'A'.repeat(20000), cache_hint: 'long' as const }], context_blocks: [], prompt: 'q1', task_type: 'agency_judge' as any }
    await provider.complete(sameSkill)
    await provider.complete({ ...sameSkill, prompt: 'q2' })
    expect(cacheCreations.length).toBe(1)   // only ONE creation, second call reused
  })

  it('reports cached_input_tokens from usageMetadata.cachedContentTokenCount', async () => {
    const provider = new GeminiApiProvider({
      apiKey: 'test',
      _fetch: async () => new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'r' }] } }],
        usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 50, cachedContentTokenCount: 400 },
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    } as any)
    const result = await provider.complete({
      task_type: 'agency_judge' as any,
      system_blocks: [{ text: 'A', cache_hint: 'long' }],
      context_blocks: [],
      prompt: 'q',
    })
    expect(result.cached_input_tokens).toBe(400)
  })
})
