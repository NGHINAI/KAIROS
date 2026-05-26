// src/daemon/llm/policy.ts
// Maps task types → tiers → ordered list of (provider, model) candidates.
// Order is cheapest-acceptable-first. ModelRouter filters by which
// providers are actually configured and walks the list trying each.

import type { ProviderId, TaskType, Tier } from './types'

const TASK_TO_TIER: Record<TaskType, Tier> = {
  narrative:        'ultra_cheap',
  trigger_eval:     'ultra_cheap',
  classify:         'ultra_cheap',
  observe_classify: 'ultra_cheap',
  action_compose:   'mid',
  dream:            'mid',
  agency_judge:     'mid',
  skill_generate:   'heavy',
  source_patch:     'heavy',
}

export type Candidate = { provider: ProviderId; model: string }

// Ordered cheapest → most expensive within each tier.
// Phase A only needs narrative + dream; the full table is here so later
// phases (B-I) can use the same router without policy changes.
const TIER_CANDIDATES: Record<Tier, Candidate[]> = {
  ultra_cheap: [
    { provider: 'gemini',         model: 'gemini-2.5-flash-lite' },
    { provider: 'kimi',           model: 'moonshot-v1-8k' },
    { provider: 'openai',         model: 'gpt-4o-mini' },
    { provider: 'anthropic_cli',  model: 'claude-haiku-4-5-20251001' },
    { provider: 'codex_cli',      model: 'gpt-5-mini' },
    { provider: 'anthropic_api',  model: 'claude-haiku-4-5-20251001' },
    { provider: 'ollama',         model: 'qwen3:8b' },
  ],
  mid: [
    { provider: 'gemini',         model: 'gemini-2.5-flash' },
    { provider: 'openai',         model: 'gpt-4o' },
    { provider: 'anthropic_cli',  model: 'claude-sonnet-4-6' },
    { provider: 'codex_cli',      model: 'gpt-5' },
    { provider: 'anthropic_api',  model: 'claude-sonnet-4-6' },
    { provider: 'ollama',         model: 'qwen3:32b' },
  ],
  heavy: [
    { provider: 'anthropic_cli',  model: 'claude-opus-4-7' },
    { provider: 'codex_cli',      model: 'gpt-5-codex' },
    { provider: 'anthropic_api',  model: 'claude-opus-4-7' },
    { provider: 'openai',         model: 'gpt-5' },
    { provider: 'gemini',         model: 'gemini-2.5-pro' },
  ],
}

export function tierForTask(t: TaskType): Tier {
  return TASK_TO_TIER[t]
}

export function defaultCandidates(t: TaskType): Candidate[] {
  return TIER_CANDIDATES[tierForTask(t)].slice()
}
