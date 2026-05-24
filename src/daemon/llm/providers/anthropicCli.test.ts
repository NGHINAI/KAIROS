// src/daemon/llm/providers/anthropicCli.test.ts
import { describe, it, expect } from 'bun:test'
import { AnthropicCliProvider } from './anthropicCli'

describe('AnthropicCliProvider', () => {
  it('reports id and tier models', () => {
    const p = new AnthropicCliProvider({ enabled: true })
    expect(p.id).toBe('anthropic_cli')
    expect(p.modelsForTier('ultra_cheap')).toContain('claude-haiku-4-5-20251001')
    expect(p.modelsForTier('heavy')).toContain('claude-opus-4-7')
  })

  it('reports zero cost (subscription)', () => {
    const p = new AnthropicCliProvider({ enabled: true })
    const price = p.pricePerMillion('claude-sonnet-4-6')
    expect(price.input).toBe(0)
    expect(price.output).toBe(0)
  })

  it('isConfigured returns enabled flag', () => {
    expect(new AnthropicCliProvider({ enabled: true }).isConfigured()).toBe(true)
    expect(new AnthropicCliProvider({ enabled: false }).isConfigured()).toBe(false)
  })
})
