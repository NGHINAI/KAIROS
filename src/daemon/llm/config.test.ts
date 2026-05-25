// src/daemon/llm/config.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { loadProviderConfig, defaultProviderConfig } from './config'

describe('loadProviderConfig', () => {
  let tmp: string

  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'kairos-cfg-')) })

  it('returns defaults when file missing', () => {
    const cfg = loadProviderConfig(join(tmp, 'missing.json'))
    expect(cfg.default_policy).toBe('cost_optimized')
    expect(cfg.providers.anthropic_cli.enabled).toBe(true)
  })

  it('parses a valid config', () => {
    const path = join(tmp, 'providers.json')
    writeFileSync(path, JSON.stringify({
      providers: { openai: { enabled: true, api_key_env: 'OPENAI_API_KEY' } },
      default_policy: 'quality_optimized',
      monthly_budget_usd: 100,
    }))
    const cfg = loadProviderConfig(path)
    expect(cfg.providers.openai.enabled).toBe(true)
    expect(cfg.providers.openai.api_key_env).toBe('OPENAI_API_KEY')
    expect(cfg.default_policy).toBe('quality_optimized')
    expect(cfg.monthly_budget_usd).toBe(100)
    // merged with defaults: anthropic_cli still present
    expect(cfg.providers.anthropic_cli).toBeDefined()
    rmSync(tmp, { recursive: true })
  })

  it('falls back to defaults on parse error', () => {
    const path = join(tmp, 'bad.json')
    writeFileSync(path, '{ this is not json')
    const cfg = loadProviderConfig(path)
    expect(cfg.default_policy).toBe('cost_optimized')
  })
})
