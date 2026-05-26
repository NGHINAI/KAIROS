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
  system_blocks: [],
  prompt: 'In one sentence, what is the color of grass?',
  max_output_tokens: 50,
})
console.log(`✓ provider=${result.provider} model=${result.model}`)
console.log(`  cost=${result.cost_cents}¢ latency=${result.latency_ms}ms fallbacks=${result.fallback_count}`)
console.log(`  text="${result.text.slice(0, 200)}"`)
