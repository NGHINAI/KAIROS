// src/daemon/skills/skillStore.ts
// SQLite-backed index of skill metadata. Filesystem is the source of truth;
// this is a cache for fast boot-time listing without scanning hundreds of SKILL.md files.

import type { Database } from 'bun:sqlite'
import { existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { loadSkillFromDir } from './skillMd'
import type { SkillState } from './types'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS skills_index (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active',
  pinned INTEGER NOT NULL DEFAULT 0,
  tier TEXT,
  last_used_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  dir_path TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_skills_state ON skills_index(state);
CREATE INDEX IF NOT EXISTS idx_skills_last_used ON skills_index(last_used_at);
`

export type SkillIndexRow = {
  slug: string
  name: string
  description: string
  state: SkillState
  pinned: boolean
  tier?: string                          // from kairos:autonomy_tier metadata
  last_used_at: number
  created_at: number
  dir_path: string
}

export type SkillStoreOptions = {
  root_dir?: string                       // default ~/.kairos/skills/
}

export class SkillStore {
  private rootDir: string

  constructor(private db: Database, opts: SkillStoreOptions = {}) {
    db.exec(SCHEMA)
    this.rootDir = opts.root_dir ?? join(homedir(), '.kairos', 'skills')
  }

  upsert(row: SkillIndexRow): void {
    this.db.run(
      `INSERT INTO skills_index (slug, name, description, state, pinned, tier, last_used_at, created_at, dir_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET
         name = excluded.name,
         description = excluded.description,
         state = excluded.state,
         pinned = excluded.pinned,
         tier = excluded.tier,
         last_used_at = excluded.last_used_at,
         created_at = excluded.created_at,
         dir_path = excluded.dir_path`,
      [
        row.slug, row.name, row.description, row.state,
        row.pinned ? 1 : 0, row.tier ?? null,
        row.last_used_at, row.created_at, row.dir_path,
      ],
    )
  }

  get(slug: string): SkillIndexRow | null {
    const r = this.db.query(`SELECT * FROM skills_index WHERE slug = ?`).get(slug) as any
    return r ? this.rowFromDb(r) : null
  }

  listActive(): SkillIndexRow[] {
    const rows = this.db.query(`SELECT * FROM skills_index WHERE state = 'active' ORDER BY name`).all() as any[]
    return rows.map(r => this.rowFromDb(r))
  }

  listAll(): SkillIndexRow[] {
    const rows = this.db.query(`SELECT * FROM skills_index ORDER BY name`).all() as any[]
    return rows.map(r => this.rowFromDb(r))
  }

  /** Mark stale based on inactivity threshold. Returns slugs that transitioned. */
  markStaleByAge(thresholdMs: number, now: number = Date.now()): string[] {
    const cutoff = now - thresholdMs
    const candidates = this.db.query(
      `SELECT slug FROM skills_index WHERE state = 'active' AND pinned = 0 AND last_used_at > 0 AND last_used_at < ?`,
    ).all(cutoff) as Array<{ slug: string }>
    const slugs: string[] = []
    for (const c of candidates) {
      this.db.run(`UPDATE skills_index SET state = 'stale' WHERE slug = ?`, [c.slug])
      slugs.push(c.slug)
    }
    return slugs
  }

  /** Remove from index (called when a skill is fully archived to .archive/). */
  remove(slug: string): void {
    this.db.run(`DELETE FROM skills_index WHERE slug = ?`, [slug])
  }

  /** Rescan the rootDir and rebuild the index from disk. Used on boot if index is stale or missing. */
  rebuildFromDisk(): number {
    // Clear active entries
    this.db.run(`DELETE FROM skills_index`)
    if (!existsSync(this.rootDir)) return 0
    let count = 0
    for (const entry of readdirSync(this.rootDir)) {
      if (entry.startsWith('.')) continue  // skip .archive etc.
      const dir = join(this.rootDir, entry)
      try { if (!statSync(dir).isDirectory()) continue } catch { continue }
      const skill = loadSkillFromDir(dir, { strict: false })
      if (!skill) continue
      const tier = skill.metadata?.['kairos:autonomy_tier']
      const state = (skill.metadata?.['kairos:state'] as SkillState | undefined) ?? 'active'
      this.upsert({
        slug: skill.slug,
        name: skill.name,
        description: skill.description,
        state,
        pinned: skill.metadata?.['kairos:pinned'] === 'true',
        tier,
        last_used_at: 0,                  // .usage.json is the source for this; not loaded here
        created_at: Date.now(),
        dir_path: dir,
      })
      count++
    }
    return count
  }

  private rowFromDb(r: any): SkillIndexRow {
    return {
      slug: r.slug,
      name: r.name,
      description: r.description,
      state: r.state,
      pinned: r.pinned === 1,
      tier: r.tier ?? undefined,
      last_used_at: r.last_used_at,
      created_at: r.created_at,
      dir_path: r.dir_path,
    }
  }
}
