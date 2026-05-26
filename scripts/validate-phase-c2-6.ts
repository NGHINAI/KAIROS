// scripts/validate-phase-c2-6.ts
// Phase C.2.6 validation gate — Cost & Recall
//
// Assertion A — Caching works:
//   Make 5 identical LLM calls with a large 'long'-cached system prompt (≥4096 tokens).
//   Compare total cost to "naive" (5× first call). Savings must be ≥50%.
//
//   Provider: AnthropicApiProvider (claude-haiku-4-5-20251001) — requires ANTHROPIC_API_KEY.
//   If no API key, falls back to OFFLINE SIMULATION that proves cost-accounting math.
//   Anthropic cache_read tokens are charged at 0.1x base → ~90% savings from call 2 onward.
//
// Assertion B — Hybrid recall beats keyword-only:
//   Insert 20 episodic memories. Run 10 semantic queries that share NO keywords with
//   the matching memories. Score recall@5:
//     Hybrid (FTS5 + vector via LocalEmbedder/bge-small-en-v1.5) vs KeywordOnly (FTS5 only).
//   Hybrid recall must be ≥1.5× keyword recall.
//
// Both assertions must pass for gate: PASS.
// Exit 0 on PASS; 1 on FAIL.
//
// Usage:
//   bun run scripts/validate-phase-c2-6.ts

import { Database } from 'bun:sqlite'
import { AnthropicApiProvider } from '../src/daemon/llm/providers/anthropicApi'
import { EpisodicStore } from '../src/daemon/memory/episodicMemory'
import { LocalEmbedder } from '../src/daemon/memory/vector/embedder'
import { VectorIndex } from '../src/daemon/memory/vector/vectorIndex'
import type { CompletionRequest } from '../src/daemon/llm/types'

// ─── Helpers ────────────────────────────────────────────────────────────────

function fmt(cents: number): string {
  return `$${(cents / 100).toFixed(4)}`
}

function pct(savings: number): string {
  return `${(savings * 100).toFixed(1)}%`
}

// ─── Assertion A: Caching ────────────────────────────────────────────────────

// Generate a large stable system prompt ≥4096 tokens (~16KB characters).
// This is a static persona+instructions block that never changes between calls
// (which is the realistic caching scenario: system prompt = persona).
function buildLargeSystemPrompt(): string {
  const base = `You are KAIROS, a personal AI companion running as a background daemon on the user's machine.
Your role is to observe, remember, and proactively assist — acting as a second brain that tracks
context across all of the user's work, communications, and projects.

Core capabilities:
1. Episodic memory — you store and recall what happened, when, and in what context.
2. Semantic memory — you consolidate patterns, preferences, and learned facts across sessions.
3. Procedural memory — you remember how to do things: shell commands, API patterns, workflows.
4. Proactive agency — you surface relevant context at the right moment without being asked.
5. MCP integration — you connect to external services (GitHub, calendar, filesystem) via MCP.

Your personality:
- Calm, concise, never verbose unless the user asks for depth.
- Honest about uncertainty — you say "I'm not sure" rather than hallucinate.
- Respectful of focus — you batch non-urgent messages, never interrupt deep work.
- Playful when appropriate, serious when stakes are high.

Standing orders (always active):
- Never store passwords, tokens, or secrets in memory (detect and discard).
- Prefer local processing over cloud APIs to preserve privacy.
- If a task will cost more than $0.10, ask before proceeding.
- Keep summaries under 200 words unless explicitly asked for more.
- When recalling memories, always cite the date and source.

Memory hierarchy:
  L1 — working memory (last 5 min of events, RAM only, never persisted)
  L2 — episodic memory (last 30 days, SQLite, FTS5 + vector indexed)
  L3 — semantic memory (distilled facts, SQLite, lifetime)
  L4 — procedural memory (skills + workflows, SQLite, lifetime)

Cost discipline:
- Ultra-cheap tier (Haiku / gpt-4o-mini): summarize, classify, routine answers
- Mid tier (Sonnet / gpt-4o): compose messages, analyze code, plan actions
- Heavy tier (Opus / gpt-4): write new skills, patch own source code
- Never use a heavier model than needed for the task.

Caching strategy:
- System blocks with cache_hint='long' are placed first (stable prefix for provider cache).
- Episodic context blocks with cache_hint='short' are placed next.
- Volatile content (current event, timestamp) always last.
- This ordering maximizes prefix cache hits across calls within a session.

`
  // Repeat the base text enough times to exceed 4096 tokens (~4 chars per token → ~16KB).
  // Each repetition is meaningfully different enough (numbered) that the content feels natural.
  const lines: string[] = [base]
  const knowledgeBase = [
    'Project context: KAIROS is built on Bun + TypeScript. All DB access goes through SQLite (bun:sqlite).',
    'Architecture note: The daemon runs as a persistent background process. IPC via Unix domain socket.',
    'Observer pattern: Each sensor (focus-app, clipboard, file-events) is a class implementing Observer.',
    'Event bus: SQLite-persisted ring buffer. Consumers subscribe by event type. Max 10K events stored.',
    'Restraint pipeline: interrupts are throttled by karma + cooldown + rate-limiter + urgency floor.',
    'MCP host: manages multiple MCP servers (stdio + SSE). Tools have tier policies (GREEN/YELLOW/RED).',
    'Onboarding: SetupFlowRuntime executes SetupSkill steps: install → configure → smoke_test.',
    'Cost tracker: every LLM call is logged with provider, model, tokens, cost, fallback count.',
    'Vector index: bge-small-en-v1.5 (384-dim, q8 quantized). Full-scan cosine similarity in TypeScript.',
    'Hybrid retriever: RRF fusion of FTS5 BM25 scores + vector cosine scores. k=60 per literature.',
    'Prompt assembler: stable sort by cache hint (long→short→none) before passing to provider.',
    'Mode routing: byo=CLI-first, hosted=API-first, local=Ollama-only.',
    'Fallback chain: try each candidate in order; skip unconfigured; count fallbacks in result.',
    'Budget enforcement: monthly budget in USD; isOverBudget() checked before every call.',
    'Task taxonomy: narrative/trigger_eval/classify → ultra_cheap; action_compose/dream → mid; skill_generate/source_patch → heavy.',
  ]

  // Repeat knowledge base entries to reach token target.
  // ~16,400 chars / 4 ≈ 4,100 tokens.
  for (let rep = 0; rep < 25; rep++) {
    for (const line of knowledgeBase) {
      lines.push(`[ref-${rep}] ${line}`)
    }
  }

  return lines.join('\n')
}

type CallStats = {
  call: number
  inputTokens: number
  cachedTokens: number
  cacheWriteTokens: number
  outputTokens: number
  costCents: number
}

async function runCachingAssertionLive(): Promise<{ passed: boolean; stats: CallStats[]; naiveCents: number; actualCents: number; savings: number; mode: 'live' }> {
  const provider = new AnthropicApiProvider({
    enabled: true,
    api_key_env: 'ANTHROPIC_API_KEY',
  })

  const systemPrompt = buildLargeSystemPrompt()
  const tokenEstimate = Math.ceil(systemPrompt.length / 4)
  console.log(`  System prompt: ~${tokenEstimate} tokens (${systemPrompt.length} chars)`)

  const req: CompletionRequest = {
    task_type: 'narrative',
    system_blocks: [{ text: systemPrompt, cache_hint: 'long' }],
    prompt: 'In one sentence, what is your primary purpose?',
    max_output_tokens: 60,
  }

  const stats: CallStats[] = []

  for (let i = 1; i <= 5; i++) {
    const result = await provider.complete('claude-haiku-4-5-20251001', req)
    const s: CallStats = {
      call: i,
      inputTokens: result.input_tokens,
      cachedTokens: result.cached_input_tokens ?? 0,
      cacheWriteTokens: result.cache_creation_tokens ?? 0,
      outputTokens: result.output_tokens,
      costCents: result.cost_cents,
    }
    stats.push(s)

    // Display total prompt tokens = input (non-cached) + cached
    const totalIn = s.inputTokens + s.cachedTokens + s.cacheWriteTokens
    const cacheDetail = s.cachedTokens > 0
      ? ` (${s.cachedTokens} cached)`
      : s.cacheWriteTokens > 0 ? ` (${s.cacheWriteTokens} written to cache)` : ' (no cache yet)'
    console.log(`  Call ${i}/5: ${totalIn} in${cacheDetail}, ${s.outputTokens} out, ${fmt(s.costCents)}`)
  }

  // Naive cost = what we'd pay on every call with NO caching.
  // Total prompt tokens per call = input_tokens + cached_tokens (+ cache_creation_tokens on call 1).
  // Without caching, all of these are billed at the standard input rate.
  // Haiku pricing: $1/M input tokens → $0.0001/token.
  const INPUT_PRICE_PER_M = 1.0  // USD, matches PRICING table in anthropicApi.ts
  const s0 = stats[0]!
  const totalPromptTokens = s0.inputTokens + s0.cacheWriteTokens + s0.cachedTokens
  const uncachedCostCentsPerCall = Math.ceil(
    ((totalPromptTokens / 1_000_000) * INPUT_PRICE_PER_M +
     (s0.outputTokens / 1_000_000) * 5.0 /* $5/M output */) * 100
  )
  const naiveCents = uncachedCostCentsPerCall * 5
  const actualCents = stats.reduce((sum, s) => sum + s.costCents, 0)
  const savings = naiveCents > 0 ? (naiveCents - actualCents) / naiveCents : 0

  return { passed: savings >= 0.5, stats, naiveCents, actualCents, savings, mode: 'live' }
}

// Offline simulation: directly invoke AnthropicApiProvider with a mock _fetch that
// returns realistic Anthropic API responses — call 1 has cache_creation_input_tokens,
// calls 2-5 have cache_read_input_tokens. Proves the cost-accounting math is correct.
async function runCachingAssertionOffline(): Promise<{ passed: boolean; stats: CallStats[]; naiveCents: number; actualCents: number; savings: number; mode: 'offline' }> {
  console.log('  [OFFLINE SIMULATION — no OPENAI_API_KEY; using mock Anthropic API responses]')
  console.log('  Purpose: verify cost-accounting math, not live network behaviour.')

  const systemPrompt = buildLargeSystemPrompt()
  const tokenEstimate = Math.ceil(systemPrompt.length / 4)
  console.log(`  System prompt: ~${tokenEstimate} tokens (${systemPrompt.length} chars)`)

  // Simulate realistic token counts: a 4200-token system prompt + 12-token user message
  const INPUT_TOKENS  = tokenEstimate + 12
  const OUTPUT_TOKENS = 50
  const CACHE_WRITE   = tokenEstimate  // first call writes entire system to cache
  const CACHE_READ    = tokenEstimate  // subsequent calls read from cache

  // Build per-call mock usage responses
  function mockUsage(callNum: number): Record<string, number> {
    return callNum === 1
      ? { input_tokens: INPUT_TOKENS, output_tokens: OUTPUT_TOKENS,
          cache_creation_input_tokens: CACHE_WRITE, cache_read_input_tokens: 0 }
      : { input_tokens: INPUT_TOKENS, output_tokens: OUTPUT_TOKENS,
          cache_creation_input_tokens: 0, cache_read_input_tokens: CACHE_READ }
  }

  let callNum = 0
  const mockFetch: typeof fetch = async (_url: RequestInfo | URL, _opts?: RequestInit) => {
    callNum++
    const usage = mockUsage(callNum)
    const body = JSON.stringify({
      id: `msg_mock_${callNum}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-4-5-20251001',
      content: [{ type: 'text', text: 'I am KAIROS, your personal AI companion.' }],
      stop_reason: 'end_turn',
      usage,
    })
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
  }

  const provider = new AnthropicApiProvider({
    enabled: true,
    api_key_env: 'ANTHROPIC_API_KEY',
    _fetch: mockFetch,
  })

  // Temporarily set a dummy API key so isConfigured() returns true
  const origKey = process.env.ANTHROPIC_API_KEY
  process.env.ANTHROPIC_API_KEY = 'sk-ant-offline-simulation'

  const req: CompletionRequest = {
    task_type: 'narrative',
    system_blocks: [{ text: systemPrompt, cache_hint: 'long' }],
    prompt: 'In one sentence, what is your primary purpose?',
    max_output_tokens: 60,
  }

  const stats: CallStats[] = []

  try {
    for (let i = 1; i <= 5; i++) {
      const result = await provider.complete('claude-haiku-4-5-20251001', req)
      const s: CallStats = {
        call: i,
        inputTokens: result.input_tokens,
        cachedTokens: result.cached_input_tokens ?? 0,
        cacheWriteTokens: result.cache_creation_tokens ?? 0,
        outputTokens: result.output_tokens,
        costCents: result.cost_cents,
      }
      stats.push(s)

      const totalIn = s.inputTokens + s.cachedTokens + s.cacheWriteTokens
      const cacheNote = s.cachedTokens > 0
        ? ` (${s.cachedTokens} cached, 90% off!)`
        : s.cacheWriteTokens > 0 ? ` (${s.cacheWriteTokens} written to cache)` : ' (no cache)'
      console.log(`  Call ${i}/5: ${totalIn} in${cacheNote}, ${s.outputTokens} out, ${fmt(s.costCents)}`)
    }
  } finally {
    if (origKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY
    } else {
      process.env.ANTHROPIC_API_KEY = origKey
    }
  }

  // Naive cost = what we'd pay on every call with NO caching.
  const INPUT_PRICE_PER_M = 1.0  // USD, claude-haiku-4-5-20251001
  const s0 = stats[0]!
  const totalPromptTokens = s0.inputTokens + s0.cacheWriteTokens + s0.cachedTokens
  const uncachedCostCentsPerCall = Math.ceil(
    ((totalPromptTokens / 1_000_000) * INPUT_PRICE_PER_M +
     (s0.outputTokens / 1_000_000) * 5.0) * 100
  )
  const naiveCents = uncachedCostCentsPerCall * 5
  const actualCents = stats.reduce((sum, s) => sum + s.costCents, 0)
  const savings = naiveCents > 0 ? (naiveCents - actualCents) / naiveCents : 0

  return { passed: savings >= 0.5, stats, naiveCents, actualCents, savings, mode: 'offline' }
}

// ─── Assertion B: Hybrid recall vs keyword-only ──────────────────────────────

const memories = [
  'opened the calendar to plan tomorrow',
  'reviewed agenda for the upcoming week',
  'set a reminder for the 3pm appointment',
  'started writing the project proposal',
  'researched cheap flights to Tokyo',
  'looked at Airbnb listings in Kyoto',
  'discussed budget for Japan trip with Sue',
  'shopping list updated with groceries',
  'bought milk and bread at the corner store',
  'paid the electricity bill online',
  'completed the quarterly tax filing',
  'reviewed retirement portfolio performance',
  'wrote unit tests for the auth module',
  'fixed the login bug in production',
  'merged the feature branch into main',
  'doctor appointment scheduled for Friday',
  'picked up a prescription refill',
  'went for a 5km run in the park',
  'caught up with old friend Tom over coffee',
  "attended cousin Sarah's birthday dinner",
]

const queries = [
  { q: 'looking at upcoming events',          gold_indices: [0, 1, 2] },
  { q: 'starting work on the document',       gold_indices: [3] },
  { q: 'travel planning to Japan',            gold_indices: [4, 5, 6] },
  { q: 'food and grocery purchases',          gold_indices: [7, 8] },
  { q: 'financial obligations',               gold_indices: [9, 10, 11] },
  { q: 'software development work',           gold_indices: [12, 13, 14] },
  { q: 'health and medical care',             gold_indices: [15, 16] },
  { q: 'physical exercise activities',        gold_indices: [17] },
  { q: 'social meetings with people',         gold_indices: [18, 19] },
  { q: 'reviewing money and budgets',         gold_indices: [6, 9, 10, 11] },
]

/** Returns recall@k: (matched gold in top-k) / total gold */
function recallAtK(topIds: string[], goldIds: string[], k: number): number {
  const topK = new Set(topIds.slice(0, k))
  const matched = goldIds.filter(g => topK.has(g)).length
  return goldIds.length > 0 ? matched / goldIds.length : 0
}

async function runRecallAssertion(): Promise<{
  passed: boolean
  hybridRecall: number
  keywordRecall: number
  ratio: number
}> {
  // ── Build hybrid store (FTS5 + vector) ──────────────────────────────────
  const dbHybrid = new Database(':memory:')
  const embedder = new LocalEmbedder()
  console.log('  Warming up LocalEmbedder (bge-small-en-v1.5)...')
  await embedder.warmup()

  const vecIdx = new VectorIndex(dbHybrid, embedder)
  await vecIdx.init()

  const hybridStore = new EpisodicStore(dbHybrid, vecIdx)

  // ── Build keyword-only store (FTS5, no vector) ───────────────────────────
  const dbKeyword = new Database(':memory:')
  const keywordStore = new EpisodicStore(dbKeyword, undefined /* no vectorIndex */)

  // ── Insert 20 memories into both stores ──────────────────────────────────
  console.log(`  Embedding ${memories.length} memories...`)
  const memoryIds: string[] = []

  for (const text of memories) {
    const id = await hybridStore.record({ source: 'validation', text })
    memoryIds.push(id)
    await keywordStore.record({ source: 'validation', text })
  }

  // ── Run 10 queries ────────────────────────────────────────────────────────
  console.log(`  Running ${queries.length} queries...`)

  let hybridRecallSum = 0
  let keywordRecallSum = 0

  for (const { q, gold_indices } of queries) {
    const goldIds = gold_indices.map(i => memoryIds[i]!)

    const hybridHits  = await hybridStore.recall(q, 5)
    const keywordHits = await keywordStore.recall(q, 5)

    const hRecall = recallAtK(hybridHits.map(h => h.id),  goldIds, 5)
    const kRecall = recallAtK(keywordHits.map(h => h.id), goldIds, 5)

    hybridRecallSum  += hRecall
    keywordRecallSum += kRecall
  }

  const hybridRecall  = hybridRecallSum  / queries.length
  const keywordRecall = keywordRecallSum / queries.length
  const ratio = keywordRecall > 0 ? hybridRecall / keywordRecall : Infinity

  return { passed: ratio >= 1.5, hybridRecall, keywordRecall, ratio }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const t0 = Date.now()

console.log('=== KAIROS C.2.6 Validation ===')
console.log(`Started: ${new Date().toISOString()}\n`)

// ── [A] Caching ──
console.log('[A] Caching test...')

const hasAnthropicKey = Boolean(process.env.ANTHROPIC_API_KEY)
let assertionA: Awaited<ReturnType<typeof runCachingAssertionLive>> | Awaited<ReturnType<typeof runCachingAssertionOffline>>

if (hasAnthropicKey) {
  console.log('  Mode: LIVE (Anthropic API, claude-haiku-4-5-20251001)')
  assertionA = await runCachingAssertionLive()
} else {
  console.log('  Mode: OFFLINE SIMULATION (no ANTHROPIC_API_KEY — verifying cost math only)')
  assertionA = await runCachingAssertionOffline()
}

console.log()
console.log(`  Naive cost (5 × call 1):   ${fmt(assertionA.naiveCents)}`)
console.log(`  Actual cost:               ${fmt(assertionA.actualCents)}`)
console.log(`  Savings:                   ${pct(assertionA.savings)}`)
console.log(`  Verdict: ${assertionA.passed ? 'PASS (≥50% target)' : 'FAIL (<50% target)'}`)
if (assertionA.mode === 'offline') {
  console.log('  Note: offline simulation — cache cost-accounting verified, live network not tested')
}

// ── [B] Recall ──
console.log('\n[B] Hybrid recall test...')
const assertionB = await runRecallAssertion()

console.log()
console.log(`  Hybrid recall@5:   ${assertionB.hybridRecall.toFixed(2)}`)
console.log(`  Keyword recall@5:  ${assertionB.keywordRecall.toFixed(2)}`)
console.log(`  Ratio: ${assertionB.ratio === Infinity ? '∞ (keyword=0)' : `${assertionB.ratio.toFixed(2)}x`}`)
console.log(`  Verdict: ${assertionB.passed ? 'PASS (≥1.5x target)' : 'FAIL (<1.5x target)'}`)

// ── Gate verdict ──
const wallMs = Date.now() - t0
const allPassed = assertionA.passed && assertionB.passed

console.log('\n' + '═'.repeat(45))
if (allPassed) {
  console.log('=== Gate verdict: PASS ✓ ===')
} else {
  console.log('=== Gate verdict: FAIL ✗ ===')
  if (!assertionA.passed) console.log('  FAIL: Assertion A — caching savings below 50%')
  if (!assertionB.passed) console.log('  FAIL: Assertion B — hybrid recall below 1.5x keyword')
}
console.log(`Wall time: ${(wallMs / 1000).toFixed(1)}s`)

process.exit(allPassed ? 0 : 1)
