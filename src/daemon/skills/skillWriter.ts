// src/daemon/skills/skillWriter.ts
// Atomic persistence of SKILL.md + optional scripts/ directory to ~/.kairos/skills/<slug>/.

import { homedir } from 'os'
import { join } from 'path'
import { mkdirSync, existsSync, writeFileSync, renameSync } from 'fs'
import type { SkillFile } from './types'
import { serializeSkillMd } from './skillMd'

export type SkillWriteOptions = {
  root_dir?: string                       // default ~/.kairos/skills/
  scripts?: { filename: string; content: string }[]   // optional scripts/ contents
  force?: boolean                          // if true, overwrite existing slug
}

export class SkillWriteError extends Error {
  constructor(message: string) { super(message) }
}

export class SkillWriter {
  private rootDir: string

  constructor(opts: { root_dir?: string } = {}) {
    this.rootDir = opts.root_dir ?? join(homedir(), '.kairos', 'skills')
    if (!existsSync(this.rootDir)) mkdirSync(this.rootDir, { recursive: true })
  }

  /** Write a SkillFile + optional scripts to disk. Atomic via tmp-then-rename. */
  write(skill: SkillFile, opts: SkillWriteOptions = {}): string {
    const dir = join(this.rootDir, skill.slug)
    if (existsSync(dir) && !opts.force) {
      throw new SkillWriteError(`Skill slug already exists: ${skill.slug}. Pass force=true to overwrite.`)
    }
    // Create dir (or ensure)
    mkdirSync(dir, { recursive: true })

    // Write SKILL.md atomically
    const skillMdPath = join(dir, 'SKILL.md')
    const tmpPath = skillMdPath + '.tmp.' + process.pid
    const content = serializeSkillMd({ ...skill, dir_path: dir })
    writeFileSync(tmpPath, content)
    renameSync(tmpPath, skillMdPath)

    // Write scripts if provided
    if (opts.scripts && opts.scripts.length > 0) {
      const scriptsDir = join(dir, 'scripts')
      if (!existsSync(scriptsDir)) mkdirSync(scriptsDir, { recursive: true })
      for (const s of opts.scripts) {
        const scriptPath = join(scriptsDir, s.filename)
        const stmp = scriptPath + '.tmp.' + process.pid
        writeFileSync(stmp, s.content)
        renameSync(stmp, scriptPath)
      }
    }

    return dir
  }

  /** Check if a slug exists. */
  exists(slug: string): boolean {
    return existsSync(join(this.rootDir, slug, 'SKILL.md'))
  }

  /** Return absolute path to a slug's dir (whether or not it exists). */
  pathFor(slug: string): string {
    return join(this.rootDir, slug)
  }
}
