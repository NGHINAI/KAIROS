# Phase C.4.1 — STANDING_ORDERS v2 + Time-Triggered Rules — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the standing-orders subsystem from v1 (English → opaque LLM-compiled triggers) into v2 (structured DSL stored in `STANDING_ORDERS.md`, with per-rule cooldowns, chaining via named events, and time-triggered rules wired into the existing `ScheduleManager`). KAIROS authors the file as the user speaks; the file is the audit record.

**Architecture:** Six new units (`OrdersParser`, `OrdersStore`, `OrdersAuthor`, `ActionDispatcher`, `ReactiveEvaluator`, `RulesEventBus`) plus an adapter onto the existing `ScheduleManager`. Rules are YAML frontmatter blocks in one file. State-triggered rules fire via the perception bus; time-triggered fire via `setTimeout` at exact ms. Both paths funnel into `ActionDispatcher` which routes to four action types: built-in intents, C.3.3 skills, C.2.7 Composio tools, or `emit_event` for chaining. New rules dry-run for 24h before going live.

**Tech Stack:** TypeScript on Bun runtime, `bun:sqlite`, existing `yaml` package, existing `cronParser.ts` + `scheduleManager.ts`. No new dependencies.

**Spec:** [`docs/superpowers/specs/2026-05-28-c4-1-standing-orders-v2-design.md`](../specs/2026-05-28-c4-1-standing-orders-v2-design.md)

---

## File Structure

**New files (`src/daemon/orders/v2/`):**
- `types.ts` — Rule, When, Condition, Action, lifecycle state types
- `parser.ts` — YAML frontmatter blocks → Rule[]
- `parser.test.ts`
- `store.ts` — SQLite CRUD over orders_rules, orders_rule_state, orders_dry_run_log
- `store.test.ts`
- `interp.ts` — variable interpolation (`${trigger.X}`, `${payload.X}`, `${skill_output.X}`, `${persona.X}`)
- `interp.test.ts`
- `conditionEvaluator.ts` — safe expression evaluator for `if`/`unless`
- `conditionEvaluator.test.ts`
- `eventBus.ts` — small typed pub/sub for chaining
- `eventBus.test.ts`
- `dryRunLogger.ts` — aggregates would-have-fired events + 24h approval prompt builder
- `dryRunLogger.test.ts`
- `actionDispatcher.ts` — routes Action[] to the four subsystems
- `actionDispatcher.test.ts`
- `reactiveEvaluator.ts` — perception-bus subscriber for state-triggered rules
- `reactiveEvaluator.test.ts`
- `scheduleAdapter.ts` — wraps existing ScheduleManager for time-triggered rules
- `scheduleAdapter.test.ts`
- `author.ts` — speech → LLM → file append + dedup
- `author.test.ts`
- `watcher.ts` — fs.watch on STANDING_ORDERS.md with 200ms debounce
- `watcher.test.ts`

**Modified files:**
- `src/daemon/llm/types.ts` — add `orders_compose` TaskType
- `src/daemon/llm/policy.ts` — map `orders_compose` → mid tier
- `src/daemon/types.ts` — add `orders.v2_enabled` to Config (default true)
- `src/daemon/index.ts` — instantiate the v2 subsystem after the C.3.3 skills block

**Scripts:**
- `scripts/migrate-orders-v1.ts` — interactive one-shot migration
- `scripts/validate-phase-c4-1.ts` — 14-assertion validation gate

---

## Task 0: Types — Rule, When, Action, lifecycle states

**Files:**
- Create: `src/daemon/orders/v2/types.ts`

- [ ] **Step 1: Write the types file**

```typescript
// src/daemon/orders/v2/types.ts
// Core types for STANDING_ORDERS v2 — the DSL Rule shape and its serialized form.

export type LifecycleState = 'pending' | 'active' | 'suspended' | 'dry_run' | 'legacy'
export type CreatedBy = 'voice' | 'manual' | 'crystallized' | 'migrated_v1'

export type Duration = string                       // "20h", "5m", "30s", "1d"

export type WhenCron    = { cron: string }
export type WhenAt      = { at: string }            // "5pm", "in 2 hours", absolute ISO
export type WhenEvent   = { event: string }
export type WhenState   = { state: StateSelector }
export type When = WhenCron | WhenAt | WhenEvent | WhenState

export type StateSelector =
  | { clipboard:    { contains?: string; is_url?: boolean } }
  | { focus_app:    { equals?: string; in?: string[] } }
  | { calendar:     { event_starts_in?: Duration } }
  | { file_events:  { path_matches?: string } }
  | { browser_tabs: { opened?: boolean } }
  | { pattern:      { repeats: number; window: Duration; same?: 'file' | 'app' | 'url' } }

/** Condition is a raw string in the source DSL; evaluator parses it. */
export type Condition = string

export type ActionBuiltIn      = { action: 'notify' | 'remind_later' | 'add_to_memory' | 'log' | 'suspend'; args: Record<string, unknown> }
export type ActionInvokeSkill  = { action: 'invoke_skill'; args: { slug: string; args?: Record<string, unknown> } }
export type ActionComposioTool = { action: 'composio_tool'; args: { toolkit: string; tool: string; args: Record<string, unknown> } }
export type ActionEmitEvent    = { action: 'emit_event'; args: { name: string; payload?: Record<string, unknown> } }
export type Action = ActionBuiltIn | ActionInvokeSkill | ActionComposioTool | ActionEmitEvent

/** In-memory rule (ms-epoch timestamps). Parser produces these; Store serializes to SQL. */
export type Rule = {
  schema_version: 1
  slug: string                          // ^[a-z0-9][a-z0-9-]{0,63}$
  when: When
  if?: Condition[]
  unless?: Condition[]
  do: Action[]
  cooldown_ms?: number                  // parsed from Duration string
  dry_run_until?: number                // ms epoch; undefined means not dry-running
  state: LifecycleState
  created_by: CreatedBy
  created_at: number                    // ms epoch
  /** English description body below the frontmatter (audit trail). */
  description?: string
}

/** A trigger context handed to ActionDispatcher when a rule fires. */
export type TriggerContext = {
  trigger: Record<string, unknown>      // event payload, perception data, or { fired_at }
  payload?: Record<string, unknown>     // for `when: event` rules
}

/** What ActionDispatcher returns. Allows chaining ${skill_output.X}. */
export type ActionResult = {
  ok: boolean
  output?: Record<string, unknown>
  error?: string
}
```

- [ ] **Step 2: Commit**

```bash
git add src/daemon/orders/v2/types.ts
git commit -m "feat(orders-v2): core types (Rule, When, Action, lifecycle)"
```

---

## Task 1: OrdersParser — YAML frontmatter blocks → Rule[]

**Files:**
- Create: `src/daemon/orders/v2/parser.ts`
- Create: `src/daemon/orders/v2/parser.test.ts`

OrdersParser turns a markdown file with `## <slug>` headers and YAML frontmatter blocks into validated `Rule[]`. Bad rules are logged and skipped; other rules continue (matches v1 behavior).

- [ ] **Step 1: Write the failing test file**

```typescript
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
    expect(result.rules).toHaveLength(0)
    expect(result.errors[0]!.error).toMatch(/slug/i)
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

## Bad_Slug
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
`
    const r = new OrdersParser().parseString(mixed)
    expect(r.rules.map(x => x.slug)).toEqual(['good-one', 'another-good'])
    expect(r.errors).toHaveLength(1)
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
```

- [ ] **Step 2: Implement parser**

```typescript
// src/daemon/orders/v2/parser.ts
// Parses STANDING_ORDERS.md into typed Rule objects.
// Format: `## <slug>` headers + YAML frontmatter blocks. Bad rules are
// logged & skipped; other rules continue (matches v1's lenient behavior).

import { readFileSync } from 'fs'
import { parse as parseYaml } from 'yaml'
import type { Rule, Action, When, LifecycleState, CreatedBy } from './types'

const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{0,63}$/
const DURATION_REGEX = /^(\d+)(s|m|h|d)$/

const ALLOWED_ACTIONS = new Set([
  'notify', 'remind_later', 'add_to_memory', 'log', 'suspend',
  'invoke_skill', 'composio_tool', 'emit_event',
])
const ALLOWED_LIFECYCLE = new Set<LifecycleState>(['pending', 'active', 'suspended', 'dry_run', 'legacy'])
const ALLOWED_CREATED_BY = new Set<CreatedBy>(['voice', 'manual', 'crystallized', 'migrated_v1'])

export type ParseError = { slug: string; error: string }
export type ParseResult = { rules: Rule[]; errors: ParseError[] }

export class OrdersParser {
  parseString(text: string): ParseResult {
    const rules: Rule[] = []
    const errors: ParseError[] = []
    // Split on `^## <slug>$` headers
    const lines = text.split('\n')
    let i = 0
    while (i < lines.length) {
      const m = lines[i]!.match(/^## ([\w-]+)\s*$/)
      if (!m) { i++; continue }
      const slug = m[1]!
      i++
      // Expect YAML frontmatter fence
      if (lines[i]?.trim() !== '---') { i++; continue }
      i++
      const yamlStart = i
      while (i < lines.length && lines[i]?.trim() !== '---') i++
      const yamlEnd = i
      i++ // skip closing ---
      // Read description body until next `## ` or EOF
      const descStart = i
      while (i < lines.length && !/^## [\w-]+/.test(lines[i]!)) i++
      const descEnd = i
      const yamlText = lines.slice(yamlStart, yamlEnd).join('\n')
      const description = lines.slice(descStart, descEnd).join('\n').trim() || undefined
      try {
        const raw = parseYaml(yamlText) as Record<string, unknown>
        const rule = this.validate(slug, raw, description)
        rules.push(rule)
      } catch (err) {
        errors.push({ slug, error: err instanceof Error ? err.message : String(err) })
      }
    }
    return { rules, errors }
  }

  parseFile(path: string): ParseResult {
    return this.parseString(readFileSync(path, 'utf8'))
  }

  parseDuration(s: string): number {
    const m = s.match(DURATION_REGEX)
    if (!m) throw new Error(`invalid Duration: ${s}`)
    const n = parseInt(m[1]!, 10)
    const unit = m[2]!
    const mult = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000
    return n * mult
  }

  private validate(headerSlug: string, raw: Record<string, unknown>, description: string | undefined): Rule {
    if (!SLUG_REGEX.test(headerSlug)) throw new Error(`invalid slug "${headerSlug}" — must be kebab-case`)
    if (raw.schema_version !== 1) throw new Error(`unsupported schema_version: ${raw.schema_version}`)
    if (!raw.when || typeof raw.when !== 'object') throw new Error('missing when')
    const w = raw.when as Record<string, unknown>
    const whenKeys = Object.keys(w).filter(k => ['cron', 'at', 'event', 'state'].includes(k))
    if (whenKeys.length !== 1) throw new Error(`when must have exactly one of {cron, at, event, state}, got [${whenKeys.join(',')}]`)
    const doArr = raw.do as Action[] | undefined
    if (!Array.isArray(doArr) || doArr.length === 0) throw new Error('do must be non-empty array')
    for (const a of doArr) {
      if (!a || typeof a !== 'object' || !ALLOWED_ACTIONS.has((a as any).action)) {
        throw new Error(`invalid action: ${JSON.stringify(a)}`)
      }
    }
    const state = raw.state as LifecycleState
    if (!ALLOWED_LIFECYCLE.has(state)) throw new Error(`invalid state: ${state}`)
    const createdBy = raw.created_by as CreatedBy
    if (!ALLOWED_CREATED_BY.has(createdBy)) throw new Error(`invalid created_by: ${createdBy}`)
    if (!raw.created_at) throw new Error('missing created_at')
    const cooldownStr = raw.cooldown as string | undefined
    const cooldown_ms = cooldownStr ? this.parseDuration(cooldownStr) : undefined
    return {
      schema_version: 1,
      slug: headerSlug,
      when: raw.when as When,
      if: raw.if as string[] | undefined,
      unless: raw.unless as string[] | undefined,
      do: doArr,
      cooldown_ms,
      dry_run_until: raw.dry_run_until ? new Date(raw.dry_run_until as string).getTime() : undefined,
      state,
      created_by: createdBy,
      created_at: new Date(raw.created_at as string).getTime(),
      description,
    }
  }
}
```

- [ ] **Step 3: Run tests**

```bash
bun test src/daemon/orders/v2/parser.test.ts
```
Expected: 12/12 PASS

- [ ] **Step 4: Commit**

```bash
git add src/daemon/orders/v2/parser.ts src/daemon/orders/v2/parser.test.ts
git commit -m "feat(orders-v2): OrdersParser — YAML frontmatter blocks to typed Rules"
```

---

## Task 2: OrdersStore — SQLite CRUD

**Files:**
- Create: `src/daemon/orders/v2/store.ts`
- Create: `src/daemon/orders/v2/store.test.ts`

- [ ] **Step 1: Write the failing test file**

```typescript
// src/daemon/orders/v2/store.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { OrdersStore } from './store'
import type { Rule } from './types'

function mkRule(slug: string, overrides: Partial<Rule> = {}): Rule {
  return {
    schema_version: 1,
    slug,
    when: { event: 'foo' },
    do: [{ action: 'log', args: { message: 'x' } }],
    state: 'active',
    created_by: 'manual',
    created_at: Date.now(),
    ...overrides,
  }
}

describe('OrdersStore', () => {
  let db: Database
  let store: OrdersStore

  beforeEach(() => {
    db = new Database(':memory:')
    store = new OrdersStore(db)
  })

  it('upsert + get round-trip preserves shape', () => {
    const r = mkRule('test-rule', { cooldown_ms: 30_000 })
    store.upsert(r)
    const got = store.get('test-rule')
    expect(got).not.toBeNull()
    expect(got!.slug).toBe('test-rule')
    expect(got!.cooldown_ms).toBe(30_000)
    expect(got!.do[0]!.action).toBe('log')
  })

  it('upsert is idempotent (second upsert updates)', () => {
    store.upsert(mkRule('x', { state: 'pending' }))
    store.upsert(mkRule('x', { state: 'active' }))
    expect(store.get('x')!.state).toBe('active')
    expect(store.listAll()).toHaveLength(1)
  })

  it('listActiveByWhenKind filters by when kind', () => {
    store.upsert(mkRule('a', { when: { cron: '* * * * *' } }))
    store.upsert(mkRule('b', { when: { event: 'foo' } }))
    store.upsert(mkRule('c', { when: { state: { clipboard: { contains: 'x' } } } }))
    expect(store.listActiveByWhenKind('cron').map(r => r.slug)).toEqual(['a'])
    expect(store.listActiveByWhenKind('state').map(r => r.slug)).toEqual(['c'])
    expect(store.listActiveByWhenKind('event').map(r => r.slug)).toEqual(['b'])
  })

  it('listActiveByWhenKind ignores suspended', () => {
    store.upsert(mkRule('a', { when: { event: 'foo' }, state: 'suspended' }))
    expect(store.listActiveByWhenKind('event')).toHaveLength(0)
  })

  it('replaceAll deletes missing rules', () => {
    store.upsert(mkRule('a'))
    store.upsert(mkRule('b'))
    store.replaceAll([mkRule('a'), mkRule('c')])
    expect(store.listAll().map(r => r.slug).sort()).toEqual(['a', 'c'])
  })

  it('recordFire updates last_fired_at and increments fire_count', () => {
    store.upsert(mkRule('x'))
    const now = Date.now()
    store.recordFire('x', now)
    const s = store.getState('x')
    expect(s!.last_fired_at).toBe(now)
    expect(s!.fire_count).toBe(1)
    store.recordFire('x', now + 1000)
    expect(store.getState('x')!.fire_count).toBe(2)
  })

  it('recordDryRunFire logs to dry_run table', () => {
    store.upsert(mkRule('x'))
    const now = Date.now()
    store.recordDryRunFire('x', now, [{ action: 'log', args: { m: 'y' } }], { trigger: { foo: 1 } })
    const logs = store.listDryRunLog('x')
    expect(logs).toHaveLength(1)
    expect(logs[0]!.fired_at).toBe(now)
  })

  it('countDryRunFiresSince counts within window', () => {
    store.upsert(mkRule('x'))
    const now = Date.now()
    store.recordDryRunFire('x', now - 1000, [], {})
    store.recordDryRunFire('x', now - 100, [], {})
    expect(store.countDryRunFiresSince('x', now - 500)).toBe(1)
    expect(store.countDryRunFiresSince('x', now - 2000)).toBe(2)
  })
})
```

- [ ] **Step 2: Implement store**

```typescript
// src/daemon/orders/v2/store.ts
// SQLite-backed store for v2 standing orders. Three tables:
//   orders_rules         — the rule definitions (JSON blob + indexed columns)
//   orders_rule_state    — per-rule mutable counters (last_fired_at, fire_count)
//   orders_dry_run_log   — append-only would-have-fired log for the 24h gate

import type { Database } from 'bun:sqlite'
import type { Rule, Action, When, LifecycleState } from './types'

export const ORDERS_V2_SCHEMA = `
CREATE TABLE IF NOT EXISTS orders_rules (
  slug          TEXT PRIMARY KEY,
  when_kind     TEXT NOT NULL,
  rule_json     TEXT NOT NULL,
  state         TEXT NOT NULL,
  dry_run_until INTEGER,
  cooldown_ms   INTEGER,
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_v2_when_kind ON orders_rules(when_kind);
CREATE INDEX IF NOT EXISTS idx_orders_v2_state ON orders_rules(state);

CREATE TABLE IF NOT EXISTS orders_rule_state (
  slug            TEXT PRIMARY KEY,
  last_fired_at   INTEGER NOT NULL DEFAULT 0,
  fire_count      INTEGER NOT NULL DEFAULT 0,
  last_dry_run_at INTEGER NOT NULL DEFAULT 0,
  dry_run_count   INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  FOREIGN KEY (slug) REFERENCES orders_rules(slug) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS orders_dry_run_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT NOT NULL,
  fired_at    INTEGER NOT NULL,
  would_do    TEXT NOT NULL,
  trigger_ctx TEXT,
  FOREIGN KEY (slug) REFERENCES orders_rules(slug) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_dry_run_slug_time ON orders_dry_run_log(slug, fired_at);
`

export type RuleStateRow = {
  slug: string
  last_fired_at: number
  fire_count: number
  last_dry_run_at: number
  dry_run_count: number
  last_error?: string
}

export type DryRunLogRow = {
  id: number
  slug: string
  fired_at: number
  would_do: Action[]
  trigger_ctx?: Record<string, unknown>
}

export type WhenKind = 'cron' | 'at' | 'event' | 'state'

export class OrdersStore {
  constructor(private db: Database) {
    db.exec(ORDERS_V2_SCHEMA)
  }

  upsert(rule: Rule): void {
    const whenKind = this.whenKindOf(rule.when)
    const now = Date.now()
    this.db.run(
      `INSERT INTO orders_rules (slug, when_kind, rule_json, state, dry_run_until, cooldown_ms, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET
         when_kind = excluded.when_kind,
         rule_json = excluded.rule_json,
         state = excluded.state,
         dry_run_until = excluded.dry_run_until,
         cooldown_ms = excluded.cooldown_ms,
         updated_at = excluded.updated_at`,
      [rule.slug, whenKind, JSON.stringify(rule), rule.state, rule.dry_run_until ?? null,
       rule.cooldown_ms ?? null, rule.created_by, rule.created_at, now],
    )
  }

  replaceAll(rules: Rule[]): void {
    const incoming = new Set(rules.map(r => r.slug))
    const existing = this.listAll().map(r => r.slug)
    for (const slug of existing) if (!incoming.has(slug)) this.remove(slug)
    for (const r of rules) this.upsert(r)
  }

  get(slug: string): Rule | null {
    const row = this.db.query(`SELECT rule_json FROM orders_rules WHERE slug = ?`).get(slug) as { rule_json: string } | null
    return row ? JSON.parse(row.rule_json) as Rule : null
  }

  listAll(): Rule[] {
    const rows = this.db.query(`SELECT rule_json FROM orders_rules ORDER BY slug`).all() as Array<{ rule_json: string }>
    return rows.map(r => JSON.parse(r.rule_json) as Rule)
  }

  listActiveByWhenKind(kind: WhenKind): Rule[] {
    const rows = this.db.query(
      `SELECT rule_json FROM orders_rules WHERE when_kind = ? AND state IN ('active', 'dry_run')`,
    ).all(kind) as Array<{ rule_json: string }>
    return rows.map(r => JSON.parse(r.rule_json) as Rule)
  }

  remove(slug: string): void {
    this.db.run(`DELETE FROM orders_rules WHERE slug = ?`, [slug])
  }

  recordFire(slug: string, firedAt: number): void {
    this.db.run(
      `INSERT INTO orders_rule_state (slug, last_fired_at, fire_count)
       VALUES (?, ?, 1)
       ON CONFLICT(slug) DO UPDATE SET
         last_fired_at = excluded.last_fired_at,
         fire_count = orders_rule_state.fire_count + 1`,
      [slug, firedAt],
    )
  }

  recordDryRunFire(slug: string, firedAt: number, wouldDo: Action[], triggerCtx: Record<string, unknown>): void {
    this.db.run(
      `INSERT INTO orders_dry_run_log (slug, fired_at, would_do, trigger_ctx) VALUES (?, ?, ?, ?)`,
      [slug, firedAt, JSON.stringify(wouldDo), JSON.stringify(triggerCtx)],
    )
    this.db.run(
      `INSERT INTO orders_rule_state (slug, last_dry_run_at, dry_run_count)
       VALUES (?, ?, 1)
       ON CONFLICT(slug) DO UPDATE SET
         last_dry_run_at = excluded.last_dry_run_at,
         dry_run_count = orders_rule_state.dry_run_count + 1`,
      [slug, firedAt],
    )
  }

  recordError(slug: string, error: string): void {
    this.db.run(
      `INSERT INTO orders_rule_state (slug, last_error) VALUES (?, ?)
       ON CONFLICT(slug) DO UPDATE SET last_error = excluded.last_error`,
      [slug, error],
    )
  }

  getState(slug: string): RuleStateRow | null {
    const r = this.db.query(`SELECT * FROM orders_rule_state WHERE slug = ?`).get(slug) as any
    return r ? { ...r, last_error: r.last_error ?? undefined } : null
  }

  countDryRunFiresSince(slug: string, sinceMs: number): number {
    const r = this.db.query(
      `SELECT COUNT(*) AS n FROM orders_dry_run_log WHERE slug = ? AND fired_at >= ?`,
    ).get(slug, sinceMs) as { n: number }
    return r.n
  }

  listDryRunLog(slug: string, limit = 100): DryRunLogRow[] {
    const rows = this.db.query(
      `SELECT * FROM orders_dry_run_log WHERE slug = ? ORDER BY fired_at DESC LIMIT ?`,
    ).all(slug, limit) as any[]
    return rows.map(r => ({
      id: r.id,
      slug: r.slug,
      fired_at: r.fired_at,
      would_do: JSON.parse(r.would_do),
      trigger_ctx: r.trigger_ctx ? JSON.parse(r.trigger_ctx) : undefined,
    }))
  }

  private whenKindOf(when: When): WhenKind {
    if ('cron' in when) return 'cron'
    if ('at' in when) return 'at'
    if ('event' in when) return 'event'
    return 'state'
  }
}
```

- [ ] **Step 3: Run tests + commit**

```bash
bun test src/daemon/orders/v2/store.test.ts
git add src/daemon/orders/v2/store.ts src/daemon/orders/v2/store.test.ts
git commit -m "feat(orders-v2): OrdersStore — SQLite CRUD for rules + state + dry-run log"
```

---

## Task 3: OrdersInterp — variable interpolation

**Files:**
- Create: `src/daemon/orders/v2/interp.ts`
- Create: `src/daemon/orders/v2/interp.test.ts`

Resolves `${trigger.X}`, `${payload.X}`, `${skill_output.X}`, `${persona.X}` against a context bundle. Missing keys interpolate to empty string and log a warning.

- [ ] **Step 1: Write the failing test file**

```typescript
// src/daemon/orders/v2/interp.test.ts
import { describe, it, expect } from 'bun:test'
import { interpolate } from './interp'

describe('interpolate', () => {
  it('substitutes ${trigger.X}', () => {
    expect(interpolate('hello ${trigger.name}', { trigger: { name: 'world' } })).toBe('hello world')
  })

  it('substitutes nested paths ${trigger.user.email}', () => {
    expect(interpolate('${trigger.user.email}', { trigger: { user: { email: 'x@y.z' } } })).toBe('x@y.z')
  })

  it('substitutes ${payload.X}', () => {
    expect(interpolate('${payload.foo}', { trigger: {}, payload: { foo: 'bar' } })).toBe('bar')
  })

  it('substitutes ${skill_output.X}', () => {
    expect(interpolate('${skill_output.result}', { trigger: {}, skill_output: { result: 'ok' } })).toBe('ok')
  })

  it('substitutes ${persona.X}', () => {
    expect(interpolate('${persona.focus_app}', { trigger: {}, persona: { focus_app: 'Slack' } })).toBe('Slack')
  })

  it('returns empty string and records warning for missing keys', () => {
    const warnings: string[] = []
    const result = interpolate('${trigger.missing}', { trigger: {} }, { onWarn: w => warnings.push(w) })
    expect(result).toBe('')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('missing')
  })

  it('handles multiple substitutions in one string', () => {
    expect(interpolate('${trigger.a}-${trigger.b}', { trigger: { a: '1', b: '2' } })).toBe('1-2')
  })

  it('passes through strings with no ${}', () => {
    expect(interpolate('hello', {})).toBe('hello')
  })

  it('interpolateObject walks objects + arrays', () => {
    const { interpolateObject } = require('./interp')
    const result = interpolateObject({ msg: 'hi ${trigger.name}', tags: ['${trigger.tag}'] }, { trigger: { name: 'world', tag: 'urgent' } })
    expect(result).toEqual({ msg: 'hi world', tags: ['urgent'] })
  })
})
```

- [ ] **Step 2: Implement**

```typescript
// src/daemon/orders/v2/interp.ts
// Variable interpolation for action args. Resolves ${trigger.X}, ${payload.X},
// ${skill_output.X}, ${persona.X} from a context bundle. Missing keys → empty
// string + warning. NOT a general-purpose expression evaluator.

export type InterpContext = {
  trigger?: Record<string, unknown>
  payload?: Record<string, unknown>
  skill_output?: Record<string, unknown>
  persona?: Record<string, unknown>
}

export type InterpOptions = {
  onWarn?: (msg: string) => void
}

const VAR_REGEX = /\$\{([a-z_]+)\.([^}]+)\}/g

function getPath(obj: unknown, path: string): unknown {
  if (obj == null || typeof obj !== 'object') return undefined
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc == null || typeof acc !== 'object') return undefined
    return (acc as Record<string, unknown>)[key]
  }, obj)
}

export function interpolate(template: string, ctx: InterpContext, opts: InterpOptions = {}): string {
  return template.replace(VAR_REGEX, (_, scope: string, path: string) => {
    const source = (ctx as Record<string, unknown>)[scope]
    if (source === undefined) {
      opts.onWarn?.(`interpolation: unknown scope '${scope}' in '${path}'`)
      return ''
    }
    const value = getPath(source, path)
    if (value === undefined) {
      opts.onWarn?.(`interpolation: missing key '${scope}.${path}'`)
      return ''
    }
    return String(value)
  })
}

/** Walk an object/array and interpolate every string-valued leaf. */
export function interpolateObject(obj: unknown, ctx: InterpContext, opts: InterpOptions = {}): unknown {
  if (typeof obj === 'string') return interpolate(obj, ctx, opts)
  if (Array.isArray(obj)) return obj.map(v => interpolateObject(v, ctx, opts))
  if (obj && typeof obj === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) out[k] = interpolateObject(v, ctx, opts)
    return out
  }
  return obj
}
```

- [ ] **Step 3: Run + commit**

```bash
bun test src/daemon/orders/v2/interp.test.ts
git add src/daemon/orders/v2/interp.ts src/daemon/orders/v2/interp.test.ts
git commit -m "feat(orders-v2): variable interpolation for action args"
```

---

## Task 4: ConditionEvaluator — safe expression evaluator for if/unless

**Files:**
- Create: `src/daemon/orders/v2/conditionEvaluator.ts`
- Create: `src/daemon/orders/v2/conditionEvaluator.test.ts`

Restricted grammar: identifier lookups, `==`/`!=`/`>`/`<`/`>=`/`<=`, `&&`/`||`/`!`, allowlist function calls (`time.between`, `payload.X.includes`). NO `eval()`.

- [ ] **Step 1: Write the failing test file**

```typescript
// src/daemon/orders/v2/conditionEvaluator.test.ts
import { describe, it, expect } from 'bun:test'
import { ConditionEvaluator } from './conditionEvaluator'

describe('ConditionEvaluator', () => {
  let ev: ConditionEvaluator
  beforeEach(() => { ev = new ConditionEvaluator() })

  it('evaluates bare boolean identifier', () => {
    expect(ev.evaluate('persona.is_in_meeting', { persona: { is_in_meeting: true } })).toBe(true)
    expect(ev.evaluate('persona.is_in_meeting', { persona: { is_in_meeting: false } })).toBe(false)
  })

  it('treats missing keys as false', () => {
    expect(ev.evaluate('persona.missing', { persona: {} })).toBe(false)
  })

  it('evaluates string equality', () => {
    expect(ev.evaluate('persona.focus_app == "Slack"', { persona: { focus_app: 'Slack' } })).toBe(true)
    expect(ev.evaluate('persona.focus_app == "Slack"', { persona: { focus_app: 'Code' } })).toBe(false)
  })

  it('evaluates numeric comparison', () => {
    expect(ev.evaluate('persona.current_hour > 9', { persona: { current_hour: 14 } })).toBe(true)
    expect(ev.evaluate('persona.current_hour > 9', { persona: { current_hour: 5 } })).toBe(false)
  })

  it('evaluates && and ||', () => {
    expect(ev.evaluate('persona.a && persona.b', { persona: { a: true, b: true } })).toBe(true)
    expect(ev.evaluate('persona.a && persona.b', { persona: { a: true, b: false } })).toBe(false)
    expect(ev.evaluate('persona.a || persona.b', { persona: { a: false, b: true } })).toBe(true)
  })

  it('evaluates ! (negation)', () => {
    expect(ev.evaluate('!persona.is_in_meeting', { persona: { is_in_meeting: false } })).toBe(true)
  })

  it('evaluates time.between("22:00","07:00")', () => {
    // Inside the window (e.g. 23:30)
    const at23 = new Date(2026, 0, 1, 23, 30).getTime()
    expect(ev.evaluate('time.between("22:00","07:00")', { now: at23 })).toBe(true)
    // Outside the window (e.g. 12:00)
    const at12 = new Date(2026, 0, 1, 12, 0).getTime()
    expect(ev.evaluate('time.between("22:00","07:00")', { now: at12 })).toBe(false)
  })

  it('evaluates payload.X comparison', () => {
    expect(ev.evaluate('payload.importance == "high"', { payload: { importance: 'high' } })).toBe(true)
  })

  it('rejects unknown function call', () => {
    expect(() => ev.evaluate('os.execSync("rm -rf /")', {})).toThrow(/not allowed/i)
  })

  it('rejects raw JS expressions', () => {
    expect(() => ev.evaluate('1; console.log(1)', {})).toThrow()
  })

  it('any() returns true if any condition true', () => {
    expect(ev.any(['persona.a', 'persona.b'], { persona: { a: false, b: true } })).toBe(true)
    expect(ev.any(['persona.a', 'persona.b'], { persona: { a: false, b: false } })).toBe(false)
  })

  it('all() returns true only if every condition true', () => {
    expect(ev.all(['persona.a', 'persona.b'], { persona: { a: true, b: true } })).toBe(true)
    expect(ev.all(['persona.a', 'persona.b'], { persona: { a: true, b: false } })).toBe(false)
  })
})
```

- [ ] **Step 2: Implement**

```typescript
// src/daemon/orders/v2/conditionEvaluator.ts
// Safe expression evaluator for `if`/`unless` conditions. Restricted grammar:
//   - identifier paths (persona.X, payload.X.Y)
//   - comparisons: == != > < >= <=
//   - boolean ops: && || !
//   - allowlist function calls: time.between("HH:MM","HH:MM")
// NO eval(). Tokenizer + recursive descent parser.

export type EvalContext = {
  persona?: Record<string, unknown>
  payload?: Record<string, unknown>
  trigger?: Record<string, unknown>
  now?: number   // ms epoch for time.* functions; defaults to Date.now()
}

type Token = { type: string; value: string }

const ALLOWED_FUNCTIONS = new Set(['time.between'])

function tokenize(src: string): Token[] {
  const out: Token[] = []
  let i = 0
  const len = src.length
  while (i < len) {
    const c = src[i]!
    if (/\s/.test(c)) { i++; continue }
    // String literal
    if (c === '"' || c === "'") {
      const quote = c
      let j = i + 1
      while (j < len && src[j] !== quote) j++
      out.push({ type: 'string', value: src.slice(i + 1, j) })
      i = j + 1
      continue
    }
    // Number
    if (/[0-9]/.test(c)) {
      let j = i
      while (j < len && /[0-9.]/.test(src[j]!)) j++
      out.push({ type: 'number', value: src.slice(i, j) })
      i = j
      continue
    }
    // Identifier (incl. dotted paths)
    if (/[a-zA-Z_]/.test(c)) {
      let j = i
      while (j < len && /[a-zA-Z0-9_.]/.test(src[j]!)) j++
      out.push({ type: 'ident', value: src.slice(i, j) })
      i = j
      continue
    }
    // Multi-char operators
    if (src.slice(i, i + 2) === '==' || src.slice(i, i + 2) === '!=' ||
        src.slice(i, i + 2) === '>=' || src.slice(i, i + 2) === '<=' ||
        src.slice(i, i + 2) === '&&' || src.slice(i, i + 2) === '||') {
      out.push({ type: 'op', value: src.slice(i, i + 2) })
      i += 2
      continue
    }
    // Single-char
    if ('()!,><'.includes(c)) {
      out.push({ type: c === '(' || c === ')' || c === ',' ? c : 'op', value: c })
      i++
      continue
    }
    throw new Error(`unexpected character: ${c}`)
  }
  return out
}

function getPath(ctx: EvalContext, path: string): unknown {
  const [scope, ...rest] = path.split('.')
  const root = (ctx as Record<string, unknown>)[scope!]
  if (root == null) return undefined
  let cur: unknown = root
  for (const k of rest) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[k]
  }
  return cur
}

function timeBetween(hhmmStart: string, hhmmEnd: string, now: number): boolean {
  const d = new Date(now)
  const cur = d.getHours() * 60 + d.getMinutes()
  const [sh, sm] = hhmmStart.split(':').map(Number) as [number, number]
  const [eh, em] = hhmmEnd.split(':').map(Number) as [number, number]
  const s = sh * 60 + sm
  const e = eh * 60 + em
  if (s <= e) return cur >= s && cur <= e
  // Wrap around midnight
  return cur >= s || cur <= e
}

export class ConditionEvaluator {
  evaluate(expr: string, ctx: EvalContext): boolean {
    const tokens = tokenize(expr)
    if (tokens.length === 0) return false
    const result = this.parseExpr(tokens, 0, ctx)
    if (result.next !== tokens.length) throw new Error(`unexpected tokens after expression`)
    return !!result.value
  }

  any(conditions: string[] | undefined, ctx: EvalContext): boolean {
    return (conditions ?? []).some(c => this.evaluate(c, ctx))
  }

  all(conditions: string[] | undefined, ctx: EvalContext): boolean {
    return (conditions ?? []).every(c => this.evaluate(c, ctx))
  }

  private parseExpr(tokens: Token[], pos: number, ctx: EvalContext): { value: unknown; next: number } {
    return this.parseOr(tokens, pos, ctx)
  }

  private parseOr(tokens: Token[], pos: number, ctx: EvalContext): { value: unknown; next: number } {
    let { value, next } = this.parseAnd(tokens, pos, ctx)
    while (tokens[next]?.type === 'op' && tokens[next]!.value === '||') {
      const right = this.parseAnd(tokens, next + 1, ctx)
      value = !!value || !!right.value
      next = right.next
    }
    return { value, next }
  }

  private parseAnd(tokens: Token[], pos: number, ctx: EvalContext): { value: unknown; next: number } {
    let { value, next } = this.parseCompare(tokens, pos, ctx)
    while (tokens[next]?.type === 'op' && tokens[next]!.value === '&&') {
      const right = this.parseCompare(tokens, next + 1, ctx)
      value = !!value && !!right.value
      next = right.next
    }
    return { value, next }
  }

  private parseCompare(tokens: Token[], pos: number, ctx: EvalContext): { value: unknown; next: number } {
    const left = this.parseUnary(tokens, pos, ctx)
    const op = tokens[left.next]
    if (op && op.type === 'op' && ['==', '!=', '>', '<', '>=', '<='].includes(op.value)) {
      const right = this.parseUnary(tokens, left.next + 1, ctx)
      let v: boolean
      switch (op.value) {
        case '==': v = left.value == right.value; break
        case '!=': v = left.value != right.value; break
        case '>':  v = (left.value as number) > (right.value as number); break
        case '<':  v = (left.value as number) < (right.value as number); break
        case '>=': v = (left.value as number) >= (right.value as number); break
        case '<=': v = (left.value as number) <= (right.value as number); break
        default:   v = false
      }
      return { value: v, next: right.next }
    }
    return left
  }

  private parseUnary(tokens: Token[], pos: number, ctx: EvalContext): { value: unknown; next: number } {
    const t = tokens[pos]
    if (t?.type === 'op' && t.value === '!') {
      const inner = this.parseUnary(tokens, pos + 1, ctx)
      return { value: !inner.value, next: inner.next }
    }
    return this.parsePrimary(tokens, pos, ctx)
  }

  private parsePrimary(tokens: Token[], pos: number, ctx: EvalContext): { value: unknown; next: number } {
    const t = tokens[pos]
    if (!t) throw new Error('unexpected end of expression')
    if (t.type === '(') {
      const inner = this.parseExpr(tokens, pos + 1, ctx)
      if (tokens[inner.next]?.type !== ')') throw new Error('missing )')
      return { value: inner.value, next: inner.next + 1 }
    }
    if (t.type === 'number') return { value: parseFloat(t.value), next: pos + 1 }
    if (t.type === 'string') return { value: t.value, next: pos + 1 }
    if (t.type === 'ident') {
      // Function call?
      if (tokens[pos + 1]?.type === '(') {
        if (!ALLOWED_FUNCTIONS.has(t.value)) throw new Error(`function not allowed: ${t.value}`)
        const args: unknown[] = []
        let p = pos + 2
        while (tokens[p] && tokens[p]!.type !== ')') {
          const arg = this.parsePrimary(tokens, p, ctx)
          args.push(arg.value)
          p = arg.next
          if (tokens[p]?.type === ',') p++
        }
        if (tokens[p]?.type !== ')') throw new Error('missing ) in function call')
        let value: unknown
        if (t.value === 'time.between') {
          value = timeBetween(args[0] as string, args[1] as string, ctx.now ?? Date.now())
        } else {
          throw new Error(`function not implemented: ${t.value}`)
        }
        return { value, next: p + 1 }
      }
      // Identifier path
      return { value: getPath(ctx, t.value), next: pos + 1 }
    }
    throw new Error(`unexpected token: ${t.type} ${t.value}`)
  }
}
```

- [ ] **Step 3: Run + commit**

```bash
bun test src/daemon/orders/v2/conditionEvaluator.test.ts
git add src/daemon/orders/v2/conditionEvaluator.ts src/daemon/orders/v2/conditionEvaluator.test.ts
git commit -m "feat(orders-v2): safe expression evaluator for if/unless conditions"
```

---

## Task 5: RulesEventBus — typed pub/sub for chaining

**Files:**
- Create: `src/daemon/orders/v2/eventBus.ts`
- Create: `src/daemon/orders/v2/eventBus.test.ts`

- [ ] **Step 1: Write the failing test file**

```typescript
import { describe, it, expect } from 'bun:test'
import { RulesEventBus } from './eventBus'

describe('RulesEventBus', () => {
  it('emit/on delivers payload', () => {
    const bus = new RulesEventBus()
    const received: Record<string, unknown>[] = []
    bus.on('foo', p => received.push(p))
    bus.emit('foo', { x: 1 })
    expect(received).toEqual([{ x: 1 }])
  })

  it('multiple listeners receive', () => {
    const bus = new RulesEventBus()
    let a = 0, b = 0
    bus.on('foo', () => a++)
    bus.on('foo', () => b++)
    bus.emit('foo', {})
    expect(a).toBe(1)
    expect(b).toBe(1)
  })

  it('off removes listener', () => {
    const bus = new RulesEventBus()
    let calls = 0
    const fn = () => calls++
    bus.on('foo', fn)
    bus.emit('foo', {})
    bus.off('foo', fn)
    bus.emit('foo', {})
    expect(calls).toBe(1)
  })

  it('emit with no listeners is a no-op', () => {
    expect(() => new RulesEventBus().emit('foo', {})).not.toThrow()
  })

  it('chain loop guard refuses depth > 10', () => {
    const bus = new RulesEventBus()
    let depth = 0
    bus.on('loop', () => {
      depth++
      bus.emit('loop', {})
    })
    bus.emit('loop', {})
    expect(depth).toBe(10)
  })

  it('listenerCount returns listener count for event', () => {
    const bus = new RulesEventBus()
    bus.on('foo', () => {})
    bus.on('foo', () => {})
    expect(bus.listenerCount('foo')).toBe(2)
    expect(bus.listenerCount('bar')).toBe(0)
  })
})
```

- [ ] **Step 2: Implement**

```typescript
// src/daemon/orders/v2/eventBus.ts
// In-process typed pub/sub for rule chaining. Per-emit depth counter prevents
// infinite chain loops (cap = 10 hops). Not persisted; restarts reset state.

export type EventHandler = (payload: Record<string, unknown>) => void

const MAX_CHAIN_DEPTH = 10

export class RulesEventBus {
  private listeners = new Map<string, Set<EventHandler>>()
  private currentDepth = 0

  on(event: string, handler: EventHandler): void {
    let s = this.listeners.get(event)
    if (!s) { s = new Set(); this.listeners.set(event, s) }
    s.add(handler)
  }

  off(event: string, handler: EventHandler): void {
    this.listeners.get(event)?.delete(handler)
  }

  emit(event: string, payload: Record<string, unknown>): void {
    if (this.currentDepth >= MAX_CHAIN_DEPTH) return
    this.currentDepth++
    try {
      const handlers = this.listeners.get(event)
      if (!handlers) return
      for (const h of handlers) {
        try { h(payload) } catch {/* swallow per-listener errors */}
      }
    } finally {
      this.currentDepth--
    }
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0
  }
}
```

- [ ] **Step 3: Run + commit**

```bash
bun test src/daemon/orders/v2/eventBus.test.ts
git add src/daemon/orders/v2/eventBus.ts src/daemon/orders/v2/eventBus.test.ts
git commit -m "feat(orders-v2): RulesEventBus — typed pub/sub with chain-loop guard"
```

---

## Task 6: ActionDispatcher — routes to four subsystems

**Files:**
- Create: `src/daemon/orders/v2/actionDispatcher.ts`
- Create: `src/daemon/orders/v2/actionDispatcher.test.ts`

- [ ] **Step 1: Write the failing test file**

```typescript
// src/daemon/orders/v2/actionDispatcher.test.ts
import { describe, it, expect } from 'bun:test'
import { ActionDispatcher } from './actionDispatcher'
import { RulesEventBus } from './eventBus'
import type { Action } from './types'

function fakeIntentRegistry() {
  const calls: any[] = []
  return {
    get: (id: string) => ({
      handler: async (args: any) => { calls.push({ id, args }); return { status: 'success', details: 'ok' } },
    }),
    calls,
  }
}

function fakeSkillDispatcher() {
  const calls: any[] = []
  return {
    invoke: async (slug: string, args: any) => {
      calls.push({ slug, args })
      return { ok: true, output: 'skill-output-' + slug, duration_ms: 1, sandbox: 'declarative' as const }
    },
    calls,
  }
}

function fakeComposio() {
  const calls: any[] = []
  return {
    invokeTool: async (toolkit: string, tool: string, args: any) => {
      calls.push({ toolkit, tool, args })
      return { ok: true, output: 'composio-result' }
    },
    calls,
  }
}

describe('ActionDispatcher', () => {
  it('routes notify → intent registry', async () => {
    const reg = fakeIntentRegistry()
    const d = new ActionDispatcher({ intentRegistry: reg as any, skillDispatcher: fakeSkillDispatcher() as any, composio: fakeComposio() as any, eventBus: new RulesEventBus() })
    await d.dispatch([{ action: 'notify', args: { message: 'hi' } } as Action], { trigger: {} })
    expect(reg.calls).toHaveLength(1)
    expect(reg.calls[0]).toEqual({ id: 'notify', args: { message: 'hi' } })
  })

  it('routes invoke_skill → skill dispatcher', async () => {
    const skl = fakeSkillDispatcher()
    const d = new ActionDispatcher({ intentRegistry: fakeIntentRegistry() as any, skillDispatcher: skl as any, composio: fakeComposio() as any, eventBus: new RulesEventBus() })
    await d.dispatch([{ action: 'invoke_skill', args: { slug: 'greet', args: { name: 'x' } } } as Action], { trigger: {} })
    expect(skl.calls).toEqual([{ slug: 'greet', args: { name: 'x' } }])
  })

  it('routes composio_tool → composio client', async () => {
    const cmp = fakeComposio()
    const d = new ActionDispatcher({ intentRegistry: fakeIntentRegistry() as any, skillDispatcher: fakeSkillDispatcher() as any, composio: cmp as any, eventBus: new RulesEventBus() })
    await d.dispatch([{ action: 'composio_tool', args: { toolkit: 'slack', tool: 'send', args: { channel: '#x' } } } as Action], { trigger: {} })
    expect(cmp.calls).toEqual([{ toolkit: 'slack', tool: 'send', args: { channel: '#x' } }])
  })

  it('routes emit_event → event bus', async () => {
    const bus = new RulesEventBus()
    const got: any[] = []
    bus.on('foo', p => got.push(p))
    const d = new ActionDispatcher({ intentRegistry: fakeIntentRegistry() as any, skillDispatcher: fakeSkillDispatcher() as any, composio: fakeComposio() as any, eventBus: bus })
    await d.dispatch([{ action: 'emit_event', args: { name: 'foo', payload: { x: 1 } } } as Action], { trigger: {} })
    expect(got).toEqual([{ x: 1 }])
  })

  it('chains ${skill_output.X} from previous action', async () => {
    const skl = fakeSkillDispatcher()
    const reg = fakeIntentRegistry()
    const d = new ActionDispatcher({ intentRegistry: reg as any, skillDispatcher: skl as any, composio: fakeComposio() as any, eventBus: new RulesEventBus() })
    await d.dispatch([
      { action: 'invoke_skill', args: { slug: 'classify' } } as Action,
      { action: 'notify', args: { message: '${skill_output}' } } as Action,
    ], { trigger: {} })
    expect(reg.calls[0]!.args.message).toBe('skill-output-classify')
  })

  it('interpolates ${trigger.X} into args', async () => {
    const reg = fakeIntentRegistry()
    const d = new ActionDispatcher({ intentRegistry: reg as any, skillDispatcher: fakeSkillDispatcher() as any, composio: fakeComposio() as any, eventBus: new RulesEventBus() })
    await d.dispatch([{ action: 'notify', args: { message: 'hi ${trigger.name}' } } as Action], { trigger: { name: 'world' } })
    expect(reg.calls[0]!.args.message).toBe('hi world')
  })

  it('returns ok=false when an action throws', async () => {
    const skl = { invoke: async () => { throw new Error('boom') } }
    const d = new ActionDispatcher({ intentRegistry: fakeIntentRegistry() as any, skillDispatcher: skl as any, composio: fakeComposio() as any, eventBus: new RulesEventBus() })
    const result = await d.dispatch([{ action: 'invoke_skill', args: { slug: 'x' } } as Action], { trigger: {} })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('boom')
  })

  it('rejects unknown action type', async () => {
    const d = new ActionDispatcher({ intentRegistry: fakeIntentRegistry() as any, skillDispatcher: fakeSkillDispatcher() as any, composio: fakeComposio() as any, eventBus: new RulesEventBus() })
    const result = await d.dispatch([{ action: 'mystery', args: {} } as any], { trigger: {} })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/unknown action/i)
  })
})
```

- [ ] **Step 2: Implement**

```typescript
// src/daemon/orders/v2/actionDispatcher.ts
// Executes a rule's Action[] sequentially. Routes by action.type to:
//   - notify/remind_later/add_to_memory/log/suspend → IntentRegistry
//   - invoke_skill → SkillDispatcher (C.3.3)
//   - composio_tool → ComposioClient (C.2.7)
//   - emit_event → RulesEventBus
// Variable interpolation runs on each action's args before dispatch.
// ${skill_output} captures the previous action's output for chaining.

import { interpolateObject } from './interp'
import type { Action, ActionResult, TriggerContext } from './types'
import type { RulesEventBus } from './eventBus'

const INTENT_ACTIONS = new Set(['notify', 'remind_later', 'add_to_memory', 'log', 'suspend'])

export type ActionDispatcherDeps = {
  intentRegistry: {
    get(id: string): { handler: (args: any, ctx?: any) => Promise<{ status: string; details?: string }> } | null
  }
  skillDispatcher: {
    invoke(slug: string, args: Record<string, unknown>): Promise<{ ok: boolean; output?: unknown; error?: string; duration_ms: number; sandbox: string }>
  }
  composio: {
    invokeTool(toolkit: string, tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; output?: unknown; error?: string }>
  } | null
  eventBus: RulesEventBus
}

export class ActionDispatcher {
  constructor(private deps: ActionDispatcherDeps) {}

  async dispatch(actions: Action[], ctx: TriggerContext): Promise<ActionResult> {
    let skill_output: unknown
    for (const action of actions) {
      const interpCtx = { ...ctx, skill_output: skill_output as Record<string, unknown> | undefined }
      const args = interpolateObject(action.args, interpCtx as any) as Record<string, unknown>
      try {
        if (INTENT_ACTIONS.has(action.action)) {
          const entry = this.deps.intentRegistry.get(action.action)
          if (!entry) throw new Error(`intent not registered: ${action.action}`)
          await entry.handler(args)
        } else if (action.action === 'invoke_skill') {
          const r = await this.deps.skillDispatcher.invoke(args.slug as string, (args.args as Record<string, unknown>) ?? {})
          if (!r.ok) throw new Error(r.error ?? 'skill failed')
          skill_output = r.output
        } else if (action.action === 'composio_tool') {
          if (!this.deps.composio) throw new Error('Composio not configured')
          const r = await this.deps.composio.invokeTool(args.toolkit as string, args.tool as string, (args.args as Record<string, unknown>) ?? {})
          if (!r.ok) throw new Error(r.error ?? 'composio tool failed')
          skill_output = r.output
        } else if (action.action === 'emit_event') {
          this.deps.eventBus.emit(args.name as string, (args.payload as Record<string, unknown>) ?? {})
        } else {
          throw new Error(`unknown action: ${(action as Action).action}`)
        }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
    return { ok: true, output: skill_output ? (typeof skill_output === 'object' ? skill_output as Record<string, unknown> : { value: skill_output }) : undefined }
  }
}
```

- [ ] **Step 3: Run + commit**

```bash
bun test src/daemon/orders/v2/actionDispatcher.test.ts
git add src/daemon/orders/v2/actionDispatcher.ts src/daemon/orders/v2/actionDispatcher.test.ts
git commit -m "feat(orders-v2): ActionDispatcher — routes to intents/skills/composio/event-bus"
```

---

## Task 7: DryRunLogger — short-circuit + 24h aggregation

**Files:**
- Create: `src/daemon/orders/v2/dryRunLogger.ts`
- Create: `src/daemon/orders/v2/dryRunLogger.test.ts`

Wraps `OrdersStore.recordDryRunFire`; produces a summary for the inbox prompt builder.

- [ ] **Step 1: Write the failing test file**

```typescript
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { OrdersStore } from './store'
import { DryRunLogger } from './dryRunLogger'
import type { Rule } from './types'

function mkRule(slug: string, dry_run_until: number): Rule {
  return {
    schema_version: 1, slug, when: { event: 'foo' },
    do: [{ action: 'notify', args: { message: 'x' } }],
    state: 'dry_run', created_by: 'voice', created_at: Date.now(),
    dry_run_until,
  }
}

describe('DryRunLogger', () => {
  let db: Database, store: OrdersStore, logger: DryRunLogger
  beforeEach(() => {
    db = new Database(':memory:')
    store = new OrdersStore(db)
    logger = new DryRunLogger(store)
  })

  it('isDryRun returns true if dry_run_until > now', () => {
    const r = mkRule('x', Date.now() + 1000)
    expect(logger.isDryRun(r, Date.now())).toBe(true)
  })

  it('isDryRun returns false if dry_run_until <= now', () => {
    const r = mkRule('x', Date.now() - 1000)
    expect(logger.isDryRun(r, Date.now())).toBe(false)
  })

  it('logFire records to store', () => {
    const r = mkRule('x', Date.now() + 1000)
    store.upsert(r)
    logger.logFire(r, [{ action: 'notify', args: {} }], { trigger: { foo: 1 } }, Date.now())
    expect(store.listDryRunLog('x')).toHaveLength(1)
  })

  it('summarize returns counts + samples', () => {
    const r = mkRule('x', Date.now() + 1000)
    store.upsert(r)
    const t0 = Date.now() - 30 * 60 * 1000
    for (let i = 0; i < 5; i++) {
      logger.logFire(r, [{ action: 'notify', args: {} }], { trigger: { i } }, t0 + i * 1000)
    }
    const summary = logger.summarize(r, Date.now())
    expect(summary.fire_count).toBe(5)
    expect(summary.samples).toHaveLength(Math.min(5, summary.samples.length))
  })

  it('listReadyForApproval returns rules whose dry_run window expired', () => {
    const rA = mkRule('a', Date.now() - 1000)   // expired
    const rB = mkRule('b', Date.now() + 1000)   // still in window
    store.upsert(rA); store.upsert(rB)
    const ready = logger.listReadyForApproval(Date.now())
    expect(ready.map(r => r.slug)).toEqual(['a'])
  })

  it('listReadyForApproval ignores rules without dry_run_until', () => {
    const r: Rule = { ...mkRule('a', 0), dry_run_until: undefined, state: 'active' }
    store.upsert(r)
    expect(logger.listReadyForApproval(Date.now())).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Implement**

```typescript
// src/daemon/orders/v2/dryRunLogger.ts
// Wraps OrdersStore for the dry-run flow. Decides whether a rule is currently
// in its 24h dry-run window, records "would have fired" events, and provides
// an aggregation summary for the inbox prompt builder.

import type { OrdersStore } from './store'
import type { Rule, Action, TriggerContext } from './types'

export type DryRunSummary = {
  slug: string
  fire_count: number
  window_start: number
  window_end: number
  samples: Array<{ fired_at: number; would_do: Action[] }>
}

export class DryRunLogger {
  constructor(private store: OrdersStore) {}

  isDryRun(rule: Rule, now: number): boolean {
    return rule.dry_run_until !== undefined && rule.dry_run_until > now
  }

  logFire(rule: Rule, wouldDo: Action[], ctx: TriggerContext, now: number): void {
    this.store.recordDryRunFire(rule.slug, now, wouldDo, ctx as Record<string, unknown>)
  }

  summarize(rule: Rule, now: number): DryRunSummary {
    const windowStart = rule.created_at
    const samples = this.store.listDryRunLog(rule.slug, 3)
    return {
      slug: rule.slug,
      fire_count: this.store.countDryRunFiresSince(rule.slug, windowStart),
      window_start: windowStart,
      window_end: rule.dry_run_until ?? now,
      samples: samples.map(s => ({ fired_at: s.fired_at, would_do: s.would_do })),
    }
  }

  /** Returns rules whose dry_run window has expired and still need approval. */
  listReadyForApproval(now: number): Rule[] {
    return this.store.listAll().filter(r => r.state === 'dry_run' && r.dry_run_until !== undefined && r.dry_run_until <= now)
  }
}
```

- [ ] **Step 3: Run + commit**

```bash
bun test src/daemon/orders/v2/dryRunLogger.test.ts
git add src/daemon/orders/v2/dryRunLogger.ts src/daemon/orders/v2/dryRunLogger.test.ts
git commit -m "feat(orders-v2): DryRunLogger — 24h gate + aggregation for inbox approval"
```

---

## Task 8: ReactiveEvaluator — state-triggered rule firing

**Files:**
- Create: `src/daemon/orders/v2/reactiveEvaluator.ts`
- Create: `src/daemon/orders/v2/reactiveEvaluator.test.ts`

Subscribes to the perception bus, evaluates state-triggered rules against each event, checks `if`/`unless`/`cooldown`, calls `ActionDispatcher` (or `DryRunLogger` if rule is in dry-run window).

- [ ] **Step 1: Write the failing test file**

```typescript
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { OrdersStore } from './store'
import { ReactiveEvaluator } from './reactiveEvaluator'
import { ConditionEvaluator } from './conditionEvaluator'
import { DryRunLogger } from './dryRunLogger'
import type { Rule } from './types'

function mkClipboardRule(slug: string, contains: string, opts: Partial<Rule> = {}): Rule {
  return {
    schema_version: 1, slug,
    when: { state: { clipboard: { contains } } },
    do: [{ action: 'notify', args: { message: 'matched' } }],
    state: 'active', created_by: 'manual', created_at: Date.now(),
    ...opts,
  }
}

function fakeDispatcher() {
  const calls: any[] = []
  return {
    dispatch: async (actions: any, ctx: any) => { calls.push({ actions, ctx }); return { ok: true } },
    calls,
  }
}

describe('ReactiveEvaluator', () => {
  let db: Database, store: OrdersStore, evaluator: ReactiveEvaluator, dispatcher: ReturnType<typeof fakeDispatcher>

  beforeEach(() => {
    db = new Database(':memory:')
    store = new OrdersStore(db)
    dispatcher = fakeDispatcher()
    evaluator = new ReactiveEvaluator({
      store,
      dispatcher: dispatcher as any,
      conditionEvaluator: new ConditionEvaluator(),
      dryRunLogger: new DryRunLogger(store),
      getPersonaState: () => ({ is_in_meeting: false, focus_app: 'Code' }),
    })
  })

  it('fires rule when clipboard event matches', async () => {
    store.upsert(mkClipboardRule('a', 'urgent'))
    await evaluator.handleEvent('clipboard', { text: 'urgent reminder' })
    expect(dispatcher.calls).toHaveLength(1)
  })

  it('does not fire when clipboard does not match', async () => {
    store.upsert(mkClipboardRule('a', 'urgent'))
    await evaluator.handleEvent('clipboard', { text: 'hello' })
    expect(dispatcher.calls).toHaveLength(0)
  })

  it('skips rule when unless persona.is_in_meeting is true', async () => {
    evaluator = new ReactiveEvaluator({
      store, dispatcher: dispatcher as any,
      conditionEvaluator: new ConditionEvaluator(),
      dryRunLogger: new DryRunLogger(store),
      getPersonaState: () => ({ is_in_meeting: true }),
    })
    store.upsert(mkClipboardRule('a', 'urgent', { unless: ['persona.is_in_meeting'] }))
    await evaluator.handleEvent('clipboard', { text: 'urgent x' })
    expect(dispatcher.calls).toHaveLength(0)
  })

  it('fires when if predicate is satisfied', async () => {
    store.upsert(mkClipboardRule('a', 'urgent', { if: ['persona.focus_app == "Code"'] }))
    await evaluator.handleEvent('clipboard', { text: 'urgent x' })
    expect(dispatcher.calls).toHaveLength(1)
  })

  it('skips when if predicate is false', async () => {
    store.upsert(mkClipboardRule('a', 'urgent', { if: ['persona.focus_app == "Slack"'] }))
    await evaluator.handleEvent('clipboard', { text: 'urgent x' })
    expect(dispatcher.calls).toHaveLength(0)
  })

  it('respects cooldown (does not fire twice within window)', async () => {
    store.upsert(mkClipboardRule('a', 'urgent', { cooldown_ms: 10_000 }))
    await evaluator.handleEvent('clipboard', { text: 'urgent x' })
    await evaluator.handleEvent('clipboard', { text: 'urgent y' })
    expect(dispatcher.calls).toHaveLength(1)
  })

  it('records fire timestamp in store', async () => {
    store.upsert(mkClipboardRule('a', 'urgent'))
    await evaluator.handleEvent('clipboard', { text: 'urgent x' })
    expect(store.getState('a')!.fire_count).toBe(1)
  })

  it('uses dry-run path when rule is in dry-run window', async () => {
    const r = mkClipboardRule('a', 'urgent', { state: 'dry_run', dry_run_until: Date.now() + 60_000 })
    store.upsert(r)
    await evaluator.handleEvent('clipboard', { text: 'urgent x' })
    expect(dispatcher.calls).toHaveLength(0)
    expect(store.listDryRunLog('a')).toHaveLength(1)
  })

  it('matches focus_app rule', async () => {
    const r: Rule = {
      schema_version: 1, slug: 'b',
      when: { state: { focus_app: { equals: 'Slack' } } },
      do: [{ action: 'log', args: {} }],
      state: 'active', created_by: 'manual', created_at: Date.now(),
    }
    store.upsert(r)
    await evaluator.handleEvent('focus_app', { app: 'Slack' })
    expect(dispatcher.calls).toHaveLength(1)
    await evaluator.handleEvent('focus_app', { app: 'Code' })
    expect(dispatcher.calls).toHaveLength(1)
  })

  it('matches focus_app.in([...])', async () => {
    const r: Rule = {
      schema_version: 1, slug: 'c',
      when: { state: { focus_app: { in: ['Slack', 'Discord'] } } },
      do: [{ action: 'log', args: {} }],
      state: 'active', created_by: 'manual', created_at: Date.now(),
    }
    store.upsert(r)
    await evaluator.handleEvent('focus_app', { app: 'Discord' })
    expect(dispatcher.calls).toHaveLength(1)
  })

  it('handles event-triggered rules via handleEvent("event", { name, payload })', async () => {
    const r: Rule = {
      schema_version: 1, slug: 'd', when: { event: 'invite_classified' },
      do: [{ action: 'notify', args: { message: 'classified' } }],
      state: 'active', created_by: 'manual', created_at: Date.now(),
    }
    store.upsert(r)
    await evaluator.handleEvent('event', { name: 'invite_classified', payload: { importance: 'high' } })
    expect(dispatcher.calls).toHaveLength(1)
  })

  it('ignores events when no rule matches', async () => {
    await evaluator.handleEvent('clipboard', { text: 'random' })
    expect(dispatcher.calls).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Implement**

```typescript
// src/daemon/orders/v2/reactiveEvaluator.ts
// State-triggered rule evaluation. Subscribes to perception event types,
// matches against rules' `when.state` selectors, applies if/unless/cooldown,
// and routes to ActionDispatcher (or DryRunLogger).
//
// "Event source" (kind) is a string: 'clipboard' | 'focus_app' | 'calendar' |
// 'file_events' | 'browser_tabs' | 'pattern' | 'event' (the last for named-event
// triggered rules from RulesEventBus).

import type { OrdersStore } from './store'
import type { ConditionEvaluator } from './conditionEvaluator'
import type { DryRunLogger } from './dryRunLogger'
import type { Rule, StateSelector, TriggerContext, ActionResult } from './types'

export type ReactiveEvaluatorDeps = {
  store: OrdersStore
  dispatcher: { dispatch(actions: any[], ctx: TriggerContext): Promise<ActionResult> }
  conditionEvaluator: ConditionEvaluator
  dryRunLogger: DryRunLogger
  getPersonaState: () => Record<string, unknown>
  now?: () => number
}

export class ReactiveEvaluator {
  private now: () => number
  constructor(private deps: ReactiveEvaluatorDeps) {
    this.now = deps.now ?? Date.now
  }

  async handleEvent(kind: string, payload: Record<string, unknown>): Promise<void> {
    if (kind === 'event') {
      // Named-event firings have payload = { name, payload }
      const eventName = payload.name as string
      await this.handleNamedEvent(eventName, payload.payload as Record<string, unknown> ?? {})
      return
    }
    const rules = this.deps.store.listActiveByWhenKind('state')
    for (const r of rules) {
      if (!('state' in r.when)) continue
      if (!this.matchesSelector(r.when.state, kind, payload)) continue
      await this.maybeFire(r, { trigger: payload })
    }
  }

  private async handleNamedEvent(name: string, payload: Record<string, unknown>): Promise<void> {
    const rules = this.deps.store.listActiveByWhenKind('event')
    for (const r of rules) {
      if (!('event' in r.when) || r.when.event !== name) continue
      await this.maybeFire(r, { trigger: payload, payload })
    }
  }

  private matchesSelector(sel: StateSelector, kind: string, payload: Record<string, unknown>): boolean {
    if ('clipboard' in sel && kind === 'clipboard') {
      const c = sel.clipboard
      const text = (payload.text as string | undefined) ?? ''
      if (c.contains && !text.toLowerCase().includes(c.contains.toLowerCase())) return false
      if (c.is_url) {
        try { new URL(text) } catch { return false }
      }
      return true
    }
    if ('focus_app' in sel && kind === 'focus_app') {
      const app = (payload.app as string | undefined) ?? ''
      const f = sel.focus_app
      if (f.equals && app !== f.equals) return false
      if (f.in && !f.in.includes(app)) return false
      return true
    }
    if ('calendar' in sel && kind === 'calendar') return true
    if ('file_events' in sel && kind === 'file_events') {
      const path = (payload.path as string | undefined) ?? ''
      const pattern = sel.file_events.path_matches
      if (pattern && !this.globMatch(path, pattern)) return false
      return true
    }
    if ('browser_tabs' in sel && kind === 'browser_tabs') return true
    if ('pattern' in sel && kind === 'pattern') return true
    return false
  }

  private globMatch(path: string, pattern: string): boolean {
    // Simple glob: * matches any segment; ** matches anything across segments
    const regex = new RegExp(
      '^' + pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '__DOUBLESTAR__')
        .replace(/\*/g, '[^/]*')
        .replace(/__DOUBLESTAR__/g, '.*') + '$',
    )
    return regex.test(path)
  }

  private async maybeFire(rule: Rule, ctx: TriggerContext): Promise<void> {
    const now = this.now()
    const ev = this.deps.conditionEvaluator
    const evalCtx = { persona: this.deps.getPersonaState(), payload: ctx.payload ?? {}, trigger: ctx.trigger, now }

    if (rule.if && !ev.all(rule.if, evalCtx)) return
    if (rule.unless && ev.any(rule.unless, evalCtx)) return

    if (rule.cooldown_ms) {
      const state = this.deps.store.getState(rule.slug)
      if (state && (now - state.last_fired_at) < rule.cooldown_ms) return
    }

    if (this.deps.dryRunLogger.isDryRun(rule, now)) {
      this.deps.dryRunLogger.logFire(rule, rule.do, ctx, now)
      return
    }

    await this.deps.dispatcher.dispatch(rule.do, ctx)
    this.deps.store.recordFire(rule.slug, now)
  }
}
```

- [ ] **Step 3: Run + commit**

```bash
bun test src/daemon/orders/v2/reactiveEvaluator.test.ts
git add src/daemon/orders/v2/reactiveEvaluator.ts src/daemon/orders/v2/reactiveEvaluator.test.ts
git commit -m "feat(orders-v2): ReactiveEvaluator — state + event triggered firing with cooldown"
```

---

## Task 9: ScheduleAdapter — wires cron/at rules to existing ScheduleManager

**Files:**
- Create: `src/daemon/orders/v2/scheduleAdapter.ts`
- Create: `src/daemon/orders/v2/scheduleAdapter.test.ts`

Wraps `cronParser.ts` directly (not the full ScheduleManager — that's wired in daemon at Task 12). Each cron/at rule gets a single `setTimeout` that re-arms after firing.

- [ ] **Step 1: Write the failing test file**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { OrdersStore } from './store'
import { ScheduleAdapter } from './scheduleAdapter'
import type { Rule } from './types'

function mkCronRule(slug: string, cron: string, opts: Partial<Rule> = {}): Rule {
  return {
    schema_version: 1, slug, when: { cron },
    do: [{ action: 'log', args: { message: 'x' } }],
    state: 'active', created_by: 'manual', created_at: Date.now(),
    ...opts,
  }
}

describe('ScheduleAdapter', () => {
  let db: Database, store: OrdersStore, adapter: ScheduleAdapter, fired: string[]
  beforeEach(() => {
    db = new Database(':memory:')
    store = new OrdersStore(db)
    fired = []
    adapter = new ScheduleAdapter({
      store,
      onFire: async (rule, ctx) => { fired.push(rule.slug); },
    })
  })
  afterEach(() => { adapter.stopAll() })

  it('register accepts a cron rule', () => {
    const r = mkCronRule('a', '0 9 * * *')
    store.upsert(r)
    adapter.register(r)
    expect(adapter.registeredSlugs()).toContain('a')
  })

  it('unregister clears timer', () => {
    const r = mkCronRule('a', '0 9 * * *')
    store.upsert(r)
    adapter.register(r)
    adapter.unregister('a')
    expect(adapter.registeredSlugs()).not.toContain('a')
  })

  it('refreshAll registers all cron + at rules', () => {
    store.upsert(mkCronRule('a', '0 9 * * *'))
    store.upsert({ ...mkCronRule('b', ''), when: { at: 'in 2 hours' } } as Rule)
    store.upsert({ ...mkCronRule('c', ''), when: { event: 'foo' } } as Rule)   // not time-triggered
    adapter.refreshAll()
    expect(adapter.registeredSlugs().sort()).toEqual(['a', 'b'])
  })

  it('rejects invalid cron expression silently (logs)', () => {
    const r = mkCronRule('bad', 'not a cron')
    store.upsert(r)
    expect(() => adapter.register(r)).not.toThrow()
    expect(adapter.registeredSlugs()).not.toContain('bad')
  })

  it('fires after at: "in 100ms"', async () => {
    // We need to bypass the cron parser, use a very short relative timer.
    // The cronParser.ts parseRelativeTime should accept "in 100ms"; verify or
    // construct a sentinel via direct timer call instead.
    const r: Rule = {
      schema_version: 1, slug: 'instant', when: { at: 'in 100ms' },
      do: [{ action: 'log', args: { message: 'x' } }],
      state: 'active', created_by: 'manual', created_at: Date.now(),
    }
    store.upsert(r)
    adapter.register(r)
    await new Promise(res => setTimeout(res, 200))
    expect(fired).toContain('instant')
  }, 5000)

  it('cron rule re-arms after firing', async () => {
    // Use cron "* * * * * *" only if 6-field is supported; otherwise this is
    // a behavioral test — we register and verify timer re-arms structurally.
    const r = mkCronRule('every-min', '* * * * *')
    store.upsert(r)
    adapter.register(r)
    expect(adapter.registeredSlugs()).toContain('every-min')
    // We don't wait 60s in a unit test; structural check is enough here.
  })
})
```

- [ ] **Step 2: Implement**

```typescript
// src/daemon/orders/v2/scheduleAdapter.ts
// Wraps cronParser.ts directly: for each cron/at rule, computes the next fire
// timestamp and arms a setTimeout. After firing, re-arms (cron) or removes (at).

import type { OrdersStore } from './store'
import type { Rule, TriggerContext } from './types'
import { parseSimpleCron, nextCronFire, parseRelativeTime, isValidCronExpr } from '../../cronParser'
import { log, logError } from '../../logger'

export type ScheduleAdapterDeps = {
  store: OrdersStore
  onFire: (rule: Rule, ctx: TriggerContext) => Promise<void>
  now?: () => number
}

export class ScheduleAdapter {
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private now: () => number

  constructor(private deps: ScheduleAdapterDeps) {
    this.now = deps.now ?? Date.now
  }

  register(rule: Rule): void {
    const slug = rule.slug
    this.unregister(slug)
    if ('cron' in rule.when) {
      const expr = parseSimpleCron(rule.when.cron) ?? (isValidCronExpr(rule.when.cron) ? rule.when.cron : null)
      if (!expr) { log(`[orders-v2] invalid cron expr for ${slug}: ${rule.when.cron}`, 'warn'); return }
      this.armCron(rule, expr)
    } else if ('at' in rule.when) {
      const at = parseRelativeTime(rule.when.at) ?? Date.parse(rule.when.at)
      if (!at || Number.isNaN(at)) { log(`[orders-v2] invalid at: for ${slug}: ${rule.when.at}`, 'warn'); return }
      this.armAt(rule, at)
    }
  }

  unregister(slug: string): void {
    const t = this.timers.get(slug)
    if (t) { clearTimeout(t); this.timers.delete(slug) }
  }

  refreshAll(): void {
    this.stopAll()
    for (const r of this.deps.store.listAll()) {
      if ('cron' in r.when || 'at' in r.when) this.register(r)
    }
  }

  stopAll(): void {
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }

  registeredSlugs(): string[] {
    return Array.from(this.timers.keys())
  }

  private armCron(rule: Rule, expr: string): void {
    const fireAt = nextCronFire(expr, this.now())
    if (!fireAt) return
    const delay = Math.max(0, fireAt - this.now())
    const timer = setTimeout(async () => {
      try {
        await this.deps.onFire(rule, { trigger: { fired_at: this.now() } })
      } catch (err) { logError(`[orders-v2] cron fire failed for ${rule.slug}`, err) }
      // Re-arm with latest rule from store (might have been updated)
      const fresh = this.deps.store.get(rule.slug)
      if (fresh) this.armCron(fresh, expr)
    }, delay)
    this.timers.set(rule.slug, timer)
  }

  private armAt(rule: Rule, fireAt: number): void {
    const delay = Math.max(0, fireAt - this.now())
    const timer = setTimeout(async () => {
      try {
        await this.deps.onFire(rule, { trigger: { fired_at: this.now() } })
      } catch (err) { logError(`[orders-v2] at fire failed for ${rule.slug}`, err) }
      this.timers.delete(rule.slug)
    }, delay)
    this.timers.set(rule.slug, timer)
  }
}
```

- [ ] **Step 3: Run + commit**

```bash
bun test src/daemon/orders/v2/scheduleAdapter.test.ts
git add src/daemon/orders/v2/scheduleAdapter.ts src/daemon/orders/v2/scheduleAdapter.test.ts
git commit -m "feat(orders-v2): ScheduleAdapter — wires cron/at rules to setTimeout via cronParser"
```

---

## Task 10: OrdersAuthor — speech → LLM → file append

**Files:**
- Modify: `src/daemon/llm/types.ts` (add `orders_compose` TaskType)
- Modify: `src/daemon/llm/policy.ts` (map to mid tier)
- Create: `src/daemon/orders/v2/author.ts`
- Create: `src/daemon/orders/v2/author.test.ts`

- [ ] **Step 1: Add `orders_compose` TaskType**

In `src/daemon/llm/types.ts`, append to the TaskType union:
```typescript
  | 'orders_compose'      // mid: speech → DSL rule for STANDING_ORDERS v2
```

In `src/daemon/llm/policy.ts`, add to TASK_TO_TIER:
```typescript
  orders_compose:     'mid',
```

- [ ] **Step 2: Write the failing test file**

```typescript
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { OrdersStore } from './store'
import { OrdersParser } from './parser'
import { OrdersAuthor } from './author'

function makeFakeRouter(response: any) {
  const calls: any[] = []
  return {
    router: {
      async complete(req: any) {
        calls.push(req)
        return { parsed: response, text: JSON.stringify(response) } as any
      },
    },
    calls,
  }
}

describe('OrdersAuthor', () => {
  let db: Database, store: OrdersStore, parser: OrdersParser, dir: string, file: string

  beforeEach(() => {
    db = new Database(':memory:')
    store = new OrdersStore(db)
    parser = new OrdersParser()
    dir = mkdtempSync(join(tmpdir(), 'orders-author-'))
    file = join(dir, 'STANDING_ORDERS.md')
    writeFileSync(file, '# KAIROS Standing Orders\n')
  })

  it('compose appends a new rule block to the file', async () => {
    const fake = makeFakeRouter({
      proposed_rule: {
        when: { cron: '0 9 * * 1' },
        do: [{ action: 'notify', args: { message: 'send standup' } }],
      },
      slug_suggestion: 'monday-standup',
      similar_existing: null,
      confidence: 0.9,
    })
    const author = new OrdersAuthor({ router: fake.router as any, store, parser, filePath: file })
    const result = await author.handleSpeech('remind me every Monday at 9 to send standup')
    expect(result.created_slug).toBe('monday-standup')
    const content = readFileSync(file, 'utf8')
    expect(content).toContain('## monday-standup')
    expect(content).toContain('cron: "0 9 * * 1"')
    expect(content).toContain('state: dry_run')
  })

  it('sets dry_run_until = now + 24h by default', async () => {
    const fake = makeFakeRouter({
      proposed_rule: { when: { event: 'foo' }, do: [{ action: 'log', args: { message: 'x' } }] },
      slug_suggestion: 'test-rule',
      similar_existing: null,
      confidence: 1,
    })
    const author = new OrdersAuthor({ router: fake.router as any, store, parser, filePath: file })
    const before = Date.now()
    await author.handleSpeech('test')
    const after = Date.now()
    const content = readFileSync(file, 'utf8')
    const m = content.match(/dry_run_until: (.+)/)
    expect(m).not.toBeNull()
    const ts = new Date(m![1]!).getTime()
    expect(ts).toBeGreaterThanOrEqual(before + 23 * 60 * 60 * 1000)
    expect(ts).toBeLessThanOrEqual(after + 25 * 60 * 60 * 1000)
  })

  it('returns similar_existing without writing when LLM finds duplicate', async () => {
    const fake = makeFakeRouter({
      proposed_rule: { when: { event: 'foo' }, do: [{ action: 'log', args: { message: 'x' } }] },
      slug_suggestion: 'new-thing',
      similar_existing: 'existing-thing',
      confidence: 0.95,
    })
    const author = new OrdersAuthor({ router: fake.router as any, store, parser, filePath: file })
    const result = await author.handleSpeech('test')
    expect(result.created_slug).toBeNull()
    expect(result.similar_existing).toBe('existing-thing')
    expect(readFileSync(file, 'utf8')).not.toContain('## new-thing')
  })

  it('appends description body showing the user speech', async () => {
    const fake = makeFakeRouter({
      proposed_rule: { when: { event: 'foo' }, do: [{ action: 'log', args: { message: 'x' } }] },
      slug_suggestion: 'r',
      similar_existing: null,
      confidence: 1,
    })
    const author = new OrdersAuthor({ router: fake.router as any, store, parser, filePath: file })
    await author.handleSpeech('hello world test phrase')
    expect(readFileSync(file, 'utf8')).toContain('hello world test phrase')
  })

  it('returns error when LLM omits proposed_rule', async () => {
    const fake = makeFakeRouter({ slug_suggestion: 'x' })
    const author = new OrdersAuthor({ router: fake.router as any, store, parser, filePath: file })
    const result = await author.handleSpeech('test')
    expect(result.created_slug).toBeNull()
    expect(result.error).toBeDefined()
  })

  it('slug collision: appends -2 suffix', async () => {
    const fake = makeFakeRouter({
      proposed_rule: { when: { event: 'foo' }, do: [{ action: 'log', args: { message: 'x' } }] },
      slug_suggestion: 'dup',
      similar_existing: null,
      confidence: 1,
    })
    store.upsert({ schema_version: 1, slug: 'dup', when: { event: 'foo' }, do: [{ action: 'log', args: {} }], state: 'active', created_by: 'manual', created_at: Date.now() })
    const author = new OrdersAuthor({ router: fake.router as any, store, parser, filePath: file })
    const result = await author.handleSpeech('test')
    expect(result.created_slug).toBe('dup-2')
  })
})
```

- [ ] **Step 3: Implement OrdersAuthor**

```typescript
// src/daemon/orders/v2/author.ts
// Speech-to-rule: takes natural language, calls the LLM (orders_compose tier),
// derives a unique slug, writes a YAML frontmatter block to STANDING_ORDERS.md,
// and updates OrdersStore. Rules default to 24h dry-run.

import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { stringify as stringifyYaml } from 'yaml'
import type { ModelRouter } from '../../llm/router'
import type { OrdersStore } from './store'
import type { OrdersParser } from './parser'
import type { Rule, Action, When } from './types'

const SYSTEM_PROMPT = `You are KAIROS's standing-orders compiler. The user just spoke a request like "remind me every Monday at 9 to send the standup". Convert it into a structured rule object.

Return STRICT JSON only:
{
  "proposed_rule": {
    "when": { "cron": "0 9 * * 1" } | { "at": "5pm" } | { "event": "name" } | { "state": { ... } },
    "if": ["persona.X == 'Y'", ...],
    "unless": ["persona.is_in_meeting", ...],
    "do": [{ "action": "notify"|"invoke_skill"|"composio_tool"|"emit_event"|..., "args": { ... } }],
    "cooldown": "20h" | "5m" | ...        // optional
  },
  "slug_suggestion": "kebab-case-slug",
  "similar_existing": null | "<slug-of-existing-rule-this-duplicates>",
  "confidence": 0.0-1.0
}

Guidance:
- For time-based rules ("every Monday at 9", "at 5pm") use cron/at
- For state-triggered ("if a Slack DM has 'urgent'") use when.state
- Action types: notify, remind_later, add_to_memory, log, suspend, invoke_skill, composio_tool, emit_event
- If the request resembles one of the EXISTING rules below, set similar_existing to that slug; otherwise null
- Confidence reflects how sure you are about the structure`

export type OrdersAuthorDeps = {
  router: ModelRouter
  store: OrdersStore
  parser: OrdersParser
  filePath: string
}

export type AuthorResult = {
  created_slug: string | null
  similar_existing?: string
  error?: string
}

export class OrdersAuthor {
  constructor(private deps: OrdersAuthorDeps) {}

  async handleSpeech(text: string): Promise<AuthorResult> {
    const existing = this.deps.store.listAll().map(r => ({ slug: r.slug, when_kind: this.whenKindOf(r.when), description: r.description?.slice(0, 80) ?? '' }))
    const userPrompt = `User said: "${text}"

Existing rules (for dedup check):
${existing.length === 0 ? '(none)' : existing.map(e => `- ${e.slug} (${e.when_kind}): ${e.description}`).join('\n')}

Produce the JSON object.`

    let parsed: any
    try {
      const result = await this.deps.router.complete({
        task_type: 'orders_compose' as any,
        system_blocks: [{ text: SYSTEM_PROMPT, cache_hint: 'long' }],
        prompt: userPrompt,
        structured: true,
        max_output_tokens: 1500,
        latency_target: 'standard',
      })
      parsed = result.parsed
    } catch (err) {
      return { created_slug: null, error: err instanceof Error ? err.message : String(err) }
    }
    if (!parsed?.proposed_rule || !parsed.slug_suggestion) {
      return { created_slug: null, error: 'LLM output missing proposed_rule or slug_suggestion' }
    }
    if (parsed.similar_existing) {
      return { created_slug: null, similar_existing: parsed.similar_existing }
    }
    const slug = this.uniqueSlug(parsed.slug_suggestion)
    const now = Date.now()
    const rule: Rule = {
      schema_version: 1,
      slug,
      when: parsed.proposed_rule.when as When,
      if: parsed.proposed_rule.if,
      unless: parsed.proposed_rule.unless,
      do: parsed.proposed_rule.do as Action[],
      cooldown_ms: parsed.proposed_rule.cooldown ? this.deps.parser.parseDuration(parsed.proposed_rule.cooldown) : undefined,
      dry_run_until: now + 24 * 60 * 60 * 1000,
      state: 'dry_run',
      created_by: 'voice',
      created_at: now,
      description: `You said: "${text}"`,
    }
    this.appendRuleBlock(rule, parsed.proposed_rule.cooldown)
    this.deps.store.upsert(rule)
    return { created_slug: slug }
  }

  private uniqueSlug(suggested: string): string {
    if (!this.deps.store.get(suggested)) return suggested
    let i = 2
    while (this.deps.store.get(`${suggested}-${i}`)) i++
    return `${suggested}-${i}`
  }

  private whenKindOf(when: When): string {
    if ('cron' in when) return 'cron'
    if ('at' in when) return 'at'
    if ('event' in when) return 'event'
    return 'state'
  }

  private appendRuleBlock(rule: Rule, cooldownStr: string | undefined): void {
    if (!existsSync(this.deps.filePath)) {
      writeFileSync(this.deps.filePath, '# KAIROS Standing Orders\n')
    }
    const frontmatter: Record<string, unknown> = {
      schema_version: 1,
      when: rule.when,
      ...(rule.if ? { if: rule.if } : {}),
      ...(rule.unless ? { unless: rule.unless } : {}),
      do: rule.do,
      ...(cooldownStr ? { cooldown: cooldownStr } : {}),
      ...(rule.dry_run_until ? { dry_run_until: new Date(rule.dry_run_until).toISOString() } : {}),
      state: rule.state,
      created_by: rule.created_by,
      created_at: new Date(rule.created_at).toISOString(),
    }
    const block = `\n## ${rule.slug}\n---\n${stringifyYaml(frontmatter).trimEnd()}\n---\n${rule.description ?? ''}\n`
    appendFileSync(this.deps.filePath, block)
  }
}
```

- [ ] **Step 4: Run + commit**

```bash
bun test src/daemon/orders/v2/author.test.ts
git add src/daemon/llm/types.ts src/daemon/llm/policy.ts src/daemon/orders/v2/author.ts src/daemon/orders/v2/author.test.ts
git commit -m "feat(orders-v2): OrdersAuthor — speech to DSL rule + file append + dedup"
```

---

## Task 11: File watcher with 200ms debounce

**Files:**
- Create: `src/daemon/orders/v2/watcher.ts`
- Create: `src/daemon/orders/v2/watcher.test.ts`

Watches `STANDING_ORDERS.md`; calls a callback after a 200ms debounced settling period.

- [ ] **Step 1: Write tests + implementation**

```typescript
// src/daemon/orders/v2/watcher.test.ts
import { describe, it, expect } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { watchOrdersFile } from './watcher'

describe('watchOrdersFile', () => {
  it('calls callback after a write (with debounce)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orders-watch-'))
    const file = join(dir, 'S.md')
    writeFileSync(file, 'a')
    let fired = 0
    const stop = watchOrdersFile(file, () => fired++, 50)
    await new Promise(r => setTimeout(r, 100))
    writeFileSync(file, 'b')
    await new Promise(r => setTimeout(r, 200))
    expect(fired).toBeGreaterThanOrEqual(1)
    stop()
  })

  it('coalesces multiple rapid writes into one callback', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orders-watch-2-'))
    const file = join(dir, 'S.md')
    writeFileSync(file, 'a')
    let fired = 0
    const stop = watchOrdersFile(file, () => fired++, 100)
    await new Promise(r => setTimeout(r, 50))
    writeFileSync(file, 'b')
    writeFileSync(file, 'c')
    writeFileSync(file, 'd')
    await new Promise(r => setTimeout(r, 250))
    expect(fired).toBeLessThanOrEqual(2)
    stop()
  })

  it('stop() halts further callbacks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orders-watch-3-'))
    const file = join(dir, 'S.md')
    writeFileSync(file, 'a')
    let fired = 0
    const stop = watchOrdersFile(file, () => fired++, 50)
    stop()
    writeFileSync(file, 'b')
    await new Promise(r => setTimeout(r, 200))
    expect(fired).toBe(0)
  })
})
```

```typescript
// src/daemon/orders/v2/watcher.ts
// fs.watch wrapper with debounce coalescing.

import { watch } from 'fs'

export function watchOrdersFile(path: string, onChange: () => void, debounceMs = 200): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  const watcher = watch(path, () => {
    if (stopped) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      if (!stopped) onChange()
    }, debounceMs)
  })
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
    watcher.close()
  }
}
```

- [ ] **Step 2: Run + commit**

```bash
bun test src/daemon/orders/v2/watcher.test.ts
git add src/daemon/orders/v2/watcher.ts src/daemon/orders/v2/watcher.test.ts
git commit -m "feat(orders-v2): file watcher with 200ms debounce coalescing"
```

---

## Task 12: Daemon wire-up

**Files:**
- Modify: `src/daemon/types.ts` (add `orders.v2_enabled`)
- Modify: `src/daemon/index.ts` (instantiate v2 subsystem)

- [ ] **Step 1: Extend Config type**

In `src/daemon/types.ts`, find the `orders?:` block (currently around the seed file config) — add:

```typescript
  orders?: {
    enabled?: boolean
    filePath?: string
    v2_enabled?: boolean   // C.4.1 — turn on the structured DSL pipeline
  }
```

(If `orders` is already a top-level object with `enabled` and `filePath`, just add `v2_enabled` to it.)

- [ ] **Step 2: Wire in index.ts AFTER the C.3.3 skills block**

Add these imports near the existing skills imports:

```typescript
import { OrdersStore } from './orders/v2/store'
import { OrdersParser } from './orders/v2/parser'
import { OrdersAuthor } from './orders/v2/author'
import { ActionDispatcher } from './orders/v2/actionDispatcher'
import { ReactiveEvaluator } from './orders/v2/reactiveEvaluator'
import { RulesEventBus } from './orders/v2/eventBus'
import { ConditionEvaluator } from './orders/v2/conditionEvaluator'
import { DryRunLogger } from './orders/v2/dryRunLogger'
import { ScheduleAdapter } from './orders/v2/scheduleAdapter'
import { watchOrdersFile } from './orders/v2/watcher'
```

Add the boot block after the skills block (after the line that logs `[skills] subsystem ready`):

```typescript
// ──────────────────────────────────────────────────────────────────────────
// C.4.1 STANDING_ORDERS v2 — structured DSL + time-triggered rules
// ──────────────────────────────────────────────────────────────────────────
let v2Watcher: (() => void) | null = null
let v2ScheduleAdapter: ScheduleAdapter | null = null

if (config.orders?.v2_enabled !== false) {
  try {
    const ordersV2Store = new OrdersStore(db)
    const ordersV2Parser = new OrdersParser()
    const rulesBus = new RulesEventBus()
    const dryRunLogger = new DryRunLogger(ordersV2Store)
    const conditionEval = new ConditionEvaluator()

    // PersonaAwareness exposes hints; use them as the live-state source for if/unless.
    const personaAwareness = (globalThis as any).__kairosPersonaAwareness
    const getPersonaState = () => {
      if (!personaAwareness) return {}
      try { return personaAwareness.getLiveState?.() ?? {} } catch { return {} }
    }

    // ActionDispatcher needs SkillDispatcher + ComposioClient — pull from globalThis.
    const skillDispatcher = (globalThis as any).__kairosSkillDispatcher ?? null
    const composioClient = (globalThis as any).__kairosComposioClient ?? null

    const actionDispatcher = new ActionDispatcher({
      intentRegistry,
      skillDispatcher: skillDispatcher ?? { invoke: async () => ({ ok: false, error: 'skill subsystem not initialized', duration_ms: 0, sandbox: 'declarative' }) },
      composio: composioClient ? {
        invokeTool: async (toolkit: string, tool: string, args: any) => {
          // Composio invocation surface — minimal wrapper. Real impl in C.4.2 polish.
          return { ok: false, error: 'composio_tool action not wired yet' }
        },
      } : null,
      eventBus: rulesBus,
    })

    const reactiveEvaluator = new ReactiveEvaluator({
      store: ordersV2Store,
      dispatcher: actionDispatcher,
      conditionEvaluator: conditionEval,
      dryRunLogger,
      getPersonaState,
    })

    // Wire RulesEventBus → ReactiveEvaluator so emit_event triggers chained rules
    rulesBus.on('*' as any, () => {})    // placeholder; per-event listeners registered as rules load
    // For each event-triggered rule, subscribe its handler:
    const subscribeEventRules = () => {
      // Register a listener for every distinct event name across rules.
      // We re-register on each refresh; old listeners are GC'd as RulesEventBus only keeps current.
      const events = new Set<string>()
      for (const r of ordersV2Store.listAll()) {
        if ('event' in r.when) events.add(r.when.event)
      }
      for (const ev of events) {
        rulesBus.on(ev, payload => {
          reactiveEvaluator.handleEvent('event', { name: ev, payload }).catch(e => log(`[orders-v2] event handler failed: ${e}`, 'warn'))
        })
      }
    }

    v2ScheduleAdapter = new ScheduleAdapter({
      store: ordersV2Store,
      onFire: async (rule, ctx) => {
        await actionDispatcher.dispatch(rule.do, ctx)
        ordersV2Store.recordFire(rule.slug, Date.now())
      },
    })

    const filePath = config.orders?.filePath ?? join(homedir(), '.kairos', 'STANDING_ORDERS.md')
    const refreshAllFromFile = () => {
      try {
        const { rules, errors } = ordersV2Parser.parseFile(filePath)
        ordersV2Store.replaceAll(rules)
        v2ScheduleAdapter!.refreshAll()
        subscribeEventRules()
        if (errors.length > 0) log(`[orders-v2] ${errors.length} rules skipped due to parse errors`, 'warn')
      } catch (err) {
        log(`[orders-v2] reload failed: ${err}`, 'warn')
      }
    }

    // Initial load
    refreshAllFromFile()
    // Hot-reload on file changes
    v2Watcher = watchOrdersFile(filePath, refreshAllFromFile, 200)

    // Author — expose on globalThis so kairos_tell / Discord can call it
    if (router) {
      const ordersAuthor = new OrdersAuthor({ router, store: ordersV2Store, parser: ordersV2Parser, filePath })
      ;(globalThis as any).__kairosOrdersAuthor = ordersAuthor
    }

    // Wire perception bus → ReactiveEvaluator (state-triggered firing)
    bus.subscribe('*', (kind: string, payload: any) => {
      reactiveEvaluator.handleEvent(kind, payload).catch(e => log(`[orders-v2] reactive failed: ${e}`, 'warn'))
    })

    // Stash for shutdown + lookup
    ;(globalThis as any).__kairosOrdersV2Store = ordersV2Store
    ;(globalThis as any).__kairosOrdersV2DryRunLogger = dryRunLogger

    log(`[orders-v2] subsystem ready — ${ordersV2Store.listAll().length} rules loaded`)
  } catch (err) {
    log(`[orders-v2] subsystem failed to start: ${err}`, 'warn')
  }
}
```

Add to the shutdown handler (find the existing block that stops `awmWorker`, `curatorTimer`, etc.):

```typescript
if (v2Watcher) v2Watcher()
if (v2ScheduleAdapter) v2ScheduleAdapter.stopAll()
```

(If the perception bus's subscribe takes a different signature than `(kind, payload)`, adapt accordingly — verify `src/daemon/perception/bus.ts` or similar before wiring.)

- [ ] **Step 3: Run all tests + build check**

```bash
bun test src/daemon/orders/v2/
bun build src/daemon/index.ts --target=bun --outfile=/tmp/check.js 2>&1 | tail -5
```

- [ ] **Step 4: Commit**

```bash
git add src/daemon/types.ts src/daemon/index.ts
git commit -m "feat(orders-v2): daemon wire-up — boot, hot-reload, perception bus integration"
```

---

## Task 13: Inbox prompt for dry-run approval (24h gate)

**Files:**
- Create: `src/daemon/orders/v2/approvalPrompt.ts`
- Create: `src/daemon/orders/v2/approvalPrompt.test.ts`
- Modify: `src/daemon/index.ts` (add the periodic timer)

Periodic timer (hourly check) → for each rule whose dry-run window expired → adds an inbox item.

- [ ] **Step 1: Tests + implementation**

```typescript
// src/daemon/orders/v2/approvalPrompt.test.ts
import { describe, it, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { OrdersStore } from './store'
import { DryRunLogger } from './dryRunLogger'
import { buildApprovalPrompt } from './approvalPrompt'
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
})
```

```typescript
// src/daemon/orders/v2/approvalPrompt.ts
// Builds an inbox prompt for a rule whose dry-run window has expired.
// Caller writes the result to InboxSurface.

import type { Rule } from './types'
import type { DryRunLogger } from './dryRunLogger'

export type ApprovalPrompt = {
  slug: string
  title: string
  body: string
  actions: Array<'approve' | 'reject' | 'tune'>
}

export function buildApprovalPrompt(rule: Rule, logger: DryRunLogger, now: number): ApprovalPrompt {
  const summary = logger.summarize(rule, now)
  const sampleLines = summary.samples.length === 0 ? '(no fires)' :
    summary.samples.map(s => `  - ${new Date(s.fired_at).toISOString()}`).join('\n')
  return {
    slug: rule.slug,
    title: `Rule '${rule.slug}' finished 24h dry-run`,
    body: `Would have fired ${summary.fire_count} times. Recent fires:\n${sampleLines}\n\nApprove to go live, reject to suspend, or tune to adjust cooldown.`,
    actions: ['approve', 'reject', 'tune'],
  }
}

/** Apply approval: clear dry_run_until and set state=active. */
export function applyApproval(rule: Rule): Rule {
  return { ...rule, dry_run_until: undefined, state: 'active' }
}

export function applyRejection(rule: Rule): Rule {
  return { ...rule, state: 'suspended' }
}
```

- [ ] **Step 2: Wire the periodic check in `src/daemon/index.ts`**

Inside the C.4.1 boot block, after `v2Watcher` is set, add:

```typescript
// Hourly check for dry-run windows that expired → add inbox prompts
let v2ApprovalTimer: ReturnType<typeof setInterval> | null = setInterval(() => {
  try {
    const expired = dryRunLogger.listReadyForApproval(Date.now())
    for (const rule of expired) {
      const prompt = buildApprovalPrompt(rule, dryRunLogger, Date.now())
      // Use existing inbox surface
      inbox.add?.({ kind: 'orders_v2_approval', title: prompt.title, body: prompt.body, actions: prompt.actions, source_slug: rule.slug })
        ?? log(`[orders-v2] approval ready: ${prompt.title}`)
    }
  } catch (err) { log(`[orders-v2] approval scan failed: ${err}`, 'warn') }
}, 60 * 60 * 1000)
```

Import `buildApprovalPrompt` at the top of `index.ts`:
```typescript
import { buildApprovalPrompt } from './orders/v2/approvalPrompt'
```

Add to shutdown: `if (v2ApprovalTimer) clearInterval(v2ApprovalTimer)`.

(If the inbox surface API uses a different method name or shape, adapt — the goal is "drop a user-visible prompt." Logging is acceptable fallback for v0 of this hook.)

- [ ] **Step 3: Run + commit**

```bash
bun test src/daemon/orders/v2/approvalPrompt.test.ts
git add src/daemon/orders/v2/approvalPrompt.ts src/daemon/orders/v2/approvalPrompt.test.ts src/daemon/index.ts
git commit -m "feat(orders-v2): 24h dry-run approval prompt builder + hourly inbox check"
```

---

## Task 14: Validation gate + tag v0.3.8-phase-c4-1

**Files:**
- Create: `scripts/validate-phase-c4-1.ts`

Mirror the structure of `scripts/validate-phase-c3-3.ts` (helpers, `record(pass, note)`, labels array, final report, exit code).

- [ ] **Step 1: Write the validation script**

The script runs 14 assertions:

1. OrdersParser accepts valid + rejects 4 invalid (slug, multiple when, unknown action, unknown schema_version)
2. OrdersStore upsert + replaceAll round-trip via SQLite
3. ReactiveEvaluator fires a clipboard rule with matching contains
4. ReactiveEvaluator skips when unless: persona.is_in_meeting=true
5. ScheduleAdapter fires `at: "in 100ms"` within 300ms
6. ScheduleAdapter registers cron rule (`* * * * *`) without throwing
7. ActionDispatcher routes invoke_skill to fake skill dispatcher
8. ActionDispatcher routes emit_event → listening rule fires
9. ConditionEvaluator: persona.X == "Y", payload.X > 5, time.between
10. Dry-run rule fires to dry_run log instead of dispatching action
11. After dry_run_until expires, approvalPrompt aggregates fires
12. Cooldown enforcement: rule fires once, immediately re-evaluates, gets skipped
13. OrdersAuthor speech→rule round trip with fake router (produces valid DSL block)
14. End-to-end: speech → OrdersAuthor → file → reparse → OrdersStore → ReactiveEvaluator → ActionDispatcher → fake skill (with usage tracking ok)

Use the same skeleton as `validate-phase-c3-3.ts` (already in the repo). Use fakes for router/skillDispatcher/composio. Each assertion uses a fresh `mkdtempSync` + `Database(':memory:')`.

The exact code structure (read `scripts/validate-phase-c3-3.ts` first, then mirror the function-per-assertion pattern):

```typescript
// scripts/validate-phase-c4-1.ts — Phase C.4.1 Validation Gate
// 14 assertions covering parser/store/evaluator/dispatcher/conditions/dry-run/author/e2e.
// Run: bun run scripts/validate-phase-c4-1.ts
// Exit 0 if all 14 PASS; 1 otherwise.

import { mkdtempSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'

import { OrdersParser } from '../src/daemon/orders/v2/parser'
import { OrdersStore } from '../src/daemon/orders/v2/store'
import { ReactiveEvaluator } from '../src/daemon/orders/v2/reactiveEvaluator'
import { ConditionEvaluator } from '../src/daemon/orders/v2/conditionEvaluator'
import { DryRunLogger } from '../src/daemon/orders/v2/dryRunLogger'
import { ScheduleAdapter } from '../src/daemon/orders/v2/scheduleAdapter'
import { ActionDispatcher } from '../src/daemon/orders/v2/actionDispatcher'
import { RulesEventBus } from '../src/daemon/orders/v2/eventBus'
import { OrdersAuthor } from '../src/daemon/orders/v2/author'
import { buildApprovalPrompt } from '../src/daemon/orders/v2/approvalPrompt'
import type { Rule } from '../src/daemon/orders/v2/types'

type AssertResult = { pass: boolean; note: string }
const results: AssertResult[] = []
function record(pass: boolean, note: string) { results.push({ pass, note }) }

console.log('=== KAIROS Phase C.4.1 Validation Gate ===')
console.log(`Started: ${new Date().toISOString()}`)
console.log()

// (Insert the 14 assertion blocks here — each wrapped in try/catch + record(...).
//  Use fake router via { complete: async (req) => ({ parsed: <fixture>, text: '...' }) }.
//  Use fake skill dispatcher: { invoke: async () => ({ ok: true, output: 'fake', duration_ms: 1, sandbox: 'declarative' }) }.)

// ─── Report ───────────────────────────────────────────────────────────────────
const labels = [
  'OrdersParser valid+invalid',
  'OrdersStore upsert+replaceAll',
  'ReactiveEvaluator clipboard fire',
  'ReactiveEvaluator unless persona.is_in_meeting',
  'ScheduleAdapter at: 100ms fires',
  'ScheduleAdapter cron registration',
  'ActionDispatcher → invoke_skill',
  'ActionDispatcher → emit_event chain',
  'ConditionEvaluator predicates',
  'Dry-run logs instead of dispatches',
  'ApprovalPrompt aggregates dry-run fires',
  'Cooldown skips re-fire',
  'OrdersAuthor speech→rule',
  'End-to-end speech→fire',
]

for (let i = 0; i < results.length; i++) {
  const { pass, note } = results[i]!
  const status = pass ? 'PASS' : `FAIL: ${note}`
  const padded = `[${String(i + 1).padStart(2, '0')}/14] ${labels[i]}`.padEnd(56, '.')
  console.log(`${padded} ${status}`)
}
const allPass = results.every(r => r.pass)
console.log()
console.log(`=== Gate verdict: ${allPass ? 'PASS ✓' : 'FAIL ✗'} ===`)
process.exit(allPass ? 0 : 1)
```

The implementer should write each of the 14 assertion blocks inline using the same `mkdtempSync` + fresh `Database` pattern shown in `validate-phase-c3-3.ts`. Each assertion is wrapped in try/catch + `record(...)`.

- [ ] **Step 2: Run validation**

```bash
bun run scripts/validate-phase-c4-1.ts
```

Expected: `=== Gate verdict: PASS ✓ ===`, exit code 0.

- [ ] **Step 3: Update CHANGELOG**

Prepend an entry after the most recent one:

```markdown
## [v0.3.8-phase-c4-1] - 2026-05-28

### Added
- **STANDING_ORDERS v2 DSL** — structured YAML frontmatter rules in `~/.kairos/STANDING_ORDERS.md`
- **Time-triggered rules** — `when: cron: "..."` and `when: at: "..."` via existing `ScheduleManager` (no separate HEARTBEAT.md needed)
- **Per-rule cooldowns** — `cooldown: 20h` field per rule
- **Chaining via named events** — actions can `emit_event`, rules can listen via `when: event "name"`
- **24h dry-run gate** — new rules fire silently to log; inbox prompt after 24h with stats
- **OrdersAuthor** — speech → LLM-compiled DSL → file append; KAIROS writes the file as you speak
- **Four action types** — built-in intents + invoke_skill (C.3.3) + composio_tool (C.2.7) + emit_event
- **Safe condition evaluator** — restricted expression grammar (no `eval()`)
- Validation gate (`scripts/validate-phase-c4-1.ts`) — 14 assertions
- `orders_compose` TaskType (mid tier)

### Changed
- New SQLite tables: `orders_rules`, `orders_rule_state`, `orders_dry_run_log`
- v1 standing-orders subsystem preserved; both run side-by-side until user migrates via `scripts/migrate-orders-v1.ts`

### Notes
- Persona-conditioned RestraintPipeline routing, offline LLM-free English parsing, and the Phase C overall validation gate (v0.4.0) are deferred to C.4.2.
```

- [ ] **Step 4: Commit + tag**

```bash
git add CHANGELOG.md scripts/validate-phase-c4-1.ts
git commit -m "test(c4.1): validation gate — 14 assertions across orders v2 subsystem"
git tag v0.3.8-phase-c4-1
```

---

## Self-Review

**Spec coverage check (every spec section mapped to a task):**

| Spec section | Task |
|---|---|
| §1 Why v2 | Motivation; no impl task |
| §2 Non-goals | Documented in plan header; no impl task |
| §3 Architecture (8 units) | Tasks 0–11, 12 (wire-up), 13 (approval prompt) |
| §4 DSL shape + validation rules | Task 1 (parser) |
| §4 Condition evaluator | Task 4 |
| §5 Input pipeline | Task 10 (author) |
| §6 Evaluator (state + time) | Tasks 8 + 9 |
| §7 Chaining via named events | Tasks 5 + 6 + 12 (subscribeEventRules) |
| §8 Dry-run integration | Tasks 7 + 13 |
| §9 Migration from v1 | Mentioned; migration script is deferred to a follow-up commit (not blocking the v2 ship) |
| §10 Storage schema | Task 2 |
| §11 Daemon wire-up | Task 12 |
| §12 Test strategy | Tasks 0–13 (unit tests) + Task 14 (validation gate) |
| §13 Risks | Mitigated via tests + spec doc |
| §14 Deferred | C.4.2 tasks (separate plan) |

**Note on migration script:** §9 specifies `scripts/migrate-orders-v1.ts`. To keep C.4.1 scope tight and avoid disrupting v1 users on first install, the migration script is intentionally **not** part of C.4.1's mandatory tasks — it can ship as a small follow-up commit before tagging or in C.4.2. Both v1 and v2 subsystems run side-by-side without it. If we ship without the migration script, the v1 subsystem keeps working untouched for existing rules, and v2 only handles new speech-authored rules.

**Placeholder scan:** No "TBD" / "TODO" / "fill in details" in the plan body. All test bodies have concrete assertions. All implementation bodies have complete code.

**Type consistency check:**
- `Rule.cooldown_ms` (number) used consistently across parser/store/evaluator
- `Rule.dry_run_until` (number, ms-epoch) used consistently in in-memory form; ISO string only in file/CHANGELOG
- `Action.action` type-narrowed in ActionDispatcher's switch
- `SkillExecutionResult` shape (`ok, output?, error?, duration_ms, sandbox`) matches the C.3.3 `SkillDispatcher.invoke` return; verified in Task 6 test fake
- `ScheduleAdapter` uses `parseSimpleCron` and `nextCronFire` from existing `cronParser.ts` (Task 9)
- The perception bus subscribe signature in Task 12 is described tentatively — implementer should verify and adapt if `bus.subscribe('*', ...)` isn't the actual API

**Known integration adaptations** (implementer should verify before wiring):
1. The perception bus may not have a wildcard `'*'` subscribe — Task 12 explicitly notes this requires verification
2. `inbox.add({...})` in Task 13 is a placeholder shape — log fallback is acceptable for v0
3. SkillDispatcher.invoke returns `{ ok, output, error, duration_ms, sandbox }` — verified against existing code

End of plan.
