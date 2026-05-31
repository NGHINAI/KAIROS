// src/daemon/llm/config.ts
import { existsSync, readFileSync } from 'fs'
import type { RouterConfig, ProviderId, ProviderConfig } from './types'

export function defaultProviderConfig(): RouterConfig {
  const empty = (overrides: Partial<ProviderConfig> = {}): ProviderConfig =>
    ({ enabled: false, ...overrides })
  return {
    providers: {
      anthropic_cli: empty({ enabled: true, priority: 1 }),
      codex_cli:     empty({ enabled: true, priority: 1 }),
      anthropic_api: empty({ api_key_env: 'ANTHROPIC_API_KEY' }),
      openai:        empty({ api_key_env: 'OPENAI_API_KEY' }),
      gemini:        empty({ api_key_env: 'GEMINI_API_KEY' }),
      kimi:          empty({ api_key_env: 'MOONSHOT_API_KEY', base_url: 'https://api.moonshot.ai/v1' }),
      ollama:        empty({ base_url: 'http://localhost:11434/v1' }),
      openrouter:    empty({ enabled: true, api_key_env: 'OPENROUTER_API_KEY' }),
    },
    default_policy: 'cost_optimized',
    monthly_budget_usd: 50,
  }
}

export function loadProviderConfig(path: string): RouterConfig {
  const defaults = defaultProviderConfig()
  if (!existsSync(path)) return defaults

  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<RouterConfig>
    const merged: RouterConfig = {
      ...defaults,
      ...raw,
      providers: { ...defaults.providers } as Record<ProviderId, ProviderConfig>,
    }
    // Per-provider merge so user partial overrides don't drop defaults.
    for (const [id, override] of Object.entries(raw.providers ?? {})) {
      const key = id as ProviderId
      merged.providers[key] = { ...defaults.providers[key], ...override }
    }
    return merged
  } catch {
    return defaults
  }
}
