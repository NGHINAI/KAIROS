// src/daemon/skills/curator.ts
// Hermes-derived 2-phase skill lifecycle manager.
// Phase 1: deterministic stale/archive transitions.
// Phase 2: LLM-driven decisions on flagged (broken) skills.

import { existsSync, mkdirSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { ModelRouter } from '../llm/router'
import type { SkillStore } from './skillStore'
import type { UsageTracker } from './usageTracker'
import type { SkillWriter } from './skillWriter'
import type { SkillFile } from './types'
import { loadSkillFromDir, serializeSkillMd } from './skillMd'

const DAY_MS = 24 * 60 * 60 * 1000

const PHASE2_SYSTEM_PROMPT = `You are the Curator for a skill that has been flagged for review because it failed during recent executions.

You will receive the SKILL.md content and the recent failure_history. Decide what to do.

Return STRICT JSON only:
{
  "action": "keep" | "patch" | "consolidate" | "archive",
  "reason": "<short explanation>",
  "patched_body": "<only required when action=patch — the new full markdown body>",
  "patched_description": "<optional new description when action=patch>",
  "consolidate_with": "<only required when action=consolidate — slug of the other skill to merge with>"
}

Guidance:
- "keep" if failures look transient (network blips, rate limits) or already self-corrected
- "patch" if failures point to a fixable issue in the SKILL.md body (wrong tool, missing step, bad assumption)
- "consolidate" if a similar skill exists that should subsume this one
- "archive" if the skill is fundamentally broken or no longer useful`

export type CuratorConfig = {
  stale_threshold_days?: number      // default 30
  archive_threshold_days?: number    // default 90
  min_skill_age_days?: number        // default 7 — young-skill guard
  phase2_ceiling?: number            // default 8
  root_dir?: string                  // default ~/.kairos/skills/
  archive_dir?: string               // default ~/.kairos/skills/.archive/
  cycle_interval_days?: number       // default 7
  idle_gate_ms?: number              // default 2h
}

const DEFAULTS: Required<CuratorConfig> = {
  stale_threshold_days: 30,
  archive_threshold_days: 90,
  min_skill_age_days: 7,
  phase2_ceiling: 8,
  root_dir: join(homedir(), '.kairos', 'skills'),
  archive_dir: join(homedir(), '.kairos', 'skills', '.archive'),
  cycle_interval_days: 7,
  idle_gate_ms: 2 * 60 * 60 * 1000,
}

export type CuratorDeps = {
  skillStore: SkillStore
  usageTracker: UsageTracker
  skillWriter: SkillWriter
  router?: ModelRouter   // optional — when omitted, Phase 2 is skipped (used by tests)
}

export type CuratorAction =
  | { type: 'marked_stale'; slug: string }
  | { type: 'archived'; slug: string; reason: 'aged_out' | 'llm_decision' }
  | { type: 'patched'; slug: string; reason: string }
  | { type: 'consolidated'; loser: string; into: string; reason: string }
  | { type: 'kept'; slug: string; reason: string }
  | { type: 'skipped'; slug: string; reason: string }
  | { type: 'error'; slug: string; error: string }

export type CuratorReport = {
  ran_at: number
  phase1: {
    marked_stale: string[]
    archived: string[]
  }
  phase2: {
    processed: number
    actions: CuratorAction[]
  }
}

export class Curator {
  private cfg: Required<CuratorConfig>

  constructor(private deps: CuratorDeps, config: CuratorConfig = {}) {
    this.cfg = { ...DEFAULTS, ...config }
  }

  /** Caller-side gating helper. Returns true if both gates pass. */
  shouldRun(now: number, lastRunAt: number, daemonIdleMs: number): boolean {
    if (now - lastRunAt < this.cfg.cycle_interval_days * DAY_MS) return false
    if (daemonIdleMs < this.cfg.idle_gate_ms) return false
    return true
  }

  async runOnce(now: number = Date.now()): Promise<CuratorReport> {
    const report: CuratorReport = {
      ran_at: now,
      phase1: { marked_stale: [], archived: [] },
      phase2: { processed: 0, actions: [] },
    }

    // ── Phase 1: deterministic ────────────────────────────────────────────
    this.runPhase1(now, report)

    // ── Phase 2: LLM-driven, only if router is configured ─────────────────
    if (this.deps.router) {
      await this.runPhase2(now, report)
    }

    this.writeReport(report)
    return report
  }

  private runPhase1(now: number, report: CuratorReport): void {
    const staleCutoff = this.cfg.stale_threshold_days * DAY_MS
    const archiveCutoff = this.cfg.archive_threshold_days * DAY_MS
    const youngCutoff = this.cfg.min_skill_age_days * DAY_MS

    // Mark stale by inactivity
    const all = this.deps.skillStore.listAll()
    for (const row of all) {
      if (row.pinned) continue
      const usage = this.deps.usageTracker.read(row.slug)
      if (!usage) continue
      // Young-skill guard: skip if too new
      if (now - usage.created_at < youngCutoff) continue

      // active → stale at 30d unused (only if it's been used at least once;
      // unused-since-creation skills with last_used_at=0 also count)
      const referenceTs = usage.last_used_at > 0 ? usage.last_used_at : usage.created_at

      if (row.state === 'active' && now - referenceTs >= staleCutoff) {
        this.deps.usageTracker.markState(row.slug, 'stale')
        this.deps.skillStore.upsert({ ...row, state: 'stale' })
        report.phase1.marked_stale.push(row.slug)
      }

      // stale → archived at 90d unused
      const currentState = (this.deps.skillStore.get(row.slug)?.state) ?? row.state
      if (currentState === 'stale' && now - referenceTs >= archiveCutoff) {
        this.archiveSkill(row.slug, row.dir_path)
        report.phase1.archived.push(row.slug)
      }
    }
  }

  private async runPhase2(now: number, report: CuratorReport): Promise<void> {
    const flagged = this.deps.skillStore.listAll().filter(r => {
      const u = this.deps.usageTracker.read(r.slug)
      return u?.curator_review_flag === true && r.state !== 'archived'
    })

    const toProcess = flagged.slice(0, this.cfg.phase2_ceiling)
    report.phase2.processed = toProcess.length

    for (const row of toProcess) {
      let wasArchived = false
      try {
        const skill = loadSkillFromDir(row.dir_path, { strict: false })
        if (!skill) {
          report.phase2.actions.push({ type: 'error', slug: row.slug, error: 'failed to load SKILL.md' })
          this.deps.usageTracker.clearCuratorFlag(row.slug)
          continue
        }
        const usage = this.deps.usageTracker.read(row.slug)
        // Record view (Phase 2 counts as a "view" per spec)
        this.deps.usageTracker.recordView(row.slug)

        const decision = await this.askLLM(skill, usage?.failure_history ?? [])
        switch (decision.action) {
          case 'keep':
            report.phase2.actions.push({ type: 'kept', slug: row.slug, reason: decision.reason })
            break
          case 'patch': {
            if (!decision.patched_body) {
              report.phase2.actions.push({ type: 'error', slug: row.slug, error: 'patch action without patched_body' })
              break
            }
            const newSkill: SkillFile = {
              ...skill,
              body: decision.patched_body,
              description: decision.patched_description ?? skill.description,
            }
            this.deps.skillWriter.write(newSkill, { force: true })
            this.deps.usageTracker.recordPatch(row.slug)
            // Clear failure_history after patch so we don't re-trigger immediately
            const u = this.deps.usageTracker.read(row.slug)
            if (u) {
              u.failure_history = []
              // Write directly to UsageTracker's path (decoupled from skill dir)
              writeFileSync(
                this.deps.usageTracker.pathFor(row.slug),
                JSON.stringify(u, null, 2),
              )
            }
            report.phase2.actions.push({ type: 'patched', slug: row.slug, reason: decision.reason })
            break
          }
          case 'consolidate': {
            if (!decision.consolidate_with) {
              report.phase2.actions.push({ type: 'error', slug: row.slug, error: 'consolidate without target slug' })
              break
            }
            const target = this.deps.skillStore.get(decision.consolidate_with)
            if (!target) {
              report.phase2.actions.push({ type: 'error', slug: row.slug, error: `consolidate target '${decision.consolidate_with}' not found` })
              break
            }
            // Archive the loser (current skill)
            this.archiveSkill(row.slug, row.dir_path)
            wasArchived = true
            report.phase2.actions.push({ type: 'consolidated', loser: row.slug, into: target.slug, reason: decision.reason })
            break
          }
          case 'archive':
            this.archiveSkill(row.slug, row.dir_path)
            wasArchived = true
            report.phase2.actions.push({ type: 'archived', slug: row.slug, reason: 'llm_decision' })
            break
          default:
            report.phase2.actions.push({ type: 'error', slug: row.slug, error: `unknown action: ${(decision as any).action}` })
        }
      } catch (err) {
        report.phase2.actions.push({
          type: 'error',
          slug: row.slug,
          error: err instanceof Error ? err.message : String(err),
        })
      } finally {
        // Don't call clearCuratorFlag on archived skills — UsageTracker.write() would recreate
        // the skill dir in root, making existsSync(dir) true again after archival.
        if (!wasArchived) {
          this.deps.usageTracker.clearCuratorFlag(row.slug)
        }
      }
    }
  }

  private async askLLM(
    skill: SkillFile,
    failure_history: Array<{ ts: number; error: string }>,
  ): Promise<{
    action: 'keep' | 'patch' | 'consolidate' | 'archive'
    reason: string
    patched_body?: string
    patched_description?: string
    consolidate_with?: string
  }> {
    const userPrompt = `SKILL.md content:
\`\`\`
${serializeSkillMd(skill).slice(0, 6000)}
\`\`\`

Recent failure_history (last ${failure_history.length}):
${failure_history.map(f => `- [${new Date(f.ts).toISOString()}] ${f.error}`).join('\n')}

Decide: keep | patch | consolidate | archive. Return strict JSON only.`

    const result = await this.deps.router!.complete({
      task_type: 'skill_curate' as any,
      system_blocks: [{ text: PHASE2_SYSTEM_PROMPT, cache_hint: 'long', source: 'persona' }],
      prompt: userPrompt,
      structured: true,
      max_output_tokens: 4000,
      latency_target: 'standard',
    })
    const parsed = result.parsed as any
    if (!parsed || typeof parsed !== 'object' || typeof parsed.action !== 'string') {
      throw new Error('Curator: LLM did not return parseable JSON with action field')
    }
    return parsed
  }

  private archiveSkill(slug: string, dirPath: string): void {
    if (!existsSync(this.cfg.archive_dir)) {
      mkdirSync(this.cfg.archive_dir, { recursive: true })
    }
    const dest = join(this.cfg.archive_dir, slug)
    if (existsSync(dirPath) && !existsSync(dest)) {
      renameSync(dirPath, dest)
    }
    this.deps.usageTracker.markState(slug, 'archived')
    this.deps.skillStore.remove(slug)
  }

  private writeReport(report: CuratorReport): void {
    if (!existsSync(this.cfg.root_dir)) mkdirSync(this.cfg.root_dir, { recursive: true })
    const path = join(this.cfg.root_dir, 'CURATOR-REPORT.md')
    const lines: string[] = []
    lines.push(`# CURATOR-REPORT.md`)
    lines.push('')
    lines.push(`Ran at: ${new Date(report.ran_at).toISOString()}`)
    lines.push('')
    lines.push(`## Phase 1 (deterministic)`)
    lines.push(`- Marked stale: ${report.phase1.marked_stale.length}`)
    for (const s of report.phase1.marked_stale) lines.push(`  - ${s}`)
    lines.push(`- Archived: ${report.phase1.archived.length}`)
    for (const s of report.phase1.archived) lines.push(`  - ${s}`)
    lines.push('')
    lines.push(`## Phase 2 (LLM)`)
    lines.push(`- Processed: ${report.phase2.processed}`)
    for (const a of report.phase2.actions) {
      lines.push(`  - ${JSON.stringify(a)}`)
    }
    writeFileSync(path, lines.join('\n') + '\n')
  }
}
