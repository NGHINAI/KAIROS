// src/daemon/llm/index.ts
// Convenience builder: load config, instantiate enabled providers, return router.

import type { Database } from 'bun:sqlite'
import { loadProviderConfig } from './config'
import { CostTracker } from './costTracker'
import { ModelRouter } from './router'
import { GeminiProvider } from './providers/gemini'
import { OpenAIProvider } from './providers/openai'
import { OpenRouterProvider } from './providers/openrouter'
import { log, logError } from '../logger'
import type { LLMProvider, ProviderId } from './types'
import type { KairosMode } from './router'

export * from './types'
export { ModelRouter } from './router'
export { CostTracker } from './costTracker'

export function buildRouter(db: Database, configPath: string, mode?: KairosMode): ModelRouter {
  const cfg = loadProviderConfig(configPath)
  const tracker = new CostTracker(db, cfg.monthly_budget_usd)

  const providers: Partial<Record<ProviderId, LLMProvider>> = {
    // OpenRouter is FIRST so the daemon logs it at the head of "configured
    // providers" — its model menu is set entirely from env vars.
    // NO claude: anthropic_cli / anthropic_api are deliberately NOT registered —
    // the runtime must never invoke a claude model, not even as a ModelRouter fallback.
    // codex_cli is also dropped: we pivoted off codex, and it errored when the router
    // fell to it (config.toml HooksToml mismatch) — a broken fallback is worse than none.
    openrouter:    new OpenRouterProvider({ enabled: true }),
    gemini:        new GeminiProvider(cfg.providers.gemini),
    openai:        new OpenAIProvider('openai', cfg.providers.openai),
    kimi:          new OpenAIProvider('kimi',   cfg.providers.kimi),
    ollama:        new OpenAIProvider('ollama', cfg.providers.ollama),
  }

  // Fire all warmups in background — Clicky-derived pattern (8.4.8 #3).
  // Skip CLI providers (subprocess-based, no socket pool benefit).
  for (const p of Object.values(providers)) {
    if (p && 'warmupTLS' in p && typeof (p as any).warmupTLS === 'function') {
      (p as any).warmupTLS()
    }
  }

  // ── Startup guard ────────────────────────────────────────────────────────
  // Count how many providers say isConfigured(). If zero, the daemon will
  // throw on the first ModelRouter.complete() call with the cryptic message
  // "all candidates exhausted". Fail LOUDLY at boot instead, so the human
  // sees what's actually wrong.
  const configured: ProviderId[] = []
  for (const [id, p] of Object.entries(providers)) {
    if (p && p.isConfigured()) configured.push(id as ProviderId)
  }
  log(`[llm] configured providers: ${configured.length > 0 ? configured.join(', ') : '(none)'}`)
  if (configured.length === 0) {
    const msg =
      '[llm] CRITICAL: no LLM providers are configured. ' +
      'Set OPENROUTER_API_KEY (recommended), or enable a provider in ' +
      `${configPath} and set its api_key_env. ` +
      'Refusing to start a daemon that cannot serve a single LLM call.'
    logError(msg)
    throw new Error(msg)
  }

  return new ModelRouter({ providers, tracker, mode })
}
