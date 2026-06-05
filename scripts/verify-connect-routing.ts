// scripts/verify-connect-routing.ts
// Live verification for the "connect me to Linear did nothing" fix.
// Exercises the REAL classifier (KAIROS_FAST_MODEL via OpenRouter) — the one
// part of the fix that can't be unit-tested deterministically — to confirm
// tool-requiring requests now route to "smart" (the only tool-capable tier),
// while pure chat stays "fast".
//
// Run: bun scripts/verify-connect-routing.ts   (reads .env for OPENROUTER_API_KEY)

import { classifyIntent } from '../src/daemon/agents/intentClassifier'
import { OpenRouterAdapter } from '../src/daemon/wrapApi/adapters/openRouterAdapter'

const model = process.env.KAIROS_FAST_MODEL ?? 'openai/gpt-4o-mini'
const adapter = new OpenRouterAdapter({ defaultModel: model })
const llm = { complete: (b: any) => adapter.complete(b) }

// [utterance, expected tier]
const cases: Array<[string, 'fast' | 'smart' | 'deep' | 'vision']> = [
  ['Can you connect me to Linear?', 'smart'],
  ['Connect my Gmail', 'smart'],
  ['Remind me at 5 to call mom', 'smart'],
  ['Summarize today\'s emails', 'smart'],
  ['Hello there!', 'fast'],
  ['Thanks, that\'s helpful', 'fast'],
  ['What can you do?', 'fast'],
]

let pass = 0
console.log(`\nClassifier routing check — model=${model}\n${'-'.repeat(60)}`)
for (const [utterance, expected] of cases) {
  const d = await classifyIntent(utterance, { llm })
  const ok = d.tier === expected
  if (ok) pass++
  console.log(`${ok ? 'PASS' : 'FAIL'}  "${utterance}"  →  ${d.tier} (want ${expected})  [${d.reason}]`)
}
console.log('-'.repeat(60))
console.log(`${pass}/${cases.length} routed correctly\n`)
process.exit(pass === cases.length ? 0 : 1)
