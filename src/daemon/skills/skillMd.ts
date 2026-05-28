// src/daemon/skills/skillMd.ts
// Parser + serializer + validator for SKILL.md files (agentskills.io spec, Dec 2025).
// Adds KAIROS extension handling: metadata fields prefixed `kairos:` are recognized.

import { existsSync, statSync } from 'fs'
import { dirname, basename, join } from 'path'
import { MdLoader } from '../persona/mdLoader'
import type { SkillFile } from './types'

const NAME_REGEX = /^[a-z0-9][a-z0-9-]*$/

export class SkillMdError extends Error {
  constructor(message: string, public field?: string) { super(message) }
}

/** Validates frontmatter shape per agentskills.io spec. Throws SkillMdError on violation. */
function validateFrontmatter(fm: Record<string, unknown>): void {
  const name = fm.name
  if (typeof name !== 'string' || name.length === 0 || name.length > 64 || !NAME_REGEX.test(name)) {
    throw new SkillMdError(`Invalid 'name': must be 1-64 chars, lowercase alphanumeric+hyphens. Got: ${JSON.stringify(name)}`, 'name')
  }
  const description = fm.description
  if (typeof description !== 'string' || description.length === 0 || description.length > 1024) {
    throw new SkillMdError(`Invalid 'description': must be 1-1024 chars. Got length ${typeof description === 'string' ? description.length : 'non-string'}`, 'description')
  }
  if (fm.license !== undefined && typeof fm.license !== 'string') {
    throw new SkillMdError(`Invalid 'license': must be string`, 'license')
  }
  if (fm.compatibility !== undefined) {
    if (typeof fm.compatibility !== 'string') throw new SkillMdError(`Invalid 'compatibility': must be string`, 'compatibility')
    if ((fm.compatibility as string).length > 500) throw new SkillMdError(`Invalid 'compatibility': max 500 chars`, 'compatibility')
  }
  if (fm.allowed_tools !== undefined && !Array.isArray(fm.allowed_tools)) {
    throw new SkillMdError(`Invalid 'allowed_tools': must be string[]`, 'allowed_tools')
  }
  if (fm.metadata !== undefined && (typeof fm.metadata !== 'object' || Array.isArray(fm.metadata))) {
    throw new SkillMdError(`Invalid 'metadata': must be object (string→string)`, 'metadata')
  }
}

export type LoadSkillOptions = {
  /** If true, throws on validation errors. If false, returns null and logs. Default: true. */
  strict?: boolean
}

/** Load a SKILL.md from a directory. The dir's basename must match the SKILL.md's `name`. */
export function loadSkillFromDir(dirPath: string, opts: LoadSkillOptions = {}): SkillFile | null {
  const skillMdPath = join(dirPath, 'SKILL.md')
  if (!existsSync(skillMdPath)) return null
  const content = MdLoader.load(skillMdPath)
  if (!content) return null
  try {
    validateFrontmatter(content.frontmatter)
  } catch (err) {
    if (opts.strict !== false) throw err
    return null
  }
  const fm = content.frontmatter as any
  const dirName = basename(dirPath)
  if (fm.name !== dirName) {
    const e = new SkillMdError(`SKILL.md 'name' (${fm.name}) must match directory name (${dirName})`, 'name')
    if (opts.strict !== false) throw e
    return null
  }
  return {
    name: fm.name,
    description: fm.description,
    license: fm.license,
    compatibility: fm.compatibility,
    allowed_tools: fm.allowed_tools,
    metadata: (fm.metadata as Record<string, string>) ?? undefined,
    slug: fm.name,
    body: content.body.trim(),
    dir_path: dirPath,
    has_scripts: existsSync(join(dirPath, 'scripts')) && statSync(join(dirPath, 'scripts')).isDirectory(),
    has_references: existsSync(join(dirPath, 'references')) && statSync(join(dirPath, 'references')).isDirectory(),
  }
}

/** Serialize a SkillFile to a string (frontmatter + body). */
export function serializeSkillMd(skill: SkillFile): string {
  validateFrontmatter({
    name: skill.name,
    description: skill.description,
    license: skill.license,
    compatibility: skill.compatibility,
    allowed_tools: skill.allowed_tools,
    metadata: skill.metadata,
  })
  const fm: Record<string, unknown> = {
    name: skill.name,
    description: skill.description,
  }
  if (skill.license) fm.license = skill.license
  if (skill.compatibility) fm.compatibility = skill.compatibility
  if (skill.allowed_tools) fm.allowed_tools = skill.allowed_tools
  if (skill.metadata && Object.keys(skill.metadata).length > 0) fm.metadata = skill.metadata

  // Use yaml stringify from MdLoader pattern
  const { stringify } = require('yaml')
  return '---\n' + stringify(fm).trimEnd() + '\n---\n\n' + skill.body
}

/** Pull KAIROS-prefixed extension fields from metadata. */
export function extractKairosExtensions(skill: SkillFile): Record<string, string> {
  if (!skill.metadata) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(skill.metadata)) {
    if (k.startsWith('kairos:')) out[k] = v
  }
  return out
}
