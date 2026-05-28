# Phase C.2.6 — Cost & Recall: Prompt Caching + Semantic Vector Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce per-call LLM cost by ~10x via prompt caching AND replace keyword-only memory recall with hybrid semantic retrieval, so KAIROS can both afford to remember everything AND actually find what it remembers.

**Architecture:** Two tightly-related improvements ship together because they touch the same code path — the prompt-assembly pipeline that injects memory into LLM calls. Prompt caching demands that prompts be layered by volatility (stable system+procedural → semi-stable semantic → volatile episodic → current event). Semantic retrieval determines WHICH episodic and semantic snippets get pulled in. Refactor `CompletionRequest` once for both improvements rather than churn it twice.

**Two parallel sub-systems:**

1. **Cost subsystem (caching):** Refactor `CompletionRequest` from `{ system, prompt }` to `{ system_blocks[], context_blocks[], prompt }` where each block carries a `cache_hint`. Per-provider adapters translate the hints: Anthropic gets explicit `cache_control: {type: 'ephemeral'}` markers, OpenAI gets prefix-ordering for automatic caching, Gemini gets `cachedContents` resources, CLI subscriptions pass through. Add hosted-mode router preference that defaults to cheap models (`gpt-4o-mini` / `gemini-1.5-flash` / Kimi cheap tier) when the daemon runs in `KAIROS_MODE=hosted`.

2. **Recall subsystem (vector memory):** Add an `Embedder` interface with a default `LocalEmbedder` powered by `@huggingface/transformers` running `Xenova/bge-small-en-v1.5` ONNX in-process. Add `sqlite-vec` extension to the existing memory SQLite Database. Build `VectorIndex` (embed/insert/search/delete) and `HybridRetriever` (RRF fusion of FTS5 + vector results). Refactor L2 episodic + L3 semantic stores to use HybridRetriever instead of FTS5-only.

**Tech Stack additions:**
- `@huggingface/transformers@^3` — ONNX runtime + tokenizer in pure JS, runs in Bun
- `sqlite-vec@^0.1` — SQLite extension for vector storage + cosine search
- Embedding model: `Xenova/bge-small-en-v1.5` (33MB ONNX, 384-dim, MTEB-strong)

**Estimated size:** ~3,500 LOC of TypeScript + tests across 16 atomic tasks. Larger than C.2.5 because it touches two distinct subsystems, but coherent because both modify the same prompt-assembly pipeline.

**The cost math, restated for clarity:**

| Scenario | Tokens/call | $/call (Sonnet) | 200 calls/day |
|---|---|---|---|
| Today (no caching) | ~6,700 | $0.0201 | $4.02/day = $120/mo |
| After C.2.6 caching | ~6,700 (90% cached) | $0.0022 | $0.44/day = $13.20/mo |
| Hosted mode (gpt-4o-mini) | ~6,700 (50% cached) | $0.00033 | $0.066/day = $2/mo |

Order-of-magnitude better economics either way.

---

## Mode-aware routing primer

KAIROS will now know its own deployment mode via env var:

```
KAIROS_MODE=byo       # BYO subscription: prefer Claude Pro / Codex CLI / Ollama
KAIROS_MODE=hosted    # KAIROS Cloud: prefer cheap APIs (gpt-4o-mini, gemini-flash, kimi-cheap)
KAIROS_MODE=local     # Air-gapped: Ollama only
```

The router's per-tier provider preference list flips based on mode. This is wired in Task 6.

---

## File Structure

All new code follows existing conventions. New directories: `src/daemon/llm/cache/`, `src/daemon/memory/vector/`. Modifications to existing files are surgical.

```
src/daemon/llm/
├── types.ts                          [MODIFY — new CompletionRequest shape]
├── router.ts                         [MODIFY — mode-aware tier preferences + cost recording]
├── cache/                            [NEW]
│   ├── cacheHints.ts                 Block-volatility taxonomy + cache_hint translator
│   ├── promptAssembler.ts            Composes SystemBlock[] + ContextBlock[] + user prompt into provider-native shape
│   └── cacheStats.ts                 Per-call token accounting (input, output, cached) → SQLite
└── providers/
    ├── anthropic.ts                  [MODIFY — emit cache_control markers]
    ├── openai.ts                     [MODIFY — ensure stable prefix ordering for automatic caching]
    ├── gemini.ts                     [MODIFY — create cachedContents for long-hint blocks]
    ├── kimi.ts                       [MODIFY — Moonshot API, may not support caching; pass through]
    ├── ollama.ts                     [MODIFY — no caching, just adapt new shape]
    ├── anthropicCli.ts               [MODIFY — adapt new shape, no caching control]
    └── codexCli.ts                   [MODIFY — adapt new shape, no caching control]

src/daemon/memory/
├── vector/                           [NEW]
│   ├── embedder.ts                   Embedder interface + LocalEmbedder (Transformers.js)
│   ├── vectorIndex.ts                sqlite-vec wrapper: embed/insert/search/delete
│   └── hybridRetriever.ts            RRF fusion of FTS5 + vector hits
├── episodic.ts                       [MODIFY — store + retrieve via HybridRetriever]
├── semantic.ts                       [MODIFY — store + retrieve via HybridRetriever]
└── memoryInjector.ts                 [NEW or MODIFY — assembles ContextBlock[] for ModelRouter]

src/daemon/
├── types.ts                          [MODIFY — KAIROS_MODE config field]
├── config.ts                         [MODIFY — read KAIROS_MODE from env]
└── index.ts                          [MODIFY — instantiate Embedder + VectorIndex + HybridRetriever]
```

**Test files** alongside source as `*.test.ts`. Each new module has its own test file. Existing tests for `router`, `episodic`, `semantic` need adjustment to the new types.

---

## Task 0: Dependencies + types

**Files:**
- Modify: `package.json`
- Create: `src/daemon/llm/cache/cacheHints.ts`
- Modify: `src/daemon/llm/types.ts`

- [ ] **Step 1: Install deps**

```bash
cd /Users/nirmalghinaiya/Desktop/kairos-sandbox
bun add @huggingface/transformers@^3 sqlite-vec@^0.1
```

Verify `bun.lockb` updates. Re-run `bun install` to confirm no peer-dep warnings.

- [ ] **Step 2: Write `cacheHints.ts`**

```typescript
// src/daemon/llm/cache/cacheHints.ts
// Taxonomy of how long different prompt sections stay stable.
// Per-provider adapters translate these hints to native cache_control markers.

export type CacheHint = 'long' | 'short' | 'none'

// 'long'  — stable for hours/days (system prompt, persona, procedural memory, semantic memory)
//           Anthropic: cache_control with ephemeral type + 1h extended (when available)
//           OpenAI:    place first in prompt, automatic caching takes care of it
//           Gemini:    create explicit cachedContents resource
//
// 'short' — stable for minutes (recent episodic snippets, recent observations)
//           Anthropic: cache_control with ephemeral type, default 5-min TTL
//           OpenAI:    place after long-cached blocks, still benefits from automatic caching
//           Gemini:    inlined (TTL not worth the cachedContents overhead)
//
// 'none'  — volatile (current event/question, timestamp, random seed)
//           All providers: never cached

export type SystemBlock = {
  text: string
  cache_hint?: CacheHint    // defaults to 'long' for system blocks
  source?: 'persona' | 'standing_orders' | 'procedural_memory'
}

export type ContextBlock = {
  text: string
  cache_hint?: CacheHint    // defaults to 'short' for context blocks
  source: 'L1' | 'L2' | 'L3' | 'L4' | 'observation'
  ts?: number               // when the snippet was recorded (for sorting)
}

export type CacheableBlock = SystemBlock | ContextBlock

export function resolveHint(block: CacheableBlock): CacheHint {
  if (block.cache_hint) return block.cache_hint
  // Defaults: SystemBlock → long, ContextBlock by source
  if ('source' in block && (block.source === 'L1' || block.source === 'observation')) return 'none'
  if ('source' in block && (block.source === 'L2')) return 'short'
  return 'long'    // L3, L4, persona, standing_orders, procedural_memory default to long
}
```

- [ ] **Step 3: Modify `src/daemon/llm/types.ts`**

Replace the existing `CompletionRequest`:

```typescript
// src/daemon/llm/types.ts (relevant section)
import type { SystemBlock, ContextBlock } from './cache/cacheHints'

export type TaskType =
  | 'skill_generate' | 'agency_judge' | 'agency_summarize'
  | 'memory_consolidate' | 'observe_classify' | 'orders_compile'
  // ... existing values

export type LatencyTarget = 'fast' | 'standard' | 'patient'

export type CompletionRequest = {
  task_type: TaskType

  // NEW: replace single `system` string with structured blocks.
  // Each block carries a cache_hint; providers translate to native caching mechanisms.
  system_blocks: SystemBlock[]

  // NEW: memory injection blocks. Same caching semantics as system blocks but
  // logically separate so the router can decide which memory tier to include.
  context_blocks?: ContextBlock[]

  // The volatile user/trigger prompt — never cached.
  prompt: string

  structured?: boolean
  max_output_tokens?: number
  latency_target?: LatencyTarget
}

// Backward-compat shim — old call sites passing `{ system, prompt }` get auto-wrapped.
// Remove after all call sites migrated (target: end of C.2.6 Task 14).
export type LegacyCompletionRequest = {
  task_type: TaskType
  system?: string
  prompt: string
  structured?: boolean
  max_output_tokens?: number
  latency_target?: LatencyTarget
}

export type CompletionResult = {
  text: string
  parsed?: unknown
  provider: string
  model: string
  cost_cents: number              // rounded; full precision in token fields below
  latency_ms: number
  fallback_count: number
  input_tokens: number            // raw input tokens (incl. cached)
  output_tokens: number
  cached_input_tokens?: number    // NEW: how many of input_tokens were served from cache
  cache_creation_tokens?: number  // NEW: how many input tokens were written to cache this call
}
```

- [ ] **Step 4: Commit**

```bash
git add package.json bun.lockb src/daemon/llm/cache/cacheHints.ts src/daemon/llm/types.ts
git commit -m "feat(llm): C.2.6 type surface — SystemBlock/ContextBlock with cache_hint, new CompletionRequest shape"
```

---

## Task 1: PromptAssembler

**Files:**
- Create: `src/daemon/llm/cache/promptAssembler.ts`
- Test:  `src/daemon/llm/cache/promptAssembler.test.ts`

The assembler takes the structured request and produces a provider-native payload. It also orders blocks by volatility (long → short → none) so OpenAI's automatic prefix caching works without explicit markers.

- [ ] **Step 1: Test**

```typescript
// src/daemon/llm/cache/promptAssembler.test.ts
import { describe, it, expect } from 'bun:test'
import { PromptAssembler } from './promptAssembler'
import type { SystemBlock, ContextBlock } from './cacheHints'

describe('PromptAssembler', () => {
  it('orders blocks: long-cached first, then short-cached, then volatile', () => {
    const sys: SystemBlock[] = [
      { text: 'PERSONA', cache_hint: 'long' },
      { text: 'STANDING_ORDERS', cache_hint: 'long' },
    ]
    const ctx: ContextBlock[] = [
      { text: 'L2_recent', cache_hint: 'short', source: 'L2' },
      { text: 'L3_semantic', cache_hint: 'long', source: 'L3' },
      { text: 'now_obs', cache_hint: 'none', source: 'observation' },
    ]
    const out = new PromptAssembler().assemble({ system_blocks: sys, context_blocks: ctx, prompt: 'Q?', task_type: 'agency_judge' as any })
    // long-cached blocks come first (system + L3)
    expect(out.layered[0].cache_hint).toBe('long')
    expect(out.layered[1].cache_hint).toBe('long')
    expect(out.layered[2].cache_hint).toBe('long')
    // short-cached next
    expect(out.layered[3].cache_hint).toBe('short')
    // volatile last
    expect(out.layered[4].cache_hint).toBe('none')
  })

  it('marks the cache breakpoints — last long-block + last short-block', () => {
    const sys: SystemBlock[] = [{ text: 'A', cache_hint: 'long' }, { text: 'B', cache_hint: 'long' }]
    const ctx: ContextBlock[] = [{ text: 'C', cache_hint: 'short', source: 'L2' }]
    const out = new PromptAssembler().assemble({ system_blocks: sys, context_blocks: ctx, prompt: 'P', task_type: 'agency_judge' as any })
    // Anthropic-style markers: cache breakpoint goes on the LAST block of each cacheable tier
    expect(out.long_cache_breakpoint_index).toBe(1)    // last 'long' block
    expect(out.short_cache_breakpoint_index).toBe(2)   // last 'short' block (after 2 long blocks)
  })

  it('accepts legacy {system, prompt} shape and wraps it', () => {
    const out = PromptAssembler.fromLegacy({ task_type: 'agency_judge' as any, system: 'old-style', prompt: 'q' })
    expect(out.system_blocks.length).toBe(1)
    expect(out.system_blocks[0].text).toBe('old-style')
    expect(out.system_blocks[0].cache_hint).toBe('long')
  })

  it('computes total estimated tokens (rough)', () => {
    const sys: SystemBlock[] = [{ text: 'a'.repeat(400) }]    // ~100 tokens at 4 chars/token
    const out = new PromptAssembler().assemble({ system_blocks: sys, context_blocks: [], prompt: 'short', task_type: 'agency_judge' as any })
    expect(out.estimated_total_tokens).toBeGreaterThanOrEqual(100)
    expect(out.estimated_total_tokens).toBeLessThanOrEqual(150)
  })
})
```

- [ ] **Step 2: Implementation**

```typescript
// src/daemon/llm/cache/promptAssembler.ts
// Composes SystemBlock[] + ContextBlock[] + prompt into a layered structure
// providers translate to their native caching mechanism.

import type { CompletionRequest, LegacyCompletionRequest } from '../types'
import type { CacheableBlock, CacheHint, SystemBlock, ContextBlock } from './cacheHints'
import { resolveHint } from './cacheHints'

export type LayeredBlock = CacheableBlock & {
  cache_hint: CacheHint   // resolved (non-optional)
  kind: 'system' | 'context'
}

export type AssembledPrompt = {
  layered: LayeredBlock[]                       // ordered: long → short → none
  user_prompt: string                           // volatile, last
  long_cache_breakpoint_index: number | null    // index of LAST 'long' block (-1 if none)
  short_cache_breakpoint_index: number | null   // index of LAST 'short' block (-1 if none)
  estimated_total_tokens: number                // 1 token ≈ 4 chars (rough)
}

const ORDER: Record<CacheHint, number> = { long: 0, short: 1, none: 2 }

export class PromptAssembler {
  assemble(req: CompletionRequest): AssembledPrompt {
    const sys = (req.system_blocks ?? []).map(b => ({ ...b, kind: 'system' as const, cache_hint: resolveHint(b) }))
    const ctx = (req.context_blocks ?? []).map(b => ({ ...b, kind: 'context' as const, cache_hint: resolveHint(b) }))

    // Stable sort: order by cache_hint, then preserve original order within each tier.
    const layered: LayeredBlock[] = [...sys, ...ctx].sort((a, b) => ORDER[a.cache_hint] - ORDER[b.cache_hint])

    let long_bp: number | null = null
    let short_bp: number | null = null
    layered.forEach((b, i) => {
      if (b.cache_hint === 'long') long_bp = i
      if (b.cache_hint === 'short') short_bp = i
    })

    const totalChars = layered.reduce((n, b) => n + b.text.length, 0) + req.prompt.length
    return {
      layered,
      user_prompt: req.prompt,
      long_cache_breakpoint_index: long_bp,
      short_cache_breakpoint_index: short_bp,
      estimated_total_tokens: Math.ceil(totalChars / 4),
    }
  }

  static fromLegacy(legacy: LegacyCompletionRequest): CompletionRequest {
    return {
      task_type: legacy.task_type,
      system_blocks: legacy.system ? [{ text: legacy.system, cache_hint: 'long' as const }] : [],
      context_blocks: [],
      prompt: legacy.prompt,
      structured: legacy.structured,
      max_output_tokens: legacy.max_output_tokens,
      latency_target: legacy.latency_target,
    }
  }
}
```

- [ ] **Step 3: Run + commit**

```bash
bun test src/daemon/llm/cache/promptAssembler.test.ts
git add src/daemon/llm/cache/promptAssembler.ts src/daemon/llm/cache/promptAssembler.test.ts
git commit -m "feat(llm): PromptAssembler — orders blocks by volatility, marks cache breakpoints, legacy shim"
```

Expected: 4/4 pass.

---

## Task 2: Anthropic provider — emit cache_control

**Files:**
- Modify: `src/daemon/llm/providers/anthropic.ts`
- Test:  `src/daemon/llm/providers/anthropic.test.ts` (add cases)

Anthropic API supports prompt caching via explicit markers. The API shape for the system message:

```typescript
system: [
  { type: 'text', text: 'long-cached content', cache_control: { type: 'ephemeral' } },
  { type: 'text', text: 'short-cached content', cache_control: { type: 'ephemeral' } },
  { type: 'text', text: 'volatile content' }
]
```

Note Anthropic allows up to **4 cache breakpoints per request**. Use them strategically.

- [ ] **Step 1: Tests (add to existing file)**

```typescript
// Append to src/daemon/llm/providers/anthropic.test.ts
import { describe, it, expect } from 'bun:test'
import { AnthropicProvider } from './anthropic'

describe('AnthropicProvider caching', () => {
  it('emits cache_control on the last long-cached block', async () => {
    let capturedBody: any
    const provider = new AnthropicProvider({
      apiKey: 'test',
      fetch: async (_url, init) => {
        capturedBody = JSON.parse((init as RequestInit).body as string)
        return new Response(JSON.stringify({
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        }), { status: 200 })
      },
    })
    await provider.complete({
      task_type: 'agency_judge' as any,
      system_blocks: [
        { text: 'A', cache_hint: 'long' },
        { text: 'B', cache_hint: 'long' },    // ← cache_control should land HERE (last long)
      ],
      context_blocks: [
        { text: 'C', cache_hint: 'short', source: 'L2' }  // ← and HERE (last short)
      ],
      prompt: 'q',
    })
    // system array should have 3 items, only the 2nd (last long) carries cache_control
    expect(capturedBody.system.length).toBe(3)
    expect(capturedBody.system[0].cache_control).toBeUndefined()
    expect(capturedBody.system[1].cache_control).toEqual({ type: 'ephemeral' })
    expect(capturedBody.system[2].cache_control).toEqual({ type: 'ephemeral' })
  })

  it('reports cached_input_tokens in result', async () => {
    const provider = new AnthropicProvider({
      apiKey: 'test',
      fetch: async () => new Response(JSON.stringify({
        content: [{ type: 'text', text: 'r' }],
        usage: { input_tokens: 200, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 1500 },
      }), { status: 200 }),
    })
    const result = await provider.complete({
      task_type: 'agency_judge' as any,
      system_blocks: [{ text: 'A', cache_hint: 'long' }],
      context_blocks: [],
      prompt: 'q',
    })
    expect(result.cached_input_tokens).toBe(1500)
    expect(result.input_tokens).toBe(200)
  })
})
```

- [ ] **Step 2: Patch implementation**

The current `anthropic.ts` constructs a single `system` string. Refactor to build the array form. Use `PromptAssembler` internally.

Key changes:
```typescript
// src/daemon/llm/providers/anthropic.ts (relevant section)
import { PromptAssembler } from '../cache/promptAssembler'
const assembler = new PromptAssembler()

async complete(req: CompletionRequest): Promise<CompletionResult> {
  const assembled = assembler.assemble(req)

  // Build system array with cache_control on the LAST 'long' and LAST 'short' block.
  const systemArray = assembled.layered
    .filter(b => b.kind === 'system')   // only system blocks go in system: ...
    .map((b, i, arr) => {
      const obj: any = { type: 'text', text: b.text }
      // Mark cache breakpoint on the last long block AND last short block (if any are in system)
      if (i === assembled.long_cache_breakpoint_index || i === assembled.short_cache_breakpoint_index) {
        obj.cache_control = { type: 'ephemeral' }
      }
      return obj
    })

  // Context blocks (L2/L3) ALSO go in system array per Anthropic's recommendation —
  // they're stable enough to share the cache space. Append after system blocks.
  const contextSystem = assembled.layered
    .filter(b => b.kind === 'context' && b.cache_hint !== 'none')
    .map(b => {
      const obj: any = { type: 'text', text: b.text }
      if (b.cache_hint === 'long' || b.cache_hint === 'short') {
        obj.cache_control = { type: 'ephemeral' }
      }
      return obj
    })

  const messages = [{ role: 'user', content: assembled.user_prompt }]

  // Volatile context (cache_hint: 'none') prepends to user message instead of system
  const volatileContext = assembled.layered
    .filter(b => b.kind === 'context' && b.cache_hint === 'none')
    .map(b => b.text)
    .join('\n\n')
  if (volatileContext) {
    messages[0].content = volatileContext + '\n\n' + assembled.user_prompt
  }

  const body = {
    model: this.model,
    max_tokens: req.max_output_tokens ?? 2048,
    system: [...systemArray, ...contextSystem],
    messages,
  }

  // ... HTTP call as before ...

  return {
    text,
    parsed,
    provider: 'anthropic',
    model: this.model,
    cost_cents: this.computeCost(usage),
    latency_ms,
    fallback_count: 0,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cached_input_tokens: usage.cache_read_input_tokens ?? 0,
    cache_creation_tokens: usage.cache_creation_input_tokens ?? 0,
  }
}
```

Anthropic cache pricing (as of plan write): cache writes cost 1.25x base input, cache reads cost 0.1x base input. Update `computeCost`:

```typescript
private computeCost(usage: AnthropicUsage): number {
  // Sonnet 4.5 pricing per 1M tokens: $3 input, $15 output, $3.75 cache-write, $0.30 cache-read
  const baseInputTokens = usage.input_tokens - (usage.cache_read_input_tokens ?? 0) - (usage.cache_creation_input_tokens ?? 0)
  const cacheWrite = usage.cache_creation_input_tokens ?? 0
  const cacheRead = usage.cache_read_input_tokens ?? 0
  const out = usage.output_tokens
  const cents = (baseInputTokens * 0.0003 + cacheWrite * 0.000375 + cacheRead * 0.00003 + out * 0.0015) / 10
  return Math.round(cents * 100) / 100
}
```

- [ ] **Step 3: Run + commit**

```bash
bun test src/daemon/llm/providers/anthropic.test.ts
git add src/daemon/llm/providers/anthropic.ts src/daemon/llm/providers/anthropic.test.ts
git commit -m "feat(llm): Anthropic provider emits cache_control markers + reports cached_input_tokens"
```

Expected: all existing tests still pass + 2 new caching tests pass.

---

## Task 3: OpenAI provider — prefix-stable ordering

**Files:**
- Modify: `src/daemon/llm/providers/openai.ts`
- Test: `src/daemon/llm/providers/openai.test.ts` (add cases)

OpenAI's prompt caching is **automatic** — it hashes prefixes of >1024 tokens and serves matching prefixes from cache at 50% discount. No explicit markers. The only thing KAIROS needs to do is ensure stable blocks ALWAYS come first in the prompt, in the same order, every call.

- [ ] **Step 1: Tests**

```typescript
// Append to src/daemon/llm/providers/openai.test.ts
describe('OpenAIProvider caching', () => {
  it('places long-cached blocks before short before volatile in system message', async () => {
    let capturedBody: any
    const provider = new OpenAIProvider({
      apiKey: 'test',
      fetch: async (_url, init) => {
        capturedBody = JSON.parse((init as RequestInit).body as string)
        return new Response(JSON.stringify({
          choices: [{ message: { content: 'ok' } }],
          usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 0 } },
        }), { status: 200 })
      },
    })
    await provider.complete({
      task_type: 'agency_judge' as any,
      system_blocks: [
        { text: 'LONG_A', cache_hint: 'long' },
        { text: 'LONG_B', cache_hint: 'long' },
      ],
      context_blocks: [
        { text: 'SHORT_C', cache_hint: 'short', source: 'L2' },
        { text: 'VOLATILE_D', cache_hint: 'none', source: 'observation' },
      ],
      prompt: 'q',
    })
    const sysContent = capturedBody.messages[0].content
    // LONG_A appears before LONG_B before SHORT_C
    expect(sysContent.indexOf('LONG_A')).toBeLessThan(sysContent.indexOf('LONG_B'))
    expect(sysContent.indexOf('LONG_B')).toBeLessThan(sysContent.indexOf('SHORT_C'))
    // VOLATILE_D goes in user message, not system
    expect(sysContent).not.toContain('VOLATILE_D')
    expect(capturedBody.messages[1].content).toContain('VOLATILE_D')
  })

  it('reports cached_input_tokens from prompt_tokens_details.cached_tokens', async () => {
    const provider = new OpenAIProvider({
      apiKey: 'test',
      fetch: async () => new Response(JSON.stringify({
        choices: [{ message: { content: 'r' } }],
        usage: { prompt_tokens: 200, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 1500 } },
      }), { status: 200 }),
    })
    const result = await provider.complete({
      task_type: 'agency_judge' as any,
      system_blocks: [{ text: 'A', cache_hint: 'long' }],
      context_blocks: [],
      prompt: 'q',
    })
    expect(result.cached_input_tokens).toBe(1500)
  })
})
```

- [ ] **Step 2: Implementation**

```typescript
// src/daemon/llm/providers/openai.ts — adapt to new shape, ensure prefix ordering
async complete(req: CompletionRequest): Promise<CompletionResult> {
  const assembled = new PromptAssembler().assemble(req)

  // System message = concatenation of all NON-volatile blocks, in volatility order
  const systemContent = assembled.layered
    .filter(b => b.cache_hint !== 'none')
    .map(b => b.text)
    .join('\n\n')

  // User message = volatile context (if any) + the actual user prompt
  const volatileContext = assembled.layered
    .filter(b => b.cache_hint === 'none')
    .map(b => b.text)
    .join('\n\n')
  const userContent = volatileContext ? volatileContext + '\n\n' + assembled.user_prompt : assembled.user_prompt

  const body = {
    model: this.model,
    messages: [
      { role: 'system', content: systemContent },
      { role: 'user', content: userContent },
    ],
    max_tokens: req.max_output_tokens ?? 2048,
  }

  // ... HTTP call ...

  return {
    text,
    parsed,
    provider: 'openai',
    model: this.model,
    cost_cents: this.computeCost(usage),
    latency_ms,
    fallback_count: 0,
    input_tokens: usage.prompt_tokens,
    output_tokens: usage.completion_tokens,
    cached_input_tokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
    cache_creation_tokens: 0,   // OpenAI doesn't charge for cache writes
  }
}

private computeCost(usage: OpenAIUsage): number {
  // gpt-4o-mini pricing per 1M tokens: $0.15 input, $0.60 output, $0.075 cached input (50% off)
  const cachedTokens = usage.prompt_tokens_details?.cached_tokens ?? 0
  const baseInput = usage.prompt_tokens - cachedTokens
  const out = usage.completion_tokens
  // Convert to cents per token then sum
  const cents = (baseInput * 0.000015 + cachedTokens * 0.0000075 + out * 0.00006) / 10
  return Math.round(cents * 100) / 100
}
```

- [ ] **Step 3: Run + commit**

```bash
bun test src/daemon/llm/providers/openai.test.ts
git add src/daemon/llm/providers/openai.ts src/daemon/llm/providers/openai.test.ts
git commit -m "feat(llm): OpenAI provider — prefix-stable ordering for automatic prompt caching + cost tracking"
```

Expected: all existing tests pass + 2 new caching tests.

---

## Task 4: Gemini provider — cachedContents

**Files:**
- Modify: `src/daemon/llm/providers/gemini.ts`
- Test: `src/daemon/llm/providers/gemini.test.ts` (add cases)

Gemini uses an explicit `cachedContents` resource. Cache creation has its own API call (`cachedContents.create`), returns a name, then subsequent generation calls reference the cache by name. Cache has explicit TTL (KAIROS uses 1h).

For 'long'-hint blocks, create+reuse a cache. For 'short' and 'none', inline.

- [ ] **Step 1: Tests**

```typescript
describe('GeminiProvider caching', () => {
  it('creates a cachedContents resource for long-hint blocks on first call', async () => {
    const httpCalls: string[] = []
    const provider = new GeminiProvider({
      apiKey: 'test',
      fetch: async (url, init) => {
        httpCalls.push((init as RequestInit).method + ' ' + url.toString())
        if (url.toString().includes('cachedContents')) {
          return new Response(JSON.stringify({ name: 'cachedContents/abc123' }), { status: 200 })
        }
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'ok' }] } }],
          usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10, cachedContentTokenCount: 80 },
        }), { status: 200 })
      },
    })
    await provider.complete({
      task_type: 'agency_judge' as any,
      system_blocks: [{ text: 'A'.repeat(2000), cache_hint: 'long' }],   // big enough to be worth caching
      context_blocks: [],
      prompt: 'q',
    })
    expect(httpCalls.some(c => c.includes('cachedContents'))).toBe(true)
  })

  it('reuses an existing cachedContents resource within TTL', async () => {
    // ... write a test that calls .complete() twice with the same long-hint content;
    // assert the second call does NOT create a new cachedContents resource ...
  })

  it('reports cached_input_tokens from usageMetadata.cachedContentTokenCount', async () => {
    // ... assert result.cached_input_tokens matches the API response ...
  })
})
```

- [ ] **Step 2: Implementation**

Add a per-provider cache index keyed by hash of long-content + model:

```typescript
// src/daemon/llm/providers/gemini.ts
type CacheEntry = { name: string; created_at: number; ttl_ms: number; content_hash: string }
const CACHE_TTL_MS = 60 * 60 * 1000   // 1 hour
const MIN_CACHE_TOKENS = 4096          // Gemini minimum for cachedContents

export class GeminiProvider {
  private cacheIndex: Map<string, CacheEntry> = new Map()   // hash → CacheEntry

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const assembled = new PromptAssembler().assemble(req)

    // Decide whether to use cachedContents:
    // - Sum of 'long'-hint blocks must exceed MIN_CACHE_TOKENS (4096)
    // - Cache must exist or be created
    const longContent = assembled.layered.filter(b => b.cache_hint === 'long').map(b => b.text).join('\n\n')
    const longTokensEstimate = Math.ceil(longContent.length / 4)

    let cacheName: string | undefined
    if (longContent && longTokensEstimate >= MIN_CACHE_TOKENS) {
      cacheName = await this.getOrCreateCache(longContent)
    }

    // The remaining content (short + volatile) goes inline.
    const inlineContent = assembled.layered
      .filter(b => b.cache_hint !== 'long')
      .map(b => b.text)
      .join('\n\n')
    const userContent = inlineContent ? inlineContent + '\n\n' + assembled.user_prompt : assembled.user_prompt

    const body: any = {
      contents: [{ role: 'user', parts: [{ text: userContent }] }],
      generationConfig: { maxOutputTokens: req.max_output_tokens ?? 2048 },
    }
    if (cacheName) body.cachedContent = cacheName

    // ... HTTP call to v1beta/models/{model}:generateContent ...

    return {
      text, parsed,
      provider: 'gemini',
      model: this.model,
      cost_cents: this.computeCost(usage),
      latency_ms,
      fallback_count: 0,
      input_tokens: usage.promptTokenCount,
      output_tokens: usage.candidatesTokenCount,
      cached_input_tokens: usage.cachedContentTokenCount ?? 0,
      cache_creation_tokens: 0,
    }
  }

  private async getOrCreateCache(content: string): Promise<string> {
    const hash = await sha256(this.model + ':' + content)
    const existing = this.cacheIndex.get(hash)
    if (existing && Date.now() - existing.created_at < existing.ttl_ms) return existing.name

    // Create a new cachedContents resource
    const url = `https://generativelanguage.googleapis.com/v1beta/cachedContents?key=${this.apiKey}`
    const res = await this.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: `models/${this.model}`,
        contents: [{ role: 'user', parts: [{ text: content }] }],
        ttl: { seconds: 3600 },
      }),
    })
    const json = await res.json()
    this.cacheIndex.set(hash, { name: json.name, created_at: Date.now(), ttl_ms: CACHE_TTL_MS, content_hash: hash })
    return json.name
  }
}

async function sha256(input: string): Promise<string> {
  const hashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('')
}
```

- [ ] **Step 3: Run + commit**

```bash
bun test src/daemon/llm/providers/gemini.test.ts
git add src/daemon/llm/providers/gemini.ts src/daemon/llm/providers/gemini.test.ts
git commit -m "feat(llm): Gemini provider — cachedContents resource for long-hint blocks + reuse within TTL"
```

Expected: existing tests + 3 new caching tests.

---

## Task 5: Adapt remaining providers (Kimi, Ollama, anthropic_cli, codex_cli)

**Files:**
- Modify: `src/daemon/llm/providers/kimi.ts`
- Modify: `src/daemon/llm/providers/ollama.ts`
- Modify: `src/daemon/llm/providers/anthropicCli.ts`
- Modify: `src/daemon/llm/providers/codexCli.ts`

These providers don't expose KAIROS-controllable caching:
- **Kimi (Moonshot):** OpenAI-compatible API. No documented prompt caching as of plan write — adapt to new shape, return `cached_input_tokens: 0`. If/when Moonshot adds caching, revisit.
- **Ollama:** Local, no caching API. Adapt new shape, `cached_input_tokens: 0`.
- **anthropic_cli:** Shells out to `claude --print`. Caching happens internally in the CLI/upstream service, KAIROS can't observe it. Adapt new shape, leave `cached_input_tokens: undefined` (signal "we don't know").
- **codex_cli:** Same pattern as anthropic_cli.

- [ ] **Step 1: Adapt each provider**

For each, the change is:
1. Accept the new `CompletionRequest` shape (uses `system_blocks`/`context_blocks` instead of `system`)
2. Use `PromptAssembler` to flatten back into the format the provider needs
3. Set `cached_input_tokens: 0` (Kimi/Ollama) or `undefined` (CLI providers)

Example for kimi.ts:
```typescript
async complete(req: CompletionRequest): Promise<CompletionResult> {
  const assembled = new PromptAssembler().assemble(req)
  const systemContent = assembled.layered.filter(b => b.cache_hint !== 'none').map(b => b.text).join('\n\n')
  const volatile = assembled.layered.filter(b => b.cache_hint === 'none').map(b => b.text).join('\n\n')
  const userContent = volatile ? volatile + '\n\n' + assembled.user_prompt : assembled.user_prompt

  // ... existing Moonshot HTTP call with these flattened strings ...

  return { /* ... */, cached_input_tokens: 0, cache_creation_tokens: 0 }
}
```

For anthropicCli.ts and codexCli.ts, also flatten via PromptAssembler. Pass the result to the shell command. Add a comment that caching is upstream and not measurable.

- [ ] **Step 2: Run all provider tests**

```bash
bun test src/daemon/llm/providers/
```

- [ ] **Step 3: Commit**

```bash
git add src/daemon/llm/providers/kimi.ts src/daemon/llm/providers/ollama.ts src/daemon/llm/providers/anthropicCli.ts src/daemon/llm/providers/codexCli.ts
git commit -m "feat(llm): remaining providers adapt to CompletionRequest with system_blocks (no native caching)"
```

Expected: all provider tests still pass (no caching tests added for these — they're pass-through).

---

## Task 6: Mode-aware router preferences

**Files:**
- Modify: `src/daemon/llm/router.ts`
- Test: `src/daemon/llm/router.test.ts` (add cases)

The router has per-tier provider preferences (cheap/standard/heavy). Add a `KAIROS_MODE` axis:

- **`byo`** (default if Claude/Codex CLI detected): prefer CLI subscriptions, then Ollama
- **`hosted`** (KAIROS Cloud): prefer cheap APIs (gpt-4o-mini, gemini-flash, kimi-cheap), then Anthropic if needed
- **`local`**: Ollama only, fail-closed if Ollama unreachable

- [ ] **Step 1: Tests**

```typescript
describe('ModelRouter mode preferences', () => {
  it('byo mode: prefers Anthropic CLI when available', async () => {
    const router = createTestRouter({ mode: 'byo', available: ['anthropic_cli', 'openai_api'] })
    const chosen = router.pickProviderForTask({ task_type: 'agency_judge' as any, /* tier=standard */ } as any)
    expect(chosen.provider).toBe('anthropic_cli')
  })

  it('hosted mode: prefers gpt-4o-mini for cheap tier', async () => {
    const router = createTestRouter({ mode: 'hosted', available: ['anthropic_cli', 'openai_api', 'gemini_api'] })
    const chosen = router.pickProviderForTask({ task_type: 'observe_classify' as any, /* tier=cheap */ } as any)
    expect(chosen.provider).toBe('openai_api')
    expect(chosen.model).toBe('gpt-4o-mini')
  })

  it('hosted mode: uses gemini-1.5-flash if OpenAI unavailable', async () => {
    const router = createTestRouter({ mode: 'hosted', available: ['gemini_api', 'kimi_api'] })
    const chosen = router.pickProviderForTask({ task_type: 'observe_classify' as any } as any)
    expect(['gemini_api', 'kimi_api']).toContain(chosen.provider)
  })

  it('local mode: only Ollama, never API providers', async () => {
    const router = createTestRouter({ mode: 'local', available: ['anthropic_cli', 'openai_api', 'ollama'] })
    const chosen = router.pickProviderForTask({ task_type: 'agency_judge' as any } as any)
    expect(chosen.provider).toBe('ollama')
  })

  it('local mode + no Ollama: throws clear error', async () => {
    const router = createTestRouter({ mode: 'local', available: ['anthropic_cli'] })
    expect(() => router.pickProviderForTask({ task_type: 'agency_judge' as any } as any)).toThrow(/local mode/i)
  })
})
```

- [ ] **Step 2: Implementation**

Add the mode dimension to the provider-preference table. Sketch:

```typescript
// src/daemon/llm/router.ts (relevant additions)

export type KairosMode = 'byo' | 'hosted' | 'local'

type ProviderPreferenceTable = Record<KairosMode, Record<Tier, Array<{ provider: string; model: string }>>>

const PREFS: ProviderPreferenceTable = {
  byo: {
    cheap:    [{ provider: 'anthropic_cli', model: 'haiku' }, { provider: 'ollama', model: 'llama-3.2-3b' }, { provider: 'openai_api', model: 'gpt-4o-mini' }],
    standard: [{ provider: 'anthropic_cli', model: 'sonnet' }, { provider: 'codex_cli', model: 'gpt-4o' }, { provider: 'openai_api', model: 'gpt-4o-mini' }],
    heavy:    [{ provider: 'anthropic_cli', model: 'opus' }, { provider: 'codex_cli', model: 'o1' }, { provider: 'anthropic_api', model: 'sonnet-4-5' }],
  },
  hosted: {
    cheap:    [{ provider: 'openai_api', model: 'gpt-4o-mini' }, { provider: 'gemini_api', model: 'gemini-1.5-flash' }, { provider: 'kimi_api', model: 'kimi-8k' }],
    standard: [{ provider: 'openai_api', model: 'gpt-4o' }, { provider: 'gemini_api', model: 'gemini-1.5-pro' }, { provider: 'anthropic_api', model: 'sonnet-4-5' }],
    heavy:    [{ provider: 'anthropic_api', model: 'sonnet-4-5' }, { provider: 'openai_api', model: 'gpt-4o' }, { provider: 'gemini_api', model: 'gemini-1.5-pro' }],
  },
  local: {
    cheap:    [{ provider: 'ollama', model: 'llama-3.2-3b' }],
    standard: [{ provider: 'ollama', model: 'llama-3.1-8b' }],
    heavy:    [{ provider: 'ollama', model: 'qwen2.5-14b' }],
  },
}

export class ModelRouter {
  constructor(opts: { mode: KairosMode; providerRegistry: ProviderRegistry }) { /* ... */ }

  pickProviderForTask(req: CompletionRequest): { provider: string; model: string } {
    const tier = TASK_TIER[req.task_type]
    const candidates = PREFS[this.mode][tier]
    for (const c of candidates) {
      if (this.providerRegistry.isAvailable(c.provider)) return c
    }
    if (this.mode === 'local') {
      throw new Error(`ModelRouter: local mode requires Ollama, but it's not available`)
    }
    throw new Error(`ModelRouter: no available provider for tier=${tier} in mode=${this.mode}`)
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const choice = this.pickProviderForTask(req)
    const result = await this.providerRegistry.get(choice.provider).complete({ ...req, model: choice.model } as any)

    // Record cost metrics (Task 7 wires this into a SQLite store)
    await this.cacheStats?.record({
      provider: choice.provider, model: choice.model, task_type: req.task_type,
      input_tokens: result.input_tokens, output_tokens: result.output_tokens,
      cached_input_tokens: result.cached_input_tokens ?? 0,
      cost_cents: result.cost_cents,
    })

    return result
  }
}
```

- [ ] **Step 3: Run + commit**

```bash
bun test src/daemon/llm/router.test.ts
git add src/daemon/llm/router.ts src/daemon/llm/router.test.ts
git commit -m "feat(llm): ModelRouter mode-aware tier preferences (byo / hosted / local)"
```

Expected: existing router tests still pass + 5 new mode tests.

---

## Task 7: CacheStats — per-call cost tracking

**Files:**
- Create: `src/daemon/llm/cache/cacheStats.ts`
- Create: `src/daemon/llm/cache/cacheStats.test.ts`

Records per-call metrics (provider, tokens, cost, cached %) to a SQLite table. Lets the dashboard (Phase F) show "you saved $X via caching this week" and lets KAIROS make budget decisions.

- [ ] **Step 1: Test**

```typescript
// src/daemon/llm/cache/cacheStats.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { CacheStats } from './cacheStats'

describe('CacheStats', () => {
  let db: Database
  let stats: CacheStats

  beforeEach(() => {
    db = new Database(':memory:')
    stats = new CacheStats(db)
  })

  it('records a call and retrieves it', async () => {
    await stats.record({
      provider: 'anthropic', model: 'sonnet-4-5', task_type: 'agency_judge',
      input_tokens: 6700, output_tokens: 200, cached_input_tokens: 6000, cost_cents: 0.22,
    })
    const summary = stats.summaryFor({ window_ms: 24 * 60 * 60 * 1000 })
    expect(summary.total_calls).toBe(1)
    expect(summary.total_input_tokens).toBe(6700)
    expect(summary.total_cached_tokens).toBe(6000)
    expect(summary.cache_hit_rate).toBeCloseTo(6000 / 6700)
  })

  it('aggregates by provider', async () => {
    await stats.record({ provider: 'anthropic', model: 'sonnet', task_type: 'a' as any, input_tokens: 100, output_tokens: 10, cached_input_tokens: 50, cost_cents: 0.1 })
    await stats.record({ provider: 'openai', model: 'gpt-4o-mini', task_type: 'b' as any, input_tokens: 200, output_tokens: 20, cached_input_tokens: 100, cost_cents: 0.05 })
    const byProvider = stats.summaryByProvider({ window_ms: 24 * 60 * 60 * 1000 })
    expect(byProvider.anthropic.total_calls).toBe(1)
    expect(byProvider.openai.total_calls).toBe(1)
  })

  it('projects monthly cost from rolling window', async () => {
    // Record 10 calls in last 24h, each $0.10 → projected month = $30
    for (let i = 0; i < 10; i++) {
      await stats.record({ provider: 'a' as any, model: 'm', task_type: 't' as any, input_tokens: 100, output_tokens: 10, cached_input_tokens: 50, cost_cents: 10 })
    }
    const proj = stats.projectedMonthlyCost()
    expect(proj).toBeCloseTo(300, 0)   // $300/month projected from $10/day
  })
})
```

- [ ] **Step 2: Implementation**

```typescript
// src/daemon/llm/cache/cacheStats.ts
import type { Database } from 'bun:sqlite'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS llm_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  task_type TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  cost_cents REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_llm_calls_ts ON llm_calls(ts);
CREATE INDEX IF NOT EXISTS idx_llm_calls_provider ON llm_calls(provider);
`

export type CallRecord = {
  provider: string
  model: string
  task_type: string
  input_tokens: number
  output_tokens: number
  cached_input_tokens: number
  cost_cents: number
}

export type Summary = {
  total_calls: number
  total_input_tokens: number
  total_output_tokens: number
  total_cached_tokens: number
  cache_hit_rate: number
  total_cost_cents: number
}

export class CacheStats {
  constructor(private db: Database) {
    db.exec(SCHEMA)
  }

  async record(c: CallRecord): Promise<void> {
    this.db.run(
      `INSERT INTO llm_calls (ts, provider, model, task_type, input_tokens, output_tokens, cached_input_tokens, cost_cents)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [Date.now(), c.provider, c.model, c.task_type, c.input_tokens, c.output_tokens, c.cached_input_tokens, c.cost_cents],
    )
  }

  summaryFor(opts: { window_ms: number }): Summary {
    const since = Date.now() - opts.window_ms
    const row = this.db.query(`
      SELECT
        COUNT(*) AS total_calls,
        COALESCE(SUM(input_tokens), 0) AS total_input,
        COALESCE(SUM(output_tokens), 0) AS total_output,
        COALESCE(SUM(cached_input_tokens), 0) AS total_cached,
        COALESCE(SUM(cost_cents), 0) AS total_cost
      FROM llm_calls WHERE ts >= ?
    `).get(since) as any
    const hit_rate = row.total_input > 0 ? row.total_cached / row.total_input : 0
    return {
      total_calls: row.total_calls,
      total_input_tokens: row.total_input,
      total_output_tokens: row.total_output,
      total_cached_tokens: row.total_cached,
      cache_hit_rate: hit_rate,
      total_cost_cents: row.total_cost,
    }
  }

  summaryByProvider(opts: { window_ms: number }): Record<string, Summary> {
    const since = Date.now() - opts.window_ms
    const rows = this.db.query(`
      SELECT provider, COUNT(*) AS total_calls,
             COALESCE(SUM(input_tokens), 0) AS total_input,
             COALESCE(SUM(output_tokens), 0) AS total_output,
             COALESCE(SUM(cached_input_tokens), 0) AS total_cached,
             COALESCE(SUM(cost_cents), 0) AS total_cost
      FROM llm_calls WHERE ts >= ? GROUP BY provider
    `).all(since) as any[]
    const out: Record<string, Summary> = {}
    for (const r of rows) {
      out[r.provider] = {
        total_calls: r.total_calls,
        total_input_tokens: r.total_input,
        total_output_tokens: r.total_output,
        total_cached_tokens: r.total_cached,
        cache_hit_rate: r.total_input > 0 ? r.total_cached / r.total_input : 0,
        total_cost_cents: r.total_cost,
      }
    }
    return out
  }

  projectedMonthlyCost(): number {
    const day = this.summaryFor({ window_ms: 24 * 60 * 60 * 1000 })
    return (day.total_cost_cents / 100) * 30
  }
}
```

- [ ] **Step 3: Run + commit**

```bash
bun test src/daemon/llm/cache/cacheStats.test.ts
git add src/daemon/llm/cache/cacheStats.ts src/daemon/llm/cache/cacheStats.test.ts
git commit -m "feat(llm): CacheStats — per-call cost+cache tracking with windowed summaries"
```

Expected: 3/3 pass.

---

## Task 8: Embedder interface + LocalEmbedder

**Files:**
- Create: `src/daemon/memory/vector/embedder.ts`
- Create: `src/daemon/memory/vector/embedder.test.ts`

In-process embeddings via `@huggingface/transformers`. Model: `Xenova/bge-small-en-v1.5` (33MB ONNX, 384-dim).

- [ ] **Step 1: Test**

```typescript
// src/daemon/memory/vector/embedder.test.ts
import { describe, it, expect, beforeAll } from 'bun:test'
import { LocalEmbedder } from './embedder'

describe('LocalEmbedder', () => {
  let embedder: LocalEmbedder

  beforeAll(async () => {
    embedder = new LocalEmbedder()
    await embedder.warmup()
  }, 60_000)    // model download can take a minute on first run

  it('embeds a string to a 384-dim Float32Array', async () => {
    const v = await embedder.embed('the quick brown fox')
    expect(v.length).toBe(384)
    expect(v).toBeInstanceOf(Float32Array)
  })

  it('produces similar vectors for semantically similar text', async () => {
    const a = await embedder.embed('I went to the store to buy milk')
    const b = await embedder.embed('I picked up some milk from the grocery')
    const c = await embedder.embed('the spaceship docked at the moon base')
    expect(cosine(a, b)).toBeGreaterThan(cosine(a, c))
  })

  it('batch embeds multiple strings', async () => {
    const vs = await embedder.embedBatch(['hello', 'world', 'foo'])
    expect(vs.length).toBe(3)
    expect(vs[0].length).toBe(384)
  })

  it('reports dimension via property', () => {
    expect(embedder.dim).toBe(384)
  })
})

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}
```

- [ ] **Step 2: Implementation**

```typescript
// src/daemon/memory/vector/embedder.ts
// In-process embeddings via Transformers.js ONNX runtime.
// Default model: Xenova/bge-small-en-v1.5 (33MB quantized, 384-dim, MTEB-strong).
//
// First call downloads + caches the model under ~/.cache/huggingface/. Subsequent
// runs load from disk in ~200ms.

import { pipeline, env, type FeatureExtractionPipeline } from '@huggingface/transformers'

// Pin to a stable model. Override via env if needed for evaluation.
const DEFAULT_MODEL = process.env.KAIROS_EMBED_MODEL ?? 'Xenova/bge-small-en-v1.5'
const DIM = 384

export interface Embedder {
  readonly dim: number
  warmup(): Promise<void>
  embed(text: string): Promise<Float32Array>
  embedBatch(texts: string[]): Promise<Float32Array[]>
}

export class LocalEmbedder implements Embedder {
  readonly dim = DIM
  private pipe: FeatureExtractionPipeline | null = null
  private warmupPromise: Promise<void> | null = null

  constructor(opts: { model?: string; cacheDir?: string } = {}) {
    // Cache models under ~/.kairos/cache/huggingface so we own the cache location.
    env.cacheDir = opts.cacheDir ?? (require('os').homedir() + '/.kairos/cache/huggingface')
  }

  async warmup(): Promise<void> {
    if (this.warmupPromise) return this.warmupPromise
    this.warmupPromise = (async () => {
      this.pipe = await pipeline('feature-extraction', DEFAULT_MODEL, {
        quantized: true,   // use the int8 quantized ONNX variant (smaller, faster)
      }) as FeatureExtractionPipeline
    })()
    return this.warmupPromise
  }

  async embed(text: string): Promise<Float32Array> {
    await this.warmup()
    const result = await this.pipe!(text, { pooling: 'mean', normalize: true })
    // result.data is Float32Array of shape [DIM]
    return new Float32Array(result.data as Float32Array)
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    await this.warmup()
    // Transformers.js supports batch input directly
    const result = await this.pipe!(texts, { pooling: 'mean', normalize: true })
    // result.data is Float32Array of shape [N*DIM]
    const out: Float32Array[] = []
    for (let i = 0; i < texts.length; i++) {
      out.push(new Float32Array(result.data.slice(i * DIM, (i + 1) * DIM) as Float32Array))
    }
    return out
  }
}

// Stub for future hosted-mode embedder (Voyage / OpenAI / Gemini)
export class HostedEmbedder implements Embedder {
  readonly dim = DIM   // adjust if using a different model
  async warmup(): Promise<void> { /* TODO Phase C.2.7 follow-up if needed */ }
  async embed(_text: string): Promise<Float32Array> { throw new Error('HostedEmbedder: not implemented in C.2.6') }
  async embedBatch(_texts: string[]): Promise<Float32Array[]> { throw new Error('HostedEmbedder: not implemented in C.2.6') }
}
```

- [ ] **Step 3: Run + commit**

```bash
bun test src/daemon/memory/vector/embedder.test.ts
# First run downloads the model — give it up to 60s
git add src/daemon/memory/vector/embedder.ts src/daemon/memory/vector/embedder.test.ts
git commit -m "feat(memory): LocalEmbedder — in-process Transformers.js with bge-small-en-v1.5 (384-dim)"
```

Expected: 4/4 pass (slow on first run due to model download).

---

## Task 9: VectorIndex with sqlite-vec

**Files:**
- Create: `src/daemon/memory/vector/vectorIndex.ts`
- Create: `src/daemon/memory/vector/vectorIndex.test.ts`

`sqlite-vec` extension lets a regular SQLite table hold vectors and run cosine search via virtual table. The extension ships as a `.dylib` for macOS. Load via `db.loadExtension(path)`.

- [ ] **Step 1: Verify extension loads**

```bash
bun --eval 'import { Database } from "bun:sqlite"; const db = new Database(":memory:"); db.loadExtension(require.resolve("sqlite-vec")); db.run("CREATE VIRTUAL TABLE v USING vec0(embed FLOAT[384])"); console.log("ok")'
```

Should print `ok`. If sqlite-vec path is wrong, find the .dylib under `node_modules/sqlite-vec` and adjust the resolve path.

- [ ] **Step 2: Test**

```typescript
// src/daemon/memory/vector/vectorIndex.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { VectorIndex } from './vectorIndex'
import { LocalEmbedder } from './embedder'

describe('VectorIndex', () => {
  let db: Database
  let embedder: LocalEmbedder
  let index: VectorIndex

  beforeEach(async () => {
    db = new Database(':memory:')
    embedder = new LocalEmbedder()
    await embedder.warmup()
    index = new VectorIndex(db, embedder, { tableName: 'test_vec' })
    await index.init()
  })

  it('inserts and retrieves by id', async () => {
    await index.insert('doc1', 'the cat sat on the mat')
    const found = await index.searchByText('feline on a rug', 3)
    expect(found.length).toBeGreaterThan(0)
    expect(found[0].id).toBe('doc1')
  })

  it('cosine ranks results by semantic similarity', async () => {
    await index.insert('doc-a', 'I love programming in Rust')
    await index.insert('doc-b', 'My favorite hobby is gardening')
    await index.insert('doc-c', 'Systems programming is fascinating')
    const results = await index.searchByText('writing systems software', 3)
    // doc-a and doc-c should rank above doc-b
    expect(results[0].id).toMatch(/^doc-(a|c)$/)
    expect(results[1].id).toMatch(/^doc-(a|c)$/)
    expect(results[2].id).toBe('doc-b')
  })

  it('delete removes an entry', async () => {
    await index.insert('x', 'hello')
    await index.delete('x')
    const r = await index.searchByText('hello', 5)
    expect(r.find(h => h.id === 'x')).toBeUndefined()
  })

  it('respects limit parameter', async () => {
    for (let i = 0; i < 10; i++) await index.insert('id-' + i, 'document number ' + i)
    const r = await index.searchByText('document', 3)
    expect(r.length).toBe(3)
  })

  it('returns cosine distance + similarity score', async () => {
    await index.insert('exact', 'the quick brown fox')
    const r = await index.searchByText('the quick brown fox', 1)
    expect(r[0].similarity).toBeGreaterThan(0.95)    // near-exact match
  })
})
```

- [ ] **Step 3: Implementation**

```typescript
// src/daemon/memory/vector/vectorIndex.ts
import type { Database } from 'bun:sqlite'
import type { Embedder } from './embedder'

const SQLITE_VEC_PATH = process.env.KAIROS_SQLITE_VEC_PATH
  ?? require.resolve('sqlite-vec/dist/vec0.dylib')   // macOS; Linux would be vec0.so

export type VectorHit = {
  id: string
  similarity: number     // 0..1, higher = more similar
  distance: number       // L2 distance from the query
}

export type VectorIndexOptions = {
  tableName?: string     // default 'vec_memory'
  dim?: number           // overridden from embedder.dim if not provided
}

export class VectorIndex {
  private tableName: string
  private dim: number
  private initialized = false

  constructor(private db: Database, private embedder: Embedder, opts: VectorIndexOptions = {}) {
    this.tableName = opts.tableName ?? 'vec_memory'
    this.dim = opts.dim ?? embedder.dim
  }

  async init(): Promise<void> {
    if (this.initialized) return
    this.db.loadExtension(SQLITE_VEC_PATH)
    // Use sqlite-vec's vec0 virtual table.
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS ${this.tableName} USING vec0(
        id TEXT PRIMARY KEY,
        embed FLOAT[${this.dim}]
      );
    `)
    this.initialized = true
  }

  async insert(id: string, text: string): Promise<void> {
    await this.init()
    const vec = await this.embedder.embed(text)
    // sqlite-vec accepts vectors as JSON-encoded float arrays
    const vecJson = JSON.stringify(Array.from(vec))
    this.db.run(
      `INSERT OR REPLACE INTO ${this.tableName} (id, embed) VALUES (?, ?)`,
      [id, vecJson],
    )
  }

  async insertBatch(items: Array<{ id: string; text: string }>): Promise<void> {
    await this.init()
    const texts = items.map(it => it.text)
    const vecs = await this.embedder.embedBatch(texts)
    const stmt = this.db.prepare(`INSERT OR REPLACE INTO ${this.tableName} (id, embed) VALUES (?, ?)`)
    const tx = this.db.transaction(() => {
      items.forEach((it, i) => stmt.run(it.id, JSON.stringify(Array.from(vecs[i]))))
    })
    tx()
  }

  async searchByText(query: string, k: number): Promise<VectorHit[]> {
    await this.init()
    const queryVec = await this.embedder.embed(query)
    return this.searchByVector(queryVec, k)
  }

  async searchByVector(queryVec: Float32Array, k: number): Promise<VectorHit[]> {
    await this.init()
    const queryJson = JSON.stringify(Array.from(queryVec))
    const rows = this.db.query(`
      SELECT id, distance
      FROM ${this.tableName}
      WHERE embed MATCH ?
      ORDER BY distance ASC
      LIMIT ?
    `).all(queryJson, k) as Array<{ id: string; distance: number }>

    // Convert L2 distance to cosine similarity. For unit-normalized vectors,
    // cosine_sim = 1 - (L2_distance^2) / 2.
    return rows.map(r => ({
      id: r.id,
      distance: r.distance,
      similarity: Math.max(0, 1 - (r.distance * r.distance) / 2),
    }))
  }

  async delete(id: string): Promise<void> {
    await this.init()
    this.db.run(`DELETE FROM ${this.tableName} WHERE id = ?`, [id])
  }

  async count(): Promise<number> {
    await this.init()
    const r = this.db.query(`SELECT COUNT(*) as n FROM ${this.tableName}`).get() as { n: number }
    return r.n
  }
}
```

- [ ] **Step 4: Run + commit**

```bash
bun test src/daemon/memory/vector/vectorIndex.test.ts
git add src/daemon/memory/vector/vectorIndex.ts src/daemon/memory/vector/vectorIndex.test.ts
git commit -m "feat(memory): VectorIndex with sqlite-vec — semantic search over embedded memory"
```

Expected: 5/5 pass.

---

## Task 10: HybridRetriever — RRF fusion

**Files:**
- Create: `src/daemon/memory/vector/hybridRetriever.ts`
- Create: `src/daemon/memory/vector/hybridRetriever.test.ts`

Reciprocal Rank Fusion (RRF) combines results from independent rankers (BM25/FTS5 and vector cosine) by summing `1 / (k + rank_i)` for each result `i`. Constant `k=60` is the standard, validated by Cormack et al. (2009).

- [ ] **Step 1: Test**

```typescript
// src/daemon/memory/vector/hybridRetriever.test.ts
import { describe, it, expect } from 'bun:test'
import { HybridRetriever, rrfFuse } from './hybridRetriever'

describe('rrfFuse', () => {
  it('combines ranks from two sources', () => {
    const fts = [{ id: 'a', score: 0 }, { id: 'b', score: 0 }, { id: 'c', score: 0 }]
    const vec = [{ id: 'b', score: 0 }, { id: 'd', score: 0 }, { id: 'a', score: 0 }]
    const fused = rrfFuse([fts, vec], 5)
    expect(fused.map(h => h.id)).toContain('a')
    expect(fused.map(h => h.id)).toContain('b')
    // 'b' appeared at rank 1 in vec, rank 1 in fts → should be tied or near-top
  })

  it('respects k constant (default 60)', () => {
    const a = [{ id: 'x', score: 0 }]   // rank 0
    const b = [{ id: 'x', score: 0 }]
    const fused = rrfFuse([a, b], 5, 60)
    // RRF score = 2 / (60 + 1) = 0.0328
    expect(fused[0].id).toBe('x')
    expect(fused[0].score).toBeCloseTo(2 / 61, 4)
  })

  it('handles disjoint result sets', () => {
    const a = [{ id: 'only-a', score: 0 }]
    const b = [{ id: 'only-b', score: 0 }]
    const fused = rrfFuse([a, b], 2)
    expect(fused.length).toBe(2)
  })

  it('caps to limit', () => {
    const a = Array.from({ length: 10 }, (_, i) => ({ id: 'a' + i, score: 0 }))
    const b = Array.from({ length: 10 }, (_, i) => ({ id: 'b' + i, score: 0 }))
    const fused = rrfFuse([a, b], 5)
    expect(fused.length).toBe(5)
  })
})

describe('HybridRetriever', () => {
  // Integration tests would need a SQLite Database with FTS5 + VectorIndex set up.
  // Skipping deep integration test here — covered in memory store tests (Tasks 12-13)
})
```

- [ ] **Step 2: Implementation**

```typescript
// src/daemon/memory/vector/hybridRetriever.ts
import type { Database } from 'bun:sqlite'
import type { VectorIndex } from './vectorIndex'

export type RankedHit = { id: string; score: number }

const RRF_K = 60

export function rrfFuse(rankings: RankedHit[][], limit: number, k: number = RRF_K): RankedHit[] {
  const acc = new Map<string, number>()
  for (const ranking of rankings) {
    ranking.forEach((hit, rank) => {
      const prev = acc.get(hit.id) ?? 0
      acc.set(hit.id, prev + 1 / (k + rank + 1))
    })
  }
  const fused = [...acc.entries()].map(([id, score]) => ({ id, score }))
  fused.sort((a, b) => b.score - a.score)
  return fused.slice(0, limit)
}

export type HybridRetrieverOptions = {
  ftsTableName: string         // FTS5 virtual table holding text + id
  vectorIndex: VectorIndex
  topK?: number                // pull top-N from each ranker before fusion (default 20)
  finalK?: number              // final limit after fusion (default 10)
}

export class HybridRetriever {
  constructor(private db: Database, private opts: HybridRetrieverOptions) {}

  async retrieve(query: string): Promise<RankedHit[]> {
    const topK = this.opts.topK ?? 20
    const finalK = this.opts.finalK ?? 10

    const [ftsHits, vecHits] = await Promise.all([
      this.ftsSearch(query, topK),
      this.opts.vectorIndex.searchByText(query, topK),
    ])

    const ftsRanked: RankedHit[] = ftsHits.map(r => ({ id: r.id, score: r.bm25 }))
    const vecRanked: RankedHit[] = vecHits.map(h => ({ id: h.id, score: h.similarity }))

    return rrfFuse([ftsRanked, vecRanked], finalK)
  }

  private async ftsSearch(query: string, limit: number): Promise<Array<{ id: string; bm25: number }>> {
    // Tokenize the query: drop punctuation, split on whitespace, OR-join.
    // This mirrors the punctuation-fix in src/daemon/memory/recall.ts that
    // landed earlier (the FTS5 MATCH bug for queries with '?').
    const tokens = query
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 1)
    if (tokens.length === 0) return []
    const matchExpr = tokens.map(t => `"${t}"`).join(' OR ')
    try {
      return this.db.query(`
        SELECT id, bm25(${this.opts.ftsTableName}) AS bm25
        FROM ${this.opts.ftsTableName}
        WHERE ${this.opts.ftsTableName} MATCH ?
        ORDER BY bm25 ASC
        LIMIT ?
      `).all(matchExpr, limit) as Array<{ id: string; bm25: number }>
    } catch {
      return []   // fts5 may not be set up; degrade gracefully
    }
  }
}
```

- [ ] **Step 3: Run + commit**

```bash
bun test src/daemon/memory/vector/hybridRetriever.test.ts
git add src/daemon/memory/vector/hybridRetriever.ts src/daemon/memory/vector/hybridRetriever.test.ts
git commit -m "feat(memory): HybridRetriever — RRF fusion of FTS5 keyword + vector cosine results"
```

Expected: 4/4 pass.

---

## Task 11: MemoryInjector — assemble ContextBlock[] from memory tiers

**Files:**
- Create: `src/daemon/memory/memoryInjector.ts`
- Create: `src/daemon/memory/memoryInjector.test.ts`

Given a query (or trigger context), the injector queries L2/L3 memory stores via HybridRetriever and emits structured `ContextBlock[]` for ModelRouter — pre-tagged with the right `cache_hint`.

- [ ] **Step 1: Test**

```typescript
// src/daemon/memory/memoryInjector.test.ts
import { describe, it, expect } from 'bun:test'
import { MemoryInjector } from './memoryInjector'

describe('MemoryInjector', () => {
  it('tags L3 snippets as long-cache, L2 as short-cache', async () => {
    const fakeL2 = { recall: async (q: string, n: number) => [{ id: 'e1', text: 'recent observation' }] }
    const fakeL3 = { recall: async (q: string, n: number) => [{ id: 's1', text: 'distilled fact' }] }
    const fakeL4 = { activeSkills: async () => [{ id: 'sk1', text: 'a workflow' }] }
    const inj = new MemoryInjector({ l2: fakeL2 as any, l3: fakeL3 as any, l4: fakeL4 as any })
    const blocks = await inj.inject('what was the GitHub thing yesterday?', { max_l2: 3, max_l3: 5, include_l4: true })
    const l2Blocks = blocks.filter(b => b.source === 'L2')
    const l3Blocks = blocks.filter(b => b.source === 'L3')
    const l4Blocks = blocks.filter(b => b.source === 'L4')
    expect(l2Blocks.every(b => b.cache_hint === 'short')).toBe(true)
    expect(l3Blocks.every(b => b.cache_hint === 'long')).toBe(true)
    expect(l4Blocks.every(b => b.cache_hint === 'long')).toBe(true)
  })

  it('respects max counts per tier', async () => {
    const fakeL3 = { recall: async () => Array.from({ length: 10 }, (_, i) => ({ id: 's' + i, text: 't' + i })) }
    const inj = new MemoryInjector({ l2: { recall: async () => [] } as any, l3: fakeL3 as any, l4: { activeSkills: async () => [] } as any })
    const blocks = await inj.inject('q', { max_l2: 0, max_l3: 3, include_l4: false })
    expect(blocks.filter(b => b.source === 'L3').length).toBe(3)
  })

  it('returns empty array gracefully when no stores have results', async () => {
    const inj = new MemoryInjector({
      l2: { recall: async () => [] } as any,
      l3: { recall: async () => [] } as any,
      l4: { activeSkills: async () => [] } as any,
    })
    const blocks = await inj.inject('q', { max_l2: 5, max_l3: 5, include_l4: true })
    expect(blocks.length).toBe(0)
  })
})
```

- [ ] **Step 2: Implementation**

```typescript
// src/daemon/memory/memoryInjector.ts
import type { ContextBlock } from '../llm/cache/cacheHints'

// Memory tier interfaces (matches the API the existing episodic/semantic/procedural stores expose
// after their Task 12-13 refactors).
export interface MemoryStore {
  recall(query: string, limit: number): Promise<Array<{ id: string; text: string; ts?: number }>>
}
export interface ProceduralStore {
  activeSkills(): Promise<Array<{ id: string; text: string }>>
}

export type InjectOptions = {
  max_l2?: number          // default 5 (recent episodic)
  max_l3?: number          // default 8 (semantic / distilled facts)
  include_l4?: boolean     // default true (procedural memory / skills)
}

export class MemoryInjector {
  constructor(private deps: { l2: MemoryStore; l3: MemoryStore; l4: ProceduralStore }) {}

  async inject(query: string, opts: InjectOptions = {}): Promise<ContextBlock[]> {
    const max_l2 = opts.max_l2 ?? 5
    const max_l3 = opts.max_l3 ?? 8
    const include_l4 = opts.include_l4 ?? true

    const [l2Hits, l3Hits, l4Skills] = await Promise.all([
      max_l2 > 0 ? this.deps.l2.recall(query, max_l2) : Promise.resolve([]),
      max_l3 > 0 ? this.deps.l3.recall(query, max_l3) : Promise.resolve([]),
      include_l4 ? this.deps.l4.activeSkills() : Promise.resolve([]),
    ])

    const blocks: ContextBlock[] = []
    for (const s of l4Skills) blocks.push({ text: s.text, source: 'L4', cache_hint: 'long' })
    for (const s of l3Hits) blocks.push({ text: s.text, source: 'L3', cache_hint: 'long', ts: s.ts })
    for (const s of l2Hits) blocks.push({ text: s.text, source: 'L2', cache_hint: 'short', ts: s.ts })

    return blocks
  }
}
```

- [ ] **Step 3: Run + commit**

```bash
bun test src/daemon/memory/memoryInjector.test.ts
git add src/daemon/memory/memoryInjector.ts src/daemon/memory/memoryInjector.test.ts
git commit -m "feat(memory): MemoryInjector — assembles ContextBlock[] with per-tier cache_hint defaults"
```

Expected: 3/3 pass.

---

## Task 12: Refactor L2 episodic store to use HybridRetriever

**Files:**
- Modify: `src/daemon/memory/episodic.ts`
- Modify: `src/daemon/memory/episodic.test.ts`

Add embedding-on-insert and hybrid retrieval. Existing `recall(query)` becomes hybrid.

- [ ] **Step 1: Test additions**

```typescript
// Append to episodic.test.ts
describe('EpisodicStore hybrid recall', () => {
  it('returns semantically similar results even without keyword overlap', async () => {
    const store = await createEpisodicStoreWithEmbedder()
    await store.record({ source: 'observation', text: 'user opened the calendar app to check tomorrow' })
    await store.record({ source: 'observation', text: 'shopping list was updated' })
    await store.record({ source: 'observation', text: 'reviewed agenda for next day meetings' })
    const results = await store.recall('checking the schedule', 3)
    // Both calendar + agenda should rank above shopping
    const ids = results.map(r => r.id)
    expect(ids.findIndex(id => id.includes('calendar'))).toBeLessThan(ids.findIndex(id => id.includes('shopping')))
  })
})
```

- [ ] **Step 2: Implementation**

Add a `VectorIndex` field to `EpisodicStore`. On `record()`, insert into both the existing SQL row AND the vector index. On `recall()`, use `HybridRetriever`.

```typescript
// src/daemon/memory/episodic.ts (relevant changes)
export class EpisodicStore implements MemoryStore {
  constructor(
    private db: Database,
    private vectorIndex?: VectorIndex,   // optional for backward compat
  ) {
    // ... existing schema setup ...
    // ADD: FTS5 virtual table for keyword search (if not already there)
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS episodic_fts USING fts5(id UNINDEXED, text)`)
  }

  async record(e: EpisodicEvent): Promise<string> {
    const id = e.id ?? crypto.randomUUID()
    // ... existing insert into episodic table ...
    this.db.run(`INSERT INTO episodic_fts (id, text) VALUES (?, ?)`, [id, e.text])
    if (this.vectorIndex) {
      await this.vectorIndex.insert(id, e.text)
    }
    return id
  }

  async recall(query: string, limit: number): Promise<RecallHit[]> {
    if (!this.vectorIndex) {
      // legacy keyword-only path
      return this.recallKeyword(query, limit)
    }
    const retriever = new HybridRetriever(this.db, {
      ftsTableName: 'episodic_fts',
      vectorIndex: this.vectorIndex,
      topK: limit * 2,
      finalK: limit,
    })
    const hits = await retriever.retrieve(query)
    return this.hydrate(hits.map(h => h.id))
  }
}
```

- [ ] **Step 3: Run + commit**

```bash
bun test src/daemon/memory/episodic.test.ts
git add src/daemon/memory/episodic.ts src/daemon/memory/episodic.test.ts
git commit -m "feat(memory): EpisodicStore uses HybridRetriever + auto-embeds on record"
```

Expected: existing tests pass + new hybrid test passes.

---

## Task 13: Refactor L3 semantic store to use HybridRetriever

**Files:**
- Modify: `src/daemon/memory/semantic.ts`
- Modify: `src/daemon/memory/semantic.test.ts`

Same pattern as Task 12, applied to the semantic store. L3 holds distilled facts (Hermes Dreaming output). Vector retrieval matters even more here because users phrase queries semantically against compressed facts.

- [ ] Same shape as Task 12. Insert into FTS5 + VectorIndex on `record()`. Use HybridRetriever on `recall()`.
- [ ] Commit: `feat(memory): SemanticStore uses HybridRetriever + auto-embeds on record`

Expected: existing tests pass + new hybrid tests pass.

---

## Task 14: Migrate all call sites to new CompletionRequest shape

**Files:**
- Modify: `src/daemon/agency/*.ts` — wherever the router is called
- Modify: `src/daemon/onboarding/setupSkillGenerator.ts` — already migrated in Task 6 (Field-rigor patch); verify
- Modify: `src/daemon/memory/dreaming.ts` (or wherever consolidation happens)
- Remove: backward-compat shim `LegacyCompletionRequest` in `src/daemon/llm/types.ts`

For each call site:
- Find `router.complete({ system: '...', prompt: '...' })`
- Replace with:
  ```typescript
  router.complete({
    task_type: ...,
    system_blocks: [
      { text: PERSONA, cache_hint: 'long', source: 'persona' },
      { text: STANDING_ORDERS, cache_hint: 'long', source: 'standing_orders' },
    ],
    context_blocks: await memoryInjector.inject(query),
    prompt: query,
  })
  ```

- [ ] Run `bun test` (full suite) — all tests still pass
- [ ] Remove `LegacyCompletionRequest` + the `PromptAssembler.fromLegacy` shim
- [ ] Commit: `refactor(llm): migrate all call sites to system_blocks + context_blocks (drops legacy shim)`

Expected: ~315 tests pass (the current full suite count).

---

## Task 15: Daemon wire-up

**Files:**
- Modify: `src/daemon/types.ts` — add `mode: KairosMode`, `embedding: { model, cache_dir }`
- Modify: `src/daemon/config.ts` — read `KAIROS_MODE` env, defaults
- Modify: `src/daemon/index.ts` — instantiate Embedder + VectorIndex(es) + HybridRetrievers + CacheStats + pass `mode` to ModelRouter

```typescript
// src/daemon/index.ts (relevant additions)
import { LocalEmbedder } from './memory/vector/embedder'
import { VectorIndex } from './memory/vector/vectorIndex'
import { MemoryInjector } from './memory/memoryInjector'
import { CacheStats } from './llm/cache/cacheStats'

const embedder = new LocalEmbedder({ cacheDir: join(homedir(), '.kairos', 'cache', 'huggingface') })
await embedder.warmup()    // download model on first boot; subsequent boots are instant

const l2VectorIndex = new VectorIndex(db, embedder, { tableName: 'l2_vec' })
const l3VectorIndex = new VectorIndex(db, embedder, { tableName: 'l3_vec' })
await Promise.all([l2VectorIndex.init(), l3VectorIndex.init()])

const episodic = new EpisodicStore(db, l2VectorIndex)
const semantic = new SemanticStore(db, l3VectorIndex)
const procedural = new ProceduralStore(db)

const memoryInjector = new MemoryInjector({ l2: episodic, l3: semantic, l4: procedural })
const cacheStats = new CacheStats(db)

const router = new ModelRouter({
  mode: config.kairos_mode ?? 'byo',
  providerRegistry,
  cacheStats,
})

// Anywhere a previous component built a CompletionRequest, it now ALSO calls
// memoryInjector.inject(query) and includes the result as context_blocks.
```

- [ ] Full test suite passes (~315 tests)
- [ ] Type-check clean
- [ ] Commit: `feat(daemon): wire C.2.6 — embedder, vector indexes, memory injector, mode-aware router`

---

## Task 16: Validation gate

**Files:**
- Create: `scripts/validate-phase-c2-6.ts`

End-to-end validation with two main assertions:

**Assertion A — caching works:** Make 5 identical LLM calls with the same large system prompt. After the first (cache write), the next 4 should report `cached_input_tokens > 0` and total cost should be ~10% of naive cost.

**Assertion B — semantic recall beats keyword-only:** Insert 20 episodic memories with varied phrasing. Run 10 queries phrased differently from the memories. Compare hybrid retrieval (FTS5 + vector) vs FTS5-only. Hybrid recall@5 should be ≥ 1.5x keyword-only on this benchmark.

```typescript
// scripts/validate-phase-c2-6.ts
// Phase C.2.6 validation: prompt caching savings + hybrid recall improvement.

import { Database } from 'bun:sqlite'
import { LocalEmbedder } from '../src/daemon/memory/vector/embedder'
import { VectorIndex } from '../src/daemon/memory/vector/vectorIndex'
import { HybridRetriever } from '../src/daemon/memory/vector/hybridRetriever'
import { ModelRouter } from '../src/daemon/llm/router'
// ... etc

async function assertCaching(): Promise<{ passed: boolean; savings_pct: number }> {
  // Build a fat system prompt (>4096 tokens) so all providers cache it
  const fatSystem = 'You are KAIROS, an AI co-worker. '.repeat(500)   // ~6000 tokens
  const router = await bootRouter({ mode: 'byo' })

  const results = []
  for (let i = 0; i < 5; i++) {
    const r = await router.complete({
      task_type: 'agency_judge' as any,
      system_blocks: [{ text: fatSystem, cache_hint: 'long' }],
      context_blocks: [],
      prompt: `iteration ${i}: respond with the number ${i}`,
      max_output_tokens: 20,
    })
    results.push(r)
  }
  const naive_cost = results.reduce((s, r) => s + r.cost_cents, 0)
  const projected_uncached = results[0].cost_cents * 5     // if NO caching, 5x first call
  const savings_pct = 1 - naive_cost / projected_uncached
  return { passed: savings_pct >= 0.5, savings_pct }       // expect ≥50% savings; reality ~85-90%
}

async function assertHybridRecall(): Promise<{ passed: boolean; hybrid_recall: number; keyword_recall: number }> {
  const db = new Database(':memory:')
  const embedder = new LocalEmbedder(); await embedder.warmup()
  const vec = new VectorIndex(db, embedder); await vec.init()

  // 20 memories, all about everyday observations
  const memories = [
    'opened the calendar to plan tomorrow',
    'reviewed agenda for next week',
    'set a reminder for the meeting at 3pm',
    'started writing the project proposal',
    'researched cheap flights to Tokyo',
    // ... 15 more in a similar vein
  ]
  // ... insert all ...

  // 10 semantic queries that don't share keywords with memories
  const queries = [
    { q: 'looking at upcoming events',                      gold: [0, 1, 2] },   // calendar/agenda/reminder
    { q: 'starting work on the document',                   gold: [3] },
    { q: 'travel to Japan',                                 gold: [4] },
    // ... etc
  ]

  let hybridCorrect = 0, keywordCorrect = 0
  // ... run both retrieval methods, score recall@5 against gold ...

  return { passed: hybridCorrect >= keywordCorrect * 1.5, hybrid_recall: hybridCorrect / queries.length, keyword_recall: keywordCorrect / queries.length }
}

const a = await assertCaching()
console.log(`[A] Caching savings: ${(a.savings_pct * 100).toFixed(1)}%  →  ${a.passed ? 'PASS' : 'FAIL'}`)
const b = await assertHybridRecall()
console.log(`[B] Hybrid recall vs keyword: ${b.hybrid_recall.toFixed(2)} vs ${b.keyword_recall.toFixed(2)}  →  ${b.passed ? 'PASS' : 'FAIL'}`)

process.exit(a.passed && b.passed ? 0 : 1)
```

- [ ] Run validation. Both assertions must pass.
- [ ] Append CHANGELOG entry for `v0.3.4-phase-c2-6` summarizing: caching savings %, hybrid recall improvement, total LOC, test count.
- [ ] Commit + tag `v0.3.4-phase-c2-6`.

---

## Self-review checklist

- [ ] **Cost subsystem coverage:** every provider has explicit caching strategy (markers / prefix ordering / cachedContents / pass-through)
- [ ] **Recall subsystem coverage:** L2 and L3 both use HybridRetriever; L4 is procedural (no retrieval needed)
- [ ] **Backward compat:** Task 14 removes the legacy shim — all internal call sites migrated before deletion
- [ ] **Privacy:** embeddings happen in-process (LocalEmbedder), never leave the daemon
- [ ] **Hosted-mode economics:** Task 6's preference table puts gpt-4o-mini / gemini-flash / kimi first for cheap tier; KAIROS Cloud doesn't accidentally route to expensive Anthropic
- [ ] **Observability:** CacheStats records EVERY call, so Phase F's HUD can show real numbers
- [ ] **Failure modes:** If sqlite-vec fails to load, VectorIndex throws clearly. If Transformers.js model fails to download, LocalEmbedder throws clearly. Neither crashes the daemon.
- [ ] **Migration safety:** the daemon-wire-up task (15) is reversible (revert the index.ts changes and the vector tables become orphan; existing data unaffected)

---

## Risks flagged

1. **Transformers.js model download** — first-run UX has a ~30-60 second wait while bge-small-en-v1.5 downloads. Mitigation: do `await embedder.warmup()` in the daemon's boot sequence; surface a one-line "downloading embedding model (~33MB, one-time)" message.

2. **sqlite-vec platform variability** — works great on macOS (`.dylib`) and Linux (`.so`). Windows would need `.dll`. For now KAIROS is macOS-only, so this is fine. Document for future expansion.

3. **Anthropic 4-cache-breakpoint limit** — if KAIROS injects >4 logical sections, only 4 can be marked. The PromptAssembler currently marks at most 2 breakpoints (long-tier + short-tier). Headroom is fine.

4. **OpenAI cache hit warmup** — first call writes the prefix to cache, subsequent calls within ~5 min benefit. If KAIROS does an LLM call once an hour, caching may not help — but background dreaming + frequent observe-classify calls will keep the cache warm.

5. **Gemini cachedContents creation cost** — Gemini charges for the cache itself (small storage fee + creation tokens). Only worth it when long-cached content is reused ≥5 times within TTL. Task 4 enforces MIN_CACHE_TOKENS=4096 to ensure caches are worth creating.

6. **Token estimation accuracy** — `PromptAssembler.estimated_total_tokens` uses 1 token ≈ 4 chars. Real tokenizers (BPE) vary by language and content. Estimate is only for prompt-too-long pre-flight checks; cost numbers use actual reported tokens from provider.

---

## Execution Handoff

Plan saved to `docs/superpowers/plans/2026-05-25-phase-c2-6-cost-and-recall.md`.

After C.2.6 ships (`v0.3.4-phase-c2-6`), the next phase in your sequencing was C.3 (Magentic-One + smolagents + AWM + Persona-Awareness). C.3 inherits a *much cheaper* base — every LLM call inside Magentic-One's planning loop and smolagents CodeAgent's iteration loop benefits from caching automatically.

**Estimated calendar time** with subagent-driven execution (haiku for mechanical tasks, sonnet for integration tasks): 2-3 working sessions of ~60-90 min each, mirroring the C.2.5 cadence (~16 tasks shipped over ~3 sessions).

When ready to execute: invoke `superpowers:subagent-driven-development` pointing at this plan.
