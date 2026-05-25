// src/daemon/llm/providers/openai.test.ts
import { describe, it, expect } from 'bun:test'
import { OpenAIProvider } from './openai'

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
