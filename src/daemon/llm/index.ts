// src/daemon/llm/index.ts
// Convenience builder: load config, instantiate enabled providers, return router.

import type { Database } from 'bun:sqlite'
import { loadProviderConfig } from './config'
import { CostTracker } from './costTracker'
import { ModelRouter } from './router'
import { AnthropicCliProvider } from './providers/anthropicCli'
import { AnthropicApiProvider } from './providers/anthropicApi'
import { CodexCliProvider } from './providers/codexCli'
import { GeminiProvider } from './providers/gemini'
import { OpenAIProvider } from './providers/openai'
import type { LLMProvider, ProviderId } from './types'

export * from './types'
export { ModelRouter } from './router'
export { CostTracker } from './costTracker'

export function buildRouter(db: Database, configPath: string): ModelRouter {
  const cfg = loadProviderConfig(configPath)
  const tracker = new CostTracker(db, cfg.monthly_budget_usd)

  const providers: Partial<Record<ProviderId, LLMProvider>> = {
    anthropic_cli: new AnthropicCliProvider(cfg.providers.anthropic_cli),
    codex_cli:     new CodexCliProvider(cfg.providers.codex_cli),
    anthropic_api: new AnthropicApiProvider(cfg.providers.anthropic_api),
    gemini:        new GeminiProvider(cfg.providers.gemini),
    openai:        new OpenAIProvider('openai', cfg.providers.openai),
    kimi:          new OpenAIProvider('kimi',   cfg.providers.kimi),
    ollama:        new OpenAIProvider('ollama', cfg.providers.ollama),
  }

  return new ModelRouter({ providers, tracker })
}
