import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SkillStore } from './skillStore'
import { UsageTracker } from './usageTracker'
import { SkillRegistry } from './skillRegistry'

function makeSkillOnDisk(rootDir: string, slug: string, opts: { description?: string; tier?: string } = {}): string {
  const dir = join(rootDir, slug)
  mkdirSync(dir, { recursive: true })
  const desc = opts.description ?? `Test skill ${slug}`
  const meta = opts.tier ? `\nmetadata:\n  "kairos:autonomy_tier": ${opts.tier}` : ''
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${slug}\ndescription: ${desc}${meta}\n---\n\n# Body\n\nDo a thing.\n`)
  return dir
}

describe('SkillRegistry', () => {
  let db: Database
  let tmp: string
  let store: SkillStore
  let tracker: UsageTracker
  let registry: SkillRegistry

  beforeEach(() => {
    db = new Database(':memory:')
    tmp = mkdtempSync(join(tmpdir(), 'kairos-sr-'))
    store = new SkillStore(db, { root_dir: tmp })
    tracker = new UsageTracker({ root_dir: tmp })
    registry = new SkillRegistry({ skillStore: store, usageTracker: tracker, rootDir: tmp })
  })

  it('listActiveMetadata returns active skill metadata only', () => {
    makeSkillOnDisk(tmp, 'a')
    makeSkillOnDisk(tmp, 'b')
    registry.initialize()
    // Mark one stale
    store.upsert({ ...store.get('a')!, state: 'stale' })
    const list = registry.listActiveMetadata()
    expect(list.length).toBe(1)
    expect(list[0]?.slug).toBe('b')
    rmSync(tmp, { recursive: true })
  })

  it('listActiveMetadata is lightweight — only metadata fields exposed', () => {
    makeSkillOnDisk(tmp, 'demo')
    registry.initialize()
    const list = registry.listActiveMetadata()
    expect(list[0]).toMatchObject({ slug: 'demo', name: 'demo', description: expect.any(String) })
    expect((list[0] as any).body).toBeUndefined()   // body NOT in metadata
    rmSync(tmp, { recursive: true })
  })

  it('loadFullSkill returns full body and records a view', () => {
    makeSkillOnDisk(tmp, 'full')
    registry.initialize()
    const skill = registry.loadFullSkill('full')
    expect(skill?.body).toContain('Do a thing')
    const usage = tracker.read('full')
    expect(usage?.view_count).toBe(1)
    rmSync(tmp, { recursive: true })
  })

  it('loadFullSkill returns null for stale/archived skills', () => {
    makeSkillOnDisk(tmp, 'old')
    registry.initialize()
    store.upsert({ ...store.get('old')!, state: 'stale' })
    expect(registry.loadFullSkill('old')).toBeNull()
    rmSync(tmp, { recursive: true })
  })

  it('initialize rebuilds from disk when SkillStore is empty', () => {
    makeSkillOnDisk(tmp, 'fresh', { tier: 'GREEN' })
    expect(store.listAll().length).toBe(0)   // empty before initialize
    registry.initialize()
    expect(store.listAll().length).toBe(1)
    expect(store.get('fresh')?.tier).toBe('GREEN')
    rmSync(tmp, { recursive: true })
  })

  it('hot-reload picks up a new skill via file watch', async () => {
    registry.initialize()
    registry.startWatching()
    makeSkillOnDisk(tmp, 'late-arrival')
    // Wait for watcher to debounce + rebuild
    await Bun.sleep(400)
    registry.stopWatching()
    expect(store.get('late-arrival')?.name).toBe('late-arrival')
    rmSync(tmp, { recursive: true })
  })
})
