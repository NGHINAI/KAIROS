// src/daemon/restraint/dryRunMode.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { DryRunMode, DRY_RUN_SCHEMA } from './dryRunMode'

describe('DryRunMode', () => {
  let db: Database
  let dryRun: DryRunMode

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(DRY_RUN_SCHEMA)
    dryRun = new DryRunMode(db, { dry_run_duration_hours: 24 } as any)
  })

  it('registers a new trigger as dry-run for 24 hours', () => {
    dryRun.register('trig-a')
    expect(dryRun.isInDryRun('trig-a')).toBe(true)
  })

  it('records would-have-fired counts during dry run', () => {
    dryRun.register('trig-a')
    dryRun.recordWouldFire('trig-a', 'event1')
    dryRun.recordWouldFire('trig-a', 'event2')
    const rec = dryRun.get('trig-a')
    expect(rec?.would_have_fired_count).toBe(2)
    expect(rec?.sample_events.length).toBe(2)
  })

  it('sample events cap at 5', () => {
    dryRun.register('trig-a')
    for (let i = 0; i < 10; i++) dryRun.recordWouldFire('trig-a', `event${i}`)
    const rec = dryRun.get('trig-a')
    expect(rec?.would_have_fired_count).toBe(10)
    expect(rec?.sample_events.length).toBe(5)   // capped
  })

  it('completed() returns triggers past their dry-run window', () => {
    dryRun.register('trig-a')
    // Manually expire it
    db.run('UPDATE restraint_dry_run SET ends_at = ? WHERE trigger_id = ?', [Date.now() - 1000, 'trig-a'])
    expect(dryRun.completed().map(r => r.trigger_id)).toContain('trig-a')
  })

  it('promote moves a trigger out of dry-run', () => {
    dryRun.register('trig-a')
    dryRun.promote('trig-a')
    expect(dryRun.isInDryRun('trig-a')).toBe(false)
  })
})
