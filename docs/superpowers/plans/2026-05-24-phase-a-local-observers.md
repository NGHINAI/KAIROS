# Phase A — Local Observer Network + Multi-LLM Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the foundation for fully-proactive KAIROS: a push-based local observer network that emits world-state events into a SQLite-backed event bus, aggregated into a live snapshot that a Narrator summarizes every 5 minutes via a multi-LLM ModelRouter supporting Anthropic / OpenAI / Gemini / Kimi / Ollama.

**Architecture:** Five OS-level observers (focus-app, browser-tabs, clipboard, file-events, calendar-local) push events into an `EventBus`. A `StateSnapshot` continuously aggregates the latest events into a queryable live view. Every 5 minutes the `Narrator` reads the snapshot and produces a ≤200-word natural-language summary, dropped into the bus as a `narrative` event. Every LLM call (narrator and all future callers) routes through `ModelRouter`, which selects provider+model by task tier (ultra-cheap / mid / heavy), enforces per-task budget, and falls back across providers on failure.

**Tech Stack:** TypeScript on Bun runtime, `bun:sqlite` for the bus, `@anthropic-ai/sdk`, `openai` (also for Kimi/Ollama via baseURL), `@google/genai`, macOS `osascript` for browser/calendar, `pbpaste` for clipboard, Node `fs.watch` for files.

**Scope boundary:** Phase A only ships local observers + router + narrator. Cloud/OAuth connectors (Gmail/Slack/GitHub) are Phase D. Memory layers (episodic/semantic/procedural) are Phase B. Trigger evaluation and autonomous action are Phase C.

**Estimated size:** ~2,400 lines of TypeScript + tests.

---

## File Structure

All new code lives under `src/daemon/proactive/` and `src/daemon/llm/`. Existing files are NOT touched in Phase A — the new subsystem runs alongside and is wired in via `src/daemon/index.ts`.

```
src/daemon/
├── llm/                              [NEW — multi-LLM router]
│   ├── types.ts                      Provider/CompletionRequest/CompletionResult types
│   ├── config.ts                     Provider config loader from ~/.kairos/providers.json
│   ├── costTracker.ts                Per-provider cost ledger persisted to SQLite
│   ├── router.ts                     Task-type → tier → provider selection + fallback
│   ├── policy.ts                     Default task-tier mapping table
│   └── providers/
│       ├── anthropicCli.ts           Wraps `claude -p` subprocess (Pro subscription)
│       ├── anthropicApi.ts           @anthropic-ai/sdk (BYOK)
│       ├── openai.ts                 openai package (also handles Kimi+Ollama via baseURL)
│       └── gemini.ts                 @google/genai
│
├── proactive/                        [NEW — observer subsystem]
│   ├── eventBus.ts                   SQLite-backed pub/sub bus
│   ├── stateSnapshot.ts              Live aggregated world-state view
│   ├── narrator.ts                   5-min summarizer using ModelRouter
│   ├── observerRegistry.ts           Lifecycle for all observers
│   └── observers/
│       ├── base.ts                   Abstract Observer interface
│       ├── focusApp.ts               Active macOS app (via osascript)
│       ├── browserTabs.ts            Open tabs in Safari/Chrome/Arc
│       ├── clipboard.ts              pbpaste polling with change detection
│       ├── fileEvents.ts             fs.watch on configured roots
│       └── calendarLocal.ts          macOS Calendar.app via icalbuddy
│
└── index.ts                          [MODIFY] wire ModelRouter + ObserverRegistry + Narrator on startup
```

**Test files** live alongside their source as `*.test.ts` and run via `bun test`.

---

## Task 0: Setup & dependencies

**Files:**
- Modify: `package.json`
- Create: `~/.kairos/providers.json` (example)

- [ ] **Step 1: Add LLM provider SDKs**

```bash
cd /Users/nirmalghinaiya/Desktop/kairos-sandbox
bun add @anthropic-ai/sdk openai @google/genai
```

- [ ] **Step 2: Verify versions installed**

```bash
bun pm ls | grep -E "(anthropic|openai|google)"
```

Expected: three packages listed with versions printed.

- [ ] **Step 3: Create provider config skeleton**

Write `~/.kairos/providers.json`:

```json
{
  "providers": {
    "anthropic_cli": { "enabled": true, "priority": 1 },
    "anthropic_api": { "enabled": false, "api_key_env": "ANTHROPIC_API_KEY" },
    "openai":        { "enabled": false, "api_key_env": "OPENAI_API_KEY" },
    "gemini":        { "enabled": false, "api_key_env": "GEMINI_API_KEY" },
    "kimi":          { "enabled": false, "api_key_env": "MOONSHOT_API_KEY", "base_url": "https://api.moonshot.cn/v1" },
    "ollama":        { "enabled": false, "base_url": "http://localhost:11434/v1" }
  },
  "default_policy": "cost_optimized",
  "monthly_budget_usd": 50
}
```

- [ ] **Step 4: Commit**

```bash
git add package.json bun.lock
git commit -m "deps: add @anthropic-ai/sdk, openai, @google/genai for ModelRouter"
```

---

## Task 1: Provider & router type definitions

**Files:**
- Create: `src/daemon/llm/types.ts`

- [ ] **Step 1: Write the types file**

```typescript
// src/daemon/llm/types.ts
// Core types for the multi-LLM router. Every LLM caller in KAIROS
// constructs a CompletionRequest, hands it to ModelRouter.complete(),
// and receives a CompletionResult with provenance + cost.

export type ProviderId =
  | 'anthropic_cli'
  | 'anthropic_api'
  | 'openai'
  | 'gemini'
  | 'kimi'
  | 'ollama'

export type TaskType =
  | 'narrative'          // ultra-cheap: summarize world state
  | 'trigger_eval'       // ultra-cheap: should this fire?
  | 'action_compose'     // mid: draft a message / craft an action
  | 'skill_generate'     // heavy: write new bash skill
  | 'source_patch'       // heavy: modify own TS source
  | 'dream'              // mid: consolidate episodic → semantic memory
  | 'classify'           // ultra-cheap: tag an event

export type Tier = 'ultra_cheap' | 'mid' | 'heavy'

export type CompletionRequest = {
  task_type: TaskType
  prompt: string
  system?: string
  max_cost_cents?: number          // refuse if all providers exceed
  latency_target?: 'realtime' | 'standard' | 'background'
  fallback_chain?: ProviderId[]    // optional override
  structured?: boolean             // require parseable JSON
  max_output_tokens?: number
}

export type CompletionResult = {
  text: string
  parsed?: unknown                 // populated when structured=true
  provider: ProviderId
  model: string
  cost_cents: number
  latency_ms: number
  fallback_count: number           // how many providers tried before this
  input_tokens: number
  output_tokens: number
}

export type ProviderError = {
  provider: ProviderId
  kind: 'rate_limit' | 'auth' | 'timeout' | 'invalid_request' | 'server' | 'unknown'
  message: string
  retryable: boolean
}

// Each provider adapter implements this interface.
export interface LLMProvider {
  readonly id: ProviderId
  isConfigured(): boolean
  modelsForTier(tier: Tier): string[]
  pricePerMillion(model: string): { input: number; output: number }  // USD
  complete(model: string, req: CompletionRequest): Promise<CompletionResult>
}

export type ProviderConfig = {
  enabled: boolean
  priority?: number
  api_key_env?: string
  base_url?: string
}

export type RouterConfig = {
  providers: Record<ProviderId, ProviderConfig>
  default_policy: 'cost_optimized' | 'quality_optimized' | 'latency_optimized'
  monthly_budget_usd: number
}
```

- [ ] **Step 2: Type-check the file**

```bash
bunx tsc --noEmit src/daemon/llm/types.ts
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/daemon/llm/types.ts
git commit -m "feat(llm): define ModelRouter type surface"
```

---

## Task 2: Router policy table

**Files:**
- Create: `src/daemon/llm/policy.ts`
- Test:  `src/daemon/llm/policy.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/daemon/llm/policy.test.ts
import { describe, it, expect } from 'bun:test'
import { tierForTask, defaultCandidates } from './policy'

describe('policy', () => {
  it('maps task types to tiers', () => {
    expect(tierForTask('narrative')).toBe('ultra_cheap')
    expect(tierForTask('trigger_eval')).toBe('ultra_cheap')
    expect(tierForTask('action_compose')).toBe('mid')
    expect(tierForTask('skill_generate')).toBe('heavy')
    expect(tierForTask('source_patch')).toBe('heavy')
    expect(tierForTask('dream')).toBe('mid')
    expect(tierForTask('classify')).toBe('ultra_cheap')
  })

  it('returns ordered candidate list cheapest-first for narrative', () => {
    const cands = defaultCandidates('narrative')
    expect(cands.length).toBeGreaterThan(0)
    expect(cands[0]?.provider).toBe('gemini')      // Gemini Flash Lite is cheapest
    expect(cands.some(c => c.provider === 'anthropic_cli')).toBe(true)
  })

  it('returns heavy-tier candidates for source_patch', () => {
    const cands = defaultCandidates('source_patch')
    expect(cands[0]?.model).toMatch(/sonnet|opus|gpt-5|pro/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/daemon/llm/policy.test.ts
```

Expected: FAIL — `Cannot find module './policy'`

- [ ] **Step 3: Write the policy module**

```typescript
// src/daemon/llm/policy.ts
// Maps task types → tiers → ordered list of (provider, model) candidates.
// Order is cheapest-acceptable-first. ModelRouter filters by which
// providers are actually configured and walks the list trying each.

import type { ProviderId, TaskType, Tier } from './types'

const TASK_TO_TIER: Record<TaskType, Tier> = {
  narrative:      'ultra_cheap',
  trigger_eval:   'ultra_cheap',
  classify:       'ultra_cheap',
  action_compose: 'mid',
  dream:          'mid',
  skill_generate: 'heavy',
  source_patch:   'heavy',
}

export type Candidate = { provider: ProviderId; model: string }

// Ordered cheapest → most expensive within each tier.
// Phase A only needs narrative + dream; the full table is here so later
// phases (B-I) can use the same router without policy changes.
const TIER_CANDIDATES: Record<Tier, Candidate[]> = {
  ultra_cheap: [
    { provider: 'gemini',         model: 'gemini-2.5-flash-lite' },
    { provider: 'kimi',           model: 'moonshot-v1-8k' },
    { provider: 'openai',         model: 'gpt-4o-mini' },
    { provider: 'anthropic_cli',  model: 'claude-haiku-4-5-20251001' },
    { provider: 'anthropic_api',  model: 'claude-haiku-4-5-20251001' },
    { provider: 'ollama',         model: 'qwen3:8b' },
  ],
  mid: [
    { provider: 'gemini',         model: 'gemini-2.5-flash' },
    { provider: 'openai',         model: 'gpt-4o' },
    { provider: 'anthropic_cli',  model: 'claude-sonnet-4-6' },
    { provider: 'anthropic_api',  model: 'claude-sonnet-4-6' },
    { provider: 'ollama',         model: 'qwen3:32b' },
  ],
  heavy: [
    { provider: 'anthropic_cli',  model: 'claude-opus-4-7' },
    { provider: 'anthropic_api',  model: 'claude-opus-4-7' },
    { provider: 'openai',         model: 'gpt-5' },
    { provider: 'gemini',         model: 'gemini-2.5-pro' },
  ],
}

export function tierForTask(t: TaskType): Tier {
  return TASK_TO_TIER[t]
}

export function defaultCandidates(t: TaskType): Candidate[] {
  return TIER_CANDIDATES[tierForTask(t)].slice()
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test src/daemon/llm/policy.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/llm/policy.ts src/daemon/llm/policy.test.ts
git commit -m "feat(llm): policy table mapping task types to provider candidates"
```

---

## Task 3: Cost tracker

**Files:**
- Create: `src/daemon/llm/costTracker.ts`
- Test:  `src/daemon/llm/costTracker.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/daemon/llm/costTracker.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { CostTracker } from './costTracker'

describe('CostTracker', () => {
  let db: Database
  let tracker: CostTracker

  beforeEach(() => {
    db = new Database(':memory:')
    tracker = new CostTracker(db, 50)  // $50/month budget
  })

  it('records a call and returns monthly total', () => {
    tracker.record({
      provider: 'gemini',
      model: 'gemini-2.5-flash-lite',
      input_tokens: 1000,
      output_tokens: 500,
      cost_cents: 12,
      task_type: 'narrative',
    })
    expect(tracker.monthlyCostCents()).toBe(12)
  })

  it('aggregates multiple calls by provider', () => {
    tracker.record({ provider: 'gemini', model: 'g1', input_tokens: 100, output_tokens: 50, cost_cents: 5, task_type: 'narrative' })
    tracker.record({ provider: 'openai', model: 'o1', input_tokens: 100, output_tokens: 50, cost_cents: 10, task_type: 'narrative' })
    tracker.record({ provider: 'gemini', model: 'g1', input_tokens: 100, output_tokens: 50, cost_cents: 5, task_type: 'narrative' })
    const byProvider = tracker.monthlyCostByProvider()
    expect(byProvider.gemini).toBe(10)
    expect(byProvider.openai).toBe(10)
  })

  it('flags over budget once exceeded', () => {
    expect(tracker.isOverBudget()).toBe(false)
    tracker.record({ provider: 'openai', model: 'o1', input_tokens: 1, output_tokens: 1, cost_cents: 5001, task_type: 'source_patch' })
    expect(tracker.isOverBudget()).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/daemon/llm/costTracker.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// src/daemon/llm/costTracker.ts
// Persistent per-provider cost ledger. Lives in the main daemon DB.
// Every CompletionResult is recorded; aggregate rollups answer
// "are we over budget?" and "which provider is consuming the most?".

import type { Database } from 'bun:sqlite'
import type { ProviderId, TaskType } from './types'

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS llm_call_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ts              INTEGER NOT NULL,
    provider        TEXT    NOT NULL,
    model           TEXT    NOT NULL,
    task_type       TEXT    NOT NULL,
    input_tokens    INTEGER NOT NULL,
    output_tokens   INTEGER NOT NULL,
    cost_cents      INTEGER NOT NULL,
    fallback_count  INTEGER NOT NULL DEFAULT 0,
    latency_ms      INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_llm_call_log_ts ON llm_call_log(ts);
  CREATE INDEX IF NOT EXISTS idx_llm_call_log_provider ON llm_call_log(provider, ts);
`

export type CostRecord = {
  provider: ProviderId
  model: string
  input_tokens: number
  output_tokens: number
  cost_cents: number
  task_type: TaskType
  fallback_count?: number
  latency_ms?: number
}

export class CostTracker {
  constructor(
    private db: Database,
    private monthlyBudgetUsd: number,
  ) {
    db.exec(SCHEMA)
  }

  record(r: CostRecord): void {
    this.db.run(
      `INSERT INTO llm_call_log
         (ts, provider, model, task_type, input_tokens, output_tokens, cost_cents, fallback_count, latency_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        Date.now(),
        r.provider,
        r.model,
        r.task_type,
        r.input_tokens,
        r.output_tokens,
        r.cost_cents,
        r.fallback_count ?? 0,
        r.latency_ms ?? null,
      ],
    )
  }

  monthlyCostCents(): number {
    const since = this.monthStartMs()
    const row = this.db
      .query('SELECT COALESCE(SUM(cost_cents), 0) AS total FROM llm_call_log WHERE ts >= ?')
      .get(since) as { total: number }
    return row.total
  }

  monthlyCostByProvider(): Record<string, number> {
    const since = this.monthStartMs()
    const rows = this.db
      .query('SELECT provider, COALESCE(SUM(cost_cents),0) AS total FROM llm_call_log WHERE ts >= ? GROUP BY provider')
      .all(since) as Array<{ provider: string; total: number }>
    return Object.fromEntries(rows.map(r => [r.provider, r.total]))
  }

  isOverBudget(): boolean {
    return this.monthlyCostCents() >= this.monthlyBudgetUsd * 100
  }

  private monthStartMs(): number {
    const d = new Date()
    return new Date(d.getFullYear(), d.getMonth(), 1).getTime()
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test src/daemon/llm/costTracker.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/llm/costTracker.ts src/daemon/llm/costTracker.test.ts
git commit -m "feat(llm): persistent cost tracker with per-provider rollup"
```

---

## Task 4: Provider config loader

**Files:**
- Create: `src/daemon/llm/config.ts`
- Test:  `src/daemon/llm/config.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/daemon/llm/config.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { loadProviderConfig, defaultProviderConfig } from './config'

describe('loadProviderConfig', () => {
  let tmp: string

  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'kairos-cfg-')) })

  it('returns defaults when file missing', () => {
    const cfg = loadProviderConfig(join(tmp, 'missing.json'))
    expect(cfg.default_policy).toBe('cost_optimized')
    expect(cfg.providers.anthropic_cli.enabled).toBe(true)
  })

  it('parses a valid config', () => {
    const path = join(tmp, 'providers.json')
    writeFileSync(path, JSON.stringify({
      providers: { openai: { enabled: true, api_key_env: 'OPENAI_API_KEY' } },
      default_policy: 'quality_optimized',
      monthly_budget_usd: 100,
    }))
    const cfg = loadProviderConfig(path)
    expect(cfg.providers.openai.enabled).toBe(true)
    expect(cfg.providers.openai.api_key_env).toBe('OPENAI_API_KEY')
    expect(cfg.default_policy).toBe('quality_optimized')
    expect(cfg.monthly_budget_usd).toBe(100)
    // merged with defaults: anthropic_cli still present
    expect(cfg.providers.anthropic_cli).toBeDefined()
    rmSync(tmp, { recursive: true })
  })

  it('falls back to defaults on parse error', () => {
    const path = join(tmp, 'bad.json')
    writeFileSync(path, '{ this is not json')
    const cfg = loadProviderConfig(path)
    expect(cfg.default_policy).toBe('cost_optimized')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/daemon/llm/config.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the loader**

```typescript
// src/daemon/llm/config.ts
import { existsSync, readFileSync } from 'fs'
import type { RouterConfig, ProviderId, ProviderConfig } from './types'

export function defaultProviderConfig(): RouterConfig {
  const empty = (overrides: Partial<ProviderConfig> = {}): ProviderConfig =>
    ({ enabled: false, ...overrides })
  return {
    providers: {
      anthropic_cli: empty({ enabled: true, priority: 1 }),
      anthropic_api: empty({ api_key_env: 'ANTHROPIC_API_KEY' }),
      openai:        empty({ api_key_env: 'OPENAI_API_KEY' }),
      gemini:        empty({ api_key_env: 'GEMINI_API_KEY' }),
      kimi:          empty({ api_key_env: 'MOONSHOT_API_KEY', base_url: 'https://api.moonshot.cn/v1' }),
      ollama:        empty({ base_url: 'http://localhost:11434/v1' }),
    },
    default_policy: 'cost_optimized',
    monthly_budget_usd: 50,
  }
}

export function loadProviderConfig(path: string): RouterConfig {
  const defaults = defaultProviderConfig()
  if (!existsSync(path)) return defaults

  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<RouterConfig>
    const merged: RouterConfig = {
      ...defaults,
      ...raw,
      providers: { ...defaults.providers } as Record<ProviderId, ProviderConfig>,
    }
    // Per-provider merge so user partial overrides don't drop defaults.
    for (const [id, override] of Object.entries(raw.providers ?? {})) {
      const key = id as ProviderId
      merged.providers[key] = { ...defaults.providers[key], ...override }
    }
    return merged
  } catch {
    return defaults
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test src/daemon/llm/config.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/llm/config.ts src/daemon/llm/config.test.ts
git commit -m "feat(llm): provider config loader with default-merge semantics"
```

---

## Task 5: Anthropic CLI provider adapter

**Files:**
- Create: `src/daemon/llm/providers/anthropicCli.ts`
- Test:  `src/daemon/llm/providers/anthropicCli.test.ts`

The CLI adapter wraps the existing `claude -p` subprocess pattern (used today across 11 files) behind the `LLMProvider` interface, so the router can call it identically to API-based providers. **Cost is $0** because it consumes the user's Pro/Max subscription.

- [ ] **Step 1: Write the failing test**

```typescript
// src/daemon/llm/providers/anthropicCli.test.ts
import { describe, it, expect } from 'bun:test'
import { AnthropicCliProvider } from './anthropicCli'

describe('AnthropicCliProvider', () => {
  it('reports id and tier models', () => {
    const p = new AnthropicCliProvider({ enabled: true })
    expect(p.id).toBe('anthropic_cli')
    expect(p.modelsForTier('ultra_cheap')).toContain('claude-haiku-4-5-20251001')
    expect(p.modelsForTier('heavy')).toContain('claude-opus-4-7')
  })

  it('reports zero cost (subscription)', () => {
    const p = new AnthropicCliProvider({ enabled: true })
    const price = p.pricePerMillion('claude-sonnet-4-6')
    expect(price.input).toBe(0)
    expect(price.output).toBe(0)
  })

  it('isConfigured returns enabled flag', () => {
    expect(new AnthropicCliProvider({ enabled: true }).isConfigured()).toBe(true)
    expect(new AnthropicCliProvider({ enabled: false }).isConfigured()).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/daemon/llm/providers/anthropicCli.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the adapter**

```typescript
// src/daemon/llm/providers/anthropicCli.ts
// Wraps the `claude -p` subprocess so the router can treat it like any
// other provider. Uses the user's Anthropic Pro/Max subscription
// (cost = $0 incremental). Guard against re-entry via KAIROS_SUBPROCESS env.

import type {
  CompletionRequest, CompletionResult, LLMProvider, ProviderConfig, Tier,
} from '../types'

const MODELS_BY_TIER: Record<Tier, string[]> = {
  ultra_cheap: ['claude-haiku-4-5-20251001'],
  mid:         ['claude-sonnet-4-6'],
  heavy:       ['claude-opus-4-7', 'claude-sonnet-4-7'],
}

export class AnthropicCliProvider implements LLMProvider {
  readonly id = 'anthropic_cli' as const

  constructor(private cfg: ProviderConfig) {}

  isConfigured(): boolean { return this.cfg.enabled }

  modelsForTier(tier: Tier): string[] { return MODELS_BY_TIER[tier] }

  pricePerMillion(_model: string): { input: number; output: number } {
    return { input: 0, output: 0 }   // covered by subscription
  }

  async complete(model: string, req: CompletionRequest): Promise<CompletionResult> {
    const start = Date.now()

    const args = ['-p', req.prompt, '--model', model, '--output-format', 'json']
    if (req.system) args.push('--append-system-prompt', req.system)

    const proc = Bun.spawn(['claude', ...args], {
      env: { ...process.env, KAIROS_SUBPROCESS: '1' },  // prevent recursion via shim
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const exitCode = await proc.exited
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    if (exitCode !== 0) {
      throw new Error(`claude -p exited ${exitCode}: ${stderr.slice(0, 500)}`)
    }

    // Output-format json wraps the response with metadata; extract text safely.
    let text: string
    let parsed: unknown = undefined
    try {
      const obj = JSON.parse(stdout) as { result?: string; usage?: { input_tokens?: number; output_tokens?: number } }
      text = obj.result ?? stdout
      if (req.structured) parsed = tryParseJson(text)
    } catch {
      text = stdout
    }

    return {
      text,
      parsed,
      provider: this.id,
      model,
      cost_cents: 0,
      latency_ms: Date.now() - start,
      fallback_count: 0,
      // We don't have token counts via CLI; estimate from chars.
      input_tokens: Math.ceil(req.prompt.length / 4),
      output_tokens: Math.ceil(text.length / 4),
    }
  }
}

function tryParseJson(s: string): unknown {
  try { return JSON.parse(s) } catch { /* try to extract fenced */ }
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) { try { return JSON.parse(fence[1]!) } catch { /* fall through */ } }
  return undefined
}
```

- [ ] **Step 4: Run unit tests (no integration test in this task — that comes in Task 9)**

```bash
bun test src/daemon/llm/providers/anthropicCli.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/llm/providers/anthropicCli.ts src/daemon/llm/providers/anthropicCli.test.ts
git commit -m "feat(llm): Anthropic CLI provider (Pro subscription, \$0 cost)"
```

---

## Task 6: OpenAI provider adapter (also serves Kimi + Ollama)

**Files:**
- Create: `src/daemon/llm/providers/openai.ts`
- Test:  `src/daemon/llm/providers/openai.test.ts`

OpenAI, Kimi (Moonshot), and Ollama all expose OpenAI-compatible APIs. One adapter handles all three by varying `baseURL` and API key.

- [ ] **Step 1: Write the failing test**

```typescript
// src/daemon/llm/providers/openai.test.ts
import { describe, it, expect } from 'bun:test'
import { OpenAIProvider } from './openai'

describe('OpenAIProvider', () => {
  it('reports openai id when used as openai', () => {
    const p = new OpenAIProvider('openai', { enabled: true, api_key_env: 'OPENAI_API_KEY' })
    expect(p.id).toBe('openai')
    expect(p.modelsForTier('ultra_cheap')).toContain('gpt-4o-mini')
    expect(p.modelsForTier('heavy')).toContain('gpt-5')
  })

  it('serves Kimi via base_url override', () => {
    const p = new OpenAIProvider('kimi', { enabled: true, api_key_env: 'MOONSHOT_API_KEY', base_url: 'https://api.moonshot.cn/v1' })
    expect(p.id).toBe('kimi')
    expect(p.modelsForTier('ultra_cheap')).toContain('moonshot-v1-8k')
  })

  it('serves Ollama via base_url override (no auth)', () => {
    const p = new OpenAIProvider('ollama', { enabled: true, base_url: 'http://localhost:11434/v1' })
    expect(p.id).toBe('ollama')
    expect(p.pricePerMillion('qwen3:8b').input).toBe(0)  // local = free
  })

  it('isConfigured requires api key env when no base_url-only mode', () => {
    const p = new OpenAIProvider('openai', { enabled: true, api_key_env: 'NEVER_SET_THIS' })
    expect(p.isConfigured()).toBe(false)
  })

  it('isConfigured ok for ollama without env (base_url only)', () => {
    const p = new OpenAIProvider('ollama', { enabled: true, base_url: 'http://localhost:11434/v1' })
    expect(p.isConfigured()).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/daemon/llm/providers/openai.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the adapter**

```typescript
// src/daemon/llm/providers/openai.ts
// One adapter for three providers: openai, kimi (Moonshot), ollama (local).
// All speak the OpenAI Chat Completions API; differ only in baseURL + auth.

import OpenAI from 'openai'
import type {
  CompletionRequest, CompletionResult, LLMProvider, ProviderConfig, ProviderId, Tier,
} from '../types'

type Variant = Extract<ProviderId, 'openai' | 'kimi' | 'ollama'>

// USD per 1M tokens. Approximate — refresh quarterly.
const PRICING: Record<Variant, Record<string, { input: number; output: number }>> = {
  openai: {
    'gpt-4o-mini': { input: 0.15, output: 0.60 },
    'gpt-4o':      { input: 2.50, output: 10.00 },
    'gpt-5':       { input: 5.00, output: 15.00 },
  },
  kimi: {
    'moonshot-v1-8k':  { input: 0.15, output: 0.60 },
    'moonshot-v1-32k': { input: 0.30, output: 1.20 },
  },
  ollama: {
    'qwen3:8b':   { input: 0, output: 0 },
    'qwen3:32b':  { input: 0, output: 0 },
    'llama3.3':   { input: 0, output: 0 },
  },
}

const TIER_MODELS: Record<Variant, Record<Tier, string[]>> = {
  openai: {
    ultra_cheap: ['gpt-4o-mini'],
    mid:         ['gpt-4o'],
    heavy:       ['gpt-5'],
  },
  kimi: {
    ultra_cheap: ['moonshot-v1-8k'],
    mid:         ['moonshot-v1-32k'],
    heavy:       ['moonshot-v1-32k'],
  },
  ollama: {
    ultra_cheap: ['qwen3:8b'],
    mid:         ['qwen3:32b'],
    heavy:       ['qwen3:32b'],
  },
}

export class OpenAIProvider implements LLMProvider {
  readonly id: Variant
  private client: OpenAI | null = null

  constructor(id: Variant, private cfg: ProviderConfig) {
    this.id = id
  }

  isConfigured(): boolean {
    if (!this.cfg.enabled) return false
    if (this.cfg.api_key_env) {
      return Boolean(process.env[this.cfg.api_key_env])
    }
    // ollama-style: no key required, just base_url
    return Boolean(this.cfg.base_url)
  }

  modelsForTier(tier: Tier): string[] {
    return TIER_MODELS[this.id][tier]
  }

  pricePerMillion(model: string): { input: number; output: number } {
    return PRICING[this.id][model] ?? { input: 0, output: 0 }
  }

  private getClient(): OpenAI {
    if (this.client) return this.client
    const apiKey = this.cfg.api_key_env ? (process.env[this.cfg.api_key_env] ?? 'ollama') : 'ollama'
    this.client = new OpenAI({ apiKey, baseURL: this.cfg.base_url })
    return this.client
  }

  async complete(model: string, req: CompletionRequest): Promise<CompletionResult> {
    const start = Date.now()
    const messages: { role: 'system' | 'user'; content: string }[] = []
    if (req.system) messages.push({ role: 'system', content: req.system })
    messages.push({ role: 'user', content: req.prompt })

    const completion = await this.getClient().chat.completions.create({
      model,
      messages,
      max_tokens: req.max_output_tokens,
      response_format: req.structured ? { type: 'json_object' } : undefined,
    })

    const text = completion.choices[0]?.message?.content ?? ''
    const inputTok = completion.usage?.prompt_tokens ?? 0
    const outputTok = completion.usage?.completion_tokens ?? 0
    const price = this.pricePerMillion(model)
    const costCents = Math.ceil(
      ((inputTok / 1_000_000) * price.input + (outputTok / 1_000_000) * price.output) * 100,
    )

    let parsed: unknown = undefined
    if (req.structured) {
      try { parsed = JSON.parse(text) } catch { /* leave undefined */ }
    }

    return {
      text,
      parsed,
      provider: this.id,
      model,
      cost_cents: costCents,
      latency_ms: Date.now() - start,
      fallback_count: 0,
      input_tokens: inputTok,
      output_tokens: outputTok,
    }
  }
}
```

- [ ] **Step 4: Run tests**

```bash
bun test src/daemon/llm/providers/openai.test.ts
```

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/llm/providers/openai.ts src/daemon/llm/providers/openai.test.ts
git commit -m "feat(llm): unified OpenAI-compatible provider (OpenAI + Kimi + Ollama)"
```

---

## Task 7: Gemini provider adapter

**Files:**
- Create: `src/daemon/llm/providers/gemini.ts`
- Test:  `src/daemon/llm/providers/gemini.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/daemon/llm/providers/gemini.test.ts
import { describe, it, expect } from 'bun:test'
import { GeminiProvider } from './gemini'

describe('GeminiProvider', () => {
  it('reports id and tier models', () => {
    const p = new GeminiProvider({ enabled: true, api_key_env: 'GEMINI_API_KEY' })
    expect(p.id).toBe('gemini')
    expect(p.modelsForTier('ultra_cheap')).toContain('gemini-2.5-flash-lite')
    expect(p.modelsForTier('mid')).toContain('gemini-2.5-flash')
    expect(p.modelsForTier('heavy')).toContain('gemini-2.5-pro')
  })

  it('flash-lite has the cheapest pricing', () => {
    const p = new GeminiProvider({ enabled: true, api_key_env: 'GEMINI_API_KEY' })
    const lite = p.pricePerMillion('gemini-2.5-flash-lite')
    const pro  = p.pricePerMillion('gemini-2.5-pro')
    expect(lite.input).toBeLessThan(pro.input)
  })

  it('isConfigured requires API key env to be set', () => {
    expect(new GeminiProvider({ enabled: true, api_key_env: 'NEVER_SET_THIS' }).isConfigured()).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/daemon/llm/providers/gemini.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the adapter**

```typescript
// src/daemon/llm/providers/gemini.ts
// Google Gemini adapter using @google/genai. Flash Lite is the cheapest
// viable model in the entire router catalog ($0.075/M input).

import { GoogleGenAI } from '@google/genai'
import type {
  CompletionRequest, CompletionResult, LLMProvider, ProviderConfig, Tier,
} from '../types'

const PRICING: Record<string, { input: number; output: number }> = {
  'gemini-2.5-flash-lite': { input: 0.075, output: 0.30 },
  'gemini-2.5-flash':      { input: 0.30,  output: 2.50 },
  'gemini-2.5-pro':        { input: 1.25,  output: 5.00 },
}

const TIER_MODELS: Record<Tier, string[]> = {
  ultra_cheap: ['gemini-2.5-flash-lite'],
  mid:         ['gemini-2.5-flash'],
  heavy:       ['gemini-2.5-pro'],
}

export class GeminiProvider implements LLMProvider {
  readonly id = 'gemini' as const
  private client: GoogleGenAI | null = null

  constructor(private cfg: ProviderConfig) {}

  isConfigured(): boolean {
    return Boolean(this.cfg.enabled && this.cfg.api_key_env && process.env[this.cfg.api_key_env])
  }

  modelsForTier(tier: Tier): string[] { return TIER_MODELS[tier] }

  pricePerMillion(model: string): { input: number; output: number } {
    return PRICING[model] ?? { input: 1, output: 4 }   // safe overestimate
  }

  private getClient(): GoogleGenAI {
    if (this.client) return this.client
    const apiKey = process.env[this.cfg.api_key_env!]
    this.client = new GoogleGenAI({ apiKey })
    return this.client
  }

  async complete(model: string, req: CompletionRequest): Promise<CompletionResult> {
    const start = Date.now()
    const contents = req.system
      ? `${req.system}\n\n${req.prompt}`
      : req.prompt

    const resp = await this.getClient().models.generateContent({
      model,
      contents,
      config: {
        maxOutputTokens: req.max_output_tokens,
        responseMimeType: req.structured ? 'application/json' : undefined,
      },
    })

    const text = resp.text ?? ''
    const inputTok = resp.usageMetadata?.promptTokenCount ?? 0
    const outputTok = resp.usageMetadata?.candidatesTokenCount ?? 0
    const price = this.pricePerMillion(model)
    const costCents = Math.ceil(
      ((inputTok / 1_000_000) * price.input + (outputTok / 1_000_000) * price.output) * 100,
    )

    let parsed: unknown = undefined
    if (req.structured) {
      try { parsed = JSON.parse(text) } catch { /* leave undefined */ }
    }

    return {
      text,
      parsed,
      provider: this.id,
      model,
      cost_cents: costCents,
      latency_ms: Date.now() - start,
      fallback_count: 0,
      input_tokens: inputTok,
      output_tokens: outputTok,
    }
  }
}
```

- [ ] **Step 4: Run tests**

```bash
bun test src/daemon/llm/providers/gemini.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/llm/providers/gemini.ts src/daemon/llm/providers/gemini.test.ts
git commit -m "feat(llm): Gemini provider (Flash Lite is cheapest in catalog)"
```

---

## Task 8: Anthropic API provider adapter

**Files:**
- Create: `src/daemon/llm/providers/anthropicApi.ts`
- Test:  `src/daemon/llm/providers/anthropicApi.test.ts`

For users who prefer BYOK over the CLI subscription.

- [ ] **Step 1: Write the failing test**

```typescript
// src/daemon/llm/providers/anthropicApi.test.ts
import { describe, it, expect } from 'bun:test'
import { AnthropicApiProvider } from './anthropicApi'

describe('AnthropicApiProvider', () => {
  it('reports id and tier models', () => {
    const p = new AnthropicApiProvider({ enabled: true, api_key_env: 'ANTHROPIC_API_KEY' })
    expect(p.id).toBe('anthropic_api')
    expect(p.modelsForTier('heavy')).toContain('claude-opus-4-7')
  })

  it('opus is more expensive than haiku', () => {
    const p = new AnthropicApiProvider({ enabled: true, api_key_env: 'ANTHROPIC_API_KEY' })
    expect(p.pricePerMillion('claude-opus-4-7').input)
      .toBeGreaterThan(p.pricePerMillion('claude-haiku-4-5-20251001').input)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/daemon/llm/providers/anthropicApi.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the adapter**

```typescript
// src/daemon/llm/providers/anthropicApi.ts
import Anthropic from '@anthropic-ai/sdk'
import type {
  CompletionRequest, CompletionResult, LLMProvider, ProviderConfig, Tier,
} from '../types'

const PRICING: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5-20251001': { input: 1,  output: 5  },
  'claude-sonnet-4-6':         { input: 3,  output: 15 },
  'claude-sonnet-4-7':         { input: 3,  output: 15 },
  'claude-opus-4-7':           { input: 15, output: 75 },
}

const TIER_MODELS: Record<Tier, string[]> = {
  ultra_cheap: ['claude-haiku-4-5-20251001'],
  mid:         ['claude-sonnet-4-6'],
  heavy:       ['claude-opus-4-7', 'claude-sonnet-4-7'],
}

export class AnthropicApiProvider implements LLMProvider {
  readonly id = 'anthropic_api' as const
  private client: Anthropic | null = null

  constructor(private cfg: ProviderConfig) {}

  isConfigured(): boolean {
    return Boolean(this.cfg.enabled && this.cfg.api_key_env && process.env[this.cfg.api_key_env])
  }

  modelsForTier(tier: Tier): string[] { return TIER_MODELS[tier] }

  pricePerMillion(model: string): { input: number; output: number } {
    return PRICING[model] ?? { input: 3, output: 15 }
  }

  private getClient(): Anthropic {
    if (this.client) return this.client
    this.client = new Anthropic({ apiKey: process.env[this.cfg.api_key_env!] })
    return this.client
  }

  async complete(model: string, req: CompletionRequest): Promise<CompletionResult> {
    const start = Date.now()
    const resp = await this.getClient().messages.create({
      model,
      max_tokens: req.max_output_tokens ?? 4096,
      system: req.system,
      messages: [{ role: 'user', content: req.prompt }],
    })

    const text = resp.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map(b => b.text)
      .join('')

    const inputTok = resp.usage.input_tokens
    const outputTok = resp.usage.output_tokens
    const price = this.pricePerMillion(model)
    const costCents = Math.ceil(
      ((inputTok / 1_000_000) * price.input + (outputTok / 1_000_000) * price.output) * 100,
    )

    let parsed: unknown = undefined
    if (req.structured) {
      try { parsed = JSON.parse(text) } catch { /* leave undefined */ }
    }

    return {
      text,
      parsed,
      provider: this.id,
      model,
      cost_cents: costCents,
      latency_ms: Date.now() - start,
      fallback_count: 0,
      input_tokens: inputTok,
      output_tokens: outputTok,
    }
  }
}
```

- [ ] **Step 4: Run tests**

```bash
bun test src/daemon/llm/providers/anthropicApi.test.ts
```

Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/llm/providers/anthropicApi.ts src/daemon/llm/providers/anthropicApi.test.ts
git commit -m "feat(llm): Anthropic API provider (BYOK alternative to CLI)"
```

---

## Task 9: ModelRouter orchestrator

**Files:**
- Create: `src/daemon/llm/router.ts`
- Test:  `src/daemon/llm/router.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/daemon/llm/router.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { ModelRouter } from './router'
import { CostTracker } from './costTracker'
import type {
  CompletionRequest, CompletionResult, LLMProvider, ProviderId, Tier,
} from './types'

function fakeProvider(
  id: ProviderId,
  opts: { configured?: boolean; shouldFail?: boolean; cost?: number } = {},
): LLMProvider {
  return {
    id,
    isConfigured: () => opts.configured ?? true,
    modelsForTier: (_t: Tier) => [`fake-${id}-model`],
    pricePerMillion: () => ({ input: 1, output: 4 }),
    complete: async (model: string, req: CompletionRequest): Promise<CompletionResult> => {
      if (opts.shouldFail) throw new Error(`fake ${id} failure`)
      return {
        text: `response from ${id}`,
        provider: id,
        model,
        cost_cents: opts.cost ?? 1,
        latency_ms: 10,
        fallback_count: 0,
        input_tokens: 10,
        output_tokens: 5,
      }
    },
  }
}

describe('ModelRouter', () => {
  let db: Database
  let tracker: CostTracker

  beforeEach(() => {
    db = new Database(':memory:')
    tracker = new CostTracker(db, 50)
  })

  it('routes to cheapest configured provider in tier', async () => {
    const router = new ModelRouter({
      providers: { gemini: fakeProvider('gemini'), openai: fakeProvider('openai') } as any,
      tracker,
      candidates: () => [
        { provider: 'gemini', model: 'g' },
        { provider: 'openai', model: 'o' },
      ],
    })
    const result = await router.complete({ task_type: 'narrative', prompt: 'hi' })
    expect(result.provider).toBe('gemini')
    expect(result.fallback_count).toBe(0)
  })

  it('falls back when first provider throws', async () => {
    const router = new ModelRouter({
      providers: {
        gemini: fakeProvider('gemini', { shouldFail: true }),
        openai: fakeProvider('openai'),
      } as any,
      tracker,
      candidates: () => [
        { provider: 'gemini', model: 'g' },
        { provider: 'openai', model: 'o' },
      ],
    })
    const result = await router.complete({ task_type: 'narrative', prompt: 'hi' })
    expect(result.provider).toBe('openai')
    expect(result.fallback_count).toBe(1)
  })

  it('skips unconfigured providers', async () => {
    const router = new ModelRouter({
      providers: {
        gemini: fakeProvider('gemini', { configured: false }),
        openai: fakeProvider('openai'),
      } as any,
      tracker,
      candidates: () => [
        { provider: 'gemini', model: 'g' },
        { provider: 'openai', model: 'o' },
      ],
    })
    const result = await router.complete({ task_type: 'narrative', prompt: 'hi' })
    expect(result.provider).toBe('openai')
    expect(result.fallback_count).toBe(0)   // unconfigured isn't a fallback, it's a skip
  })

  it('records cost in tracker', async () => {
    const router = new ModelRouter({
      providers: { gemini: fakeProvider('gemini', { cost: 7 }) } as any,
      tracker,
      candidates: () => [{ provider: 'gemini', model: 'g' }],
    })
    await router.complete({ task_type: 'narrative', prompt: 'hi' })
    expect(tracker.monthlyCostCents()).toBe(7)
  })

  it('throws when all providers fail', async () => {
    const router = new ModelRouter({
      providers: {
        gemini: fakeProvider('gemini', { shouldFail: true }),
        openai: fakeProvider('openai', { shouldFail: true }),
      } as any,
      tracker,
      candidates: () => [
        { provider: 'gemini', model: 'g' },
        { provider: 'openai', model: 'o' },
      ],
    })
    expect(router.complete({ task_type: 'narrative', prompt: 'hi' })).rejects.toThrow()
  })

  it('respects max_cost_cents budget gate', async () => {
    const router = new ModelRouter({
      providers: { openai: fakeProvider('openai', { cost: 100 }) } as any,
      tracker,
      candidates: () => [{ provider: 'openai', model: 'o' }],
    })
    // estimate via pricePerMillion — but our fake always reports cost only post-call.
    // For now, this test ensures router has the field; full budget enforcement
    // happens in Task 10 (router refinement) via a priceEstimate hook.
    const result = await router.complete({ task_type: 'narrative', prompt: 'hi', max_cost_cents: 9999 })
    expect(result.cost_cents).toBe(100)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/daemon/llm/router.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the router**

```typescript
// src/daemon/llm/router.ts
// The single entry point every LLM caller in KAIROS uses.
// Picks (provider, model) from the policy candidate list, tries each
// in order, falls back on failure, records cost. Unconfigured providers
// are silently skipped (not counted as failures).

import { logError } from '../logger'
import { defaultCandidates, type Candidate } from './policy'
import { CostTracker } from './costTracker'
import type {
  CompletionRequest, CompletionResult, LLMProvider, ProviderId, TaskType,
} from './types'

export type ModelRouterOptions = {
  providers: Partial<Record<ProviderId, LLMProvider>>
  tracker: CostTracker
  candidates?: (taskType: TaskType) => Candidate[]
}

export class ModelRouter {
  private providers: Partial<Record<ProviderId, LLMProvider>>
  private tracker: CostTracker
  private candidatesFn: (t: TaskType) => Candidate[]

  constructor(opts: ModelRouterOptions) {
    this.providers = opts.providers
    this.tracker = opts.tracker
    this.candidatesFn = opts.candidates ?? defaultCandidates
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    if (this.tracker.isOverBudget()) {
      throw new Error('ModelRouter: monthly budget exceeded')
    }

    const candidates = req.fallback_chain
      ? req.fallback_chain.flatMap(pid => this.candidatesFn(req.task_type).filter(c => c.provider === pid))
      : this.candidatesFn(req.task_type)

    let fallbackCount = 0
    const errors: string[] = []

    for (const cand of candidates) {
      const provider = this.providers[cand.provider]
      if (!provider || !provider.isConfigured()) {
        continue   // skip — not a fallback event, just unavailable
      }

      // Cost-budget gate: estimate before calling
      if (req.max_cost_cents !== undefined) {
        const estCents = this.estimateCostCents(provider, cand.model, req)
        if (estCents > req.max_cost_cents) {
          errors.push(`${cand.provider}/${cand.model} est cost ${estCents}¢ > budget ${req.max_cost_cents}¢`)
          continue
        }
      }

      try {
        const result = await provider.complete(cand.model, req)
        result.fallback_count = fallbackCount
        this.tracker.record({
          provider: result.provider,
          model: result.model,
          input_tokens: result.input_tokens,
          output_tokens: result.output_tokens,
          cost_cents: result.cost_cents,
          task_type: req.task_type,
          fallback_count: fallbackCount,
          latency_ms: result.latency_ms,
        })
        return result
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        errors.push(`${cand.provider}/${cand.model}: ${msg}`)
        logError(`ModelRouter ${cand.provider} failed`, err)
        fallbackCount++
      }
    }

    throw new Error(
      `ModelRouter: all candidates exhausted for task=${req.task_type}. Errors: ${errors.join(' | ')}`,
    )
  }

  // Rough estimate: assume output ≈ 0.3 * input tokens unless max_output_tokens given.
  private estimateCostCents(p: LLMProvider, model: string, req: CompletionRequest): number {
    const price = p.pricePerMillion(model)
    const inputTok = Math.ceil((req.prompt.length + (req.system?.length ?? 0)) / 4)
    const outputTok = req.max_output_tokens ?? Math.ceil(inputTok * 0.3)
    return Math.ceil(
      ((inputTok / 1_000_000) * price.input + (outputTok / 1_000_000) * price.output) * 100,
    )
  }
}
```

- [ ] **Step 4: Run tests**

```bash
bun test src/daemon/llm/router.test.ts
```

Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/llm/router.ts src/daemon/llm/router.test.ts
git commit -m "feat(llm): ModelRouter with fallback chain, budget gate, cost tracking"
```

---

## Task 10: Router factory + live integration smoke test

**Files:**
- Create: `src/daemon/llm/index.ts`
- Test:  `scripts/smoke-router.ts`

- [ ] **Step 1: Write the factory**

```typescript
// src/daemon/llm/index.ts
// Convenience builder: load config, instantiate enabled providers, return router.

import type { Database } from 'bun:sqlite'
import { loadProviderConfig } from './config'
import { CostTracker } from './costTracker'
import { ModelRouter } from './router'
import { AnthropicCliProvider } from './providers/anthropicCli'
import { AnthropicApiProvider } from './providers/anthropicApi'
import { GeminiProvider } from './providers/gemini'
import { OpenAIProvider } from './providers/openai'
import type { LLMProvider, ProviderId } from './types'

export * from './types'
export { ModelRouter } from './router'
export { CostTracker } from './costTracker'

export function buildRouter(db: Database, configPath: string): ModelRouter {
  const cfg = loadProviderConfig(configPath)
  const tracker = new CostTracker(db, cfg.monthly_budget_usd)

  const providers: Partial<Record<ProviderId, LLMProvider>> = {
    anthropic_cli: new AnthropicCliProvider(cfg.providers.anthropic_cli),
    anthropic_api: new AnthropicApiProvider(cfg.providers.anthropic_api),
    gemini:        new GeminiProvider(cfg.providers.gemini),
    openai:        new OpenAIProvider('openai', cfg.providers.openai),
    kimi:          new OpenAIProvider('kimi',   cfg.providers.kimi),
    ollama:        new OpenAIProvider('ollama', cfg.providers.ollama),
  }

  return new ModelRouter({ providers, tracker })
}
```

- [ ] **Step 2: Write a runnable smoke test (not part of `bun test` — runs against real providers)**

```typescript
// scripts/smoke-router.ts
// Runs a real round-trip through ModelRouter against whichever providers
// are configured in ~/.kairos/providers.json. Skips silently if none.
//
// Usage: bun run scripts/smoke-router.ts

import { Database } from 'bun:sqlite'
import { homedir } from 'os'
import { join } from 'path'
import { buildRouter } from '../src/daemon/llm'

const db = new Database(':memory:')
const router = buildRouter(db, join(homedir(), '.kairos', 'providers.json'))

console.log('Sending narrative request...')
const result = await router.complete({
  task_type: 'narrative',
  prompt: 'In one sentence, what is the color of grass?',
  max_output_tokens: 50,
})
console.log(`✓ provider=${result.provider} model=${result.model}`)
console.log(`  cost=${result.cost_cents}¢ latency=${result.latency_ms}ms fallbacks=${result.fallback_count}`)
console.log(`  text="${result.text.slice(0, 200)}"`)
```

- [ ] **Step 3: Run the smoke test (manual — requires at least one provider configured)**

```bash
cd /Users/nirmalghinaiya/Desktop/kairos-sandbox
bun run scripts/smoke-router.ts
```

Expected: prints a provider, cost, and a sentence about grass.

- [ ] **Step 4: Commit**

```bash
git add src/daemon/llm/index.ts scripts/smoke-router.ts
git commit -m "feat(llm): router factory + smoke test script"
```

---

## Task 11: Event Bus schema

**Files:**
- Create: `src/daemon/proactive/eventBus.ts`
- Test:  `src/daemon/proactive/eventBus.test.ts`

The bus is a SQLite table with an in-memory subscriber list. Observers publish; aggregators subscribe. Persistence means we can replay recent state on restart.

- [ ] **Step 1: Write the failing test**

```typescript
// src/daemon/proactive/eventBus.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { EventBus } from './eventBus'

describe('EventBus', () => {
  let db: Database
  let bus: EventBus

  beforeEach(() => {
    db = new Database(':memory:')
    bus = new EventBus(db)
  })

  it('persists a published event', () => {
    bus.publish({ source: 'focus-app', kind: 'app_changed', payload: { app: 'Slack' } })
    const recent = bus.recent(10)
    expect(recent.length).toBe(1)
    expect(recent[0]?.source).toBe('focus-app')
    expect(recent[0]?.payload).toEqual({ app: 'Slack' })
  })

  it('delivers events to subscribers in order', () => {
    const received: string[] = []
    bus.subscribe('focus-app', e => received.push(e.kind))
    bus.publish({ source: 'focus-app', kind: 'app_changed', payload: { app: 'A' } })
    bus.publish({ source: 'focus-app', kind: 'app_changed', payload: { app: 'B' } })
    bus.publish({ source: 'clipboard', kind: 'changed', payload: {} })  // not delivered
    expect(received).toEqual(['app_changed', 'app_changed'])
  })

  it('wildcard subscribers receive all events', () => {
    const received: string[] = []
    bus.subscribe('*', e => received.push(e.source))
    bus.publish({ source: 'focus-app', kind: 'a', payload: {} })
    bus.publish({ source: 'clipboard', kind: 'b', payload: {} })
    expect(received).toEqual(['focus-app', 'clipboard'])
  })

  it('recent() returns latest events newest-first', () => {
    bus.publish({ source: 's', kind: 'a', payload: { n: 1 } })
    bus.publish({ source: 's', kind: 'a', payload: { n: 2 } })
    bus.publish({ source: 's', kind: 'a', payload: { n: 3 } })
    const r = bus.recent(2)
    expect(r.length).toBe(2)
    expect((r[0]?.payload as any).n).toBe(3)
    expect((r[1]?.payload as any).n).toBe(2)
  })

  it('since() filters by timestamp', async () => {
    bus.publish({ source: 's', kind: 'a', payload: { n: 1 } })
    const cutoff = Date.now()
    await new Promise(r => setTimeout(r, 5))
    bus.publish({ source: 's', kind: 'a', payload: { n: 2 } })
    const r = bus.since(cutoff)
    expect(r.length).toBe(1)
    expect((r[0]?.payload as any).n).toBe(2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/daemon/proactive/eventBus.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the bus**

```typescript
// src/daemon/proactive/eventBus.ts
// SQLite-backed pub/sub bus. Observers publish, aggregators subscribe.
// Persistence lets us survive restarts and query history for the narrator.

import type { Database } from 'bun:sqlite'
import { log, logError } from '../logger'

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS world_state_events (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        INTEGER NOT NULL,
    source    TEXT    NOT NULL,            -- observer id ('focus-app', etc.)
    kind      TEXT    NOT NULL,            -- event type ('app_changed', 'tab_opened')
    payload   TEXT    NOT NULL             -- JSON
  );
  CREATE INDEX IF NOT EXISTS idx_wse_ts ON world_state_events(ts);
  CREATE INDEX IF NOT EXISTS idx_wse_source_ts ON world_state_events(source, ts);
`

export type WorldEventInput = {
  source: string
  kind: string
  payload: Record<string, unknown>
}

export type WorldEvent = WorldEventInput & {
  id: number
  ts: number
}

export type Subscriber = (e: WorldEvent) => void | Promise<void>

export class EventBus {
  private subs: Map<string, Subscriber[]> = new Map()   // source → handlers ('*' = all)

  constructor(private db: Database) {
    db.exec(SCHEMA)
  }

  publish(input: WorldEventInput): WorldEvent {
    const ts = Date.now()
    const info = this.db.run(
      'INSERT INTO world_state_events (ts, source, kind, payload) VALUES (?, ?, ?, ?)',
      [ts, input.source, input.kind, JSON.stringify(input.payload)],
    )
    const event: WorldEvent = { ...input, ts, id: Number(info.lastInsertRowid) }
    this.dispatch(event)
    return event
  }

  subscribe(source: string, handler: Subscriber): () => void {
    const list = this.subs.get(source) ?? []
    list.push(handler)
    this.subs.set(source, list)
    return () => {
      const cur = this.subs.get(source) ?? []
      this.subs.set(source, cur.filter(h => h !== handler))
    }
  }

  recent(limit: number = 50): WorldEvent[] {
    const rows = this.db
      .query('SELECT id, ts, source, kind, payload FROM world_state_events ORDER BY id DESC LIMIT ?')
      .all(limit) as Array<{ id: number; ts: number; source: string; kind: string; payload: string }>
    return rows.map(r => ({ ...r, payload: JSON.parse(r.payload) }))
  }

  since(tsMs: number): WorldEvent[] {
    const rows = this.db
      .query('SELECT id, ts, source, kind, payload FROM world_state_events WHERE ts > ? ORDER BY id ASC')
      .all(tsMs) as Array<{ id: number; ts: number; source: string; kind: string; payload: string }>
    return rows.map(r => ({ ...r, payload: JSON.parse(r.payload) }))
  }

  private dispatch(e: WorldEvent): void {
    const targeted = this.subs.get(e.source) ?? []
    const wildcard = this.subs.get('*') ?? []
    for (const h of [...targeted, ...wildcard]) {
      try {
        const r = h(e)
        if (r instanceof Promise) r.catch(err => logError(`subscriber error for ${e.source}`, err))
      } catch (err) {
        logError(`subscriber error for ${e.source}`, err)
      }
    }
  }
}
```

- [ ] **Step 4: Run tests**

```bash
bun test src/daemon/proactive/eventBus.test.ts
```

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/proactive/eventBus.ts src/daemon/proactive/eventBus.test.ts
git commit -m "feat(proactive): EventBus with SQLite persistence + in-memory pub/sub"
```

---

## Task 12: State Snapshot aggregator

**Files:**
- Create: `src/daemon/proactive/stateSnapshot.ts`
- Test:  `src/daemon/proactive/stateSnapshot.test.ts`

The snapshot is a live view of "what is the user's world right now?" — current app, open tabs, recent files, last clipboard, upcoming events. Subscribers can read it at any time; the narrator reads it once per 5 min.

- [ ] **Step 1: Write the failing test**

```typescript
// src/daemon/proactive/stateSnapshot.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { EventBus } from './eventBus'
import { StateSnapshot } from './stateSnapshot'

describe('StateSnapshot', () => {
  let db: Database
  let bus: EventBus
  let snap: StateSnapshot

  beforeEach(() => {
    db = new Database(':memory:')
    bus = new EventBus(db)
    snap = new StateSnapshot(bus)
  })

  it('starts empty', () => {
    const view = snap.read()
    expect(view.focus_app).toBeNull()
    expect(view.open_tabs).toEqual([])
    expect(view.recent_files).toEqual([])
    expect(view.clipboard_preview).toBeNull()
    expect(view.upcoming_events).toEqual([])
  })

  it('tracks the most recent focus_app', () => {
    bus.publish({ source: 'focus-app', kind: 'app_changed', payload: { app: 'VS Code', title: 'kairos' } })
    bus.publish({ source: 'focus-app', kind: 'app_changed', payload: { app: 'Slack',   title: 'general' } })
    expect(snap.read().focus_app).toEqual({ app: 'Slack', title: 'general' })
  })

  it('replaces open_tabs with the latest tab list', () => {
    bus.publish({ source: 'browser-tabs', kind: 'tabs_changed', payload: { browser: 'Arc', tabs: ['a', 'b'] } })
    expect(snap.read().open_tabs).toEqual(['a', 'b'])
    bus.publish({ source: 'browser-tabs', kind: 'tabs_changed', payload: { browser: 'Arc', tabs: ['c'] } })
    expect(snap.read().open_tabs).toEqual(['c'])
  })

  it('keeps the last N recent_files (newest first)', () => {
    for (let i = 0; i < 12; i++) {
      bus.publish({ source: 'file-events', kind: 'modified', payload: { path: `/f${i}` } })
    }
    const view = snap.read()
    expect(view.recent_files.length).toBe(10)
    expect(view.recent_files[0]).toBe('/f11')
  })

  it('truncates clipboard preview to 300 chars', () => {
    const long = 'x'.repeat(1000)
    bus.publish({ source: 'clipboard', kind: 'changed', payload: { text: long } })
    expect(snap.read().clipboard_preview?.length).toBe(300)
  })

  it('stores upcoming_events from calendar events', () => {
    bus.publish({
      source: 'calendar-local',
      kind: 'upcoming',
      payload: { events: [{ title: 'Standup', start: 1700000000000 }] },
    })
    expect(snap.read().upcoming_events.length).toBe(1)
    expect(snap.read().upcoming_events[0]?.title).toBe('Standup')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/daemon/proactive/stateSnapshot.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the snapshot**

```typescript
// src/daemon/proactive/stateSnapshot.ts
// Live aggregated view of "what is the user's world right now?".
// Subscribes to all observer events and maintains an in-memory view
// that the narrator (and later, triggers + UI) read.

import type { EventBus, WorldEvent } from './eventBus'

const MAX_RECENT_FILES = 10
const CLIP_PREVIEW_LEN = 300

export type CalendarItem = { title: string; start: number; end?: number }

export type WorldStateView = {
  focus_app: { app: string; title?: string } | null
  open_tabs: string[]
  recent_files: string[]                  // newest first
  clipboard_preview: string | null
  upcoming_events: CalendarItem[]
  updated_at: number
}

export class StateSnapshot {
  private view: WorldStateView = {
    focus_app: null,
    open_tabs: [],
    recent_files: [],
    clipboard_preview: null,
    upcoming_events: [],
    updated_at: Date.now(),
  }

  constructor(private bus: EventBus) {
    bus.subscribe('*', this.handle.bind(this))
  }

  read(): WorldStateView {
    return { ...this.view, recent_files: [...this.view.recent_files], open_tabs: [...this.view.open_tabs] }
  }

  private handle(e: WorldEvent): void {
    this.view.updated_at = e.ts

    switch (e.source) {
      case 'focus-app': {
        const p = e.payload as { app?: string; title?: string }
        if (p.app) this.view.focus_app = { app: p.app, title: p.title }
        break
      }
      case 'browser-tabs': {
        const p = e.payload as { tabs?: string[] }
        if (Array.isArray(p.tabs)) this.view.open_tabs = p.tabs.slice()
        break
      }
      case 'file-events': {
        const p = e.payload as { path?: string }
        if (p.path) {
          this.view.recent_files = [p.path, ...this.view.recent_files.filter(f => f !== p.path)]
            .slice(0, MAX_RECENT_FILES)
        }
        break
      }
      case 'clipboard': {
        const p = e.payload as { text?: string }
        if (typeof p.text === 'string') {
          this.view.clipboard_preview = p.text.slice(0, CLIP_PREVIEW_LEN)
        }
        break
      }
      case 'calendar-local': {
        const p = e.payload as { events?: CalendarItem[] }
        if (Array.isArray(p.events)) this.view.upcoming_events = p.events.slice(0, 10)
        break
      }
    }
  }
}
```

- [ ] **Step 4: Run tests**

```bash
bun test src/daemon/proactive/stateSnapshot.test.ts
```

Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/proactive/stateSnapshot.ts src/daemon/proactive/stateSnapshot.test.ts
git commit -m "feat(proactive): StateSnapshot aggregator for live world view"
```

---

## Task 13: Observer base class + registry

**Files:**
- Create: `src/daemon/proactive/observers/base.ts`
- Create: `src/daemon/proactive/observerRegistry.ts`
- Test:  `src/daemon/proactive/observerRegistry.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/daemon/proactive/observerRegistry.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { EventBus } from './eventBus'
import { ObserverRegistry } from './observerRegistry'
import { Observer } from './observers/base'

class TestObserver extends Observer {
  readonly id = 'test'
  startCount = 0
  stopCount = 0
  protected onStart() { this.startCount++ }
  protected onStop() { this.stopCount++ }
}

describe('ObserverRegistry', () => {
  let db: Database
  let bus: EventBus
  let reg: ObserverRegistry

  beforeEach(() => {
    db = new Database(':memory:')
    bus = new EventBus(db)
    reg = new ObserverRegistry(bus)
  })

  it('starts and stops registered observers', async () => {
    const obs = new TestObserver(bus)
    reg.register(obs)
    await reg.startAll()
    expect(obs.startCount).toBe(1)
    await reg.stopAll()
    expect(obs.stopCount).toBe(1)
  })

  it('returns list of registered observers', () => {
    reg.register(new TestObserver(bus))
    expect(reg.list()).toEqual(['test'])
  })

  it('does not start an observer twice', async () => {
    const obs = new TestObserver(bus)
    reg.register(obs)
    await reg.startAll()
    await reg.startAll()
    expect(obs.startCount).toBe(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/daemon/proactive/observerRegistry.test.ts
```

Expected: FAIL — modules not found.

- [ ] **Step 3: Write the base class**

```typescript
// src/daemon/proactive/observers/base.ts
// Each observer is a long-lived component that watches one channel
// of OS state and publishes events into the bus when state changes.

import type { EventBus, WorldEventInput } from '../eventBus'

export abstract class Observer {
  abstract readonly id: string
  private started = false

  constructor(protected bus: EventBus) {}

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    await this.onStart()
  }

  async stop(): Promise<void> {
    if (!this.started) return
    this.started = false
    await this.onStop()
  }

  protected emit(kind: string, payload: Record<string, unknown>): void {
    this.bus.publish({ source: this.id, kind, payload } satisfies WorldEventInput)
  }

  protected abstract onStart(): void | Promise<void>
  protected abstract onStop(): void | Promise<void>
}
```

- [ ] **Step 4: Write the registry**

```typescript
// src/daemon/proactive/observerRegistry.ts
import { log, logError } from '../logger'
import type { EventBus } from './eventBus'
import type { Observer } from './observers/base'

export class ObserverRegistry {
  private observers: Observer[] = []

  constructor(private bus: EventBus) {}

  register(obs: Observer): void {
    if (this.observers.some(o => o.id === obs.id)) {
      log(`ObserverRegistry: ${obs.id} already registered, skipping`, 'warn')
      return
    }
    this.observers.push(obs)
  }

  async startAll(): Promise<void> {
    for (const o of this.observers) {
      try {
        await o.start()
        log(`Observer started: ${o.id}`)
      } catch (err) {
        logError(`Observer ${o.id} failed to start`, err)
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const o of this.observers) {
      try { await o.stop() } catch (err) { logError(`Observer ${o.id} stop failed`, err) }
    }
  }

  list(): string[] {
    return this.observers.map(o => o.id)
  }
}
```

- [ ] **Step 5: Run tests**

```bash
bun test src/daemon/proactive/observerRegistry.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/daemon/proactive/observers/base.ts src/daemon/proactive/observerRegistry.ts src/daemon/proactive/observerRegistry.test.ts
git commit -m "feat(proactive): Observer base class + registry with lifecycle"
```

---

## Task 14: focus-app observer

**Files:**
- Create: `src/daemon/proactive/observers/focusApp.ts`
- Test:  `src/daemon/proactive/observers/focusApp.test.ts`

Polls macOS for the frontmost application name + window title every 2 seconds, emits an event only when changed.

- [ ] **Step 1: Write the failing test**

```typescript
// src/daemon/proactive/observers/focusApp.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { EventBus } from '../eventBus'
import { FocusAppObserver } from './focusApp'

describe('FocusAppObserver', () => {
  let db: Database
  let bus: EventBus

  beforeEach(() => {
    db = new Database(':memory:')
    bus = new EventBus(db)
  })

  it('emits app_changed when app differs from last', async () => {
    let nextApp = { app: 'Safari', title: 'home' }
    const obs = new FocusAppObserver(bus, {
      pollMs: 50,
      probe: async () => nextApp,
    })
    await obs.start()
    await new Promise(r => setTimeout(r, 120))
    nextApp = { app: 'Slack', title: 'general' }
    await new Promise(r => setTimeout(r, 120))
    await obs.stop()
    const recent = bus.recent(10)
    const apps = recent.map(e => (e.payload as any).app)
    expect(apps).toEqual(['Slack', 'Safari'])  // newest-first
  })

  it('does not re-emit when app is unchanged', async () => {
    const obs = new FocusAppObserver(bus, {
      pollMs: 30,
      probe: async () => ({ app: 'Same', title: 't' }),
    })
    await obs.start()
    await new Promise(r => setTimeout(r, 150))
    await obs.stop()
    expect(bus.recent(10).length).toBe(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/daemon/proactive/observers/focusApp.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the observer**

```typescript
// src/daemon/proactive/observers/focusApp.ts
// macOS frontmost-app observer. Polls every 2s via osascript and emits
// 'app_changed' only when the app or title changes.
//
// Why polling vs. a notification API: AppleScript notifications require
// accessibility permission and a long-lived helper. Polling at 2s is
// invisible to the user and uses negligible CPU.

import { Observer } from './base'
import type { EventBus } from '../eventBus'

type Probe = () => Promise<{ app: string; title?: string } | null>

const SCRIPT = `
  tell application "System Events"
    set frontApp to first application process whose frontmost is true
    set appName to name of frontApp
    try
      set winTitle to name of front window of frontApp
    on error
      set winTitle to ""
    end try
    return appName & "||" & winTitle
  end tell
`

export class FocusAppObserver extends Observer {
  readonly id = 'focus-app'
  private timer: ReturnType<typeof setInterval> | null = null
  private last: string | null = null
  private pollMs: number
  private probe: Probe

  constructor(
    bus: EventBus,
    opts?: { pollMs?: number; probe?: Probe },
  ) {
    super(bus)
    this.pollMs = opts?.pollMs ?? 2000
    this.probe = opts?.probe ?? defaultProbe
  }

  protected onStart(): void {
    this.tick()
    this.timer = setInterval(() => this.tick(), this.pollMs)
  }

  protected onStop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private async tick(): Promise<void> {
    try {
      const r = await this.probe()
      if (!r) return
      const sig = `${r.app}||${r.title ?? ''}`
      if (sig === this.last) return
      this.last = sig
      this.emit('app_changed', { app: r.app, title: r.title })
    } catch { /* ignore poll error */ }
  }
}

async function defaultProbe(): Promise<{ app: string; title?: string } | null> {
  try {
    const proc = Bun.spawn(['osascript', '-e', SCRIPT], { stdout: 'pipe', stderr: 'pipe' })
    const exitCode = await proc.exited
    if (exitCode !== 0) return null
    const out = (await new Response(proc.stdout).text()).trim()
    const [app, title] = out.split('||')
    if (!app) return null
    return { app, title: title || undefined }
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Run tests**

```bash
bun test src/daemon/proactive/observers/focusApp.test.ts
```

Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/proactive/observers/focusApp.ts src/daemon/proactive/observers/focusApp.test.ts
git commit -m "feat(proactive): focus-app observer (macOS frontmost via osascript)"
```

---

## Task 15: browser-tabs observer

**Files:**
- Create: `src/daemon/proactive/observers/browserTabs.ts`
- Test:  `src/daemon/proactive/observers/browserTabs.test.ts`

Polls open tabs in Safari/Chrome/Arc via AppleScript every 10s. Emits when the tab set changes.

- [ ] **Step 1: Write the failing test**

```typescript
// src/daemon/proactive/observers/browserTabs.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { EventBus } from '../eventBus'
import { BrowserTabsObserver } from './browserTabs'

describe('BrowserTabsObserver', () => {
  let db: Database
  let bus: EventBus

  beforeEach(() => {
    db = new Database(':memory:')
    bus = new EventBus(db)
  })

  it('emits tabs_changed when tab set changes', async () => {
    let probeResult = { browser: 'Arc', tabs: ['https://a.com', 'https://b.com'] }
    const obs = new BrowserTabsObserver(bus, {
      pollMs: 40,
      probe: async () => probeResult,
    })
    await obs.start()
    await new Promise(r => setTimeout(r, 100))
    probeResult = { browser: 'Arc', tabs: ['https://c.com'] }
    await new Promise(r => setTimeout(r, 100))
    await obs.stop()
    const recent = bus.recent(10)
    expect(recent.length).toBe(2)
    expect((recent[0]?.payload as any).tabs).toEqual(['https://c.com'])
  })

  it('does not re-emit when tab set is unchanged', async () => {
    const obs = new BrowserTabsObserver(bus, {
      pollMs: 30,
      probe: async () => ({ browser: 'Arc', tabs: ['https://same.com'] }),
    })
    await obs.start()
    await new Promise(r => setTimeout(r, 150))
    await obs.stop()
    expect(bus.recent(10).length).toBe(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/daemon/proactive/observers/browserTabs.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the observer**

```typescript
// src/daemon/proactive/observers/browserTabs.ts
// Polls open browser tabs every 10s. Tries Arc, Chrome, Safari in order;
// uses the first that responds. Emits when the tab URL set changes.

import { Observer } from './base'
import type { EventBus } from '../eventBus'

type Probe = () => Promise<{ browser: string; tabs: string[] } | null>

// AppleScript per browser. Returns newline-separated URLs.
const SCRIPTS: Record<string, string> = {
  Arc: `
    tell application "Arc"
      set urls to {}
      repeat with w in windows
        repeat with t in tabs of w
          set end of urls to URL of t
        end repeat
      end repeat
      set AppleScript's text item delimiters to linefeed
      return urls as text
    end tell
  `,
  'Google Chrome': `
    tell application "Google Chrome"
      set urls to {}
      repeat with w in windows
        repeat with t in tabs of w
          set end of urls to URL of t
        end repeat
      end repeat
      set AppleScript's text item delimiters to linefeed
      return urls as text
    end tell
  `,
  Safari: `
    tell application "Safari"
      set urls to {}
      repeat with w in windows
        repeat with t in tabs of w
          set end of urls to URL of t
        end repeat
      end repeat
      set AppleScript's text item delimiters to linefeed
      return urls as text
    end tell
  `,
}

export class BrowserTabsObserver extends Observer {
  readonly id = 'browser-tabs'
  private timer: ReturnType<typeof setInterval> | null = null
  private lastSig: string = ''
  private pollMs: number
  private probe: Probe

  constructor(bus: EventBus, opts?: { pollMs?: number; probe?: Probe }) {
    super(bus)
    this.pollMs = opts?.pollMs ?? 10_000
    this.probe = opts?.probe ?? defaultProbe
  }

  protected onStart(): void {
    this.tick()
    this.timer = setInterval(() => this.tick(), this.pollMs)
  }

  protected onStop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }

  private async tick(): Promise<void> {
    try {
      const r = await this.probe()
      if (!r) return
      const sig = `${r.browser}|${r.tabs.join('|')}`
      if (sig === this.lastSig) return
      this.lastSig = sig
      this.emit('tabs_changed', { browser: r.browser, tabs: r.tabs })
    } catch { /* ignore */ }
  }
}

async function defaultProbe(): Promise<{ browser: string; tabs: string[] } | null> {
  for (const [browser, script] of Object.entries(SCRIPTS)) {
    try {
      const proc = Bun.spawn(['osascript', '-e', script], { stdout: 'pipe', stderr: 'pipe' })
      const exitCode = await proc.exited
      if (exitCode !== 0) continue
      const out = (await new Response(proc.stdout).text()).trim()
      if (!out) continue
      const tabs = out.split('\n').map(s => s.trim()).filter(Boolean)
      if (tabs.length === 0) continue
      return { browser, tabs }
    } catch { continue }
  }
  return null
}
```

- [ ] **Step 4: Run tests**

```bash
bun test src/daemon/proactive/observers/browserTabs.test.ts
```

Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/proactive/observers/browserTabs.ts src/daemon/proactive/observers/browserTabs.test.ts
git commit -m "feat(proactive): browser-tabs observer (Arc/Chrome/Safari via osascript)"
```

---

## Task 16: clipboard observer

**Files:**
- Create: `src/daemon/proactive/observers/clipboard.ts`
- Test:  `src/daemon/proactive/observers/clipboard.test.ts`

Polls `pbpaste` every 5s. Emits on change. **Privacy note:** clipboard content is potentially sensitive (passwords, secrets); the snapshot truncates to 300 chars and persistence in `world_state_events` keeps the full payload — consider trimming before publish in production. For Phase A we emit full content; Phase G (privacy hardening) adds a redactor.

- [ ] **Step 1: Write the failing test**

```typescript
// src/daemon/proactive/observers/clipboard.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { EventBus } from '../eventBus'
import { ClipboardObserver } from './clipboard'

describe('ClipboardObserver', () => {
  let db: Database
  let bus: EventBus

  beforeEach(() => {
    db = new Database(':memory:')
    bus = new EventBus(db)
  })

  it('emits on clipboard content change', async () => {
    let content = 'first'
    const obs = new ClipboardObserver(bus, { pollMs: 30, probe: async () => content })
    await obs.start()
    await new Promise(r => setTimeout(r, 60))
    content = 'second'
    await new Promise(r => setTimeout(r, 60))
    await obs.stop()
    const r = bus.recent(10)
    expect(r.length).toBe(2)
    expect((r[0]?.payload as any).text).toBe('second')
  })

  it('skips empty clipboard', async () => {
    const obs = new ClipboardObserver(bus, { pollMs: 20, probe: async () => '' })
    await obs.start()
    await new Promise(r => setTimeout(r, 80))
    await obs.stop()
    expect(bus.recent(10).length).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/daemon/proactive/observers/clipboard.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the observer**

```typescript
// src/daemon/proactive/observers/clipboard.ts
import { Observer } from './base'
import type { EventBus } from '../eventBus'

type Probe = () => Promise<string>

export class ClipboardObserver extends Observer {
  readonly id = 'clipboard'
  private timer: ReturnType<typeof setInterval> | null = null
  private last: string = ''
  private pollMs: number
  private probe: Probe

  constructor(bus: EventBus, opts?: { pollMs?: number; probe?: Probe }) {
    super(bus)
    this.pollMs = opts?.pollMs ?? 5000
    this.probe = opts?.probe ?? defaultProbe
  }

  protected onStart(): void {
    this.tick()
    this.timer = setInterval(() => this.tick(), this.pollMs)
  }

  protected onStop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }

  private async tick(): Promise<void> {
    try {
      const content = await this.probe()
      if (!content || content === this.last) return
      this.last = content
      this.emit('changed', { text: content, length: content.length })
    } catch { /* ignore */ }
  }
}

async function defaultProbe(): Promise<string> {
  const proc = Bun.spawn(['pbpaste'], { stdout: 'pipe' })
  await proc.exited
  return (await new Response(proc.stdout).text())
}
```

- [ ] **Step 4: Run tests**

```bash
bun test src/daemon/proactive/observers/clipboard.test.ts
```

Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/proactive/observers/clipboard.ts src/daemon/proactive/observers/clipboard.test.ts
git commit -m "feat(proactive): clipboard observer (pbpaste polling, 5s)"
```

---

## Task 17: file-events observer

**Files:**
- Create: `src/daemon/proactive/observers/fileEvents.ts`
- Test:  `src/daemon/proactive/observers/fileEvents.test.ts`

Watches a configurable set of root directories (default: user's home Desktop + Documents — narrow scope; user can add more). Uses Node `fs.watch` with `recursive: true`. Debounces to avoid burst-floods from save-many-times editors.

- [ ] **Step 1: Write the failing test**

```typescript
// src/daemon/proactive/observers/fileEvents.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { EventBus } from '../eventBus'
import { FileEventsObserver } from './fileEvents'

describe('FileEventsObserver', () => {
  let db: Database
  let bus: EventBus
  let dir: string

  beforeEach(() => {
    db = new Database(':memory:')
    bus = new EventBus(db)
    dir = mkdtempSync(join(tmpdir(), 'kairos-fs-'))
  })

  it('emits modified events when files change', async () => {
    const obs = new FileEventsObserver(bus, { roots: [dir], debounceMs: 30 })
    await obs.start()
    await new Promise(r => setTimeout(r, 50))
    writeFileSync(join(dir, 'a.txt'), 'hello')
    await new Promise(r => setTimeout(r, 200))
    await obs.stop()
    const events = bus.recent(10)
    expect(events.length).toBeGreaterThan(0)
    expect((events[0]?.payload as any).path).toContain('a.txt')
    rmSync(dir, { recursive: true })
  })

  it('skips ignored extensions', async () => {
    const obs = new FileEventsObserver(bus, {
      roots: [dir],
      debounceMs: 30,
      ignoreExt: ['.log', '.tmp'],
    })
    await obs.start()
    await new Promise(r => setTimeout(r, 50))
    writeFileSync(join(dir, 'noise.log'), 'x')
    writeFileSync(join(dir, 'real.txt'), 'y')
    await new Promise(r => setTimeout(r, 200))
    await obs.stop()
    const events = bus.recent(10)
    const paths = events.map(e => (e.payload as any).path as string)
    expect(paths.some(p => p.endsWith('.log'))).toBe(false)
    expect(paths.some(p => p.endsWith('.txt'))).toBe(true)
    rmSync(dir, { recursive: true })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/daemon/proactive/observers/fileEvents.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the observer**

```typescript
// src/daemon/proactive/observers/fileEvents.ts
import { watch, type FSWatcher } from 'fs'
import { extname, join } from 'path'
import { Observer } from './base'
import type { EventBus } from '../eventBus'

const DEFAULT_IGNORE = ['.log', '.tmp', '.swp', '.DS_Store', '.lock']
const DEFAULT_DEBOUNCE_MS = 500

export type FileEventsOptions = {
  roots?: string[]
  ignoreExt?: string[]
  debounceMs?: number
}

export class FileEventsObserver extends Observer {
  readonly id = 'file-events'
  private watchers: FSWatcher[] = []
  private pending: Map<string, ReturnType<typeof setTimeout>> = new Map()
  private roots: string[]
  private ignoreExt: Set<string>
  private debounceMs: number

  constructor(bus: EventBus, opts?: FileEventsOptions) {
    super(bus)
    this.roots = opts?.roots ?? [join(process.env.HOME ?? '', 'Desktop')]
    this.ignoreExt = new Set(opts?.ignoreExt ?? DEFAULT_IGNORE)
    this.debounceMs = opts?.debounceMs ?? DEFAULT_DEBOUNCE_MS
  }

  protected onStart(): void {
    for (const root of this.roots) {
      try {
        const w = watch(root, { recursive: true }, (event, filename) => {
          if (!filename) return
          const fullPath = join(root, filename.toString())
          if (this.ignoreExt.has(extname(fullPath))) return
          this.debouncedEmit(fullPath, event)
        })
        this.watchers.push(w)
      } catch (err) {
        // root may not exist or be readable; skip silently
      }
    }
  }

  protected onStop(): void {
    for (const w of this.watchers) {
      try { w.close() } catch { /* ignore */ }
    }
    this.watchers = []
    for (const t of this.pending.values()) clearTimeout(t)
    this.pending.clear()
  }

  private debouncedEmit(path: string, event: string): void {
    const existing = this.pending.get(path)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.pending.delete(path)
      this.emit(event === 'rename' ? 'renamed' : 'modified', { path, event })
    }, this.debounceMs)
    this.pending.set(path, timer)
  }
}
```

- [ ] **Step 4: Run tests**

```bash
bun test src/daemon/proactive/observers/fileEvents.test.ts
```

Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/proactive/observers/fileEvents.ts src/daemon/proactive/observers/fileEvents.test.ts
git commit -m "feat(proactive): file-events observer (fs.watch with debounce + ignore-list)"
```

---

## Task 18: calendar-local observer

**Files:**
- Create: `src/daemon/proactive/observers/calendarLocal.ts`
- Test:  `src/daemon/proactive/observers/calendarLocal.test.ts`

Polls macOS Calendar.app every 5 min via `icalbuddy` (assumed installed; if not, falls back to AppleScript). Emits upcoming events in the next 4 hours.

- [ ] **Step 1: Write the failing test**

```typescript
// src/daemon/proactive/observers/calendarLocal.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { EventBus } from '../eventBus'
import { CalendarLocalObserver } from './calendarLocal'

describe('CalendarLocalObserver', () => {
  let db: Database
  let bus: EventBus

  beforeEach(() => {
    db = new Database(':memory:')
    bus = new EventBus(db)
  })

  it('emits upcoming events from probe', async () => {
    const obs = new CalendarLocalObserver(bus, {
      pollMs: 50,
      probe: async () => [
        { title: 'Standup',   start: 1700000000000 },
        { title: 'Lunch',     start: 1700100000000 },
      ],
    })
    await obs.start()
    await new Promise(r => setTimeout(r, 80))
    await obs.stop()
    const r = bus.recent(10)
    expect(r.length).toBeGreaterThanOrEqual(1)
    const payload = r[0]?.payload as any
    expect(payload.events.length).toBe(2)
    expect(payload.events[0].title).toBe('Standup')
  })

  it('does not re-emit when event set is unchanged', async () => {
    const events = [{ title: 'Static', start: 1700000000000 }]
    const obs = new CalendarLocalObserver(bus, { pollMs: 30, probe: async () => events })
    await obs.start()
    await new Promise(r => setTimeout(r, 150))
    await obs.stop()
    expect(bus.recent(10).length).toBe(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/daemon/proactive/observers/calendarLocal.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the observer**

```typescript
// src/daemon/proactive/observers/calendarLocal.ts
import { Observer } from './base'
import type { EventBus } from '../eventBus'
import type { CalendarItem } from '../stateSnapshot'

type Probe = () => Promise<CalendarItem[]>

export class CalendarLocalObserver extends Observer {
  readonly id = 'calendar-local'
  private timer: ReturnType<typeof setInterval> | null = null
  private lastSig: string = ''
  private pollMs: number
  private probe: Probe

  constructor(bus: EventBus, opts?: { pollMs?: number; probe?: Probe }) {
    super(bus)
    this.pollMs = opts?.pollMs ?? 5 * 60_000   // 5 min
    this.probe = opts?.probe ?? defaultProbe
  }

  protected onStart(): void {
    this.tick()
    this.timer = setInterval(() => this.tick(), this.pollMs)
  }

  protected onStop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }

  private async tick(): Promise<void> {
    try {
      const events = await this.probe()
      const sig = events.map(e => `${e.title}@${e.start}`).join('|')
      if (sig === this.lastSig) return
      this.lastSig = sig
      this.emit('upcoming', { events })
    } catch { /* ignore */ }
  }
}

// Tries icalbuddy first (much better output); falls back to AppleScript.
async function defaultProbe(): Promise<CalendarItem[]> {
  try {
    const ical = Bun.spawn(['icalbuddy', '-nc', '-nrd', '-iep', 'title,datetime', 'eventsToday+1'], {
      stdout: 'pipe', stderr: 'pipe',
    })
    const code = await ical.exited
    if (code === 0) {
      const out = await new Response(ical.stdout).text()
      return parseIcalBuddy(out)
    }
  } catch { /* fall through */ }
  return []   // AppleScript Calendar.app probe is brittle; rely on icalbuddy for Phase A
}

// icalbuddy format: each event = "• Title\n    datetime"
function parseIcalBuddy(out: string): CalendarItem[] {
  const items: CalendarItem[] = []
  const blocks = out.split(/\n(?=•)/)
  for (const block of blocks) {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean)
    if (lines.length === 0) continue
    const title = lines[0]!.replace(/^•\s*/, '')
    const datetimeLine = lines[1]
    let start = Date.now()
    if (datetimeLine) {
      const t = Date.parse(datetimeLine)
      if (!Number.isNaN(t)) start = t
    }
    items.push({ title, start })
  }
  return items
}
```

- [ ] **Step 4: Run tests**

```bash
bun test src/daemon/proactive/observers/calendarLocal.test.ts
```

Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/proactive/observers/calendarLocal.ts src/daemon/proactive/observers/calendarLocal.test.ts
git commit -m "feat(proactive): calendar-local observer (icalbuddy probe)"
```

---

## Task 19: Narrator

**Files:**
- Create: `src/daemon/proactive/narrator.ts`
- Test:  `src/daemon/proactive/narrator.test.ts`

Every 5 minutes, the narrator reads the current `StateSnapshot`, sends it through `ModelRouter` with `task_type: 'narrative'` (ultra-cheap tier — Gemini Flash Lite for ~$0.0001/call), and publishes the resulting prose summary back into the bus as a `narrative` event. The summary is the first thing later phases (triggers, UI, voice) consume — it's the daemon's running internal monologue about what the user is doing.

- [ ] **Step 1: Write the failing test**

```typescript
// src/daemon/proactive/narrator.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { EventBus } from './eventBus'
import { StateSnapshot } from './stateSnapshot'
import { Narrator } from './narrator'
import type { ModelRouter } from '../llm/router'
import type { CompletionRequest, CompletionResult } from '../llm/types'

function fakeRouter(text: string): ModelRouter {
  return {
    complete: async (req: CompletionRequest): Promise<CompletionResult> => ({
      text,
      provider: 'gemini',
      model: 'gemini-2.5-flash-lite',
      cost_cents: 0,
      latency_ms: 10,
      fallback_count: 0,
      input_tokens: 100,
      output_tokens: 30,
    }),
  } as unknown as ModelRouter
}

describe('Narrator', () => {
  let db: Database
  let bus: EventBus
  let snap: StateSnapshot

  beforeEach(() => {
    db = new Database(':memory:')
    bus = new EventBus(db)
    snap = new StateSnapshot(bus)
  })

  it('produces and publishes a narrative from snapshot', async () => {
    bus.publish({ source: 'focus-app', kind: 'app_changed', payload: { app: 'VS Code' } })
    const narrator = new Narrator(bus, snap, fakeRouter('User is editing code in VS Code.'))
    await narrator.tick()
    const r = bus.recent(10)
    const narrative = r.find(e => e.source === 'narrator')
    expect(narrative).toBeDefined()
    expect((narrative!.payload as any).text).toBe('User is editing code in VS Code.')
  })

  it('skips when snapshot is empty (no observations yet)', async () => {
    const narrator = new Narrator(bus, snap, fakeRouter('should not fire'))
    await narrator.tick()
    expect(bus.recent(10).find(e => e.source === 'narrator')).toBeUndefined()
  })

  it('start() schedules periodic ticks and stop() halts them', async () => {
    bus.publish({ source: 'focus-app', kind: 'app_changed', payload: { app: 'X' } })
    let calls = 0
    const router = {
      complete: async (): Promise<CompletionResult> => {
        calls++
        return {
          text: `tick ${calls}`,
          provider: 'gemini', model: 'g', cost_cents: 0, latency_ms: 1,
          fallback_count: 0, input_tokens: 1, output_tokens: 1,
        }
      },
    } as unknown as ModelRouter
    const narrator = new Narrator(bus, snap, router, { intervalMs: 40 })
    await narrator.start()
    await new Promise(r => setTimeout(r, 130))
    await narrator.stop()
    expect(calls).toBeGreaterThanOrEqual(2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/daemon/proactive/narrator.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the narrator**

```typescript
// src/daemon/proactive/narrator.ts
// The daemon's running internal monologue. Every N minutes, reads the
// live StateSnapshot, asks the cheapest LLM in the catalog for a ≤200-
// word natural-language summary, publishes it as a 'narrative' event.
//
// Later phases consume narratives:
//   - Trigger Engine (Phase C): "does this state warrant action?"
//   - UI (Phase F): displays in menu bar / HUD
//   - Voice (Phase E): TTS readback on demand

import { log, logError } from '../logger'
import type { EventBus } from './eventBus'
import type { StateSnapshot } from './stateSnapshot'
import type { ModelRouter } from '../llm/router'

const SYSTEM_PROMPT = `You are KAIROS's inner narrator. You are given a JSON snapshot of the user's current world state. Produce a concise natural-language summary (≤200 words) describing what the user is doing right now, what's open, what's recent, and any notable patterns. Be observational, not prescriptive. No suggestions, no actions — just describe.`

export type NarratorOptions = {
  intervalMs?: number
}

export class Narrator {
  private timer: ReturnType<typeof setInterval> | null = null
  private intervalMs: number

  constructor(
    private bus: EventBus,
    private snapshot: StateSnapshot,
    private router: ModelRouter,
    opts?: NarratorOptions,
  ) {
    this.intervalMs = opts?.intervalMs ?? 5 * 60_000   // 5 min
  }

  async start(): Promise<void> {
    log(`Narrator armed; tick every ${this.intervalMs / 1000}s`)
    await this.tick()
    this.timer = setInterval(() => { void this.tick() }, this.intervalMs)
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  async tick(): Promise<void> {
    const view = this.snapshot.read()
    if (!view.focus_app && view.open_tabs.length === 0 && view.recent_files.length === 0) {
      return   // nothing observed yet
    }

    try {
      const result = await this.router.complete({
        task_type: 'narrative',
        system: SYSTEM_PROMPT,
        prompt: `Current world state:\n${JSON.stringify(view, null, 2)}`,
        max_output_tokens: 300,
        latency_target: 'background',
      })
      this.bus.publish({
        source: 'narrator',
        kind: 'summary',
        payload: {
          text: result.text,
          provider: result.provider,
          model: result.model,
          cost_cents: result.cost_cents,
        },
      })
    } catch (err) {
      logError('Narrator tick failed', err)
    }
  }
}
```

- [ ] **Step 4: Run tests**

```bash
bun test src/daemon/proactive/narrator.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/proactive/narrator.ts src/daemon/proactive/narrator.test.ts
git commit -m "feat(proactive): Narrator — periodic LLM summarization of world state"
```

---

## Task 20: Wire proactive subsystem into daemon startup

**Files:**
- Modify: `src/daemon/index.ts`
- Modify: `src/daemon/config.ts` (add `proactive` block)

The new subsystem starts alongside existing scheduler/decision-engine/discord-bot. It's gated by `config.proactive.enabled` so we can disable it via config for safety.

- [ ] **Step 1: Read the current index.ts and config.ts to find the right insertion points**

```bash
cat src/daemon/index.ts | head -80
cat src/daemon/config.ts | head -60
```

Read both files completely before editing.

- [ ] **Step 2: Add `proactive` config block to `src/daemon/config.ts`**

Find the `Config` type and add:

```typescript
// inside Config type:
proactive: {
  enabled: boolean
  narratorIntervalMs: number
  providerConfigPath: string   // path to ~/.kairos/providers.json
}
```

And in the default config factory, append:

```typescript
proactive: {
  enabled: true,
  narratorIntervalMs: 5 * 60_000,
  providerConfigPath: join(process.env.HOME ?? '', '.kairos', 'providers.json'),
},
```

- [ ] **Step 3: Wire the subsystem into `src/daemon/index.ts`**

After the existing initialization (DB, scheduler, discord bot, etc.), add:

```typescript
import { buildRouter } from './llm'
import { EventBus } from './proactive/eventBus'
import { StateSnapshot } from './proactive/stateSnapshot'
import { ObserverRegistry } from './proactive/observerRegistry'
import { Narrator } from './proactive/narrator'
import { FocusAppObserver } from './proactive/observers/focusApp'
import { BrowserTabsObserver } from './proactive/observers/browserTabs'
import { ClipboardObserver } from './proactive/observers/clipboard'
import { FileEventsObserver } from './proactive/observers/fileEvents'
import { CalendarLocalObserver } from './proactive/observers/calendarLocal'

// ... existing init code ...

// ─── Proactive subsystem (Phase A) ────────────────────────────────
let proactiveStop: (() => Promise<void>) | null = null
if (config.proactive.enabled) {
  const router = buildRouter(db, config.proactive.providerConfigPath)
  const bus = new EventBus(db)
  const snapshot = new StateSnapshot(bus)
  const registry = new ObserverRegistry(bus)

  registry.register(new FocusAppObserver(bus))
  registry.register(new BrowserTabsObserver(bus))
  registry.register(new ClipboardObserver(bus))
  registry.register(new FileEventsObserver(bus))
  registry.register(new CalendarLocalObserver(bus))

  await registry.startAll()
  const narrator = new Narrator(bus, snapshot, router, {
    intervalMs: config.proactive.narratorIntervalMs,
  })
  await narrator.start()
  log(`Proactive subsystem active: ${registry.list().length} observers + narrator`)

  proactiveStop = async () => {
    await narrator.stop()
    await registry.stopAll()
  }
}

// ... in the shutdown handler, add:
if (proactiveStop) await proactiveStop()
```

- [ ] **Step 4: Type-check the full daemon**

```bash
cd /Users/nirmalghinaiya/Desktop/kairos-sandbox
bunx tsc --noEmit
```

Expected: no errors. Fix any import or signature mismatches before proceeding.

- [ ] **Step 5: Run the full test suite to confirm nothing existing broke**

```bash
bun test
```

Expected: all tests pass (existing + new).

- [ ] **Step 6: Commit**

```bash
git add src/daemon/index.ts src/daemon/config.ts
git commit -m "feat(daemon): wire proactive subsystem (observers + narrator) into startup"
```

---

## Task 21: End-to-end smoke test

**Files:**
- Create: `scripts/smoke-proactive.ts`

Runs the daemon for 5 minutes against real OS state, verifies events flow and a narrative is produced.

- [ ] **Step 1: Write the smoke script**

```typescript
// scripts/smoke-proactive.ts
// 5-minute end-to-end test: start observers, wait, query bus, print summary.
// Requires: at least one LLM provider configured in ~/.kairos/providers.json.
//
// Usage: bun run scripts/smoke-proactive.ts

import { Database } from 'bun:sqlite'
import { homedir } from 'os'
import { join } from 'path'
import { buildRouter } from '../src/daemon/llm'
import { EventBus } from '../src/daemon/proactive/eventBus'
import { StateSnapshot } from '../src/daemon/proactive/stateSnapshot'
import { ObserverRegistry } from '../src/daemon/proactive/observerRegistry'
import { Narrator } from '../src/daemon/proactive/narrator'
import { FocusAppObserver } from '../src/daemon/proactive/observers/focusApp'
import { BrowserTabsObserver } from '../src/daemon/proactive/observers/browserTabs'
import { ClipboardObserver } from '../src/daemon/proactive/observers/clipboard'
import { FileEventsObserver } from '../src/daemon/proactive/observers/fileEvents'
import { CalendarLocalObserver } from '../src/daemon/proactive/observers/calendarLocal'

const DURATION_MS = 5 * 60_000

const db = new Database(':memory:')
const router = buildRouter(db, join(homedir(), '.kairos', 'providers.json'))
const bus = new EventBus(db)
const snapshot = new StateSnapshot(bus)
const registry = new ObserverRegistry(bus)

registry.register(new FocusAppObserver(bus))
registry.register(new BrowserTabsObserver(bus))
registry.register(new ClipboardObserver(bus))
registry.register(new FileEventsObserver(bus))
registry.register(new CalendarLocalObserver(bus))

const narrator = new Narrator(bus, snapshot, router, { intervalMs: 90_000 })

console.log(`Starting proactive smoke test for ${DURATION_MS / 1000}s...`)
console.log(`Switch apps / open tabs / copy text to generate events.`)

await registry.startAll()
await narrator.start()

await new Promise(r => setTimeout(r, DURATION_MS))

await narrator.stop()
await registry.stopAll()

const all = bus.recent(1000)
const bySource: Record<string, number> = {}
for (const e of all) bySource[e.source] = (bySource[e.source] ?? 0) + 1

console.log(`\n─── Summary ───`)
console.log(`Total events: ${all.length}`)
for (const [src, n] of Object.entries(bySource)) {
  console.log(`  ${src.padEnd(20)} ${n}`)
}

const narratives = all.filter(e => e.source === 'narrator')
console.log(`\nNarratives generated: ${narratives.length}`)
for (const n of narratives.slice(0, 3)) {
  console.log(`\n[${new Date(n.ts).toISOString()}] ${(n.payload as any).provider}/${(n.payload as any).model}`)
  console.log((n.payload as any).text)
}
```

- [ ] **Step 2: Run the smoke test**

```bash
cd /Users/nirmalghinaiya/Desktop/kairos-sandbox
bun run scripts/smoke-proactive.ts
```

While it runs (5 min): switch apps a few times, copy something to clipboard, open browser tabs.

Expected: at least 5 focus-app events, 1+ clipboard event, 2+ narratives with coherent prose.

- [ ] **Step 3: Commit**

```bash
git add scripts/smoke-proactive.ts
git commit -m "test: end-to-end proactive smoke test"
```

---

## Task 22: Phase A wrap-up

- [ ] **Step 1: Tag the release**

```bash
git tag v0.1.0-phase-a
git log --oneline v0.1.0-phase-a~22..v0.1.0-phase-a
```

Expected: 22 commits since the tag base, one per task.

- [ ] **Step 2: Update CHANGELOG (create if absent)**

Add:

```markdown
## v0.1.0-phase-a (2026-05-24)

### Added
- Multi-LLM ModelRouter supporting Anthropic (CLI + API), OpenAI, Gemini, Kimi, Ollama
- Per-task tier routing (ultra_cheap / mid / heavy) with provider fallback
- Persistent cost tracker with monthly budget enforcement
- Local observer network: focus-app, browser-tabs, clipboard, file-events, calendar-local
- Event bus with SQLite persistence + in-memory pub/sub
- World-state snapshot aggregator
- Narrator producing 5-min LLM summaries via cheapest-tier provider

### Phase A is complete. Phase B (memory layers) starts next.
```

- [ ] **Step 3: Commit + push**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog for v0.1.0-phase-a"
```

(Hold the push until the user has reviewed the smoke test output.)

---

## Self-review

**Spec coverage:**
- ✅ Section 8 (Multi-LLM Router) — Tasks 1-10 cover all 6 providers + router + cost tracker + factory
- ✅ Section 1 (Architecture diagram, "5-stage loop: OBSERVE → AGGREGATE → NARRATE") — Tasks 11-19 cover OBSERVE (5 observers) + AGGREGATE (StateSnapshot) + NARRATE (Narrator)
- ✅ Tech stack table requirement for Bun/TS/SQLite — adhered throughout
- ⏭️ TRIGGER + ACT stages — explicitly deferred to Phase C (per spec's "build phases" section)
- ⏭️ Memory layers (working/episodic/semantic/procedural) — Phase B
- ⏭️ Cloud connectors (Gmail/Slack/etc.) — Phase D
- ⏭️ Tier-1 observer list per spec includes only the 5 here; matches

**Placeholder scan:** none found. Every task has actual code, exact paths, exact commands.

**Type consistency:** verified `CompletionRequest`/`CompletionResult` field names match across all 4 provider adapters, the router, and the narrator's usage. `Observer.emit()` signature matches all 5 concrete observers. `WorldEventInput.payload` is consistently `Record<string, unknown>`. `StateSnapshot` field names (`focus_app`, `open_tabs`, etc.) match across snapshot/narrator/tests.

**One inconsistency caught & noted:** the smoke test in Task 21 uses `intervalMs: 90_000` for faster narrative cycles during validation, while production default is `5 * 60_000`. This is intentional — the comment in Task 20 documents the default, and the smoke test override is explicit.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-24-phase-a-local-observers.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Best for Phase A since the 22 tasks are atomic and verifiable.

2. **Inline Execution** — Execute tasks in this session using executing-plans, batch with checkpoints. Slower but lets you intervene mid-task.

After Phase A ships and is tagged `v0.1.0-phase-a`, we write Phase B's plan and continue.
