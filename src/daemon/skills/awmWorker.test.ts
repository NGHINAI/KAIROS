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
