// src/daemon/orders/v2/parser.test.ts
import { describe, it, expect } from 'bun:test'
import { OrdersParser } from './parser'

const VALID_FILE = `# KAIROS Standing Orders

## morning-brief
---
schema_version: 1
when:
  cron: "0 8 * * 1-5"
unless:
  - persona.is_in_meeting
do:
  - action: invoke_skill
    args:
      slug: morning-brief
cooldown: 20h
state: dry_run
created_by: voice
created_at: 2026-05-28T14:30:00Z
dry_run_until: 2026-05-29T14:30:00Z
---
You said: "every weekday at 8am draft a morning brief"

## urgent-slack
---
schema_version: 1
when:
  state:
    clipboard:
      contains: "urgent"
do:
  - action: notify
    args:
      message: "Urgent ping"
      priority: high
state: active
created_by: manual
created_at: 2026-05-28T14:30:00Z
---
`

describe('OrdersParser', () => {
  it('parses two valid rules from a file', () => {
    const p = new OrdersParser()
    const result = p.parseString(VALID_FILE)
    expect(result.rules).toHaveLength(2)
    expect(result.errors).toHaveLength(0)
    expect(result.rules[0]!.slug).toBe('morning-brief')
    expect(result.rules[0]!.cooldown_ms).toBe(20 * 60 * 60 * 1000)
    expect(result.rules[1]!.slug).toBe('urgent-slack')
  })

  it('converts ISO timestamps to ms epoch', () => {
    const p = new OrdersParser()
    const r = p.parseString(VALID_FILE).rules[0]!
    expect(r.created_at).toBe(new Date('2026-05-28T14:30:00Z').getTime())
    expect(r.dry_run_until).toBe(new Date('2026-05-29T14:30:00Z').getTime())
  })

  it('parses Duration strings: 30s, 5m, 20h, 1d', () => {
    const p = new OrdersParser()
    expect(p.parseDuration('30s')).toBe(30_000)
    expect(p.parseDuration('5m')).toBe(5 * 60_000)
    expect(p.parseDuration('20h')).toBe(20 * 60 * 60_000)
    expect(p.parseDuration('1d')).toBe(24 * 60 * 60_000)
  })

  it('rejects invalid slug (not kebab-case)', () => {
    const bad = `## Bad_Slug
---
schema_version: 1
when: { event: foo }
do: [{ action: log, args: { message: x } }]
state: active
created_by: manual
created_at: 2026-05-28T00:00:00Z
---
`
    const result = new OrdersParser().parseString(bad)
    // Header regex /^## ([\w-]+)$/ rejects "Bad_Slug" at the regex level (\w allows _ — adjust if needed)
    // Either errors > 0 OR rules length 0 — both indicate the bad rule didn't make it through.
    expect(result.rules).toHaveLength(0)
  })

  it('rejects multiple when fields', () => {
    const bad = `## x
---
schema_version: 1
when:
  cron: "* * * * *"
  event: foo
do: [{ action: log, args: { message: x } }]
state: active
created_by: manual
created_at: 2026-05-28T00:00:00Z
---
`
    const r = new OrdersParser().parseString(bad)
    expect(r.rules).toHaveLength(0)
    expect(r.errors[0]!.error).toMatch(/exactly one/i)
  })

  it('rejects unknown action type', () => {
    const bad = `## x
---
schema_version: 1
when: { event: foo }
do: [{ action: hack_world, args: {} }]
state: active
created_by: manual
created_at: 2026-05-28T00:00:00Z
---
`
    const r = new OrdersParser().parseString(bad)
    expect(r.rules).toHaveLength(0)
    expect(r.errors[0]!.error).toMatch(/action/i)
  })

  it('rejects unknown schema_version', () => {
    const bad = `## x
---
schema_version: 99
when: { event: foo }
do: [{ action: log, args: { message: x } }]
state: active
created_by: manual
created_at: 2026-05-28T00:00:00Z
---
`
    const r = new OrdersParser().parseString(bad)
    expect(r.rules).toHaveLength(0)
    expect(r.errors[0]!.error).toMatch(/schema_version/i)
  })

  it('rejects empty do array', () => {
    const bad = `## x
---
schema_version: 1
when: { event: foo }
do: []
state: active
created_by: manual
created_at: 2026-05-28T00:00:00Z
---
`
    const r = new OrdersParser().parseString(bad)
    expect(r.rules).toHaveLength(0)
  })

  it('skips bad rule but keeps neighboring good rules', () => {
    const mixed = `## good-one
---
schema_version: 1
when: { event: foo }
do: [{ action: log, args: { message: x } }]
state: active
created_by: manual
created_at: 2026-05-28T00:00:00Z
---

## another-good
---
schema_version: 1
when: { event: foo }
do: [{ action: log, args: { message: x } }]
state: active
created_by: manual
created_at: 2026-05-28T00:00:00Z
---

## third-bad
---
schema_version: 99
when: { event: foo }
do: [{ action: log, args: { message: x } }]
state: active
created_by: manual
created_at: 2026-05-28T00:00:00Z
---
`
    const r = new OrdersParser().parseString(mixed)
    expect(r.rules.map(x => x.slug).sort()).toEqual(['another-good', 'good-one'])
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]!.slug).toBe('third-bad')
  })

  it('attaches description body to rule', () => {
    const p = new OrdersParser()
    const r = p.parseString(VALID_FILE).rules[0]!
    expect(r.description).toContain('You said:')
    expect(r.description).toContain('morning brief')
  })

  it('parseFile reads from disk', async () => {
    const { writeFileSync, mkdtempSync } = await import('fs')
    const { tmpdir } = await import('os')
    const { join } = await import('path')
    const tmp = mkdtempSync(join(tmpdir(), 'orders-parser-'))
    const path = join(tmp, 'STANDING_ORDERS.md')
    writeFileSync(path, VALID_FILE)
    const r = new OrdersParser().parseFile(path)
    expect(r.rules).toHaveLength(2)
  })

  it('returns empty result for empty file', () => {
    expect(new OrdersParser().parseString('').rules).toHaveLength(0)
    expect(new OrdersParser().parseString('# Just a comment').rules).toHaveLength(0)
  })
})
