// src/daemon/llm/types.ts
// Core types for the multi-LLM router. Every LLM caller in KAIROS
// constructs a CompletionRequest, hands it to ModelRouter.complete(),
// and receives a CompletionResult with provenance + cost.

import type { SystemBlock, ContextBlock } from './cache/cacheHints'
export type { SystemBlock, ContextBlock } from './cache/cacheHints'

export type ProviderId =
  | 'anthropic_cli'
  | 'anthropic_api'
  | 'codex_cli'
  | 'openai'
  | 'gemini'
  | 'kimi'
  | 'ollama'

export type TaskType =
  | 'narrative'          // ultra-cheap: summarize world state
  | 'trigger_eval'       // ultra-cheap: should this fire?
  | 'action_compose'     // mid: draft a message / craft an action
  | 'skill_generate'     // heavy: write new bash skill
  | 'source_patch'       // heavy: modify own TS source
  | 'dream'              // mid: consolidate episodic → semantic memory
  | 'classify'           // ultra-cheap: tag an event

export type Tier = 'ultra_cheap' | 'mid' | 'heavy'

export type CompletionRequest = {
  task_type: TaskType

  // NEW: structured blocks with cache hints
  system_blocks?: SystemBlock[]
  context_blocks?: ContextBlock[]

  // LEGACY: kept temporarily during migration. Task 14 removes.
  /** @deprecated use system_blocks instead */
  system?: string

  prompt: string
  max_cost_cents?: number          // refuse if all providers exceed
  latency_target?: 'realtime' | 'standard' | 'background'
  fallback_chain?: ProviderId[]    // optional override
  structured?: boolean             // require parseable JSON
  max_output_tokens?: number
}

export type LegacyCompletionRequest = {
  task_type: TaskType
  system?: string
  prompt: string
  structured?: boolean
  max_output_tokens?: number
  latency_target?: 'realtime' | 'standard' | 'background'
}

export type CompletionResult = {
  text: string
  parsed?: unknown                 // populated when structured=true
  provider: ProviderId
  model: string
  cost_cents: number
  latency_ms: number
  fallback_count: number           // how many providers tried before this
  input_tokens: number
  output_tokens: number
  cached_input_tokens?: number     // NEW: tokens served from provider cache
  cache_creation_tokens?: number   // NEW: tokens written to provider cache
}

export type ProviderError = {
  provider: ProviderId
  kind: 'rate_limit' | 'auth' | 'timeout' | 'invalid_request' | 'server' | 'unknown'
  message: string
  retryable: boolean
}

// Each provider adapter implements this interface.
export interface LLMProvider {
  readonly id: ProviderId
  isConfigured(): boolean
  modelsForTier(tier: Tier): string[]
  pricePerMillion(model: string): { input: number; output: number }  // USD
  complete(model: string, req: CompletionRequest): Promise<CompletionResult>
}

export type ProviderConfig = {
  enabled: boolean
  priority?: number
  api_key_env?: string
  base_url?: string
}

export type RouterConfig = {
  providers: Record<ProviderId, ProviderConfig>
  default_policy: 'cost_optimized' | 'quality_optimized' | 'latency_optimized'
  monthly_budget_usd: number
}
