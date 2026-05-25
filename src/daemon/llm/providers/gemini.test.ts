// src/daemon/llm/providers/gemini.test.ts
import { describe, it, expect } from 'bun:test'
import { GeminiProvider } from './gemini'

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
