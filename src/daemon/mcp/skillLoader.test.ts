import { describe, it, expect, beforeEach } from 'bun:test'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SkillLoader } from './skillLoader'

describe('SkillLoader', () => {
  let tmp: string
  let loader: SkillLoader

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kairos-skill-'))
    loader = new SkillLoader(tmp)
  })

  function writeSkill(name: string, frontmatter: Record<string, string>, body: string) {
    const dir = join(tmp, name)
    mkdirSync(dir, { recursive: true })
    const fm = Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`).join('\n')
    writeFileSync(join(dir, 'SKILL.md'), `---\n${fm}\n---\n\n${body}`)
  }

  it('lists skills with name+description (progressive disclosure)', () => {
    writeSkill('draft-reply', { name: 'draft-reply', description: 'Draft a reply to a Slack message' }, 'Body content here.')
    writeSkill('summarize', { name: 'summarize', description: 'Summarize a long thread' }, 'Body.')
    const summaries = loader.listSummaries()
    expect(summaries.length).toBe(2)
    expect(summaries.find(s => s.name === 'draft-reply')?.description).toContain('Draft a reply')
    rmSync(tmp, { recursive: true })
  })

  it('load() returns full manifest + body', () => {
    writeSkill('x', { name: 'x', description: 'd', version: '1.0.0', tier: 'YELLOW' }, '# Body\n\nDetails.')
    const skill = loader.load('x')
    expect(skill?.manifest.name).toBe('x')
    expect(skill?.manifest.version).toBe('1.0.0')
    expect(skill?.manifest.tier).toBe('YELLOW')
    expect(skill?.body).toContain('# Body')
    rmSync(tmp, { recursive: true })
  })

  it('load() returns null when SKILL.md is missing', () => {
    mkdirSync(join(tmp, 'empty-dir'), { recursive: true })
    expect(loader.load('empty-dir')).toBeNull()
    rmSync(tmp, { recursive: true })
  })

  it('load() ignores invalid frontmatter and returns null', () => {
    const dir = join(tmp, 'bad')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), 'no frontmatter here, just body')
    expect(loader.load('bad')).toBeNull()
    rmSync(tmp, { recursive: true })
  })

  it('lists script files when scripts/ subdir exists', () => {
    writeSkill('with-scripts', { name: 'with-scripts', description: 'd' }, 'body')
    const dir = join(tmp, 'with-scripts')
    mkdirSync(join(dir, 'scripts'))
    writeFileSync(join(dir, 'scripts', 'do.sh'), '#!/bin/bash\necho hi')
    const skill = loader.load('with-scripts')
    expect(skill?.scripts?.length).toBe(1)
    expect(skill?.scripts?.[0]).toContain('do.sh')
    rmSync(tmp, { recursive: true })
  })

  it('returns empty list when skills root does not exist', () => {
    const missing = new SkillLoader(join(tmp, 'nope'))
    expect(missing.listSummaries()).toEqual([])
  })
})
