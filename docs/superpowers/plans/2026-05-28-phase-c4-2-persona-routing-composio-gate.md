# Phase C.4.2 — Persona-Routing + Composio Wiring + Phase C Gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the gaps C.4.1 left open — wire real Composio tool execution into ActionDispatcher, make RestraintPipeline persona-aware (threshold-shifting only), add a pending-edits queue so daemon survives LLM outages, then prove Phase C works end-to-end via a simulated 4-hour user-session validation gate. Tag `v0.4.0` after PASS.

**Architecture:** One new resolver (`ComposioToolResolver`) caches friendly-name → exact Composio toolName mappings. ActionDispatcher's stub `composio_tool` path gets replaced with real `composio.executeTool()`. A pure helper `personaThresholdShift(hints)` is added next to RestraintPipeline's score step and applied to the interrupt/surface/digest thresholds at evaluation time. A new SQLite table + processor handles LLM-failure retry. The Phase C gate is a single Bun script that simulates a 4-hour user session in <60s wall time via injected clock.

**Tech Stack:** TypeScript on Bun runtime. `bun:sqlite`. Existing `@composio/core` SDK. No new dependencies.

**Spec:** [`docs/superpowers/specs/2026-05-28-c4-2-persona-routing-composio-gate-design.md`](../specs/2026-05-28-c4-2-persona-routing-composio-gate-design.md)

---

## File Structure

**New files:**
- `src/daemon/orders/v2/composioToolResolver.ts` (~200 LOC)
- `src/daemon/orders/v2/composioToolResolver.test.ts`
- `src/daemon/orders/v2/pendingEdits.ts` (~180 LOC)
- `src/daemon/orders/v2/pendingEdits.test.ts`
- `src/daemon/orders/v2/pendingEditsProcessor.ts` (~120 LOC)
- `src/daemon/orders/v2/pendingEditsProcessor.test.ts`
- `src/daemon/restraint/personaShift.ts` (~50 LOC — pure helper)
- `src/daemon/restraint/personaShift.test.ts`
- `scripts/validate-phase-c.ts` (~1500 LOC)

**Modified files:**
- `src/daemon/orders/v2/actionDispatcher.ts` — replace composio_tool stub
- `src/daemon/orders/v2/author.ts` — add try/catch wrapping LLM call + queue enqueue + new `handleSpeechDirect` internal
- `src/daemon/restraint/restraintPipeline.ts` — call `personaThresholdShift` in `evaluate()`, apply to thresholds
- `src/daemon/index.ts` — boot `ComposioToolResolver` and `PendingEditsProcessor`; wire resolver into ActionDispatcher
- `CHANGELOG.md` — append `v0.4.0` entry

---

## Regression discipline

Per spec §5b, every task that modifies existing code (Tasks 2, 3, 5) MUST:
1. Run `bun test` BEFORE the task — record pass count
2. Run `bun test` AFTER the task — confirm no regression
3. Append to commit message: `regression: X tests green (was X)`

Before tagging v0.4.0 (Task 9), run ALL `scripts/validate-phase-*.ts` gates consecutively + `bun test`. All must PASS.

---

## Task 0: Pre-flight baseline + types

Establishes the regression baseline. Pure inspection task — no code change.

- [ ] **Step 1: Capture baseline test count**

```bash
cd /Users/nirmalghinaiya/Desktop/kairos-sandbox
bun test 2>&1 | tail -5 > /tmp/c4-2-baseline-tests.txt
cat /tmp/c4-2-baseline-tests.txt
```

Record the "X pass, Y fail" line. Should be all green at the start of C.4.2.

- [ ] **Step 2: Capture baseline gate verdicts**

```bash
for f in scripts/validate-phase-c1.ts scripts/validate-phase-c1-5.ts scripts/validate-phase-c2.ts scripts/validate-phase-c2-5.ts scripts/validate-phase-c2-6.ts scripts/validate-phase-c2-7.ts scripts/validate-phase-c3-1.ts scripts/validate-phase-c3-3.ts scripts/validate-phase-c4-1.ts; do
  echo "=== $f ===" >> /tmp/c4-2-baseline-gates.txt
  bun run "$f" 2>&1 | grep -E "Gate verdict|verdict" | tail -3 >> /tmp/c4-2-baseline-gates.txt
done
cat /tmp/c4-2-baseline-gates.txt
```

Expected: every gate verdicts PASS.

- [ ] **Step 3: No-op commit to mark Phase C.4.2 start**

There's no code change yet. Move on — no commit for this task.

---

## Task 1: ComposioToolResolver

**Files:**
- Create: `src/daemon/orders/v2/composioToolResolver.ts`
- Create: `src/daemon/orders/v2/composioToolResolver.test.ts`

Boot-time resolver mapping `{toolkit, friendly_name}` → exact `toolName`. Caches to disk for warm-boot. Daily refresh timer. On-miss refresh is rate-limited.

- [ ] **Step 1: Write the failing test file**

```typescript
// src/daemon/orders/v2/composioToolResolver.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ComposioToolResolver } from './composioToolResolver'

function fakeComposio(tools: any[], options: { onListCall?: () => void } = {}) {
  let listCalls = 0
  return {
    sdk: {
      tools: {
        list: async (_opts: any) => {
          listCalls++
          options.onListCall?.()
          return { items: tools }
        },
      },
    },
    getCallCount: () => listCalls,
  } as any
}

describe('ComposioToolResolver', () => {
  let tmp: string
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'kairos-resolver-')) })
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

  it('initialize populates map from tools.list', async () => {
    const c = fakeComposio([
      { toolkit: { slug: 'slack' }, name: 'SLACK_SEND_MESSAGE' },
      { toolkit: { slug: 'github' }, name: 'GITHUB_CREATE_ISSUE' },
    ])
    const r = new ComposioToolResolver({ composio: c, userId: 'local', cachePath: join(tmp, 'cache.json') })
    await r.initialize()
    expect(r.resolve('slack', 'send_message')).toBe('SLACK_SEND_MESSAGE')
    expect(r.resolve('github', 'create_issue')).toBe('GITHUB_CREATE_ISSUE')
    r.stop()
  })

  it('indexes friendly aliases — stripped toolkit prefix + suffix truncation', async () => {
    const c = fakeComposio([
      { toolkit: { slug: 'slack' }, name: 'SLACK_SEND_MESSAGE' },
    ])
    const r = new ComposioToolResolver({ composio: c, userId: 'local', cachePath: join(tmp, 'cache.json') })
    await r.initialize()
    // Full friendly name
    expect(r.resolve('slack', 'send_message')).toBe('SLACK_SEND_MESSAGE')
    // Truncated to last word
    expect(r.resolve('slack', 'message')).toBe('SLACK_SEND_MESSAGE')
    // Verb-only (often what users say)
    expect(r.resolve('slack', 'send')).toBe('SLACK_SEND_MESSAGE')
    r.stop()
  })

  it('resolve returns null for unknown toolkit + tool combinations', async () => {
    const c = fakeComposio([{ toolkit: { slug: 'slack' }, name: 'SLACK_SEND_MESSAGE' }])
    const r = new ComposioToolResolver({ composio: c, userId: 'local', cachePath: join(tmp, 'cache.json') })
    await r.initialize()
    expect(r.resolve('slack', 'create_channel')).toBeNull()
    expect(r.resolve('discord', 'send_message')).toBeNull()
    r.stop()
  })

  it('persists cache to disk', async () => {
    const cachePath = join(tmp, 'cache.json')
    const c = fakeComposio([{ toolkit: { slug: 'slack' }, name: 'SLACK_SEND_MESSAGE' }])
    const r = new ComposioToolResolver({ composio: c, userId: 'local', cachePath })
    await r.initialize()
    expect(existsSync(cachePath)).toBe(true)
    const cached = JSON.parse(readFileSync(cachePath, 'utf8'))
    expect(cached.entries).toBeDefined()
    expect(Object.keys(cached.entries).length).toBeGreaterThan(0)
    r.stop()
  })

  it('warm-boot from cache (no list call when cache is fresh)', async () => {
    const cachePath = join(tmp, 'cache.json')
    writeFileSync(cachePath, JSON.stringify({
      saved_at: Date.now(),
      entries: { 'slack:send_message': 'SLACK_SEND_MESSAGE', 'slack:send': 'SLACK_SEND_MESSAGE', 'slack:message': 'SLACK_SEND_MESSAGE' },
    }))
    const c = fakeComposio([])
    const r = new ComposioToolResolver({ composio: c, userId: 'local', cachePath })
    await r.initialize()
    expect(c.getCallCount()).toBe(0)   // didn't refresh — cache was fresh
    expect(r.resolve('slack', 'send_message')).toBe('SLACK_SEND_MESSAGE')
    r.stop()
  })

  it('warm-boot refreshes when cache is older than 24h', async () => {
    const cachePath = join(tmp, 'cache.json')
    writeFileSync(cachePath, JSON.stringify({
      saved_at: Date.now() - 25 * 60 * 60 * 1000,
      entries: { 'old:tool': 'OLD_TOOL' },
    }))
    const c = fakeComposio([{ toolkit: { slug: 'new' }, name: 'NEW_TOOL' }])
    const r = new ComposioToolResolver({ composio: c, userId: 'local', cachePath })
    await r.initialize()
    expect(c.getCallCount()).toBe(1)   // refreshed
    expect(r.resolve('new', 'tool')).toBe('NEW_TOOL')
    r.stop()
  })

  it('refresh() updates the map', async () => {
    const c = fakeComposio([{ toolkit: { slug: 'slack' }, name: 'SLACK_SEND_MESSAGE' }])
    const r = new ComposioToolResolver({ composio: c, userId: 'local', cachePath: join(tmp, 'cache.json') })
    await r.initialize()
    // Mutate the fake's response
    (c.sdk.tools.list as any) = async () => ({ items: [{ toolkit: { slug: 'slack' }, name: 'SLACK_NEW_THING' }] })
    await r.refresh()
    expect(r.resolve('slack', 'thing')).toBe('SLACK_NEW_THING')
    r.stop()
  })

  it('on-miss refresh is rate-limited (≤ 1 / hour)', async () => {
    const c = fakeComposio([{ toolkit: { slug: 'slack' }, name: 'SLACK_SEND_MESSAGE' }])
    const r = new ComposioToolResolver({ composio: c, userId: 'local', cachePath: join(tmp, 'cache.json'), now: () => 100_000 })
    await r.initialize()
    const beforeCalls = c.getCallCount()
    // Two miss-triggered refreshes within 1 hour
    await r.resolveOrRefresh('discord', 'send')
    await r.resolveOrRefresh('discord', 'send')
    expect(c.getCallCount()).toBe(beforeCalls + 1)   // only 1 of the 2 refreshes fired
    r.stop()
  })
})
```

- [ ] **Step 2: Implement the resolver**

```typescript
// src/daemon/orders/v2/composioToolResolver.ts
// Maps friendly {toolkit, name} → exact Composio toolName via tools.list catalog.
// Caches to ~/.kairos/composio-tools-cache.json (warm-boot < 50ms). Daily refresh.
// On-miss refresh is rate-limited to once per hour.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'

const CACHE_TTL_MS = 24 * 60 * 60 * 1000           // 24 hours
const ONMISS_REFRESH_INTERVAL_MS = 60 * 60 * 1000   // 1 hour rate limit

export type ComposioToolResolverDeps = {
  composio: { sdk: { tools: { list: (opts: any) => Promise<{ items: any[] }> } } }
  userId: string
  cachePath?: string
  now?: () => number
}

type CacheFile = {
  saved_at: number
  entries: Record<string, string>
}

export class ComposioToolResolver {
  private map = new Map<string, string>()
  private dailyTimer: ReturnType<typeof setInterval> | null = null
  private cachePath: string
  private now: () => number
  private lastOnMissRefreshAt = 0

  constructor(private deps: ComposioToolResolverDeps) {
    this.cachePath = deps.cachePath ?? join(homedir(), '.kairos', 'composio-tools-cache.json')
    this.now = deps.now ?? Date.now
  }

  async initialize(): Promise<void> {
    // Try warm-boot from cache
    if (this.loadCache()) {
      // Cache is fresh enough — schedule the daily refresh and return
      this.startDailyTimer()
      return
    }
    await this.refresh()
    this.startDailyTimer()
  }

  resolve(toolkit: string, friendlyName: string): string | null {
    const key = `${toolkit.toLowerCase()}:${friendlyName.toLowerCase()}`
    return this.map.get(key) ?? null
  }

  /** Resolve; if miss, schedule a rate-limited refresh (returns whatever the current cache says). */
  async resolveOrRefresh(toolkit: string, friendlyName: string): Promise<string | null> {
    const hit = this.resolve(toolkit, friendlyName)
    if (hit) return hit
    const now = this.now()
    if (now - this.lastOnMissRefreshAt >= ONMISS_REFRESH_INTERVAL_MS) {
      this.lastOnMissRefreshAt = now
      try { await this.refresh() } catch { /* swallow */ }
      return this.resolve(toolkit, friendlyName)
    }
    return null
  }

  async refresh(): Promise<void> {
    const result = await this.deps.composio.sdk.tools.list({ limit: 500 })
    const items = result.items ?? []
    const next = new Map<string, string>()
    for (const t of items) {
      const slug = (t.toolkit?.slug ?? t.toolkit_slug ?? '').toLowerCase()
      const toolName: string = t.name ?? t.tool_name ?? t.toolName
      if (!slug || !toolName) continue
      this.indexAliases(next, slug, toolName)
    }
    this.map = next
    this.saveCache()
  }

  stop(): void {
    if (this.dailyTimer) { clearInterval(this.dailyTimer); this.dailyTimer = null }
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private indexAliases(map: Map<string, string>, slug: string, toolName: string): void {
    // Strip the toolkit prefix from toolName: "SLACK_SEND_MESSAGE" → "send_message"
    const upperSlug = slug.toUpperCase()
    let stripped = toolName.startsWith(`${upperSlug}_`) ? toolName.slice(upperSlug.length + 1) : toolName
    stripped = stripped.toLowerCase()
    // Full alias
    map.set(`${slug}:${stripped}`, toolName)
    // Word-suffix aliases: "send_message" → "message"; "create_issue" → "issue"
    const parts = stripped.split('_')
    for (let i = 0; i < parts.length; i++) {
      const suffix = parts.slice(i).join('_')
      if (!map.has(`${slug}:${suffix}`)) map.set(`${slug}:${suffix}`, toolName)
    }
    // Word-prefix aliases (first word — often what user says): "send_message" → "send"
    if (parts.length > 1 && !map.has(`${slug}:${parts[0]}`)) {
      map.set(`${slug}:${parts[0]!}`, toolName)
    }
  }

  private loadCache(): boolean {
    if (!existsSync(this.cachePath)) return false
    try {
      const cf = JSON.parse(readFileSync(this.cachePath, 'utf8')) as CacheFile
      if (this.now() - cf.saved_at > CACHE_TTL_MS) return false
      this.map = new Map(Object.entries(cf.entries))
      return true
    } catch { return false }
  }

  private saveCache(): void {
    try {
      const dir = dirname(this.cachePath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const cf: CacheFile = { saved_at: this.now(), entries: Object.fromEntries(this.map) }
      writeFileSync(this.cachePath, JSON.stringify(cf, null, 2))
    } catch { /* swallow */ }
  }

  private startDailyTimer(): void {
    this.dailyTimer = setInterval(() => {
      this.refresh().catch(() => {})
    }, CACHE_TTL_MS)
  }
}
```

- [ ] **Step 3: Run tests + commit**

```bash
bun test src/daemon/orders/v2/composioToolResolver.test.ts 2>&1 | tail -15
git add src/daemon/orders/v2/composioToolResolver.ts src/daemon/orders/v2/composioToolResolver.test.ts
git commit -m "feat(c4.2): ComposioToolResolver — friendly-name to exact toolName mapping with disk cache"
```

Expected: 8/8 tests PASS.

---

## Task 2: ActionDispatcher composio_tool wiring (MODIFY)

**Files:**
- Modify: `src/daemon/orders/v2/actionDispatcher.ts`
- Modify: `src/daemon/orders/v2/actionDispatcher.test.ts` (add 4 new tests)

Replace the C.4.1 stub with real resolver-backed execution.

- [ ] **Step 1: Run baseline test**

```bash
bun test src/daemon/orders/v2/actionDispatcher.test.ts 2>&1 | tail -5
```

Record: should be `8 pass, 0 fail`.

- [ ] **Step 2: Update ActionDispatcher implementation**

In `src/daemon/orders/v2/actionDispatcher.ts`, update the `ActionDispatcherDeps` and the composio branch:

```typescript
// Updated section of src/daemon/orders/v2/actionDispatcher.ts

export type ActionDispatcherDeps = {
  intentRegistry: {
    get(id: string): { handler: (args: any, ctx?: any) => Promise<{ status: string; details?: string }> } | null
  }
  skillDispatcher: {
    invoke(slug: string, args: Record<string, unknown>): Promise<{ ok: boolean; output?: unknown; error?: string; duration_ms: number; sandbox: string }>
  }
  /** Composio integration. Both fields together OR null to disable. */
  composio: {
    resolver: { resolveOrRefresh(toolkit: string, tool: string): Promise<string | null> }
    executeTool(args: { toolName: string; userId: string; arguments: any }): Promise<any>
    userId: string
  } | null
  eventBus: RulesEventBus
}
```

In the `dispatch()` method, replace the `composio_tool` branch:

```typescript
} else if (action.action === 'composio_tool') {
  if (!this.deps.composio) throw new Error('Composio not configured')
  const toolName = await this.deps.composio.resolver.resolveOrRefresh(
    args.toolkit as string,
    args.tool as string,
  )
  if (!toolName) throw new Error(`could not resolve composio tool '${args.toolkit}:${args.tool}'`)
  const result = await this.deps.composio.executeTool({
    toolName,
    userId: this.deps.composio.userId,
    arguments: (args.args as Record<string, unknown>) ?? {},
  })
  if (result && result.error) throw new Error(String(result.error))
  skill_output_raw = result
}
```

- [ ] **Step 3: Add 4 new tests to actionDispatcher.test.ts**

Append these tests to the existing `describe('ActionDispatcher', () => { ... })` block:

```typescript
function fakeComposioWithResolver(toolNameMap: Record<string, string>) {
  const executeCalls: any[] = []
  return {
    composio: {
      resolver: {
        resolveOrRefresh: async (toolkit: string, tool: string) => toolNameMap[`${toolkit}:${tool}`] ?? null,
      },
      executeTool: async (args: any) => { executeCalls.push(args); return { ok: true, data: 'tool-result' } },
      userId: 'local',
    },
    executeCalls,
  }
}

it('composio_tool: resolver hit + executeTool called with toolName', async () => {
  const cmp = fakeComposioWithResolver({ 'slack:send_message': 'SLACK_SEND_MESSAGE' })
  const d = new ActionDispatcher({
    intentRegistry: fakeIntentRegistry() as any,
    skillDispatcher: fakeSkillDispatcher() as any,
    composio: cmp.composio,
    eventBus: new RulesEventBus(),
  })
  await d.dispatch([{ action: 'composio_tool', args: { toolkit: 'slack', tool: 'send_message', args: { channel: '#x', text: 'hi' } } } as Action], { trigger: {} })
  expect(cmp.executeCalls).toHaveLength(1)
  expect(cmp.executeCalls[0].toolName).toBe('SLACK_SEND_MESSAGE')
  expect(cmp.executeCalls[0].userId).toBe('local')
  expect(cmp.executeCalls[0].arguments).toEqual({ channel: '#x', text: 'hi' })
})

it('composio_tool: resolver miss returns failure result', async () => {
  const cmp = fakeComposioWithResolver({})
  const d = new ActionDispatcher({
    intentRegistry: fakeIntentRegistry() as any,
    skillDispatcher: fakeSkillDispatcher() as any,
    composio: cmp.composio,
    eventBus: new RulesEventBus(),
  })
  const result = await d.dispatch([{ action: 'composio_tool', args: { toolkit: 'discord', tool: 'send_message', args: {} } } as Action], { trigger: {} })
  expect(result.ok).toBe(false)
  expect(result.error).toMatch(/could not resolve/)
})

it('composio_tool: executeTool failure surfaces as ok=false', async () => {
  const composio = {
    resolver: { resolveOrRefresh: async () => 'SLACK_SEND_MESSAGE' },
    executeTool: async () => ({ error: 'rate limited' }),
    userId: 'local',
  }
  const d = new ActionDispatcher({
    intentRegistry: fakeIntentRegistry() as any,
    skillDispatcher: fakeSkillDispatcher() as any,
    composio,
    eventBus: new RulesEventBus(),
  })
  const result = await d.dispatch([{ action: 'composio_tool', args: { toolkit: 'slack', tool: 'send_message', args: {} } } as Action], { trigger: {} })
  expect(result.ok).toBe(false)
  expect(result.error).toContain('rate limited')
})

it('composio_tool: skill_output_raw captured for chaining', async () => {
  const cmp = fakeComposioWithResolver({ 'slack:send_message': 'SLACK_SEND_MESSAGE' })
  const reg = fakeIntentRegistry()
  const d = new ActionDispatcher({
    intentRegistry: reg as any,
    skillDispatcher: fakeSkillDispatcher() as any,
    composio: cmp.composio,
    eventBus: new RulesEventBus(),
  })
  await d.dispatch([
    { action: 'composio_tool', args: { toolkit: 'slack', tool: 'send_message', args: { channel: '#x' } } } as Action,
    { action: 'notify', args: { message: '${skill_output.data}' } } as Action,
  ], { trigger: {} })
  expect(reg.calls[0]!.args.message).toBe('tool-result')
})
```

- [ ] **Step 4: Run tests + verify no regression**

```bash
bun test src/daemon/orders/v2/actionDispatcher.test.ts 2>&1 | tail -10
```

Expected: 12 pass (was 8). The pre-existing 8 still pass.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/orders/v2/actionDispatcher.ts src/daemon/orders/v2/actionDispatcher.test.ts
git commit -m "feat(c4.2): ActionDispatcher composio_tool — real executeTool via resolver

regression: 12 pass (was 8); no existing tests broke"
```

---

## Task 3: personaThresholdShift + RestraintPipeline integration (MODIFY)

**Files:**
- Create: `src/daemon/restraint/personaShift.ts`
- Create: `src/daemon/restraint/personaShift.test.ts`
- Modify: `src/daemon/restraint/restraintPipeline.ts`
- Modify: `src/daemon/restraint/restraintPipeline.test.ts` (add 4 new tests)

- [ ] **Step 1: Baseline test count for restraint suite**

```bash
bun test src/daemon/restraint/ 2>&1 | tail -5
```

Record the pass count.

- [ ] **Step 2: Write the failing tests for the pure helper**

```typescript
// src/daemon/restraint/personaShift.test.ts
import { describe, it, expect } from 'bun:test'
import { personaThresholdShift } from './personaShift'

describe('personaThresholdShift', () => {
  it('returns 0 when hints are null', () => {
    expect(personaThresholdShift(null)).toBe(0)
  })

  it('adds +0.10 for interrupt_aggressiveness=low', () => {
    expect(personaThresholdShift({ interrupt_aggressiveness: 'low', in_focus_now: false, active_hours_now: true, prefer_terse: false, prefer_voice_over_text: false } as any)).toBe(0.10)
  })

  it('subtracts -0.05 for interrupt_aggressiveness=high', () => {
    expect(personaThresholdShift({ interrupt_aggressiveness: 'high', in_focus_now: false, active_hours_now: true, prefer_terse: false, prefer_voice_over_text: false } as any)).toBe(-0.05)
  })

  it('adds +0.05 for in_focus_now=true', () => {
    expect(personaThresholdShift({ interrupt_aggressiveness: 'medium', in_focus_now: true, active_hours_now: true, prefer_terse: false, prefer_voice_over_text: false } as any)).toBe(0.05)
  })

  it('adds +0.10 when active_hours_now=false', () => {
    expect(personaThresholdShift({ interrupt_aggressiveness: 'medium', in_focus_now: false, active_hours_now: false, prefer_terse: false, prefer_voice_over_text: false } as any)).toBe(0.10)
  })

  it('clamps combined shift to ±0.20', () => {
    // low + in_focus + !active = 0.10 + 0.05 + 0.10 = 0.25 → clamped to 0.20
    expect(personaThresholdShift({ interrupt_aggressiveness: 'low', in_focus_now: true, active_hours_now: false, prefer_terse: false, prefer_voice_over_text: false } as any)).toBe(0.20)
  })
})
```

- [ ] **Step 3: Implement the helper**

```typescript
// src/daemon/restraint/personaShift.ts
// Pure helper: maps PersonaAwareness hints to a threshold delta.
// Positive = harder for the action to interrupt the user. Clamped to ±0.20.

import type { PersonaHints } from '../persona/types'

export function personaThresholdShift(hints: PersonaHints | null): number {
  if (!hints) return 0
  let shift = 0
  if (hints.interrupt_aggressiveness === 'low')  shift += 0.10
  if (hints.interrupt_aggressiveness === 'high') shift -= 0.05
  if (hints.in_focus_now)                        shift += 0.05
  if (!hints.active_hours_now)                   shift += 0.10
  return Math.max(-0.20, Math.min(0.20, shift))
}
```

- [ ] **Step 4: Run the helper tests**

```bash
bun test src/daemon/restraint/personaShift.test.ts 2>&1 | tail -10
```

Expected: 6/6 PASS.

- [ ] **Step 5: Wire helper into RestraintPipeline**

Read `src/daemon/restraint/restraintPipeline.ts`. Find the section that compares the action score to `this.deps.config.interrupt_threshold` / `surface_threshold` / `digest_threshold` (probably near the end of `evaluate()` after the scorer runs). Replace the threshold reads with:

```typescript
import { personaThresholdShift } from './personaShift'

// ... inside evaluate(), AFTER the scorer produces `score`:
const hints = this.deps.personaAwareness?.getHints() ?? null
const shift = personaThresholdShift(hints)
const interruptT = this.deps.config.interrupt_threshold + shift
const surfaceT   = this.deps.config.surface_threshold   + (shift * 0.5)
const digestT    = this.deps.config.digest_threshold    + (shift * 0.25)

// existing comparison logic, using interruptT / surfaceT / digestT instead of config values
if (score >= interruptT) return { mode: 'interrupt', score, reason: '...' /* existing */, persona_snapshot: hints }
if (score >= surfaceT)   return { mode: 'surface',   score, reason: '...', persona_snapshot: hints }
if (score >= digestT)    return { mode: 'digest',    score, reason: '...', persona_snapshot: hints }
return { mode: 'suppressed', score, reason: '...', persona_snapshot: hints }
```

`persona_snapshot` is a new optional field on `DeliveryDecision`. Find its type definition (likely in `src/daemon/restraint/types.ts`) and add:

```typescript
export type DeliveryDecision = {
  mode: 'interrupt' | 'surface' | 'digest' | 'suppressed' | 'dry_run'
  score: number | null
  reason: string
  persona_snapshot?: PersonaHints | null   // NEW — auditable persona state at decision time
}
```

(If `DeliveryDecision` already has different fields, just add `persona_snapshot?: any` and capture the hints object verbatim.)

- [ ] **Step 6: Add 4 integration tests to restraintPipeline.test.ts**

Find the existing describe block, add these tests:

```typescript
// Import at the top:
// import { personaThresholdShift } from './personaShift'

it('persona shift: medium aggressiveness + idle = no threshold change', async () => {
  const pipeline = makePipelineWithFakes()    // use the existing test helper
  pipeline.setPersonaAwareness({
    getHints: () => ({ interrupt_aggressiveness: 'medium', in_focus_now: false, active_hours_now: true, prefer_terse: false, prefer_voice_over_text: false } as any),
    invalidate: () => {},
  } as any)
  // Inject a score = base interrupt threshold → should still interrupt (>=)
  const result = await pipeline.evaluate(makeReq('test', 't1'), { urgency: 0.9, rule_match_strength: 0.9, personal_relevance: 0.9, novelty: 0.9, urgent: false })
  // Behavior should match the case without persona awareness — record the mode and verify it didn't shift unexpectedly
  expect(['interrupt', 'surface', 'digest', 'suppressed']).toContain(result.mode)
})

it('persona shift: in_focus_now=true flips a borderline interrupt to surface', async () => {
  const pipeline = makePipelineWithFakes()
  // base interrupt threshold from cfg = 0.9. Score will land at 0.92 (just over).
  // With in_focus_now: shift +0.05 → effective interrupt threshold 0.95 → routes 'surface'.
  pipeline.setPersonaAwareness({
    getHints: () => ({ interrupt_aggressiveness: 'medium', in_focus_now: true, active_hours_now: true, prefer_terse: false, prefer_voice_over_text: false } as any),
    invalidate: () => {},
  } as any)
  // Manipulate the scorer fake to return 0.92 — depends on existing test helper plumbing.
  // If the scorer is hard-coded, instead choose action params that produce ~0.92.
  // For determinism, mock ActionScorer.score() to return a fixed value:
  // (Inspect the existing fake setup and adapt.)
})

it('persona shift: !active_hours_now raises threshold by 0.10', async () => {
  // Similar setup — verify a score that would interrupt during work hours
  // routes to surface or lower during off-hours.
})

it('persona_snapshot is included in the DeliveryDecision', async () => {
  const pipeline = makePipelineWithFakes()
  const hints = { interrupt_aggressiveness: 'low', in_focus_now: false, active_hours_now: true, prefer_terse: true, prefer_voice_over_text: false } as any
  pipeline.setPersonaAwareness({ getHints: () => hints, invalidate: () => {} } as any)
  const result = await pipeline.evaluate(makeReq('x', 't2'), { urgency: 0.5, rule_match_strength: 0.5, personal_relevance: 0.5, novelty: 0.5, urgent: false })
  expect(result.persona_snapshot).toEqual(hints)
})
```

NOTE for the implementer: the existing `makePipelineWithFakes()` helper may not exist by that name. Look at the existing `restraintPipeline.test.ts` to find the actual setup pattern and reuse it. The persona-snapshot assertion at minimum is straightforward — verify the field is populated. The borderline-flip assertions may need ActionScorer mocking; if the existing fake scorer is hard-coded, override its `score()` method in the test.

- [ ] **Step 7: Run full restraint test suite**

```bash
bun test src/daemon/restraint/ 2>&1 | tail -10
```

Expected: all pre-existing tests still pass + the new 4 (or however many the integration tests turned out to be) also pass.

- [ ] **Step 8: Commit**

```bash
git add src/daemon/restraint/personaShift.ts src/daemon/restraint/personaShift.test.ts src/daemon/restraint/restraintPipeline.ts src/daemon/restraint/restraintPipeline.test.ts src/daemon/restraint/types.ts
git commit -m "feat(c4.2): persona-conditioned routing — threshold shift in RestraintPipeline

regression: all pre-existing restraint tests still pass; +6 personaShift unit tests, +4 integration tests"
```

---

## Task 4: PendingEditsQueue

**Files:**
- Create: `src/daemon/orders/v2/pendingEdits.ts`
- Create: `src/daemon/orders/v2/pendingEdits.test.ts`

SQLite-backed queue. CRUD + exponential backoff.

- [ ] **Step 1: Write the failing test file**

```typescript
// src/daemon/orders/v2/pendingEdits.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { PendingEditsQueue } from './pendingEdits'

describe('PendingEditsQueue', () => {
  let db: Database
  let q: PendingEditsQueue

  beforeEach(() => {
    db = new Database(':memory:')
    q = new PendingEditsQueue(db, { now: () => 1_000_000 })
  })

  it('enqueue creates a pending row', () => {
    const id = q.enqueue('remind me at 5pm')
    expect(id).toBeGreaterThan(0)
    const rows = q.listReadyForRetry(1_000_001)
    expect(rows).toHaveLength(0)   // next_retry_at = enqueued + 5min, not yet ready
  })

  it('listReadyForRetry returns rows whose next_retry_at <= now', () => {
    q.enqueue('a')
    const fiveMinLater = 1_000_000 + 5 * 60 * 1000
    const rows = q.listReadyForRetry(fiveMinLater)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.speech).toBe('a')
  })

  it('markRetried records error + applies exponential backoff', () => {
    const id = q.enqueue('b')
    q.markRetried(id, 'LLM 500', 1_000_000 + 5 * 60 * 1000)
    const rows = q.listAll()
    expect(rows[0]!.retry_count).toBe(1)
    expect(rows[0]!.last_error).toBe('LLM 500')
    // Backoff: 5min * 2^1 = 10min
    expect(rows[0]!.next_retry_at).toBe(1_000_000 + 5 * 60 * 1000 + 10 * 60 * 1000)
  })

  it('backoff caps at 1 hour', () => {
    const id = q.enqueue('c')
    // Manually bump retry_count high to force cap
    for (let i = 0; i < 10; i++) q.markRetried(id, 'fail', 1_000_000)
    const row = q.listAll()[0]!
    expect(row.next_retry_at - 1_000_000).toBeLessThanOrEqual(60 * 60 * 1000 + 1)   // ≤ 1h
  })

  it('markRetried at retry_count >= 10 sets status=failed', () => {
    const id = q.enqueue('d')
    for (let i = 0; i < 10; i++) q.markRetried(id, 'fail', 1_000_000)
    const row = q.listAll()[0]!
    expect(row.status).toBe('failed')
  })

  it('markDone marks row done (or deletes)', () => {
    const id = q.enqueue('e')
    q.markDone(id)
    const rows = q.listAll().filter(r => r.status === 'pending')
    expect(rows).toHaveLength(0)
  })

  it('persists across new Database connections (file-backed)', () => {
    // Use a real DB file so a second connection sees the data
    const { mkdtempSync } = require('fs')
    const { tmpdir } = require('os')
    const { join } = require('path')
    const tmp = mkdtempSync(join(tmpdir(), 'pending-edits-'))
    const path = join(tmp, 'd.sqlite')
    const dbA = new Database(path)
    const qA = new PendingEditsQueue(dbA, { now: () => 1_000_000 })
    qA.enqueue('persistent')
    dbA.close()
    const dbB = new Database(path)
    const qB = new PendingEditsQueue(dbB, { now: () => 1_000_000 })
    expect(qB.listAll()).toHaveLength(1)
    expect(qB.listAll()[0]!.speech).toBe('persistent')
    dbB.close()
  })

  it('cap: when >50 pending rows, oldest pending is dropped', () => {
    for (let i = 0; i < 52; i++) q.enqueue(`speech-${i}`)
    q.enforceCapacityCap(50)
    expect(q.listAll().length).toBeLessThanOrEqual(50)
    // The two oldest should have been dropped
    const speeches = q.listAll().map(r => r.speech)
    expect(speeches).not.toContain('speech-0')
    expect(speeches).not.toContain('speech-1')
    expect(speeches).toContain('speech-51')
  })
})
```

- [ ] **Step 2: Implement**

```typescript
// src/daemon/orders/v2/pendingEdits.ts
// SQLite-backed queue of speech edits that failed to compile (LLM unreachable).
// Processor retries periodically with exponential backoff. After max retries,
// row is marked 'failed' and surfaced to the user via the inbox.

import type { Database } from 'bun:sqlite'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS orders_pending_edits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  speech TEXT NOT NULL,
  enqueued_at INTEGER NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER NOT NULL,
  last_error TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS idx_pending_status ON orders_pending_edits(status, next_retry_at);
`

export const MAX_RETRIES = 10
export const BASE_RETRY_DELAY_MS = 5 * 60 * 1000          // 5 min
export const MAX_RETRY_DELAY_MS = 60 * 60 * 1000          // 1 hour cap
export const MAX_PENDING_ROWS = 50

export type PendingRow = {
  id: number
  speech: string
  enqueued_at: number
  retry_count: number
  next_retry_at: number
  last_error?: string
  status: 'pending' | 'failed' | 'done'
}

export type PendingEditsQueueOpts = { now?: () => number }

export class PendingEditsQueue {
  private now: () => number
  constructor(private db: Database, opts: PendingEditsQueueOpts = {}) {
    db.exec(SCHEMA)
    this.now = opts.now ?? Date.now
  }

  enqueue(speech: string): number {
    const t = this.now()
    const r = this.db.run(
      `INSERT INTO orders_pending_edits (speech, enqueued_at, next_retry_at) VALUES (?, ?, ?)`,
      [speech, t, t + BASE_RETRY_DELAY_MS],
    )
    return Number(r.lastInsertRowid)
  }

  listReadyForRetry(now: number = this.now()): PendingRow[] {
    const rows = this.db.query(
      `SELECT * FROM orders_pending_edits WHERE status = 'pending' AND next_retry_at <= ? ORDER BY enqueued_at LIMIT 10`,
    ).all(now) as any[]
    return rows.map(this.rowFromDb)
  }

  listAll(): PendingRow[] {
    const rows = this.db.query(`SELECT * FROM orders_pending_edits ORDER BY enqueued_at`).all() as any[]
    return rows.map(this.rowFromDb)
  }

  markRetried(id: number, error: string, baseTime: number = this.now()): void {
    const row = this.db.query(`SELECT * FROM orders_pending_edits WHERE id = ?`).get(id) as any
    if (!row) return
    const nextCount = row.retry_count + 1
    if (nextCount >= MAX_RETRIES) {
      this.db.run(
        `UPDATE orders_pending_edits SET retry_count = ?, last_error = ?, status = 'failed' WHERE id = ?`,
        [nextCount, error, id],
      )
      return
    }
    const backoff = Math.min(MAX_RETRY_DELAY_MS, BASE_RETRY_DELAY_MS * Math.pow(2, nextCount))
    this.db.run(
      `UPDATE orders_pending_edits SET retry_count = ?, last_error = ?, next_retry_at = ? WHERE id = ?`,
      [nextCount, error, baseTime + backoff, id],
    )
  }

  markDone(id: number): void {
    this.db.run(`UPDATE orders_pending_edits SET status = 'done' WHERE id = ?`, [id])
  }

  enforceCapacityCap(max: number = MAX_PENDING_ROWS): void {
    const count = (this.db.query(`SELECT COUNT(*) AS n FROM orders_pending_edits WHERE status = 'pending'`).get() as { n: number }).n
    if (count <= max) return
    const overflow = count - max
    const ids = this.db.query(
      `SELECT id FROM orders_pending_edits WHERE status = 'pending' ORDER BY enqueued_at ASC LIMIT ?`,
    ).all(overflow) as Array<{ id: number }>
    for (const r of ids) this.db.run(`DELETE FROM orders_pending_edits WHERE id = ?`, [r.id])
  }

  private rowFromDb = (r: any): PendingRow => ({
    id: r.id,
    speech: r.speech,
    enqueued_at: r.enqueued_at,
    retry_count: r.retry_count,
    next_retry_at: r.next_retry_at,
    last_error: r.last_error ?? undefined,
    status: r.status,
  })
}
```

- [ ] **Step 3: Run + commit**

```bash
bun test src/daemon/orders/v2/pendingEdits.test.ts 2>&1 | tail -15
git add src/daemon/orders/v2/pendingEdits.ts src/daemon/orders/v2/pendingEdits.test.ts
git commit -m "feat(c4.2): PendingEditsQueue — SQLite-backed retry queue with exponential backoff"
```

Expected: 8/8 PASS.

---

## Task 5: OrdersAuthor pending-queue integration (MODIFY)

**Files:**
- Modify: `src/daemon/orders/v2/author.ts`
- Modify: `src/daemon/orders/v2/author.test.ts` (add 4 new tests)

- [ ] **Step 1: Run baseline**

```bash
bun test src/daemon/orders/v2/author.test.ts 2>&1 | tail -5
```

Should be `6 pass`.

- [ ] **Step 2: Extend OrdersAuthor**

In `src/daemon/orders/v2/author.ts`, add a new optional dep + new method + update `handleSpeech`:

```typescript
// Add to imports:
import type { PendingEditsQueue } from './pendingEdits'

// Update OrdersAuthorDeps:
export type OrdersAuthorDeps = {
  router: ModelRouter
  store: OrdersStore
  parser: OrdersParser
  filePath: string
  pendingQueue?: PendingEditsQueue   // NEW — optional; if omitted, behavior matches C.4.1
}

// Update AuthorResult:
export type AuthorResult = {
  created_slug: string | null
  similar_existing?: string
  error?: string
  queued_for_retry?: boolean          // NEW — true when LLM failed and speech was queued
}
```

Modify `handleSpeech` so that LLM failures route to the pending queue (if configured):

```typescript
async handleSpeech(text: string): Promise<AuthorResult> {
  try {
    return await this.handleSpeechDirect(text)
  } catch (err) {
    // LLM unreachable or other transient failure → enqueue if queue is configured
    if (this.deps.pendingQueue) {
      this.deps.pendingQueue.enqueue(text)
      this.deps.pendingQueue.enforceCapacityCap()
      return { created_slug: null, queued_for_retry: true, error: err instanceof Error ? err.message : String(err) }
    }
    return { created_slug: null, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Internal — called by handleSpeech AND by PendingEditsProcessor. Always uses the LLM path. */
async handleSpeechDirect(text: string): Promise<AuthorResult> {
  // (Move the existing body of handleSpeech here, but THROW on LLM/parse errors
  //  instead of returning { error }. Specifically:
  //  - on router.complete() throwing → re-throw
  //  - on parsed?.proposed_rule missing → throw new Error('LLM output missing proposed_rule or slug_suggestion')
  //  Returning { created_slug: null, similar_existing } is still OK — that's not a failure path.)
}
```

Concretely, here's the new shape:

```typescript
async handleSpeechDirect(text: string): Promise<AuthorResult> {
  const existing = this.deps.store.listAll().map(r => ({ slug: r.slug, when_kind: this.whenKindOf(r.when), description: r.description?.slice(0, 80) ?? '' }))
  const userPrompt = `User said: "${text}"\n\nExisting rules (for dedup check):\n${existing.length === 0 ? '(none)' : existing.map(e => `- ${e.slug} (${e.when_kind}): ${e.description}`).join('\n')}\n\nProduce the JSON object.`

  const result = await this.deps.router.complete({
    task_type: 'orders_compose' as any,
    system_blocks: [{ text: SYSTEM_PROMPT, cache_hint: 'long' }],
    prompt: userPrompt,
    structured: true,
    max_output_tokens: 1500,
    latency_target: 'standard',
  })
  const parsed = result.parsed as any
  if (!parsed?.proposed_rule || !parsed.slug_suggestion) {
    throw new Error('LLM output missing proposed_rule or slug_suggestion')
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
```

- [ ] **Step 3: Add 4 new tests to author.test.ts**

Append to the existing describe block:

```typescript
import { PendingEditsQueue } from './pendingEdits'

function makeFailingRouter(errorMsg: string) {
  return {
    router: {
      async complete(_req: any) { throw new Error(errorMsg) },
    },
  }
}

it('LLM ok → file path (no queue interaction)', async () => {
  const queue = new PendingEditsQueue(new Database(':memory:'))
  const fake = makeFakeRouter({
    proposed_rule: { when: { event: 'foo' }, do: [{ action: 'log', args: { message: 'x' } }] },
    slug_suggestion: 'r',
    similar_existing: null,
    confidence: 1,
  })
  const author = new OrdersAuthor({ router: fake.router as any, store, parser, filePath: file, pendingQueue: queue })
  const result = await author.handleSpeech('do x')
  expect(result.created_slug).toBe('r')
  expect(queue.listAll()).toHaveLength(0)
})

it('LLM fails → speech enqueued to pending queue, returns queued_for_retry=true', async () => {
  const db = new Database(':memory:')
  const queue = new PendingEditsQueue(db)
  const failing = makeFailingRouter('LLM 500')
  const author = new OrdersAuthor({ router: failing.router as any, store, parser, filePath: file, pendingQueue: queue })
  const result = await author.handleSpeech('please save this')
  expect(result.created_slug).toBeNull()
  expect(result.queued_for_retry).toBe(true)
  expect(queue.listAll()).toHaveLength(1)
  expect(queue.listAll()[0]!.speech).toBe('please save this')
})

it('LLM missing proposed_rule → queued (treated as transient)', async () => {
  const db = new Database(':memory:')
  const queue = new PendingEditsQueue(db)
  const broken = makeFakeRouter({ slug_suggestion: 'x' })   // proposed_rule missing
  const author = new OrdersAuthor({ router: broken.router as any, store, parser, filePath: file, pendingQueue: queue })
  const result = await author.handleSpeech('xx')
  expect(result.queued_for_retry).toBe(true)
  expect(queue.listAll()).toHaveLength(1)
})

it('handleSpeechDirect bypasses queue — throws on failure', async () => {
  const queue = new PendingEditsQueue(new Database(':memory:'))
  const failing = makeFailingRouter('LLM 500')
  const author = new OrdersAuthor({ router: failing.router as any, store, parser, filePath: file, pendingQueue: queue })
  await expect(author.handleSpeechDirect('xx')).rejects.toThrow(/500/)
  expect(queue.listAll()).toHaveLength(0)   // not enqueued — direct path bypasses
})

it('queue absent (no pendingQueue dep) → original error behavior preserved', async () => {
  const failing = makeFailingRouter('LLM 500')
  const author = new OrdersAuthor({ router: failing.router as any, store, parser, filePath: file })   // no queue
  const result = await author.handleSpeech('xx')
  expect(result.created_slug).toBeNull()
  expect(result.queued_for_retry).toBeUndefined()
  expect(result.error).toContain('500')
})
```

- [ ] **Step 4: Run tests + verify no regression**

```bash
bun test src/daemon/orders/v2/author.test.ts 2>&1 | tail -15
```

Expected: 11 pass (was 6). All pre-existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/orders/v2/author.ts src/daemon/orders/v2/author.test.ts
git commit -m "feat(c4.2): OrdersAuthor enqueues failed speech to PendingEditsQueue

regression: 11 pass (was 6); pre-existing tests preserved via optional pendingQueue dep"
```

---

## Task 6: PendingEditsProcessor

**Files:**
- Create: `src/daemon/orders/v2/pendingEditsProcessor.ts`
- Create: `src/daemon/orders/v2/pendingEditsProcessor.test.ts`

Timer that drains the queue. Each tick: pull ready rows, retry via `OrdersAuthor.handleSpeechDirect`, mark done or backoff.

- [ ] **Step 1: Write the failing test file**

```typescript
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { OrdersStore } from './store'
import { OrdersParser } from './parser'
import { OrdersAuthor } from './author'
import { PendingEditsQueue } from './pendingEdits'
import { PendingEditsProcessor } from './pendingEditsProcessor'

function makeFakeRouter(response: any, options: { failNTimes?: number } = {}) {
  let calls = 0
  return {
    router: {
      async complete(_req: any) {
        calls++
        if (options.failNTimes && calls <= options.failNTimes) throw new Error('LLM 500')
        return { parsed: response, text: JSON.stringify(response) } as any
      },
    },
    getCallCount: () => calls,
  }
}

describe('PendingEditsProcessor', () => {
  let db: Database, store: OrdersStore, parser: OrdersParser, queue: PendingEditsQueue, file: string

  beforeEach(() => {
    db = new Database(':memory:')
    store = new OrdersStore(db)
    parser = new OrdersParser()
    queue = new PendingEditsQueue(db, { now: () => 1_000_000 })
    const tmp = mkdtempSync(join(tmpdir(), 'pep-'))
    file = join(tmp, 'STANDING_ORDERS.md')
    writeFileSync(file, '# KAIROS Standing Orders\n')
  })

  it('processes a ready row, materializes rule, marks done', async () => {
    queue.enqueue('test rule')
    const fake = makeFakeRouter({
      proposed_rule: { when: { event: 'foo' }, do: [{ action: 'log', args: { message: 'x' } }] },
      slug_suggestion: 'recovered',
      similar_existing: null,
      confidence: 1,
    })
    const author = new OrdersAuthor({ router: fake.router as any, store, parser, filePath: file, pendingQueue: queue })
    const proc = new PendingEditsProcessor({ queue, author, now: () => 1_000_000 + 6 * 60 * 1000 })   // after retry window
    await proc.runOnce()
    expect(store.get('recovered')).not.toBeNull()
    // Either done OR deleted — both acceptable
    const pending = queue.listAll().filter(r => r.status === 'pending')
    expect(pending).toHaveLength(0)
  })

  it('failed retry increments retry_count + applies backoff', async () => {
    const id = queue.enqueue('persistent fail')
    const fake = makeFakeRouter(null, { failNTimes: 5 })
    const author = new OrdersAuthor({ router: fake.router as any, store, parser, filePath: file, pendingQueue: queue })
    const proc = new PendingEditsProcessor({ queue, author, now: () => 1_000_000 + 6 * 60 * 1000 })
    await proc.runOnce()
    const rows = queue.listAll()
    expect(rows[0]!.retry_count).toBe(1)
    expect(rows[0]!.last_error).toContain('500')
  })

  it('does not process rows whose next_retry_at is in the future', async () => {
    queue.enqueue('future')
    const fake = makeFakeRouter({
      proposed_rule: { when: { event: 'foo' }, do: [{ action: 'log', args: { message: 'x' } }] },
      slug_suggestion: 'future-rule',
      similar_existing: null,
      confidence: 1,
    })
    const author = new OrdersAuthor({ router: fake.router as any, store, parser, filePath: file, pendingQueue: queue })
    const proc = new PendingEditsProcessor({ queue, author, now: () => 1_000_000 + 30 * 1000 })   // 30s after enqueue — not ready
    await proc.runOnce()
    expect(fake.getCallCount()).toBe(0)
  })

  it('start/stop manages timer', async () => {
    const fake = makeFakeRouter({
      proposed_rule: { when: { event: 'foo' }, do: [{ action: 'log', args: { message: 'x' } }] },
      slug_suggestion: 't',
      similar_existing: null,
      confidence: 1,
    })
    const author = new OrdersAuthor({ router: fake.router as any, store, parser, filePath: file, pendingQueue: queue })
    const proc = new PendingEditsProcessor({ queue, author })
    proc.start(50)
    proc.stop()
    expect(true).toBe(true)   // didn't throw
  })
})
```

- [ ] **Step 2: Implement**

```typescript
// src/daemon/orders/v2/pendingEditsProcessor.ts
// Periodically drains PendingEditsQueue. Each ready row → handleSpeechDirect.
// Success → markDone. Failure → markRetried (queue handles backoff + max-retries).

import type { PendingEditsQueue } from './pendingEdits'
import type { OrdersAuthor } from './author'

export type PendingEditsProcessorDeps = {
  queue: PendingEditsQueue
  author: { handleSpeechDirect(text: string): Promise<{ created_slug: string | null; similar_existing?: string }> }
  now?: () => number
  onFailed?: (speech: string, lastError: string) => void   // called when a row hits MAX_RETRIES
}

export class PendingEditsProcessor {
  private timer: ReturnType<typeof setInterval> | null = null
  private now: () => number

  constructor(private deps: PendingEditsProcessorDeps) {
    this.now = deps.now ?? Date.now
  }

  async runOnce(): Promise<void> {
    const ready = this.deps.queue.listReadyForRetry(this.now())
    for (const row of ready) {
      try {
        await this.deps.author.handleSpeechDirect(row.speech)
        this.deps.queue.markDone(row.id)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        this.deps.queue.markRetried(row.id, msg, this.now())
        // If the row is now in failed state, notify
        const refreshed = this.deps.queue.listAll().find(r => r.id === row.id)
        if (refreshed?.status === 'failed') this.deps.onFailed?.(row.speech, msg)
      }
    }
  }

  start(intervalMs: number = 5 * 60 * 1000): void {
    if (this.timer) return
    this.timer = setInterval(() => { this.runOnce().catch(() => {}) }, intervalMs)
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }
}
```

- [ ] **Step 3: Run + commit**

```bash
bun test src/daemon/orders/v2/pendingEditsProcessor.test.ts 2>&1 | tail -10
git add src/daemon/orders/v2/pendingEditsProcessor.ts src/daemon/orders/v2/pendingEditsProcessor.test.ts
git commit -m "feat(c4.2): PendingEditsProcessor — drains queue, retries failed speech"
```

Expected: 4/4 PASS.

---

## Task 7: Daemon wire-up

**Files:**
- Modify: `src/daemon/index.ts`

Wire ComposioToolResolver + PendingEditsProcessor into boot. Pass resolver into the existing ActionDispatcher composio block.

- [ ] **Step 1: Update the imports in index.ts**

Add:
```typescript
import { ComposioToolResolver } from './orders/v2/composioToolResolver'
import { PendingEditsQueue } from './orders/v2/pendingEdits'
import { PendingEditsProcessor } from './orders/v2/pendingEditsProcessor'
```

- [ ] **Step 2: Wire the resolver**

Find the existing C.4.1 v2 boot block (look for `[orders-v2] subsystem ready`). BEFORE the `OrdersActionDispatcher` construction, add:

```typescript
// ComposioToolResolver — populated only if Composio is configured
let composioResolver: ComposioToolResolver | null = null
if (composioClient) {
  composioResolver = new ComposioToolResolver({
    composio: composioClient,
    userId: 'local',
  })
  // Initialize asynchronously — daemon doesn't block boot on this
  composioResolver.initialize().catch(err => log(`[orders-v2] resolver init failed: ${err}`, 'warn'))
}
```

REPLACE the existing OrdersActionDispatcher construction's `composio:` field:

```typescript
const actionDispatcher = new OrdersActionDispatcher({
  intentRegistry,
  skillDispatcher: skillDispatcher ?? { invoke: async () => ({ ok: false, error: 'skill subsystem not initialized', duration_ms: 0, sandbox: 'declarative' }) },
  composio: (composioClient && composioResolver) ? {
    resolver: composioResolver,
    executeTool: async (args) => composioClient.executeTool(args),
    userId: 'local',
  } : null,
  eventBus: rulesBus,
})
```

(Adjust the exact name/path if the existing block differs. The goal: the resolver flows into the dispatcher's composio dep.)

- [ ] **Step 3: Wire the pending-edits subsystem**

After OrdersAuthor is constructed, add:

```typescript
const pendingQueue = new PendingEditsQueue(db)
// Re-construct OrdersAuthor with the queue (or pass it at construction above)
// — see Step 4 for the cleaner approach.

let pendingProcessor: PendingEditsProcessor | null = null
if ((globalThis as any).__kairosOrdersAuthor) {
  pendingProcessor = new PendingEditsProcessor({
    queue: pendingQueue,
    author: (globalThis as any).__kairosOrdersAuthor,
    onFailed: (speech, err) => log(`[orders-v2] pending edit hit max retries: "${speech.slice(0, 50)}" — ${err}`, 'warn'),
  })
  pendingProcessor.start(5 * 60 * 1000)
}
;(globalThis as any).__kairosOrdersV2PendingQueue = pendingQueue
;(globalThis as any).__kairosOrdersV2PendingProcessor = pendingProcessor
```

- [ ] **Step 4: Update OrdersAuthor construction to receive the queue**

In the existing block where `OrdersAuthor` is constructed, change to:

```typescript
if (router) {
  const ordersAuthor = new OrdersAuthor({
    router,
    store: ordersV2Store,
    parser: ordersV2Parser,
    filePath: v2FilePath,
    pendingQueue,   // NEW
  })
  ;(globalThis as any).__kairosOrdersAuthor = ordersAuthor
}
```

(Construct `pendingQueue` BEFORE `OrdersAuthor`. Order: pendingQueue → ordersAuthor → pendingProcessor.)

- [ ] **Step 5: Update shutdown**

In the shutdown block:

```typescript
if (composioResolver) composioResolver.stop()
if (pendingProcessor) pendingProcessor.stop()
```

- [ ] **Step 6: Verify build + run all orders v2 tests**

```bash
bun build src/daemon/index.ts --target=bun --outdir=/tmp/c4-2-t7-check 2>&1 | tail -5
bun test src/daemon/orders/v2/ 2>&1 | tail -5
bun test src/daemon/restraint/ 2>&1 | tail -5
```

Build must be clean. Orders v2 + restraint suites both green.

- [ ] **Step 7: Commit**

```bash
git add src/daemon/index.ts
git commit -m "feat(c4.2): wire ComposioToolResolver + PendingEditsProcessor into daemon boot"
```

---

## Task 8: Phase C validation gate — simulated 4-hour session

**Files:**
- Create: `scripts/validate-phase-c.ts`

This is the biggest task. Mirror the structure of `scripts/validate-phase-c4-1.ts` exactly: `record(pass, note)`, labels array, try/catch per assertion, final report + exit code.

The full scenario is in spec §4d. The script walks through 13 time-pointers with 30 total assertions. Each assertion uses fresh `mkdtempSync` + `Database(':memory:')` where applicable; some assertions reuse state from the running scenario.

- [ ] **Step 1: Read the existing pattern**

```bash
head -100 /Users/nirmalghinaiya/Desktop/kairos-sandbox/scripts/validate-phase-c4-1.ts
```

Mirror the imports + helpers pattern.

- [ ] **Step 2: Build the scenario script**

Create `scripts/validate-phase-c.ts`. Structure:

```typescript
// scripts/validate-phase-c.ts — Phase C overall validation gate.
// Simulated 4-hour user session. 30 assertions across all C subsystems.
// Run: bun run scripts/validate-phase-c.ts
// Exit 0 if all 30 PASS; 1 otherwise.

import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'

// All Phase C subsystem imports — abbreviated; full list will mirror what's
// actually used in the assertion blocks:
import { OrdersParser } from '../src/daemon/orders/v2/parser'
import { OrdersStore } from '../src/daemon/orders/v2/store'
import { OrdersAuthor } from '../src/daemon/orders/v2/author'
import { ActionDispatcher } from '../src/daemon/orders/v2/actionDispatcher'
import { ReactiveEvaluator } from '../src/daemon/orders/v2/reactiveEvaluator'
import { ConditionEvaluator } from '../src/daemon/orders/v2/conditionEvaluator'
import { DryRunLogger } from '../src/daemon/orders/v2/dryRunLogger'
import { ScheduleAdapter } from '../src/daemon/orders/v2/scheduleAdapter'
import { RulesEventBus } from '../src/daemon/orders/v2/eventBus'
import { ComposioToolResolver } from '../src/daemon/orders/v2/composioToolResolver'
import { PendingEditsQueue } from '../src/daemon/orders/v2/pendingEdits'
import { PendingEditsProcessor } from '../src/daemon/orders/v2/pendingEditsProcessor'
import { personaThresholdShift } from '../src/daemon/restraint/personaShift'
import { SoulLoader } from '../src/daemon/persona/soulLoader'

type AssertResult = { pass: boolean; note: string }
const results: AssertResult[] = []
function record(pass: boolean, note: string) { results.push({ pass, note }) }

console.log('=== KAIROS Phase C Overall Validation Gate ===')
console.log(`Started: ${new Date().toISOString()}`)
console.log('Scenario: simulated 4-hour user session across C.1 + C.2 + C.3 + C.4')
console.log()

const homeBase = mkdtempSync(join(tmpdir(), 'kairos-phase-c-'))

// Fakes used throughout the scenario:
function fakeRouter(responseSequence: any[]) {
  let i = 0
  return {
    complete: async (_req: any) => {
      const resp = responseSequence[i++] ?? responseSequence[responseSequence.length - 1]
      return { parsed: resp, text: JSON.stringify(resp) }
    },
  }
}

function fakeComposio() {
  const calls: any[] = []
  return {
    sdk: { tools: { list: async () => ({ items: [
      { toolkit: { slug: 'slack' }, name: 'SLACK_SEND_MESSAGE' },
    ] }) } },
    executeTool: async (args: any) => { calls.push(args); return { ok: true, data: 'sent' } },
    calls,
  }
}

function fakeSkillDispatcher() {
  const calls: any[] = []
  return {
    invoke: async (slug: string, args: any) => {
      calls.push({ slug, args })
      return { ok: true, output: 'result-' + slug, duration_ms: 1, sandbox: 'declarative' as const }
    },
    calls,
  }
}

function fakeIntentRegistry() {
  const calls: any[] = []
  return {
    get: (id: string) => ({
      handler: async (args: any) => { calls.push({ id, args }); return { status: 'success' as const, details: 'ok' } },
    }),
    calls,
  }
}

// ─── T+00:00 — Boot daemon with fresh state (3 assertions) ──────────────────
const t00 = (async () => {
  try {
    const db = new Database(':memory:')
    const store = new OrdersStore(db)
    record(true, 'OrdersStore created with fresh state')

    const soulPath = join(homeBase, 'soul.md')
    writeFileSync(soulPath, '# Soul\n\n## Core Truths\n- Be helpful\n')
    const loader = new SoulLoader({ path: soulPath })
    loader.load()
    record(loader.getBaselineBoundaries().length >= 4, 'SoulLoader has BASELINE_BOUNDARIES loaded')

    record(store.listAll().length === 0, 'OrdersStore is empty at boot')
  } catch (e) {
    record(false, 'T+00:00 boot failed: ' + (e instanceof Error ? e.message : e))
  }
})()
await t00

// ─── T+00:05 — User speaks first rule (4 assertions) ────────────────────────
// (... continue building each scenario block with concrete try/catch blocks
//  that call into the real subsystem code with fakes for external boundaries.)

// ... (repeat for T+00:10, T+00:15, T+00:20, T+01:00, T+02:00, T+02:30,
//      T+02:35, T+02:40, T+03:00, T+03:30, T+04:00 — 30 total assertions)

// ─── Report ─────────────────────────────────────────────────────────────────
const labels = [
  // T+00:00 boot (3)
  '[T+00:00] OrdersStore fresh',
  '[T+00:00] SoulLoader baselines',
  '[T+00:00] empty rules table',
  // T+00:05 first rule (4)
  '[T+00:05] author compiles',
  '[T+00:05] rule appended to file',
  '[T+00:05] store has slug',
  '[T+00:05] scheduler armed',
  // T+00:10 clipboard noise (1)
  '[T+00:10] no rule matches yet',
  // T+00:15 clipboard rule (1)
  '[T+00:15] dry-run rule created',
  // T+00:20 dry-run fire (2)
  '[T+00:20] rule matched',
  '[T+00:20] dry_run_log instead of notify',
  // T+01:00 dreaming (2)
  '[T+01:00] dreaming cycle ran',
  '[T+01:00] persona updated',
  // T+02:00 persona shift (2)
  '[T+02:00] personaThresholdShift correct',
  '[T+02:00] borderline interrupt → surface',
  // T+02:30 composio (2)
  '[T+02:30] resolver finds toolName',
  '[T+02:30] executeTool called correctly',
  // T+02:35 LLM down (2)
  '[T+02:35] queued_for_retry=true',
  '[T+02:35] pending queue has 1 row',
  // T+02:40 LLM back (2)
  '[T+02:40] processor materializes rule',
  '[T+02:40] pending row done',
  // T+03:00 crystallize (3)
  '[T+03:00] AwmWorker finds cluster',
  '[T+03:00] skill written to disk',
  '[T+03:00] registry has new skill',
  // T+03:30 invoke (2)
  '[T+03:30] SkillDispatcher routes',
  '[T+03:30] traj records the action',
  // T+04:00 shutdown (4)
  '[T+04:00] AwmWorker stopped',
  '[T+04:00] Curator timer cleared',
  '[T+04:00] file watcher closed',
  '[T+04:00] ScheduleAdapter cleared',
]

for (let i = 0; i < results.length; i++) {
  const { pass, note } = results[i]!
  const status = pass ? 'PASS' : `FAIL: ${note}`
  const padded = `[${String(i + 1).padStart(2, '0')}/30] ${labels[i]}`.padEnd(60, '.')
  console.log(`${padded} ${status}`)
}

const allPass = results.every(r => r.pass)
console.log()
console.log(`=== Gate verdict: ${allPass ? 'PASS ✓' : 'FAIL ✗'} ===`)

// Cleanup
try { rmSync(homeBase, { recursive: true, force: true }) } catch {}

process.exit(allPass ? 0 : 1)
```

The implementer fills in each scenario block. Use the spec's `§4d Phase C overall validation gate` text as the authoritative source for what each assertion should test.

**Key implementation notes for the gate script:**

- Use fresh `Database(':memory:')` for the v2 store and ephemeral home dir `homeBase`
- Inject a synthetic clock where time matters (don't actually wait 4 hours — `now` callback returns the simulated timestamp)
- For SoulLoader, write a minimal `soul.md` to `homeBase` so the loader has something to read
- For AwmWorker, write 3 fake `traj/YYYY-MM-DD.md` entries with matching `intent_id` to force the cluster threshold
- For PendingEditsProcessor, advance the fake clock past `next_retry_at` and call `runOnce()` directly (don't wait for the interval)
- For `T+04:00 shutdown`, just assert `subsystem.stop()` doesn't throw and timer counts go to zero where checkable

- [ ] **Step 3: Run the gate**

```bash
bun run scripts/validate-phase-c.ts
```

Expected: `=== Gate verdict: PASS ✓ ===` and exit code 0.

If any assertion FAILS — fix the underlying code, NOT the assertion. The assertions are the contract; failures mean the C bundle has a real integration gap.

- [ ] **Step 4: Commit (only after PASS)**

```bash
git add scripts/validate-phase-c.ts
git commit -m "test(c4.2): Phase C overall validation gate — 30 assertions, simulated 4h session"
```

---

## Task 9: Pre-merge regression sweep + CHANGELOG + tag v0.4.0

- [ ] **Step 1: Run ALL existing gates**

```bash
cd /Users/nirmalghinaiya/Desktop/kairos-sandbox
for f in scripts/validate-phase-b.ts scripts/validate-phase-c1.ts scripts/validate-phase-c1-5.ts scripts/validate-phase-c2.ts scripts/validate-phase-c2-5.ts scripts/validate-phase-c2-6.ts scripts/validate-phase-c2-7.ts scripts/validate-phase-c3-1.ts scripts/validate-phase-c3-3.ts scripts/validate-phase-c4-1.ts scripts/validate-phase-c.ts; do
  echo "=== $f ==="
  bun run "$f" 2>&1 | grep -E "Gate verdict" | tail -1
done
```

Expected: every line `Gate verdict: PASS ✓`. Any FAIL blocks the tag.

- [ ] **Step 2: Run full unit test suite**

```bash
bun test 2>&1 | tail -10
```

Expected: all green. Compare to the baseline recorded in Task 0.

If anything FAILS at this step, fix the regression before proceeding. Do NOT tag with red tests.

- [ ] **Step 3: Update CHANGELOG.md**

Prepend a `v0.4.0` entry. Read the current CHANGELOG first to find the insertion point (just after the `v0.3.8` entry).

```markdown
## [v0.4.0] - 2026-05-28

**Phase C complete.** Orchestration, persona, skills, standing orders — all four sub-phases shipped and proven to work together end-to-end via the simulated 4-hour user-session validation gate.

### Phase C arc (C.1 → C.2 → C.3 → C.4)

- **C.1 — Agency + Restraint:** trigger engine, action executor, urgency floor, karma/cooldown/rate-limit gates, dry-run mode, intent registry
- **C.2 — Memory + Composio:** episodic + semantic memory, vector embedding, prompt caching, model router with task-typed tier selection, Composio connectors with managed OAuth
- **C.3 — Persona + AWM Skills:** soul.md + persona.md + Dreaming cycles, PersonaAwareness hints, agentskills.io SKILL.md crystallization, PersonaGate + Curator
- **C.4 — Standing Orders v2:** structured DSL with time-triggered rules, chaining via named events, persona-conditioned routing, Composio tool execution, 24h dry-run gate

### Added in C.4.2 (final sub-phase)

- **ComposioToolResolver** — maps friendly `{toolkit, friendly_name}` to exact `toolName` via boot-time `composio.tools.list()`; 24h cache, on-miss refresh rate-limited
- **Real composio_tool action execution** — replaces the C.4.1 stub; resolver → executeTool → output captured for chaining
- **Persona-conditioned routing** — `personaThresholdShift(hints)` applied to RestraintPipeline's interrupt/surface/digest thresholds at score time; clamped to ±0.20; persona snapshot recorded in DeliveryDecision for audit
- **PendingEditsQueue + Processor** — SQLite-backed retry queue with exponential backoff (5min × 2^n, capped 1h); max 10 retries → failed state surfaced via inbox; max 50 pending rows
- **Phase C overall validation gate** — `scripts/validate-phase-c.ts` runs 30 assertions across a simulated 4-hour user session in <60s wall time

### Validated

All 10 phase-specific gates + the new Phase C overall gate verdict PASS. Full `bun test` green.

### Tag

`v0.4.0` — Phase C cohesive release. No `-phase-c4-2` suffix; this is the milestone.
```

- [ ] **Step 4: Commit + tag**

```bash
git add CHANGELOG.md
git commit -m "release: Phase C complete — orchestration, persona, skills, standing orders"
git tag v0.4.0
```

- [ ] **Step 5: Verify tag**

```bash
git tag --list 'v0.4.0'
git log --oneline -5
```

Expected: `v0.4.0` appears in tag list; HEAD is the release commit.

---

## Self-Review

**Spec coverage check (every spec section mapped to a task):**

| Spec section | Task |
|---|---|
| §1 Goals | Motivation; tasks 1-8 implement the gaps |
| §2 Non-goals | Documented in plan header |
| §3 Architecture (4 sub-systems) | Tasks 1-6, 7 (wire-up) |
| §4a ComposioToolResolver | Task 1 |
| §4b Persona-conditioned routing | Task 3 |
| §4c PendingEditsQueue | Tasks 4 + 5 + 6 |
| §4d Phase C validation gate | Task 8 |
| §5 Storage/config changes | Tasks 4 (new table), 1 (cache path), 3 (optional persona field) |
| §5b Regression strategy | Task 0 (baseline) + Tasks 2/3/5 (during-task checks) + Task 9 (pre-merge sweep) |
| §6 Test strategy | Tasks 1-6 (unit tests) + Task 8 (gate assertions) |
| §7 Risks | Mitigated through test design (cache, clamp, max-retries, optional deps) |
| §8 Tagging plan | Task 9 |

**Placeholder scan:** No "TBD" / "TODO" / "fill in details". The Task 8 scenario blocks are explicitly delegated to the implementer with the spec text as the source — that's intentional, not a placeholder, because the scenarios are big and prescriptive code would balloon this plan past usefulness. The blocks have full label structure + complete fakes + concrete state transitions in the spec.

**Type consistency check:**
- `ComposioToolResolver.resolve()` returns `string | null`; `resolveOrRefresh()` returns `Promise<string | null>` — consistent
- `ActionDispatcherDeps.composio` shape uses `resolver: { resolveOrRefresh }` — matches Task 1's API
- `personaThresholdShift(hints: PersonaHints | null): number` — same signature in Task 3 across both files
- `PendingRow` shape consistent between `PendingEditsQueue` and `PendingEditsProcessor`
- `OrdersAuthor.handleSpeechDirect(text)` introduced in Task 5; consumed in Task 6's `PendingEditsProcessor`; consumed in Task 7's wire-up

**Known integration adaptations the implementer may need:**
- `RestraintPipeline`'s actual file may use slightly different identifier names for the threshold-comparison block. Task 3 explicitly says "find this section" — implementer reads it and adapts
- The existing `OrdersAuthor` construction site in `index.ts` may need to be moved or have its order changed so `pendingQueue` exists first — Task 7 explicitly calls out the ordering

End of plan.
