import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SkillStore } from './skillStore'

function makeRow(slug: string, overrides: any = {}) {
  return {
    slug,
    name: slug,
    description: `description for ${slug}`,
    state: 'active' as const,
    pinned: false,
    last_used_at: 0,
    created_at: Date.now(),
    dir_path: '/tmp/' + slug,
    ...overrides,
  }
}

describe('SkillStore', () => {
  let db: Database
  let tmp: string
  let store: SkillStore
  beforeEach(() => {
    db = new Database(':memory:')
    tmp = mkdtempSync(join(tmpdir(), 'kairos-ss-'))
    store = new SkillStore(db, { root_dir: tmp })
  })

  it('insert + get round-trip', () => {
    store.upsert(makeRow('a'))
    expect(store.get('a')?.name).toBe('a')
    rmSync(tmp, { recursive: true })
  })

  it('listActive returns only state=active', () => {
    store.upsert(makeRow('a', { state: 'active' }))
    store.upsert(makeRow('b', { state: 'stale' }))
    store.upsert(makeRow('c', { state: 'archived' }))
    expect(store.listActive().map(r => r.slug)).toEqual(['a'])
  })

  it('markStaleByAge marks unused active skills as stale, exempts pinned', () => {
    const now = Date.now()
    const oneMonthAgo = now - 31 * 86400_000
    store.upsert(makeRow('old', { last_used_at: oneMonthAgo, state: 'active' }))
    store.upsert(makeRow('old-pinned', { last_used_at: oneMonthAgo, state: 'active', pinned: true }))
    store.upsert(makeRow('recent', { last_used_at: now - 1000, state: 'active' }))
    const marked = store.markStaleByAge(30 * 86400_000, now)
    expect(marked).toEqual(['old'])
    expect(store.get('old-pinned')?.state).toBe('active')
    expect(store.get('recent')?.state).toBe('active')
    rmSync(tmp, { recursive: true })
  })

  it('remove deletes the row', () => {
    store.upsert(makeRow('a'))
    store.remove('a')
    expect(store.get('a')).toBeNull()
    rmSync(tmp, { recursive: true })
  })

  it('rebuildFromDisk scans skill directories and populates index', () => {
    // Create a real SKILL.md on disk
    const dir = join(tmp, 'demo')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: demo\ndescription: demo skill for rebuild test\nmetadata:\n  "kairos:autonomy_tier": GREEN\n---\nbody\n')
    // .archive should be skipped
    mkdirSync(join(tmp, '.archive'), { recursive: true })
    const count = store.rebuildFromDisk()
    expect(count).toBe(1)
    expect(store.get('demo')?.tier).toBe('GREEN')
    rmSync(tmp, { recursive: true })
  })
})
