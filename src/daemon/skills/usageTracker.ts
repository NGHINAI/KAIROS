// src/daemon/skills/usageTracker.ts
// Per-skill .usage.json telemetry. Hermes 10-field schema + 2 KAIROS extensions.

import { homedir } from 'os'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs'
import type { SkillUsage, SkillState } from './types'

const MAX_FAILURES = 5   // failure_history bounded

function emptyUsage(): SkillUsage {
  return {
    use_count: 0,
    view_count: 0,
    last_used_at: 0,
    last_viewed_at: 0,
    patch_count: 0,
    last_patched_at: 0,
    created_at: Date.now(),
    state: 'active',
    pinned: false,
    archived_at: 0,
    curator_review_flag: false,
    failure_history: [],
  }
}

export type UsageTrackerOptions = {
  root_dir?: string                       // default ~/.kairos/skills/
}

export class UsageTracker {
  private rootDir: string

  constructor(opts: UsageTrackerOptions = {}) {
    this.rootDir = opts.root_dir ?? join(homedir(), '.kairos', 'skills')
  }

  private pathFor(slug: string): string {
    return join(this.rootDir, slug, '.usage.json')
  }

  /** Read .usage.json for slug, or null if missing. */
  read(slug: string): SkillUsage | null {
    const path = this.pathFor(slug)
    if (!existsSync(path)) return null
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as SkillUsage
    } catch {
      return null
    }
  }

  /** Atomic write — tmp-then-rename. */
  private write(slug: string, usage: SkillUsage): void {
    const dir = join(this.rootDir, slug)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const path = this.pathFor(slug)
    const tmp = path + '.tmp.' + process.pid
    writeFileSync(tmp, JSON.stringify(usage, null, 2))
    renameSync(tmp, path)
  }

  /** Initialize a usage record for a new skill. Idempotent — won't overwrite existing. */
  initialize(slug: string): SkillUsage {
    const existing = this.read(slug)
    if (existing) return existing
    const fresh = emptyUsage()
    this.write(slug, fresh)
    return fresh
  }

  /** Record an invocation. Updates use_count, last_used_at. On failure, appends to failure_history (bounded). */
  recordUse(slug: string, durationMs: number, success: boolean, errorMsg?: string): SkillUsage {
    const usage = this.read(slug) ?? emptyUsage()
    usage.use_count += 1
    usage.last_used_at = Date.now()
    if (!success && errorMsg) {
      const history = usage.failure_history ?? []
      history.push({ ts: Date.now(), error: errorMsg.slice(0, 500) })
      // Keep only the LAST 5 entries (drop oldest)
      usage.failure_history = history.slice(-MAX_FAILURES)
    }
    this.write(slug, usage)
    return usage
  }

  /** Record a metadata-only view (loaded but not invoked). */
  recordView(slug: string): SkillUsage {
    const usage = this.read(slug) ?? emptyUsage()
    usage.view_count += 1
    usage.last_viewed_at = Date.now()
    this.write(slug, usage)
    return usage
  }

  /** Record a patch (Curator updated the SKILL.md). */
  recordPatch(slug: string): SkillUsage {
    const usage = this.read(slug) ?? emptyUsage()
    usage.patch_count += 1
    usage.last_patched_at = Date.now()
    this.write(slug, usage)
    return usage
  }

  /** Update state. Pinned skills cannot enter stale/archived. */
  markState(slug: string, state: SkillState): SkillUsage {
    const usage = this.read(slug) ?? emptyUsage()
    if (usage.pinned && (state === 'stale' || state === 'archived')) {
      // Refuse — pinned skills are exempt
      return usage
    }
    usage.state = state
    if (state === 'archived' && usage.archived_at === 0) {
      usage.archived_at = Date.now()
    }
    this.write(slug, usage)
    return usage
  }

  /** Pin a skill — exempt from staleness/archival. */
  pin(slug: string): SkillUsage {
    const usage = this.read(slug) ?? emptyUsage()
    usage.pinned = true
    this.write(slug, usage)
    return usage
  }

  /** Set the Curator review flag (after a failure). */
  markCuratorFlag(slug: string): SkillUsage {
    const usage = this.read(slug) ?? emptyUsage()
    usage.curator_review_flag = true
    this.write(slug, usage)
    return usage
  }

  /** Clear the Curator review flag after the Curator has processed the skill. */
  clearCuratorFlag(slug: string): SkillUsage {
    const usage = this.read(slug) ?? emptyUsage()
    usage.curator_review_flag = false
    this.write(slug, usage)
    return usage
  }
}
