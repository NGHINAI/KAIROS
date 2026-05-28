import { describe, it, expect, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SkillWriter, SkillWriteError } from './skillWriter'
import { loadSkillFromDir } from './skillMd'
import type { SkillFile } from './types'

function makeSkill(slug: string, body = 'Step 1: do thing'): SkillFile {
  return {
    name: slug,
    description: 'A test skill for ' + slug,
    slug,
    body,
    dir_path: '',
    has_scripts: false,
    has_references: false,
  }
}

describe('SkillWriter', () => {
  let tmp: string
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'kairos-sw-')) })

  it('writes SKILL.md with valid frontmatter', () => {
    const writer = new SkillWriter({ root_dir: tmp })
    const dir = writer.write(makeSkill('basic'))
    expect(existsSync(join(dir, 'SKILL.md'))).toBe(true)
    const skill = loadSkillFromDir(dir)
    expect(skill?.name).toBe('basic')
    rmSync(tmp, { recursive: true })
  })

  it('creates scripts/ when scripts provided', () => {
    const writer = new SkillWriter({ root_dir: tmp })
    const dir = writer.write(makeSkill('with-script'), {
      scripts: [{ filename: 'main.ts', content: 'export default function() {}' }],
    })
    expect(existsSync(join(dir, 'scripts', 'main.ts'))).toBe(true)
    expect(readFileSync(join(dir, 'scripts', 'main.ts'), 'utf8')).toContain('export default')
    rmSync(tmp, { recursive: true })
  })

  it('rejects on slug collision unless force=true', () => {
    const writer = new SkillWriter({ root_dir: tmp })
    writer.write(makeSkill('dup'))
    expect(() => writer.write(makeSkill('dup'))).toThrow(SkillWriteError)
    // force=true succeeds
    writer.write(makeSkill('dup', 'NEW BODY'), { force: true })
    const skill = loadSkillFromDir(join(tmp, 'dup'))
    expect(skill?.body).toContain('NEW BODY')
    rmSync(tmp, { recursive: true })
  })

  it('atomic write — tmp file does not remain after success', () => {
    const writer = new SkillWriter({ root_dir: tmp })
    const dir = writer.write(makeSkill('atomic'))
    const files = readdirSync(dir)
    expect(files.filter((f: string) => f.includes('.tmp.')).length).toBe(0)
    rmSync(tmp, { recursive: true })
  })

  it('exists() returns true after write', () => {
    const writer = new SkillWriter({ root_dir: tmp })
    expect(writer.exists('q')).toBe(false)
    writer.write(makeSkill('q'))
    expect(writer.exists('q')).toBe(true)
    rmSync(tmp, { recursive: true })
  })

  it('round-trip: write then load via skillMd parser', () => {
    const writer = new SkillWriter({ root_dir: tmp })
    const orig = { ...makeSkill('rt'), metadata: { 'kairos:autonomy_tier': 'GREEN' } } as any
    const dir = writer.write(orig)
    const loaded = loadSkillFromDir(dir)
    expect(loaded?.metadata?.['kairos:autonomy_tier']).toBe('GREEN')
    rmSync(tmp, { recursive: true })
  })
})
