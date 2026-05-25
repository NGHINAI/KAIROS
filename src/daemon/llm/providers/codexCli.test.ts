import { describe, it, expect } from 'bun:test'
import { CodexCliProvider } from './codexCli'

describe('CodexCliProvider', () => {
  it('reports id and tier models', () => {
    const p = new CodexCliProvider({ enabled: true })
    expect(p.id).toBe('codex_cli')
    expect(p.modelsForTier('ultra_cheap').length).toBeGreaterThan(0)
    expect(p.modelsForTier('heavy').length).toBeGreaterThan(0)
  })

  it('reports zero cost (subscription)', () => {
    const p = new CodexCliProvider({ enabled: true })
    expect(p.pricePerMillion('gpt-5').input).toBe(0)
    expect(p.pricePerMillion('gpt-5').output).toBe(0)
  })

  it('isConfigured is false when disabled', () => {
    expect(new CodexCliProvider({ enabled: false }).isConfigured()).toBe(false)
  })

  it('isConfigured detects whether codex binary exists', () => {
    const p = new CodexCliProvider({ enabled: true })
    // Should not throw; returns true or false depending on system
    const result = p.isConfigured()
    expect(typeof result).toBe('boolean')
  })
})
