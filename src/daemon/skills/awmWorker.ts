// src/daemon/skills/awmWorker.ts
// AWM (Automatic Workflow Memory) orchestrator. Reads ~/.kairos/traj/, finds recurring
// patterns ≥ threshold, crystallizes into skills via LLM, gates via PersonaGate.

import { createHash } from 'crypto'
import type { TrajWriter } from '../persona/trajWriter'
import type { TrajEntry } from '../persona/types'
import type { SkillCrystallizer } from './crystallizer'
import type { PersonaGate } from './personaGate'
import type { SkillCandidate } from './types'

export type AwmWorkerConfig = {
  lookback_days?: number
  min_tool_calls?: number       // steps.length > min_tool_calls (strict; per Hermes plan: "> 5")
  min_duration_ms?: number
  min_occurrences?: number
  outcomes_accepted?: TrajEntry['outcome'][]
}

const DEFAULTS: Required<AwmWorkerConfig> = {
  lookback_days: 30,
  min_tool_calls: 5,
  min_duration_ms: 30_000,
  min_occurrences: 3,
  outcomes_accepted: ['success'],
}

export type AwmWorkerDeps = {
  trajWriter: Pick<TrajWriter, 'listDays' | 'readDay'>
  crystallizer: Pick<SkillCrystallizer, 'crystallize'>
  personaGate: Pick<PersonaGate, 'evaluate'>
}

export type AwmRunReport = {
  candidates_found: number
  promoted: number
  queued: number
  deduplicated: number
  errors: number
  /** True when this call was DROPPED because another runOnce was already in flight
   *  (re-entrancy guard) — distinguishes "skipped" from a genuine empty result, so a
   *  caller (e.g. the genesis harness) doesn't read it as "no cluster formed". */
  skipped?: boolean
}

// Numeric threshold floors. An override is applied ONLY if it coerces to a finite
// number; it's then floored to an integer and clamped to its minimum. A non-numeric
// override (e.g. min_occurrences:"abc") is IGNORED — it must never turn into NaN and
// silently disable a gate (NaN comparisons are always false → a single trajectory
// would crystallize straight into the real skill library).
const OVERRIDE_FLOORS: Record<string, number> = {
  lookback_days: 1, min_tool_calls: 0, min_duration_ms: 0, min_occurrences: 1,
}
function sanitizeOverrides(o: Partial<AwmWorkerConfig>): Partial<AwmWorkerConfig> {
  const clean: Partial<AwmWorkerConfig> = {}
  for (const [k, floor] of Object.entries(OVERRIDE_FLOORS)) {
    const v = (o as any)[k]
    if (v === undefined || v === null) continue
    const n = Number(v)
    if (Number.isFinite(n)) (clean as any)[k] = Math.max(floor, Math.floor(n))
  }
  if (Array.isArray(o.outcomes_accepted) && o.outcomes_accepted.every((x) => typeof x === "string" && x)) {
    clean.outcomes_accepted = o.outcomes_accepted
  }
  return clean
}

export class AwmWorker {
  private cfg: Required<AwmWorkerConfig>
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false

  constructor(private deps: AwmWorkerDeps, config: AwmWorkerConfig = {}) {
    this.cfg = { ...DEFAULTS, ...config }
  }

  /** Run the induction pipeline once. `overrides` temporarily relaxes/tightens the
   *  thresholds for THIS run only (restored after) — used by the test-genesis hook
   *  so a couple of real runs can crystallize on demand instead of waiting for the
   *  production defaults (3 occurrences × >5 tool calls × >30s) to accrue. */
  async runOnce(overrides?: Partial<AwmWorkerConfig>): Promise<AwmRunReport> {
    if (this.running) {
      return { candidates_found: 0, promoted: 0, queued: 0, deduplicated: 0, errors: 0, skipped: true }
    }
    this.running = true
    const savedCfg = this.cfg
    if (overrides) this.cfg = { ...this.cfg, ...sanitizeOverrides(overrides) }
    try {
      const entries = this.loadEntries()
      const filtered = entries.filter(e => this.passesThreshold(e))
      const clusters = this.cluster(filtered)
      const candidates: SkillCandidate[] = []
      for (const [cluster_id, group] of clusters) {
        if (group.length < this.cfg.min_occurrences) continue
        candidates.push(this.buildCandidate(cluster_id, group))
      }

      const report: AwmRunReport = {
        candidates_found: candidates.length,
        promoted: 0,
        queued: 0,
        deduplicated: 0,
        errors: 0,
      }

      for (const cand of candidates) {
        try {
          const skill = await this.deps.crystallizer.crystallize(cand)
          const verdict = await this.deps.personaGate.evaluate(skill)
          if (verdict.is_duplicate) report.deduplicated++
          else if (verdict.promoted) report.promoted++
          else if (verdict.needs_human_review) report.queued++
        } catch {
          report.errors++
        }
      }
      return report
    } finally {
      this.cfg = savedCfg
      this.running = false
    }
  }

  start(intervalMs: number = 4 * 60 * 60 * 1000): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      this.runOnce().catch(() => {})
    }, intervalMs)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private loadEntries(): TrajEntry[] {
    const cutoff = Date.now() - this.cfg.lookback_days * 24 * 60 * 60 * 1000
    const days = this.deps.trajWriter.listDays()
    const out: TrajEntry[] = []
    for (const day of days) {
      const entries = this.deps.trajWriter.readDay(day)
      for (const e of entries) {
        if (e.ts >= cutoff) out.push(e)
      }
    }
    return out
  }

  private passesThreshold(e: TrajEntry): boolean {
    if (!this.cfg.outcomes_accepted.includes(e.outcome)) return false
    if (!e.steps || e.steps.length <= this.cfg.min_tool_calls) return false
    if (e.duration_ms <= this.cfg.min_duration_ms) return false
    return true
  }

  /** Cluster signature = intent_id + sorted action-tool sequence. We DON'T cluster on
   *  args_summary because that's a free-form string post-sanitization. Tool-call sequence
   *  is the structural fingerprint that survives across re-runs of the same recipe. */
  private signatureOf(e: TrajEntry): string {
    const actions = e.steps.map(s => extractToolName(s.action))
    return `${e.intent_id}::${actions.join('>')}`
  }

  private cluster(entries: TrajEntry[]): Map<string, TrajEntry[]> {
    const out = new Map<string, TrajEntry[]>()
    for (const e of entries) {
      const sig = this.signatureOf(e)
      let g = out.get(sig)
      if (!g) {
        g = []
        out.set(sig, g)
      }
      g.push(e)
    }
    return out
  }

  private buildCandidate(signature: string, group: TrajEntry[]): SkillCandidate {
    const cluster_id = createHash('sha256').update(signature).digest('hex').slice(0, 12)
    const intent_id = group[0]!.intent_id
    const totalSteps = group.reduce((s, e) => s + e.steps.length, 0)
    const successes = group.filter(e => e.outcome === 'success').length
    const sorted = [...group].sort((a, b) => a.ts - b.ts)
    return {
      cluster_id,
      trajectories: group,
      representative_signature: {
        intent_id,
        common_args: {},   // reserved for future arg-intersection analysis
        avg_tool_calls: totalSteps / group.length,
        success_rate: successes / group.length,
      },
      occurrences: group.length,
      first_seen_at: sorted[0]!.ts,
      last_seen_at: sorted[sorted.length - 1]!.ts,
    }
  }
}

/** Extract just the tool name from an action string like "slack.send_message({channel: '#x'})". */
function extractToolName(action: string): string {
  const m = action.match(/^([a-zA-Z0-9_.-]+)/)
  return m ? m[1]! : action
}
