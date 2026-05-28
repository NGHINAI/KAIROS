import { describe, it, expect, beforeEach } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SoulLoader } from './soulLoader'

describe('SoulLoader', () => {
  let tmp: string
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'kairos-soul-')) })

  it('loads a well-formed soul.md', () => {
    const p = join(tmp, 'soul.md')
    writeFileSync(p, `---
version: 1
composed_at: 1234567890
core_truths:
  - I tell you what's actually happening
boundaries:
  - never delete without confirmation
vibe: a competent coworker who notices things
---

Extra prose body here.
`)
    const loader = new SoulLoader({ path: p })
    loader.load()
    const soul = loader.getSoul()!
    expect(soul.vibe).toContain('competent coworker')
    expect(soul.boundaries).toContain('never delete without confirmation')
    rmSync(tmp, { recursive: true })
  })

  it('returns a minimal fallback block when soul.md does not exist', () => {
    const loader = new SoulLoader({ path: join(tmp, 'missing.md') })
    loader.load()
    const block = loader.buildSystemBlock()
    expect(block.cache_hint).toBe('long')
    expect(block.text).toContain('Never delete user data')
    rmSync(tmp, { recursive: true })
  })

  it('buildSystemBlock returns long-cached block', () => {
    const p = join(tmp, 'soul.md')
    writeFileSync(p, '---\nversion: 1\nvibe: terse and direct\n---\n')
    const loader = new SoulLoader({ path: p })
    loader.load()
    const block = loader.buildSystemBlock()
    expect(block.cache_hint).toBe('long')
    expect(block.text).toContain('terse and direct')
    rmSync(tmp, { recursive: true })
  })

  it('hot-reloads on file change', async () => {
    const p = join(tmp, 'soul.md')
    writeFileSync(p, '---\nvibe: v1\n---\n')
    const loader = new SoulLoader({ path: p })
    loader.load()
    expect(loader.buildSystemBlock().text).toContain('v1')
    loader.startWatching()
    writeFileSync(p, '---\nvibe: v2\n---\n')
    await Bun.sleep(150)
    expect(loader.buildSystemBlock().text).toContain('v2')
    loader.stopWatching()
    rmSync(tmp, { recursive: true })
  })

  it('hardcoded baseline boundaries are ALWAYS in the system block', () => {
    const p = join(tmp, 'soul.md')
    writeFileSync(p, '---\nversion: 1\nvibe: chaotic\nboundaries: []\n---\n')
    const loader = new SoulLoader({ path: p })
    loader.load()
    const text = loader.buildSystemBlock().text
    expect(text).toMatch(/Never delete user data/i)
    expect(text).toMatch(/Never send messages.*sensitive data/i)
    rmSync(tmp, { recursive: true })
  })
})
