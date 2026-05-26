import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { ModelRouter, type KairosMode } from './router'
import { CostTracker } from './costTracker'
import type {
  CompletionRequest, CompletionResult, LLMProvider, ProviderId, Tier,
} from './types'

function fakeProvider(
  id: ProviderId,
  opts: { configured?: boolean; shouldFail?: boolean; cost?: number } = {},
): LLMProvider {
  return {
    id,
    isConfigured: () => opts.configured ?? true,
    modelsForTier: (_t: Tier) => [`fake-${id}-model`],
    pricePerMillion: () => ({ input: 1, output: 4 }),
    complete: async (model: string, req: CompletionRequest): Promise<CompletionResult> => {
      if (opts.shouldFail) throw new Error(`fake ${id} failure`)
      return {
        text: `response from ${id}`,
        provider: id,
        model,
        cost_cents: opts.cost ?? 1,
        latency_ms: 10,
        fallback_count: 0,
        input_tokens: 10,
        output_tokens: 5,
      }
    },
  }
}

describe('ModelRouter', () => {
  let db: Database
  let tracker: CostTracker

  beforeEach(() => {
    db = new Database(':memory:')
    tracker = new CostTracker(db, 50)
  })

  it('routes to cheapest configured provider in tier', async () => {
    const router = new ModelRouter({
      providers: { gemini: fakeProvider('gemini'), openai: fakeProvider('openai') } as any,
      tracker,
      candidates: () => [
        { provider: 'gemini', model: 'g' },
        { provider: 'openai', model: 'o' },
      ],
    })
    const result = await router.complete({ task_type: 'narrative', system_blocks: [], prompt: 'hi' })
    expect(result.provider).toBe('gemini')
    expect(result.fallback_count).toBe(0)
  })

  it('falls back when first provider throws', async () => {
    const router = new ModelRouter({
      providers: {
        gemini: fakeProvider('gemini', { shouldFail: true }),
        openai: fakeProvider('openai'),
      } as any,
      tracker,
      candidates: () => [
        { provider: 'gemini', model: 'g' },
        { provider: 'openai', model: 'o' },
      ],
    })
    const result = await router.complete({ task_type: 'narrative', system_blocks: [], prompt: 'hi' })
    expect(result.provider).toBe('openai')
    expect(result.fallback_count).toBe(1)
  })

  it('skips unconfigured providers', async () => {
    const router = new ModelRouter({
      providers: {
        gemini: fakeProvider('gemini', { configured: false }),
        openai: fakeProvider('openai'),
      } as any,
      tracker,
      candidates: () => [
        { provider: 'gemini', model: 'g' },
        { provider: 'openai', model: 'o' },
      ],
    })
    const result = await router.complete({ task_type: 'narrative', system_blocks: [], prompt: 'hi' })
    expect(result.provider).toBe('openai')
    expect(result.fallback_count).toBe(0)
  })

  it('records cost in tracker', async () => {
    const router = new ModelRouter({
      providers: { gemini: fakeProvider('gemini', { cost: 7 }) } as any,
      tracker,
      candidates: () => [{ provider: 'gemini', model: 'g' }],
    })
    await router.complete({ task_type: 'narrative', system_blocks: [], prompt: 'hi' })
    expect(tracker.monthlyCostCents()).toBe(7)
  })

  it('throws when all providers fail', async () => {
    const router = new ModelRouter({
      providers: {
        gemini: fakeProvider('gemini', { shouldFail: true }),
        openai: fakeProvider('openai', { shouldFail: true }),
      } as any,
      tracker,
      candidates: () => [
        { provider: 'gemini', model: 'g' },
        { provider: 'openai', model: 'o' },
      ],
    })
    expect(router.complete({ task_type: 'narrative', system_blocks: [], prompt: 'hi' })).rejects.toThrow()
  })

  it('respects max_cost_cents budget gate', async () => {
    const router = new ModelRouter({
      providers: { openai: fakeProvider('openai', { cost: 100 }) } as any,
      tracker,
      candidates: () => [{ provider: 'openai', model: 'o' }],
    })
    const result = await router.complete({ task_type: 'narrative', system_blocks: [], prompt: 'hi', max_cost_cents: 9999 })
    expect(result.cost_cents).toBe(100)
  })
})

// ---------------------------------------------------------------------------
// Helper: build a router with a controlled availability list for mode tests
// ---------------------------------------------------------------------------
function createTestRouter(opts: { mode: KairosMode; available: ProviderId[] }) {
  const db = new Database(':memory:')
  const tracker = new CostTracker(db, 50)
  const providers: Partial<Record<ProviderId, LLMProvider>> = {}
  for (const pid of opts.available) {
    providers[pid] = fakeProvider(pid, { configured: true })
  }
  return new ModelRouter({ providers, tracker, mode: opts.mode })
}

describe('ModelRouter mode preferences', () => {
  it('byo mode: prefers Anthropic CLI when available', () => {
    const router = createTestRouter({ mode: 'byo', available: ['anthropic_cli', 'openai'] })
    const chosen = router.pickProviderForTask({ task_type: 'agency_judge' as any })
    expect(chosen.provider).toBe('anthropic_cli')
  })

  it('hosted mode: prefers gpt-5-nano for cheap tier', () => {
    const router = createTestRouter({ mode: 'hosted', available: ['anthropic_cli', 'openai', 'gemini'] })
    const chosen = router.pickProviderForTask({ task_type: 'observe_classify' as any })
    expect(chosen.provider).toBe('openai')
    expect(chosen.model).toBe('gpt-5-nano')
  })

  it('hosted mode: falls back to gemini if OpenAI unavailable', () => {
    const router = createTestRouter({ mode: 'hosted', available: ['gemini', 'kimi'] })
    const chosen = router.pickProviderForTask({ task_type: 'observe_classify' as any })
    expect(['gemini', 'kimi']).toContain(chosen.provider)
  })

  it('local mode: only Ollama, never API providers', () => {
    const router = createTestRouter({ mode: 'local', available: ['anthropic_cli', 'openai', 'ollama'] })
    const chosen = router.pickProviderForTask({ task_type: 'agency_judge' as any })
    expect(chosen.provider).toBe('ollama')
  })

  it('local mode + no Ollama: throws clear error', () => {
    const router = createTestRouter({ mode: 'local', available: ['anthropic_cli'] })
    expect(() => router.pickProviderForTask({ task_type: 'agency_judge' as any })).toThrow(/local mode|ollama/i)
  })
})
