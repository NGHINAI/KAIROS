// src/daemon/skills/skillRegistry.ts
// Hot-reloaded list of active skills with agentskills.io progressive disclosure.
// At boot: just slug+name+description (~100 tokens/skill) for the agency system prompt.
// On activation: loadFullSkill() returns body + records a view via UsageTracker.

import { homedir } from 'os'
import { join } from 'path'
import { existsSync, watch as fsWatch } from 'fs'
import { loadSkillFromDir } from './skillMd'
import type { SkillFile } from './types'
import type { SkillStore } from './skillStore'
import type { UsageTracker } from './usageTracker'

export type SkillMetadata = {
  slug: string
  name: string
  description: string
  tier?: string                          // from kairos:autonomy_tier
  last_used_at: number
}

export type SkillRegistryDeps = {
  skillStore: SkillStore
  usageTracker: UsageTracker
  /** Optional override; defaults to ~/.kairos/skills/. */
  rootDir?: string
}

export class SkillRegistry {
  private rootDir: string
  private watcherStop: (() => void) | null = null
  private rebuildPending = false

  constructor(private deps: SkillRegistryDeps) {
    this.rootDir = deps.rootDir ?? join(homedir(), '.kairos', 'skills')
  }

  /** Returns ~100-token metadata for all active skills. Suitable for the agency system prompt. */
  listActiveMetadata(): SkillMetadata[] {
    const rows = this.deps.skillStore.listActive()
    return rows.map(r => ({
      slug: r.slug,
      name: r.name,
      description: r.description,
      tier: r.tier,
      last_used_at: r.last_used_at,
    }))
  }

  /** Load the full SkillFile (body + scripts presence). Records a view. Returns null if not active. */
  loadFullSkill(slug: string): SkillFile | null {
    const row = this.deps.skillStore.get(slug)
    if (!row || row.state !== 'active') return null
    const skill = loadSkillFromDir(row.dir_path, { strict: false })
    if (!skill) return null
    this.deps.usageTracker.recordView(slug)
    return skill
  }

  /** Initial load on daemon boot. Rebuilds index from disk if SkillStore is empty. */
  initialize(): void {
    const existing = this.deps.skillStore.listAll()
    if (existing.length === 0 && existsSync(this.rootDir)) {
      this.deps.skillStore.rebuildFromDisk()
    }
  }

  /** Start watching ~/.kairos/skills/ for new skill directories. */
  startWatching(): void {
    if (this.watcherStop) return
    if (!existsSync(this.rootDir)) return   // first run; no skills yet
    try {
      const watcher = fsWatch(this.rootDir, { persistent: false, recursive: false }, () => {
        // Debounce: if multiple fs events fire rapidly, only rebuild once.
        if (this.rebuildPending) return
        this.rebuildPending = true
        setTimeout(() => {
          try { this.deps.skillStore.rebuildFromDisk() } catch { /* ignore */ }
          this.rebuildPending = false
        }, 200)
      })
      this.watcherStop = () => { watcher.close() }
    } catch {
      // file watcher unavailable on this platform — non-fatal
    }
  }

  stopWatching(): void {
    if (this.watcherStop) { this.watcherStop(); this.watcherStop = null }
  }

  /** Returns a SystemBlock-shaped descriptor for injection into LLM system_blocks.
   *  Lists active skills as "- <name>: <description>" lines.
   *  Empty list returns null (caller can skip). */
  buildSystemBlock(): { text: string; cache_hint: 'short'; source: 'skills' } | null {
    const metadata = this.listActiveMetadata()
    if (metadata.length === 0) return null
    const lines = ['Available skills (invoke via invoke_skill intent with the skill slug):']
    for (const m of metadata) {
      lines.push(`- ${m.name}: ${m.description}`)
    }
    return { text: lines.join('\n'), cache_hint: 'short', source: 'skills' }
  }
}
