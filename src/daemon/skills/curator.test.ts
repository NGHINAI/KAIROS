import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SkillStore } from './skillStore'
import { UsageTracker } from './usageTracker'
import { SkillWriter } from './skillWriter'
import { Curator } from './curator'
import type { SkillFile } from './types'

const DAY = 24 * 60 * 60 * 1000

function mkSkill(slug: string, body = 'Body for ' + slug): SkillFile {
  return {
    name: slug,
    description: 'A test skill named ' + slug,
    slug,
    body,
    metadata: { 'kairos:autonomy_tier': 'YELLOW' },
    dir_path: '',
    has_scripts: false,
    has_references: false,
  }
}

function makeFakeRouter(responses: Array<any>) {
  let i = 0
  const calls: any[] = []
  return {
    router: {
      async complete(req: any) {
        calls.push(req)
        const resp = responses[i++] ?? { action: 'keep', reason: 'no more fixtures' }
        return { parsed: resp, text: JSON.stringify(resp) } as any
      },
    } as any,
    calls,
  }
}

describe('Curator', () => {
  let db: Database
  let tmp: string
  let archive: string
  let store: SkillStore
  let usage: UsageTracker
  let writer: SkillWriter

  beforeEach(() => {
    db = new Database(':memory:')
    tmp = mkdtempSync(join(tmpdir(), 'kairos-cur-'))
    archive = join(tmp, '.archive')
    store = new SkillStore(db, { root_dir: tmp })
    usage = new UsageTracker({ root_dir: tmp })
    writer = new SkillWriter({ root_dir: tmp })
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  function makeCurator(router?: any, cfg: Partial<any> = {}) {
    return new Curator(
      { skillStore: store, usageTracker: usage, skillWriter: writer, router },
      { root_dir: tmp, archive_dir: archive, ...cfg },
    )
  }

  function plantSkill(slug: string, opts: { last_used_at: number; created_at: number; pinned?: boolean; flag?: boolean; failures?: string[]; state?: 'active' | 'stale' } = { last_used_at: 0, created_at: 0 }) {
    const skill = mkSkill(slug)
    const dir = writer.write(skill, { force: true })
    usage.initialize(slug)
    const u = usage.read(slug)!
    u.last_used_at = opts.last_used_at
    u.created_at = opts.created_at
    u.pinned = !!opts.pinned
    u.curator_review_flag = !!opts.flag
    u.state = opts.state ?? 'active'
    if (opts.failures) u.failure_history = opts.failures.map(e => ({ ts: Date.now(), error: e }))
    // Write to UsageTracker's decoupled path (root_dir/.usage/<slug>.json)
    writeFileSync(usage.pathFor(slug), JSON.stringify(u, null, 2))
    store.upsert({
      slug, name: slug, description: skill.description,
      state: u.state, pinned: u.pinned, tier: 'YELLOW',
      last_used_at: u.last_used_at, created_at: u.created_at,
      dir_path: dir,
    })
    return dir
  }

  it('Phase 1: marks stale at 30 days unused', async () => {
    const now = Date.now()
    plantSkill('old-skill', { last_used_at: now - 35 * DAY, created_at: now - 60 * DAY })
    const r = await makeCurator().runOnce(now)
    expect(r.phase1.marked_stale).toContain('old-skill')
    expect(usage.read('old-skill')?.state).toBe('stale')
  })

  it('Phase 1: does NOT mark stale before 30 days', async () => {
    const now = Date.now()
    plantSkill('fresh-skill', { last_used_at: now - 10 * DAY, created_at: now - 40 * DAY })
    const r = await makeCurator().runOnce(now)
    expect(r.phase1.marked_stale).not.toContain('fresh-skill')
  })

  it('Phase 1: archives at 90 days unused (dir moved)', async () => {
    const now = Date.now()
    const dir = plantSkill('ancient-skill', { last_used_at: now - 100 * DAY, created_at: now - 200 * DAY, state: 'stale' })
    const r = await makeCurator().runOnce(now)
    expect(r.phase1.archived).toContain('ancient-skill')
    expect(existsSync(dir)).toBe(false)
    expect(existsSync(join(archive, 'ancient-skill'))).toBe(true)
    expect(usage.read('ancient-skill')?.state).toBe('archived')
  })

  it('Phase 1: pinned skills are never archived', async () => {
    const now = Date.now()
    const dir = plantSkill('pinned-skill', { last_used_at: now - 200 * DAY, created_at: now - 300 * DAY, pinned: true, state: 'stale' })
    const r = await makeCurator().runOnce(now)
    expect(r.phase1.archived).not.toContain('pinned-skill')
    expect(existsSync(dir)).toBe(true)
  })

  it('Phase 1: 7-day young-skill guard prevents archival of new skills', async () => {
    const now = Date.now()
    plantSkill('newborn', { last_used_at: 0, created_at: now - 3 * DAY })
    const r = await makeCurator().runOnce(now)
    expect(r.phase1.marked_stale).not.toContain('newborn')
    expect(r.phase1.archived).not.toContain('newborn')
  })

  it('Phase 2: only processes flagged skills', async () => {
    const now = Date.now()
    plantSkill('unflagged', { last_used_at: now - 5 * DAY, created_at: now - 30 * DAY })
    plantSkill('flagged', { last_used_at: now - 5 * DAY, created_at: now - 30 * DAY, flag: true, failures: ['boom'] })
    const fake = makeFakeRouter([{ action: 'keep', reason: 'transient' }])
    const r = await makeCurator(fake.router).runOnce(now)
    expect(r.phase2.processed).toBe(1)
    expect(fake.calls).toHaveLength(1)
  })

  it('Phase 2: patch path writes revised body + recordPatch', async () => {
    const now = Date.now()
    const dir = plantSkill('to-patch', { last_used_at: now - 5 * DAY, created_at: now - 30 * DAY, flag: true, failures: ['e1'] })
    const fake = makeFakeRouter([{ action: 'patch', reason: 'fixed step 2', patched_body: 'New improved body' }])
    const r = await makeCurator(fake.router).runOnce(now)
    expect(r.phase2.actions.find(a => a.type === 'patched')).toBeDefined()
    const md = readFileSync(join(dir, 'SKILL.md'), 'utf8')
    expect(md).toContain('New improved body')
    expect(usage.read('to-patch')?.patch_count).toBe(1)
    expect(usage.read('to-patch')?.curator_review_flag).toBe(false)
  })

  it('Phase 2: respects 8-skill ceiling', async () => {
    const now = Date.now()
    for (let i = 0; i < 10; i++) {
      plantSkill('flagged-' + i, { last_used_at: now - 5 * DAY, created_at: now - 30 * DAY, flag: true, failures: ['e' + i] })
    }
    const fake = makeFakeRouter(Array.from({ length: 10 }, () => ({ action: 'keep', reason: 'fine' })))
    const r = await makeCurator(fake.router).runOnce(now)
    expect(r.phase2.processed).toBe(8)
    expect(fake.calls).toHaveLength(8)
  })

  it('Phase 2: consolidate archives the loser, leaves target untouched', async () => {
    const now = Date.now()
    const dirA = plantSkill('skill-a', { last_used_at: now - 5 * DAY, created_at: now - 30 * DAY, flag: true, failures: ['x'] })
    const dirB = plantSkill('skill-b', { last_used_at: now - 1 * DAY, created_at: now - 30 * DAY })
    const fake = makeFakeRouter([{ action: 'consolidate', reason: 'duplicate of b', consolidate_with: 'skill-b' }])
    const r = await makeCurator(fake.router).runOnce(now)
    expect(r.phase2.actions.find(a => a.type === 'consolidated')).toBeDefined()
    expect(existsSync(dirA)).toBe(false)
    expect(existsSync(join(archive, 'skill-a'))).toBe(true)
    expect(existsSync(dirB)).toBe(true)
  })

  it('Phase 2: archive path moves dir to .archive/', async () => {
    const now = Date.now()
    const dir = plantSkill('broken', { last_used_at: now - 5 * DAY, created_at: now - 30 * DAY, flag: true, failures: ['fatal'] })
    const fake = makeFakeRouter([{ action: 'archive', reason: 'fundamentally broken' }])
    const r = await makeCurator(fake.router).runOnce(now)
    expect(r.phase2.actions.find(a => a.type === 'archived' && a.slug === 'broken')).toBeDefined()
    expect(existsSync(dir)).toBe(false)
    expect(existsSync(join(archive, 'broken'))).toBe(true)
  })

  it('Phase 2: keep path clears flag, no other change', async () => {
    const now = Date.now()
    const dir = plantSkill('temporary-blip', { last_used_at: now - 5 * DAY, created_at: now - 30 * DAY, flag: true, failures: ['blip'] })
    const before = readFileSync(join(dir, 'SKILL.md'), 'utf8')
    const fake = makeFakeRouter([{ action: 'keep', reason: 'network glitch — fine now' }])
    const r = await makeCurator(fake.router).runOnce(now)
    expect(r.phase2.actions.find(a => a.type === 'kept')).toBeDefined()
    expect(usage.read('temporary-blip')?.curator_review_flag).toBe(false)
    expect(usage.read('temporary-blip')?.patch_count).toBe(0)
    const after = readFileSync(join(dir, 'SKILL.md'), 'utf8')
    expect(after).toBe(before)
  })

  it('writes CURATOR-REPORT.md after each run', async () => {
    const now = Date.now()
    plantSkill('any', { last_used_at: now - 5 * DAY, created_at: now - 30 * DAY })
    await makeCurator().runOnce(now)
    const reportPath = join(tmp, 'CURATOR-REPORT.md')
    expect(existsSync(reportPath)).toBe(true)
    const md = readFileSync(reportPath, 'utf8')
    expect(md).toContain('# CURATOR-REPORT.md')
    expect(md).toContain('Phase 1')
    expect(md).toContain('Phase 2')
  })
})
