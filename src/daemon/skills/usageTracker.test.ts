import { describe, it, expect, beforeEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { UsageTracker } from './usageTracker'

describe('UsageTracker', () => {
  let tmp: string
  let tracker: UsageTracker
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kairos-ut-'))
    tracker = new UsageTracker({ root_dir: tmp })
    mkdirSync(join(tmp, 'demo'), { recursive: true })
  })

  it('read returns null for missing usage', () => {
    expect(tracker.read('missing')).toBeNull()
  })

  it('initialize creates an empty record', () => {
    const u = tracker.initialize('demo')
    expect(u.use_count).toBe(0)
    expect(u.state).toBe('active')
    rmSync(tmp, { recursive: true })
  })

  it('initialize is idempotent', () => {
    const a = tracker.initialize('demo')
    a.use_count = 99  // local mutate doesn't affect disk
    const b = tracker.initialize('demo')   // should re-read existing
    expect(b.use_count).toBe(0)
    rmSync(tmp, { recursive: true })
  })

  it('recordUse increments + persists', () => {
    tracker.initialize('demo')
    tracker.recordUse('demo', 100, true)
    tracker.recordUse('demo', 200, true)
    const u = tracker.read('demo')!
    expect(u.use_count).toBe(2)
    expect(u.last_used_at).toBeGreaterThan(0)
    rmSync(tmp, { recursive: true })
  })

  it('failure_history bounded to last 5', () => {
    tracker.initialize('demo')
    for (let i = 0; i < 8; i++) {
      tracker.recordUse('demo', 100, false, `error ${i}`)
    }
    const u = tracker.read('demo')!
    expect(u.failure_history?.length).toBe(5)
    expect(u.failure_history?.[0]?.error).toBe('error 3')
    expect(u.failure_history?.[4]?.error).toBe('error 7')
    rmSync(tmp, { recursive: true })
  })

  it('recordView increments view_count separately from use_count', () => {
    tracker.initialize('demo')
    tracker.recordView('demo')
    tracker.recordView('demo')
    tracker.recordUse('demo', 100, true)
    const u = tracker.read('demo')!
    expect(u.view_count).toBe(2)
    expect(u.use_count).toBe(1)
    rmSync(tmp, { recursive: true })
  })

  it('markState=archived sets archived_at on first transition', () => {
    tracker.initialize('demo')
    tracker.markState('demo', 'archived')
    const u = tracker.read('demo')!
    expect(u.state).toBe('archived')
    expect(u.archived_at).toBeGreaterThan(0)
    rmSync(tmp, { recursive: true })
  })

  it('pinned skill cannot be archived', () => {
    tracker.initialize('demo')
    tracker.pin('demo')
    tracker.markState('demo', 'archived')
    const u = tracker.read('demo')!
    expect(u.state).toBe('active')   // stayed active
    expect(u.archived_at).toBe(0)
    rmSync(tmp, { recursive: true })
  })
})
