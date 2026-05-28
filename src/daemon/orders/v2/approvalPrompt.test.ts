import { describe, it, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { OrdersStore } from './store'
import { DryRunLogger } from './dryRunLogger'
import { buildApprovalPrompt, applyApproval, applyRejection } from './approvalPrompt'
import type { Rule } from './types'

describe('buildApprovalPrompt', () => {
  it('builds a prompt with fire count and samples', () => {
    const db = new Database(':memory:')
    const store = new OrdersStore(db)
    const logger = new DryRunLogger(store)
    const r: Rule = {
      schema_version: 1, slug: 'morning-brief',
      when: { cron: '0 9 * * *' },
      do: [{ action: 'notify', args: { message: 'brief' } }],
      state: 'dry_run', created_by: 'voice',
      created_at: Date.now() - 24 * 3600 * 1000,
      dry_run_until: Date.now() - 1000,
      description: 'You said: "morning brief"',
    }
    store.upsert(r)
    for (let i = 0; i < 5; i++) logger.logFire(r, r.do, { trigger: {} }, Date.now() - i * 1000)
    const prompt = buildApprovalPrompt(r, logger, Date.now())
    expect(prompt.title).toContain('morning-brief')
    expect(prompt.body).toContain('5')
    expect(prompt.actions).toEqual(expect.arrayContaining(['approve', 'reject', 'tune']))
  })

  it('handles zero fires gracefully', () => {
    const db = new Database(':memory:')
    const store = new OrdersStore(db)
    const logger = new DryRunLogger(store)
    const r: Rule = {
      schema_version: 1, slug: 'never-fired',
      when: { event: 'foo' },
      do: [{ action: 'notify', args: {} }],
      state: 'dry_run', created_by: 'voice',
      created_at: Date.now() - 24 * 3600 * 1000,
      dry_run_until: Date.now() - 1000,
    }
    store.upsert(r)
    const prompt = buildApprovalPrompt(r, logger, Date.now())
    expect(prompt.body).toContain('0')
  })

  it('applyApproval clears dry_run_until and sets state=active', () => {
    const r: Rule = {
      schema_version: 1, slug: 'x', when: { event: 'foo' },
      do: [{ action: 'log', args: {} }], state: 'dry_run',
      created_by: 'voice', created_at: 0, dry_run_until: 1000,
    }
    const r2 = applyApproval(r)
    expect(r2.state).toBe('active')
    expect(r2.dry_run_until).toBeUndefined()
  })

  it('applyRejection sets state=suspended', () => {
    const r: Rule = {
      schema_version: 1, slug: 'x', when: { event: 'foo' },
      do: [{ action: 'log', args: {} }], state: 'dry_run',
      created_by: 'voice', created_at: 0,
    }
    expect(applyRejection(r).state).toBe('suspended')
  })
})
