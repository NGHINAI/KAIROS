// src/daemon/persona/dreamingExtension.ts
// Three-phase Hermes Dreaming on top of Phase B's existing dreamer.
// Light: scan last 4 hours of trajectories → low-priority observations.
// REM:   cross-day association → mid-priority patterns.
// Deep:  long-term promotion → high-confidence updates to persona.md.

import { homedir } from 'os'
import { join } from 'path'
import { mkdirSync, existsSync, appendFileSync, readFileSync, writeFileSync, statSync } from 'fs'
import { stringify as stringifyYaml } from 'yaml'
import type { TrajEntry, DreamCycleEntry } from './types'
import type { TrajWriter } from './trajWriter'
import type { PersonaUpdater, PersonaDiff } from './personaUpdater'
import type { ModelRouter } from '../llm/router'

const DREAMS_PATH = join(homedir(), '.kairos', 'DREAMS.md')
const DREAMS_MAX_BYTES = 50 * 1024  // 50KB rollover

// 6-factor scoring weights — Hermes-derived
const WEIGHTS = {
  relevance: 0.30,
  frequency: 0.24,
  diversity: 0.15,
  recency: 0.15,
  consolidation: 0.10,
  richness: 0.06,
}

export type DreamingExtensionDeps = {
  trajWriter: TrajWriter
  personaUpdater: PersonaUpdater
  router?: ModelRouter   // optional — used for LLM-driven diff composition; falls back to heuristic
}

export type DreamCyclePhase = 'light' | 'rem' | 'deep'

export class DreamingExtension {
  constructor(private deps: DreamingExtensionDeps) {
    const dir = join(homedir(), '.kairos')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }

  /** Run one cycle of the specified phase. Returns the entry written to DREAMS.md. */
  async runCycle(phase: DreamCyclePhase): Promise<DreamCycleEntry> {
    const now = Date.now()
    const trajectories = this.gatherTrajectories(phase)

    let diff: PersonaDiff = {}
    let promoted = 0

    if (trajectories.length > 0) {
      const scored = this.scoreTrajectories(trajectories, phase)
      const promotable = this.selectPromotable(scored, phase)
      // LLM-driven diff when a router is available — learns communication_style /
      // preferences / working_patterns from how the user actually interacts. Falls
      // back to the heuristic (recent_themes only) when no router or on LLM failure.
      diff = (await this.composeDiffViaLlm(promotable, phase)) ?? this.buildDiffFromScored(promotable)
      promoted = Object.keys(diff).length

      if (promoted > 0) {
        this.deps.personaUpdater.applyDreamingDiff(diff)
      }
    }

    const entry: DreamCycleEntry = {
      ts: now,
      cycle_type: phase,
      trajectories_scanned: trajectories.length,
      observations_promoted_to_persona: promoted,
      persona_diff_summary: this.summarizeDiff(diff),
    }
    this.appendDreams(entry)
    return entry
  }

  /** Gather trajectories from disk per phase scope. */
  private gatherTrajectories(phase: DreamCyclePhase): TrajEntry[] {
    const now = Date.now()
    const days = this.deps.trajWriter.listDays()
    const all: TrajEntry[] = []
    for (const day of days) {
      const entries = this.deps.trajWriter.readDay(day)
      for (const e of entries) all.push(e)
    }
    const lookbackMs = phase === 'light'
      ? 4 * 60 * 60 * 1000           // 4h
      : phase === 'rem'
      ? 7 * 24 * 60 * 60 * 1000      // 7d
      : 30 * 24 * 60 * 60 * 1000      // 30d
    return all.filter(e => now - e.ts <= lookbackMs)
  }

  /** Score trajectories per 6-factor formula. Returns sorted high-to-low. */
  private scoreTrajectories(trajectories: TrajEntry[], phase: DreamCyclePhase): Array<{ entry: TrajEntry; score: number }> {
    if (trajectories.length === 0) return []
    const now = Date.now()
    const totalCount = trajectories.length
    const intentCounts = new Map<string, number>()
    for (const t of trajectories) intentCounts.set(t.intent_id, (intentCounts.get(t.intent_id) ?? 0) + 1)

    const scored = trajectories.map(entry => {
      // relevance: success outcome scores higher
      const relevance = entry.outcome === 'success' ? 1.0 : entry.outcome === 'partial' ? 0.5 : 0.0
      // frequency: how often this intent has fired in scope
      const frequency = Math.min(1.0, (intentCounts.get(entry.intent_id) ?? 1) / Math.max(5, totalCount * 0.3))
      // diversity: did the entry have multiple steps?
      const diversity = Math.min(1.0, (entry.steps?.length ?? 0) / 5)
      // recency: how recent
      const ageMs = now - entry.ts
      const recency = Math.max(0, 1 - ageMs / (30 * 24 * 60 * 60 * 1000))
      // consolidation: presence of user_override_reason hurts (user reversed it)
      const consolidation = entry.user_override_reason ? 0.0 : 1.0
      // richness: length of args_summary + step content (cap at 500)
      const richnessChars = (entry.args_summary?.length ?? 0) + entry.steps.reduce((n, s) => n + (s.result_summary?.length ?? 0), 0)
      const richness = Math.min(1.0, richnessChars / 500)

      const score =
        WEIGHTS.relevance * relevance +
        WEIGHTS.frequency * frequency +
        WEIGHTS.diversity * diversity +
        WEIGHTS.recency * recency +
        WEIGHTS.consolidation * consolidation +
        WEIGHTS.richness * richness
      return { entry, score }
    })

    return scored.sort((a, b) => b.score - a.score)
  }

  /** Select trajectories whose score crosses the phase-specific promotion threshold. */
  private selectPromotable(scored: Array<{ entry: TrajEntry; score: number }>, phase: DreamCyclePhase): Array<{ entry: TrajEntry; score: number }> {
    const threshold = phase === 'light' ? 0.65 : phase === 'rem' ? 0.55 : 0.45
    return scored.filter(s => s.score >= threshold).slice(0, phase === 'deep' ? 10 : 5)
  }

  /** LLM-driven persona diff. Reads promotable trajectories (what the user did +
   *  how they interacted) and proposes updates to communication_style / preferences
   *  / working_patterns / recent_themes. Returns null when no router or on failure
   *  → caller falls back to the heuristic. This is what makes persona.md actually
   *  LEARN the user's style, not just tally activity counts. */
  private async composeDiffViaLlm(
    promotable: Array<{ entry: TrajEntry; score: number }>,
    phase: DreamCyclePhase,
  ): Promise<PersonaDiff | null> {
    if (!this.deps.router || promotable.length === 0) return null
    try {
      const current = this.deps.personaUpdater.get()
      const trajLines = promotable.slice(0, 12).map(({ entry }) =>
        `- [${entry.intent_id}] goal="${entry.task_goal}" outcome=${entry.outcome}` +
        (entry.user_override_reason ? ` (user override: ${entry.user_override_reason})` : ''),
      ).join('\n')
      const system = `You maintain a CONCISE profile of a user for their AI assistant. Given the user's CURRENT profile and recent interaction trajectories, propose updates. Only include a field if you have real evidence to add/refine it; omit unchanged fields. Keep each field to 1-2 short sentences.
Return ONLY JSON: { "communication_style"?: string, "preferences"?: string, "working_patterns"?: string, "recent_themes"?: string }`
      const prompt = `CURRENT PROFILE:\ncommunication_style: ${current.communication_style ?? '(none)'}\npreferences: ${current.preferences ?? '(none)'}\nworking_patterns: ${current.working_patterns ?? '(none)'}\n\nRECENT TRAJECTORIES (${phase} cycle):\n${trajLines}\n\nPropose profile updates as JSON.`
      const r = await this.deps.router.complete({
        task_type: 'dream',
        system_blocks: [{ text: system, cache_hint: 'long' }],
        prompt,
        max_output_tokens: 512,  // headroom for reasoning models (persona diff)
      } as any)
      const text = (r as any).text ?? (r as any).output ?? ''
      const diff = parsePersonaDiff(text)
      return diff && Object.keys(diff).length > 0 ? diff : null
    } catch {
      return null
    }
  }

  /** Build a PersonaDiff from promotable trajectories. Heuristic fallback (recent_themes only). */
  private buildDiffFromScored(promotable: Array<{ entry: TrajEntry; score: number }>): PersonaDiff {
    if (promotable.length === 0) return {}
    const themesParts: string[] = []
    const intentCounts = new Map<string, number>()
    for (const { entry } of promotable) intentCounts.set(entry.intent_id, (intentCounts.get(entry.intent_id) ?? 0) + 1)
    const topIntents = [...intentCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
    if (topIntents.length > 0) {
      themesParts.push(`Recent activities: ${topIntents.map(([id, n]) => `${id} (${n})`).join(', ')}`)
    }
    return themesParts.length > 0 ? { recent_themes: themesParts.join('. ') } : {}
  }

  private summarizeDiff(diff: PersonaDiff): string {
    const keys = Object.keys(diff).filter(k => (diff as any)[k])
    if (keys.length === 0) return 'no changes'
    return `updated: ${keys.join(', ')}`
  }

  private appendDreams(entry: DreamCycleEntry): void {
    // Rollover at DREAMS_MAX_BYTES
    if (existsSync(DREAMS_PATH)) {
      const size = statSync(DREAMS_PATH).size
      if (size > DREAMS_MAX_BYTES) {
        // Keep latter half
        const raw = readFileSync(DREAMS_PATH, 'utf8')
        const halfIdx = Math.floor(raw.length / 2)
        const truncated = raw.slice(halfIdx)
        // Find next document boundary
        const start = truncated.indexOf('\n---\n')
        writeFileSync(DREAMS_PATH, start >= 0 ? truncated.slice(start + 1) : truncated)
      }
    }
    const block = '---\n' + stringifyYaml(entry).trimEnd() + '\n---\n'
    appendFileSync(DREAMS_PATH, block)
  }
}

/** Tolerant parse of an LLM persona-diff (JSON object, possibly fenced/prose). */
function parsePersonaDiff(text: string): PersonaDiff | null {
  if (!text) return null
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) return null
  try {
    const o = JSON.parse(text.slice(start, end + 1))
    const diff: PersonaDiff = {}
    for (const k of ['communication_style', 'preferences', 'working_patterns', 'recent_themes'] as const) {
      if (typeof o[k] === 'string' && o[k].trim()) (diff as any)[k] = o[k].trim()
    }
    return diff
  } catch { return null }
}
