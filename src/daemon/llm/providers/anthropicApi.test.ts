// src/daemon/llm/providers/anthropicApi.test.ts
import { describe, it, expect } from 'bun:test'
import { AnthropicApiProvider } from './anthropicApi'

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
