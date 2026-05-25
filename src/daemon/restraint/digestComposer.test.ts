// src/daemon/restraint/digestComposer.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { DigestComposer, DIGEST_SCHEMA } from './digestComposer'

describe('DigestComposer', () => {
  let db: Database
  let composer: DigestComposer

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(DIGEST_SCHEMA)
    composer = new DigestComposer(db)
  })

  it('queues an item for a digest slot', () => {
    composer.queue('morning', { request_id: 'r1', title: 'New PR', summary: 'PR #123 opened', tier: 'GREEN' })
    expect(composer.pendingFor('morning').length).toBe(1)
  })

  it('flush delivers all pending items for a slot and clears queue', () => {
    composer.queue('morning', { request_id: 'r1', title: 'A', summary: 'a', tier: 'GREEN' })
    composer.queue('morning', { request_id: 'r2', title: 'B', summary: 'b', tier: 'GREEN' })
    composer.queue('lunch', { request_id: 'r3', title: 'C', summary: 'c', tier: 'GREEN' })
    const delivered = composer.flush('morning')
    expect(delivered.items.length).toBe(2)
    expect(composer.pendingFor('morning').length).toBe(0)
    expect(composer.pendingFor('lunch').length).toBe(1)
  })

  it('returns null when flushing empty slot', () => {
    expect(composer.flush('morning')).toBeNull()
  })

  it('flush records delivered_at', () => {
    composer.queue('morning', { request_id: 'r1', title: 'A', summary: 'a', tier: 'GREEN' })
    const delivered = composer.flush('morning')
    expect(delivered?.delivered_at).toBeGreaterThan(0)
  })
})
