// src/daemon/llm/router.ts
// The single entry point every LLM caller in KAIROS uses.
// Picks (provider, model) from the policy candidate list, tries each
// in order, falls back on failure, records cost. Unconfigured providers
// are silently skipped (not counted as failures).

import { logError } from '../logger'
import { tierForTask, type Candidate } from './policy'
import { CostTracker } from './costTracker'
import type {
  CompletionRequest, CompletionResult, LLMProvider, ProviderId, TaskType, Tier,
} from './types'

export type KairosMode = 'byo' | 'hosted' | 'local'

// Mode-aware provider preference tables.
// Tiers: ultra_cheap = cheap, mid = standard, heavy = heavy.
// Provider IDs must match ProviderId in types.ts.
type ModePrefs = Record<Tier, Candidate[]>

const MODE_PREFS: Record<KairosMode, ModePrefs> = {
  byo: {
    // OpenRouter is FIRST in every tier: when OPENROUTER_API_KEY is set we
    // route every BYO LLM call through it (perception/Tier1, Tier2, dreamer,
    // crystallizer). When unset, OpenRouter.isConfigured() returns false and
    // the router silently falls through to whatever the user has configured
    // (anthropic_cli / ollama / openai-direct).
    // NO claude: the byo fallback chain is OpenRouter-first with non-claude
    // fallbacks only (the runtime must never invoke a claude model — the old
    // anthropic_cli/anthropic_api fallbacks were removed).
    ultra_cheap: [
      { provider: 'openrouter',    model: process.env.KAIROS_FAST_MODEL  ?? 'openai/gpt-4o-mini' },
      { provider: 'ollama',        model: 'qwen3:8b' },
      { provider: 'openai',        model: 'gpt-4o-mini' },
    ],
    mid: [
      { provider: 'openrouter',    model: process.env.KAIROS_SMART_MODEL ?? 'moonshotai/kimi-k2' },
      { provider: 'codex_cli',     model: 'gpt-4o' },
      { provider: 'openai',        model: 'gpt-4o-mini' },
    ],
    heavy: [
      { provider: 'openrouter',    model: process.env.KAIROS_DEEP_MODEL  ?? 'moonshotai/kimi-k2-thinking' },
      { provider: 'codex_cli',     model: 'o1' },
      { provider: 'openai',        model: 'gpt-4o-mini' },
    ],
  },
  hosted: {
    ultra_cheap: [
      { provider: 'openai', model: 'gpt-5-nano' },           // $0.000164/call, $2.46/mo @ 15K
      { provider: 'gemini', model: 'gemini-2.5-flash-lite' }, // $0.000248/call, $3.72/mo @ 15K (deprecated Oct 2026)
      { provider: 'openai', model: 'gpt-5.4-nano' },         // $0.000586/call, $8.79/mo @ 15K
    ],
    mid: [
      { provider: 'openai', model: 'gpt-5-nano' },           // same cheap model — most "mid" tasks don't need more
      { provider: 'gemini', model: 'gemini-2.5-flash' },     // fallback for long-context if gpt-5-nano misses
      { provider: 'openai', model: 'gpt-5-mini' },           // upgrade if nano demonstrably fails
    ],
    heavy: [
      { provider: 'openai', model: 'gpt-5-mini' },           // primary — $0.000820/call, ~$0.62 per 5% of monthly calls
      { provider: 'kimi',   model: 'kimi-k2.5' },            // fallback, MoE reasoning for code tasks
      { provider: 'openai', model: 'gpt-4.1-mini' },         // fallback for 1M context if needed
    ],
  },
  local: {
    ultra_cheap: [
      { provider: 'ollama', model: 'qwen3:8b' },
    ],
    mid: [
      { provider: 'ollama', model: 'qwen3:32b' },
    ],
    heavy: [
      { provider: 'ollama', model: 'qwen3:32b' },
    ],
  },
}

export type ModelRouterOptions = {
  providers: Partial<Record<ProviderId, LLMProvider>>
  tracker: CostTracker
  candidates?: (taskType: TaskType) => Candidate[]
  mode?: KairosMode
}

export class ModelRouter {
  private providers: Partial<Record<ProviderId, LLMProvider>>
  private tracker: CostTracker
  private candidatesFn: (t: TaskType) => Candidate[]
  private mode: KairosMode

  constructor(opts: ModelRouterOptions) {
    this.providers = opts.providers
    this.tracker = opts.tracker
    this.mode = opts.mode ?? 'byo'
    // Tests inject `candidates` directly; production uses MODE_PREFS for the
    // active mode. This is the load-bearing fix: previously the production
    // path fell back to `defaultCandidates` (policy.ts) which did NOT include
    // openrouter and ignored mode entirely — meaning every BYO call site
    // tried claude_cli → ollama → openai-direct, none of which speak
    // OpenRouter. With MODE_PREFS hooked into complete(), the byo table's
    // openrouter entries are tried first.
    this.candidatesFn = opts.candidates ?? ((t: TaskType) => MODE_PREFS[this.mode][tierForTask(t)].slice())
  }

  /** Synchronously pick the first available (provider, model) for a task.
   *  Returns undefined if none available. */
  pickProviderForTask(req: Pick<CompletionRequest, 'task_type'>): Candidate {
    const tier = tierForTask(req.task_type)
    const candidates = MODE_PREFS[this.mode][tier]
    for (const cand of candidates) {
      const provider = this.providers[cand.provider]
      if (provider && provider.isConfigured()) {
        return cand
      }
    }
    if (this.mode === 'local') {
      throw new Error(
        'ModelRouter (local mode): no Ollama provider is available. ' +
        'Ensure Ollama is running and the ollama provider is configured.',
      )
    }
    throw new Error(
      `ModelRouter: no provider available for task=${req.task_type} in mode=${this.mode}`,
    )
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    if (this.tracker.isOverBudget()) {
      throw new Error('ModelRouter: monthly budget exceeded')
    }

    const candidates = req.fallback_chain
      ? req.fallback_chain.flatMap(pid => this.candidatesFn(req.task_type).filter(c => c.provider === pid))
      : this.candidatesFn(req.task_type)

    let fallbackCount = 0
    const errors: string[] = []

    for (const cand of candidates) {
      const provider = this.providers[cand.provider]
      if (!provider || !provider.isConfigured()) {
        continue
      }

      if (req.max_cost_cents !== undefined) {
        const estCents = this.estimateCostCents(provider, cand.model, req)
        if (estCents > req.max_cost_cents) {
          errors.push(`${cand.provider}/${cand.model} est cost ${estCents}¢ > budget ${req.max_cost_cents}¢`)
          continue
        }
      }

      try {
        const result = await provider.complete(cand.model, req)
        result.fallback_count = fallbackCount
        this.tracker.record({
          provider: result.provider,
          model: result.model,
          input_tokens: result.input_tokens,
          output_tokens: result.output_tokens,
          cost_cents: result.cost_cents,
          task_type: req.task_type,
          fallback_count: fallbackCount,
          latency_ms: result.latency_ms,
        })
        return result
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        errors.push(`${cand.provider}/${cand.model}: ${msg}`)
        logError(`ModelRouter ${cand.provider} failed`, err)
        fallbackCount++
      }
    }

    throw new Error(
      `ModelRouter: all candidates exhausted for task=${req.task_type}. Errors: ${errors.join(' | ')}`,
    )
  }

  private estimateCostCents(p: LLMProvider, model: string, req: CompletionRequest): number {
    const price = p.pricePerMillion(model)
    const inputTok = Math.ceil((req.prompt.length + ((req as { system?: string }).system?.length ?? 0)) / 4)
    const outputTok = req.max_output_tokens ?? Math.ceil(inputTok * 0.3)
    return Math.ceil(
      ((inputTok / 1_000_000) * price.input + (outputTok / 1_000_000) * price.output) * 100,
    )
  }
}
