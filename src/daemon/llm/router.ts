// src/daemon/llm/router.ts
// The single entry point every LLM caller in KAIROS uses.
// Picks (provider, model) from the policy candidate list, tries each
// in order, falls back on failure, records cost. Unconfigured providers
// are silently skipped (not counted as failures).

import { logError } from '../logger'
import { defaultCandidates, type Candidate } from './policy'
import { CostTracker } from './costTracker'
import type {
  CompletionRequest, CompletionResult, LLMProvider, ProviderId, TaskType,
} from './types'

export type ModelRouterOptions = {
  providers: Partial<Record<ProviderId, LLMProvider>>
  tracker: CostTracker
  candidates?: (taskType: TaskType) => Candidate[]
}

export class ModelRouter {
  private providers: Partial<Record<ProviderId, LLMProvider>>
  private tracker: CostTracker
  private candidatesFn: (t: TaskType) => Candidate[]

  constructor(opts: ModelRouterOptions) {
    this.providers = opts.providers
    this.tracker = opts.tracker
    this.candidatesFn = opts.candidates ?? defaultCandidates
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
    const inputTok = Math.ceil((req.prompt.length + (req.system?.length ?? 0)) / 4)
    const outputTok = req.max_output_tokens ?? Math.ceil(inputTok * 0.3)
    return Math.ceil(
      ((inputTok / 1_000_000) * price.input + (outputTok / 1_000_000) * price.output) * 100,
    )
  }
}
