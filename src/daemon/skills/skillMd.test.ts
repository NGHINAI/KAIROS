import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadSkillFromDir, serializeSkillMd, extractKairosExtensions, SkillMdError } from './skillMd'

describe('skillMd', () => {
  let tmp: string
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'kairos-skill-')) })
  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true })
    } catch {
      // ignore cleanup errors
    }
  })

  function makeSkillDir(slug: string, fmYaml: string, body = 'Body here.'): string {
    const dir = join(tmp, slug)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), `---\n${fmYaml}\n---\n\n${body}\n`)
    return dir
  }

  it('loads a valid SKILL.md', () => {
    const dir = makeSkillDir('hello-world',
      'name: hello-world\ndescription: A simple test skill that says hello when invoked.')
    const skill = loadSkillFromDir(dir)
    expect(skill?.name).toBe('hello-world')
    expect(skill?.description).toContain('hello')
    expect(skill?.slug).toBe('hello-world')
  })

  it('rejects name with uppercase letters', () => {
    const dir = makeSkillDir('Bad-Name',
      'name: Bad-Name\ndescription: must fail')
    expect(() => loadSkillFromDir(dir, { strict: true })).toThrow(SkillMdError)
  })

  it('rejects description longer than 1024 chars', () => {
    const longDesc = 'x'.repeat(1025)
    const dir = makeSkillDir('long-desc', `name: long-desc\ndescription: "${longDesc}"`)
    expect(() => loadSkillFromDir(dir, { strict: true })).toThrow(/1-1024 chars/)
  })

  it('rejects when SKILL.md name does not match directory name', () => {
    const dir = makeSkillDir('dir-name',
      'name: different-name\ndescription: must fail because name does not equal dirname')
    expect(() => loadSkillFromDir(dir, { strict: true })).toThrow(/must match directory name/)
  })

  it('returns null if SKILL.md missing in directory', () => {
    const dir = join(tmp, 'no-skill')
    mkdirSync(dir, { recursive: true })
    expect(loadSkillFromDir(dir)).toBeNull()
  })

  it('preserves metadata extension fields (kairos:*)', () => {
    const dir = makeSkillDir('with-meta', `name: with-meta
description: skill with kairos extensions
metadata:
  "kairos:autonomy_tier": GREEN
  "kairos:auto_crystallized": "true"`)
    const skill = loadSkillFromDir(dir)
    expect(skill?.metadata?.['kairos:autonomy_tier']).toBe('GREEN')
    const ext = extractKairosExtensions(skill!)
    expect(ext['kairos:autonomy_tier']).toBe('GREEN')
    expect(ext['kairos:auto_crystallized']).toBe('true')
  })

  it('detects presence of scripts/ directory', () => {
    const dir = makeSkillDir('with-scripts',
      'name: with-scripts\ndescription: test')
    mkdirSync(join(dir, 'scripts'))
    writeFileSync(join(dir, 'scripts', 'main.ts'), '// empty\n')
    const skill = loadSkillFromDir(dir)
    expect(skill?.has_scripts).toBe(true)
    expect(skill?.has_references).toBe(false)
  })

  it('serializeSkillMd produces parseable output (round-trip)', () => {
    const skill = {
      name: 'round-trip',
      description: 'a skill to verify round-trip works',
      license: 'MIT',
      metadata: { 'kairos:autonomy_tier': 'YELLOW' },
      slug: 'round-trip',
      body: '# Step 1\nDo a thing.\n',
      dir_path: tmp,
      has_scripts: false,
      has_references: false,
    }
    const serialized = serializeSkillMd(skill as any)
    expect(serialized).toContain('name: round-trip')
    expect(serialized).toContain('license: MIT')
    expect(serialized).toContain('# Step 1')
  })
})
