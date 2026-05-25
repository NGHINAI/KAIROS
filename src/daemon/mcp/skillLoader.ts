// src/daemon/mcp/skillLoader.ts
// agentskills.io SKILL.md loader. Each skill = a directory with
// SKILL.md (YAML frontmatter + markdown body) + optional scripts/.
// Progressive disclosure: listSummaries() reads frontmatter only;
// load() reads full content + script list.

import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import type { SkillManifest, LoadedSkill } from './types'
import type { AutonomyTier } from '../agency/types'

export type SkillSummary = {
  name: string
  description: string
  version?: string
}

export class SkillLoader {
  constructor(private root: string) {}

  listSummaries(): SkillSummary[] {
    if (!existsSync(this.root)) return []
    const entries = readdirSync(this.root)
    const out: SkillSummary[] = []
    for (const entry of entries) {
      const dir = join(this.root, entry)
      if (!statSync(dir).isDirectory()) continue
      const manifest = this.readFrontmatter(dir)
      if (manifest) {
        out.push({ name: manifest.name, description: manifest.description, version: manifest.version })
      }
    }
    return out
  }

  load(name: string): LoadedSkill | null {
    const dir = join(this.root, name)
    if (!existsSync(dir)) return null
    const skillFile = join(dir, 'SKILL.md')
    if (!existsSync(skillFile)) return null

    const content = readFileSync(skillFile, 'utf8')
    const parsed = parseFrontmatter(content)
    if (!parsed) return null

    const manifest: SkillManifest = {
      name: parsed.fm.name ?? name,
      description: parsed.fm.description ?? '',
      version: parsed.fm.version,
      tier: parsed.fm.tier as AutonomyTier | undefined,
      trigger_pattern: parsed.fm.trigger_pattern,
    }
    if (!manifest.name || !manifest.description) return null

    const scriptsDir = join(dir, 'scripts')
    const scripts: string[] = existsSync(scriptsDir)
      ? readdirSync(scriptsDir).map(f => join(scriptsDir, f))
      : []

    return { manifest, body: parsed.body, dir, scripts: scripts.length > 0 ? scripts : undefined }
  }

  private readFrontmatter(dir: string): SkillManifest | null {
    const skillFile = join(dir, 'SKILL.md')
    if (!existsSync(skillFile)) return null
    const content = readFileSync(skillFile, 'utf8')
    const parsed = parseFrontmatter(content)
    if (!parsed) return null
    if (!parsed.fm.name || !parsed.fm.description) return null
    return {
      name: parsed.fm.name,
      description: parsed.fm.description,
      version: parsed.fm.version,
      tier: parsed.fm.tier as AutonomyTier | undefined,
      trigger_pattern: parsed.fm.trigger_pattern,
    }
  }
}

function parseFrontmatter(text: string): { fm: Record<string, string>; body: string } | null {
  const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/)
  if (!match) return null
  const fmRaw = match[1]!
  const body = match[2] ?? ''
  const fm: Record<string, string> = {}
  for (const line of fmRaw.split('\n')) {
    const kv = line.match(/^([\w_]+)\s*:\s*(.+?)\s*$/)
    if (kv) fm[kv[1]!] = kv[2]!.replace(/^['"]|['"]$/g, '')
  }
  return { fm, body }
}
