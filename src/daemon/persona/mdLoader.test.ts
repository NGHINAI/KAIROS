import { describe, it, expect, beforeEach } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { MdLoader } from './mdLoader'

describe('MdLoader', () => {
  let tmp: string
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'kairos-md-')) })

  it('loads a file with frontmatter + body', () => {
    const p = join(tmp, 'soul.md')
    writeFileSync(p, '---\nversion: 1\nvibe: a thoughtful coworker\n---\n\nBody text here.\n')
    const result = MdLoader.load(p)
    expect(result!.frontmatter.version).toBe(1)
    expect(result!.frontmatter.vibe).toBe('a thoughtful coworker')
    expect(result!.body.trim()).toBe('Body text here.')
    rmSync(tmp, { recursive: true })
  })

  it('handles file without frontmatter — entire content is body', () => {
    const p = join(tmp, 'plain.md')
    writeFileSync(p, '# A heading\n\nPlain body without frontmatter.\n')
    const result = MdLoader.load(p)
    expect(result!.frontmatter).toEqual({})
    expect(result!.body).toContain('A heading')
    rmSync(tmp, { recursive: true })
  })

  it('returns null when file does not exist', () => {
    expect(MdLoader.load(join(tmp, 'missing.md'))).toBeNull()
    rmSync(tmp, { recursive: true })
  })

  it('save writes frontmatter + body back to disk', () => {
    const p = join(tmp, 'out.md')
    MdLoader.save(p, { frontmatter: { version: 2 }, body: 'hello' })
    const read = MdLoader.load(p)
    expect(read?.frontmatter.version).toBe(2)
    expect(read?.body.trim()).toBe('hello')
    rmSync(tmp, { recursive: true })
  })

  it('appendBody adds to body without touching frontmatter', () => {
    const p = join(tmp, 'append.md')
    MdLoader.save(p, { frontmatter: { v: 1 }, body: 'first line' })
    MdLoader.appendBody(p, '\nsecond line')
    const read = MdLoader.load(p)
    expect(read?.body).toContain('first line')
    expect(read?.body).toContain('second line')
    expect(read?.frontmatter.v).toBe(1)
    rmSync(tmp, { recursive: true })
  })

  it('watch fires callback when file changes', async () => {
    const p = join(tmp, 'watched.md')
    MdLoader.save(p, { frontmatter: {}, body: 'v1' })
    let calls = 0
    const stop = MdLoader.watch(p, () => { calls++ })
    await Bun.sleep(50)
    MdLoader.save(p, { frontmatter: {}, body: 'v2' })
    await Bun.sleep(200)
    stop()
    expect(calls).toBeGreaterThan(0)
    rmSync(tmp, { recursive: true })
  })
})
