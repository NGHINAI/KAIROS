// scripts/validate-phase-b.ts
// Phase B validation per Section 8.5 — replay synthetic events + judge recall.
//
// Usage: bun run scripts/validate-phase-b.ts
//
// Requires: at least one LLM provider configured in ~/.kairos/providers.json
// Cost: ~few cents on Gemini Flash Lite, $0 on anthropic_cli/codex_cli

import { Database } from 'bun:sqlite'
import { homedir } from 'os'
import { join } from 'path'
import { buildRouter } from '../src/daemon/llm'
import { EventBus } from '../src/daemon/proactive/eventBus'
import { initMemorySchema } from '../src/daemon/memory/schema'
import { Embedder } from '../src/daemon/memory/embeddings'
import { WorkingMemory } from '../src/daemon/memory/workingMemory'
import { EpisodicMemory } from '../src/daemon/memory/episodicMemory'
import { SemanticMemory } from '../src/daemon/memory/semanticMemory'
import { Recall } from '../src/daemon/memory/recall'
import { Dreamer } from '../src/daemon/memory/dreamer'
import { Tier1Classifier } from '../src/daemon/perception/tier1Classifier'
import { Tier2Summarizer } from '../src/daemon/perception/tier2Summarizer'
import { PerceptionPipeline } from '../src/daemon/perception/perceptionPipeline'
import { Narrator } from '../src/daemon/proactive/narrator'
import { StateSnapshot } from '../src/daemon/proactive/stateSnapshot'

const db = new Database(':memory:')
const router = buildRouter(db, join(homedir(), '.kairos', 'providers.json'))
const bus = new EventBus(db)
initMemorySchema(db)
const snap = new StateSnapshot(bus)
const working = new WorkingMemory(bus, { windowMs: 10 * 60_000, maxEvents: 500 })
const episodic = new EpisodicMemory(db)
const semantic = new SemanticMemory(db)
const embedder = new Embedder()
const dreamer = new Dreamer(db, episodic, semantic, router, { embedder: t => embedder.embed(t) })
const narrator = new Narrator(bus, snap, router, { intervalMs: Number.MAX_SAFE_INTEGER })
const tier1 = new Tier1Classifier(router)
const tier2 = new Tier2Summarizer(router)
const recall = new Recall(db)
const pipeline = new PerceptionPipeline(db, working, tier1, tier2, narrator, episodic, () => '', { pollMs: Number.MAX_SAFE_INTEGER })

console.log('─── Phase B Validation — Synthetic Event Replay ───\n')

// Generate 200 fake events spanning ~3 hours of compressed activity
const sources = ['focus-app', 'clipboard', 'file-events', 'browser-tabs'] as const
const apps = ['VS Code', 'Slack', 'Brave', 'Notes', 'Terminal']
const startTs = Date.now() - 3 * 3600_000
for (let i = 0; i < 200; i++) {
  const ts = startTs + (i / 200) * 3 * 3600_000
  const source = sources[i % sources.length]!
  bus.publish({
    source,
    kind: source === 'focus-app' ? 'app_changed' : 'changed',
    payload: source === 'focus-app' ? { app: apps[i % apps.length], _ts: ts }
           : source === 'clipboard' ? { text: `clipboard text ${i}`, _ts: ts }
           : source === 'file-events' ? { path: `/tmp/file${i % 10}.ts`, _ts: ts }
           : { tabs: [`https://github.com/example/repo/pull/${i % 5}`], _ts: ts },
  })
}
console.log(`✓ Replayed 200 synthetic events`)

// Drive perception 5 times to chunk through them
console.log('Driving perception pipeline (5 ticks)...')
for (let i = 0; i < 5; i++) {
  process.stdout.write(`  tick ${i + 1}/5... `)
  const before = Date.now()
  await pipeline.evaluateNow()
  console.log(`${Date.now() - before}ms`)
}

const epCount = episodic.recent(100).length
console.log(`✓ Episodes recorded: ${epCount}`)

// Run dreamer
console.log('\nRunning Dreamer (consolidating episodes → semantic facts)...')
const factsCreated = await dreamer.consolidate({ maxEpisodes: 100 })
console.log(`✓ Facts consolidated to L3: ${factsCreated}`)

// Recall test
console.log('\n─── Recall Test ───')
const questions = [
  'what apps did the user spend time in?',
  'did the user copy anything to clipboard?',
  'what files were edited?',
  'any github browsing?',
  'when was the user in Slack?',
]
for (const q of questions) {
  const emb = await embedder.embed(q)
  const results = recall.hybrid(q, emb, 3)
  console.log(`\n  Q: ${q}`)
  if (results.length === 0) {
    console.log('    (no recall — possibly insufficient memory consolidation)')
  } else {
    for (const r of results) console.log(`    → [${r.kind}] ${r.subject}: ${r.body}`)
  }
}

// Perception log analysis
const logRows = db.query('SELECT verdict_tier1, COUNT(*) as n FROM perception_log GROUP BY verdict_tier1').all() as Array<{ verdict_tier1: string; n: number }>
console.log('\n─── Perception Volume ───')
for (const r of logRows) console.log(`  ${r.verdict_tier1.padEnd(12)} ${r.n}`)
const narratorFired = db.query('SELECT COUNT(*) as n FROM perception_log WHERE narrator_fired = 1').get() as { n: number }
console.log(`  narrator_fired ${narratorFired.n}`)

// LLM cost
const costRow = db.query('SELECT COALESCE(SUM(cost_cents), 0) as total, COUNT(*) as calls FROM llm_call_log').get() as { total: number; calls: number }
console.log('\n─── LLM Usage ───')
console.log(`  Total calls: ${costRow.calls}`)
console.log(`  Total cost: ${costRow.total}¢ ($${(costRow.total / 100).toFixed(4)})`)

console.log('\n─── Done ───')
console.log('Validation gate: human reviews recall answers + perception volume.')
console.log('PASS criteria:')
console.log('  • Recall answers are roughly relevant to the questions')
console.log('  • SIGNIFICANT < 20% of evaluations (gate is working)')
console.log('  • narrator_fired < 10% of evaluations (rate-limited as intended)')
console.log('  • Total cost < 10¢ for this 200-event replay')
