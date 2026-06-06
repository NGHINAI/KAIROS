import { describe, it, expect } from 'bun:test'
import { AwmWorker } from './awmWorker'
import type { TrajEntry } from '../persona/types'
import type { SkillCandidate, SkillFile, PersonaGateVerdict } from './types'

function entry(opts: {
  ts?: number
  intent_id?: string
  outcome?: TrajEntry['outcome']
  steps?: number
  duration_ms?: number
  actions?: string[]
}): TrajEntry {
  const steps = opts.actions
    ? opts.actions.map(a => ({ action: a, result_summary: 'ok' }))
    : Array.from({ length: opts.steps ?? 6 }, (_, i) => ({ action: `tool.step_${i}`, result_summary: 'ok' }))
  return {
    ts: opts.ts ?? Date.now(),
    task_goal: 'test',
    intent_id: opts.intent_id ?? 'send_message',
    args_summary: 'channel=#general',
    steps,
    outcome: opts.outcome ?? 'success',
    duration_ms: opts.duration_ms ?? 60_000,
  }
}

function makeDeps(opts: {
  entries: TrajEntry[]
  verdict: (s: SkillFile) => PersonaGateVerdict & { promoted?: boolean; review_id?: number }
  crystallizeThrows?: boolean
}) {
  const calls: { crystallize: number; evaluate: number } = { crystallize: 0, evaluate: 0 }
  return {
    calls,
    trajWriter: {
      listDays: () => ['2026-05-28'],
      readDay: (_d: string) => opts.entries,
    },
    crystallizer: {
      async crystallize(cand: SkillCandidate): Promise<SkillFile> {
        calls.crystallize++
        if (opts.crystallizeThrows) throw new Error('LLM down')
        return {
          name: `skill-${cand.cluster_id}`,
          description: 'auto-generated test skill',
          slug: `skill-${cand.cluster_id}`,
          body: 'body',
          metadata: { 'kairos:autonomy_tier': 'GREEN' },
          dir_path: '',
          has_scripts: false,
          has_references: false,
        }
      },
    },
    personaGate: {
      async evaluate(s: SkillFile) {
        calls.evaluate++
        return opts.verdict(s)
      },
    },
  }
}

describe('AwmWorker', () => {
  it('finds clusters meeting the occurrence threshold', async () => {
    const entries: TrajEntry[] = [
      // 3 occurrences of pattern A (clusterable)
      entry({ actions: ['x.a', 'x.b', 'x.c', 'x.d', 'x.e', 'x.f'] }),
      entry({ actions: ['x.a', 'x.b', 'x.c', 'x.d', 'x.e', 'x.f'] }),
      entry({ actions: ['x.a', 'x.b', 'x.c', 'x.d', 'x.e', 'x.f'] }),
    ]
    const deps = makeDeps({
      entries,
      verdict: () => ({ approved: true, tier: 'GREEN', is_duplicate: false, needs_human_review: false, reason: 'ok', promoted: true }),
    })
    const w = new AwmWorker(deps, { min_occurrences: 3 })
    const r = await w.runOnce()
    expect(r.candidates_found).toBe(1)
    expect(r.promoted).toBe(1)
    expect(deps.calls.crystallize).toBe(1)
  })

  it('ignores below-threshold patterns', async () => {
    const entries: TrajEntry[] = [
      // Only 2 occurrences — below default min_occurrences=3
      entry({ actions: ['y.a', 'y.b', 'y.c', 'y.d', 'y.e', 'y.f'] }),
      entry({ actions: ['y.a', 'y.b', 'y.c', 'y.d', 'y.e', 'y.f'] }),
    ]
    const deps = makeDeps({ entries, verdict: () => ({ approved: true, tier: 'GREEN', is_duplicate: false, needs_human_review: false, reason: 'ok' }) })
    const w = new AwmWorker(deps)
    const r = await w.runOnce()
    expect(r.candidates_found).toBe(0)
    expect(deps.calls.crystallize).toBe(0)
  })

  it('A1: a NON-NUMERIC override (min_occurrences:"abc") is ignored, not turned into NaN — a single trajectory does NOT crystallize', async () => {
    const entries: TrajEntry[] = [entry({ actions: ['q.a', 'q.b', 'q.c', 'q.d', 'q.e', 'q.f'] })] // ONE trajectory
    const deps = makeDeps({ entries, verdict: () => ({ approved: true, tier: 'GREEN', is_duplicate: false, needs_human_review: false, reason: 'ok', promoted: true }) })
    const w = new AwmWorker(deps)
    // Bad override: previously `group.length < "abc"` → false → the gate was disabled
    // and the single trajectory was crystallized + promoted into the real library.
    const r = await w.runOnce({ min_occurrences: 'abc' as any })
    expect(r.candidates_found).toBe(0)   // default min_occurrences=3 still enforced
    expect(deps.calls.crystallize).toBe(0)
  })

  it('A1: numeric overrides are clamped to their floor (min_occurrences:0 → 1, negative lookback → 1)', async () => {
    const entries: TrajEntry[] = [entry({ actions: ['w.a', 'w.b', 'w.c', 'w.d', 'w.e', 'w.f'] })]
    const deps = makeDeps({ entries, verdict: () => ({ approved: true, tier: 'GREEN', is_duplicate: false, needs_human_review: false, reason: 'ok', promoted: true }) })
    const w = new AwmWorker(deps)
    // min_occurrences:0 clamps to 1 (a real threshold) → the single trajectory crystallizes ON PURPOSE
    const r = await w.runOnce({ min_occurrences: 0, min_tool_calls: 1, min_duration_ms: 0, lookback_days: -5 })
    expect(r.candidates_found).toBe(1)
    expect(r.promoted).toBe(1)
  })

  it('a non-array outcomes_accepted override is IGNORED (no TypeError mid-pipeline)', async () => {
    const acts = ['v.a', 'v.b', 'v.c', 'v.d', 'v.e', 'v.f']
    const entries: TrajEntry[] = [entry({ actions: acts }), entry({ actions: acts }), entry({ actions: acts })]
    const deps = makeDeps({ entries, verdict: () => ({ approved: true, tier: 'GREEN', is_duplicate: false, needs_human_review: false, reason: 'ok', promoted: true }) })
    const w = new AwmWorker(deps)
    // previously cfg.outcomes_accepted = 123 → `(123).includes` TypeError in passesThreshold
    const r = await w.runOnce({ outcomes_accepted: 123 as any })
    expect(r.errors).toBe(0)
    expect(r.candidates_found).toBe(1) // default ['success'] still applied
  })

  it('re-entrancy: a concurrent runOnce reports skipped:true (not a false empty)', async () => {
    let release!: () => void
    const slow = new Promise<void>((res) => { release = res })
    const acts = ['s.a', 's.b', 's.c', 's.d', 's.e', 's.f']
    const entries: TrajEntry[] = [entry({ actions: acts }), entry({ actions: acts }), entry({ actions: acts })]
    const deps: any = makeDeps({ entries, verdict: () => ({ approved: true, tier: 'GREEN', is_duplicate: false, needs_human_review: false, reason: 'ok', promoted: true }) })
    deps.crystallizer = { crystallize: async () => { await slow; return { name: 'x', slug: 'x', description: 'd', body: 'b', metadata: { 'kairos:autonomy_tier': 'GREEN' }, dir_path: '', has_scripts: false, has_references: false } } }
    const w = new AwmWorker(deps)
    const p1 = w.runOnce()                 // in-flight (crystallize hangs)
    await Promise.resolve()
    const r2 = await w.runOnce()           // concurrent → dropped
    expect(r2.skipped).toBe(true)
    expect(r2.candidates_found).toBe(0)
    release()
    await p1
  })

  it('filters out failed/short/quick trajectories', async () => {
    const entries: TrajEntry[] = [
      // good
      entry({ actions: ['z.a', 'z.b', 'z.c', 'z.d', 'z.e', 'z.f'] }),
      entry({ actions: ['z.a', 'z.b', 'z.c', 'z.d', 'z.e', 'z.f'] }),
      entry({ actions: ['z.a', 'z.b', 'z.c', 'z.d', 'z.e', 'z.f'] }),
      // failed → dropped
      entry({ actions: ['z.a', 'z.b', 'z.c', 'z.d', 'z.e', 'z.f'], outcome: 'failed' }),
      // too few steps → dropped
      entry({ steps: 3 }),
      // too short → dropped
      entry({ actions: ['z.a', 'z.b', 'z.c', 'z.d', 'z.e', 'z.f'], duration_ms: 1000 }),
    ]
    const deps = makeDeps({
      entries,
      verdict: () => ({ approved: true, tier: 'GREEN', is_duplicate: false, needs_human_review: false, reason: 'ok', promoted: true }),
    })
    const w = new AwmWorker(deps)
    const r = await w.runOnce()
    expect(r.candidates_found).toBe(1)
    expect(r.promoted).toBe(1)
  })

  it('counts deduplicated verdicts in the report', async () => {
    const entries: TrajEntry[] = [
      entry({ actions: ['dup.a', 'dup.b', 'dup.c', 'dup.d', 'dup.e', 'dup.f'] }),
      entry({ actions: ['dup.a', 'dup.b', 'dup.c', 'dup.d', 'dup.e', 'dup.f'] }),
      entry({ actions: ['dup.a', 'dup.b', 'dup.c', 'dup.d', 'dup.e', 'dup.f'] }),
    ]
    const deps = makeDeps({
      entries,
      verdict: () => ({ approved: false, tier: 'GREEN', is_duplicate: true, similar_existing: 'existing-skill', needs_human_review: false, reason: 'dup' }),
    })
    const w = new AwmWorker(deps)
    const r = await w.runOnce()
    expect(r.candidates_found).toBe(1)
    expect(r.deduplicated).toBe(1)
    expect(r.promoted).toBe(0)
  })

  it('counts queued ORANGE/RED verdicts separately from promoted', async () => {
    const entries: TrajEntry[] = [
      entry({ actions: ['orange.a', 'orange.b', 'orange.c', 'orange.d', 'orange.e', 'orange.f'] }),
      entry({ actions: ['orange.a', 'orange.b', 'orange.c', 'orange.d', 'orange.e', 'orange.f'] }),
      entry({ actions: ['orange.a', 'orange.b', 'orange.c', 'orange.d', 'orange.e', 'orange.f'] }),
    ]
    const deps = makeDeps({
      entries,
      verdict: () => ({ approved: false, tier: 'ORANGE', is_duplicate: false, needs_human_review: true, reason: 'risky', review_id: 42 }),
    })
    const w = new AwmWorker(deps)
    const r = await w.runOnce()
    expect(r.queued).toBe(1)
    expect(r.promoted).toBe(0)
  })

  it('runOnce returns a full metrics summary with all five fields', async () => {
    const deps = makeDeps({ entries: [], verdict: () => ({ approved: true, tier: 'GREEN', is_duplicate: false, needs_human_review: false, reason: 'ok' }) })
    const w = new AwmWorker(deps)
    const r = await w.runOnce()
    expect(r).toEqual({ candidates_found: 0, promoted: 0, queued: 0, deduplicated: 0, errors: 0 })
  })

  it('respects custom min_tool_calls config', async () => {
    const entries: TrajEntry[] = [
      // 3 short trajectories (3 steps each) — accepted only under loose config
      entry({ actions: ['a', 'b', 'c'], duration_ms: 60_000 }),
      entry({ actions: ['a', 'b', 'c'], duration_ms: 60_000 }),
      entry({ actions: ['a', 'b', 'c'], duration_ms: 60_000 }),
    ]
    const stricter = makeDeps({ entries, verdict: () => ({ approved: true, tier: 'GREEN', is_duplicate: false, needs_human_review: false, reason: 'ok', promoted: true }) })
    const strictWorker = new AwmWorker(stricter)
    const r1 = await strictWorker.runOnce()
    expect(r1.candidates_found).toBe(0)

    const looser = makeDeps({ entries, verdict: () => ({ approved: true, tier: 'GREEN', is_duplicate: false, needs_human_review: false, reason: 'ok', promoted: true }) })
    const loose = new AwmWorker(looser, { min_tool_calls: 2 })
    const r2 = await loose.runOnce()
    expect(r2.candidates_found).toBe(1)
    expect(r2.promoted).toBe(1)
  })

  it('catches crystallizer errors and increments errors counter', async () => {
    const entries: TrajEntry[] = [
      entry({ actions: ['e.a', 'e.b', 'e.c', 'e.d', 'e.e', 'e.f'] }),
      entry({ actions: ['e.a', 'e.b', 'e.c', 'e.d', 'e.e', 'e.f'] }),
      entry({ actions: ['e.a', 'e.b', 'e.c', 'e.d', 'e.e', 'e.f'] }),
    ]
    const deps = makeDeps({
      entries,
      verdict: () => ({ approved: true, tier: 'GREEN', is_duplicate: false, needs_human_review: false, reason: 'ok', promoted: true }),
      crystallizeThrows: true,
    })
    const w = new AwmWorker(deps)
    const r = await w.runOnce()
    expect(r.errors).toBe(1)
    expect(r.promoted).toBe(0)
  })
})
