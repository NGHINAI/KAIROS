// scripts/validate-phase-c1-5.ts
// Phase C.1.5 validation — REPLAY the 4,454-notification scenario.
// Same events, same triggers — but now through the restraint pipeline.
// PASS criteria:
//   - interrupts ≤ 8
//   - surfaces ≤ 20
//   - urgency-floor items always pass through (regression: never silenced)
//   - 0 unexpected throws
//
// Usage: bun run scripts/validate-phase-c1-5.ts
// Cost: $0 — pure integration test, no LLM calls.

import { Database } from 'bun:sqlite'
import { randomUUID } from 'crypto'
import { FocusDetector } from '../src/daemon/restraint/focusDetector'
import { KarmaStore, KARMA_SCHEMA } from '../src/daemon/restraint/karma'
import { CooldownTracker } from '../src/daemon/restraint/cooldownTracker'
import { RateLimiter, RATE_LIMITER_SCHEMA } from '../src/daemon/restraint/rateLimiter'
import { ActionScorer } from '../src/daemon/restraint/actionScorer'
import { DeliveryRouter } from '../src/daemon/restraint/deliveryRouter'
import { DigestComposer, DIGEST_SCHEMA } from '../src/daemon/restraint/digestComposer'
import { DryRunMode, DRY_RUN_SCHEMA } from '../src/daemon/restraint/dryRunMode'
import { UrgencyFloor } from '../src/daemon/restraint/urgencyFloor'
import { RestraintPipeline } from '../src/daemon/restraint/restraintPipeline'
import { loadRestraintConfig } from '../src/daemon/restraint/configLoader'
import type { ActionRequest } from '../src/daemon/agency/types'

const db = new Database(':memory:')
db.exec(KARMA_SCHEMA)
db.exec(RATE_LIMITER_SCHEMA)
db.exec(DIGEST_SCHEMA)
db.exec(DRY_RUN_SCHEMA)

const cfg = loadRestraintConfig('/nonexistent-use-defaults')

// Construct the full restraint pipeline (mirrors daemon wire-up)
const focus = new FocusDetector(cfg, {
  now: () => Date.now(),
  // Simulate: user mostly browsing/coding, no deep focus blocks
  probeFocusedApp: async () => ({ app: 'VS Code', duration_sec: 300 }),
  probeMeeting: async () => false,
})
const karma = new KarmaStore(db, cfg)
const cooldown = new CooldownTracker(cfg.default_trigger_cooldown_sec * 1000)
const rateLimiter = new RateLimiter(db, cfg)
const scorer = new ActionScorer(cfg)
const router = new DeliveryRouter(cfg)
const digest = new DigestComposer(db)
const dryRun = new DryRunMode(db, cfg)
const urgencyFloor = new UrgencyFloor()

const pipeline = new RestraintPipeline({
  config: cfg, urgencyFloor, focus, karma, cooldown, rateLimiter,
  scorer, router, digest, dryRun,
})

// ─── Scenario: replay 10,000 file-events + 500 focus switches + 200 clipboard ───
console.log('─── Phase C.1.5 Validation: REPLAY 4,454-notification scenario ───\n')

const counts = { interrupt: 0, surface: 0, digest: 0, log_only: 0, suppressed: 0, dry_run: 0 }
let urgencyFloorTriggered = 0
let throws = 0

const TRIGGER_IDS = [
  'file-repeated-open',         // Was the bug-trigger — now fail-closed
  'focus-slack-notify',         // Legitimate but high-frequency
  'clip-url',                   // Legitimate — but should be coalesced
  'task-error-handler',         // Should always interrupt (UrgencyFloor)
]

function makeRequest(triggerId: string, intentId: string, args: Record<string, unknown> = {}, reasoning = ''): ActionRequest {
  return {
    request_id: randomUUID(),
    intent_id: intentId,
    args,
    source_trigger_id: triggerId,
    reasoning,
    requested_at: Date.now(),
  }
}

// 10,000 file-events (the load that produced the spam)
for (let i = 0; i < 10_000; i++) {
  try {
    const decision = await pipeline.evaluate(
      makeRequest('file-repeated-open', 'notify', { kind: 'file-events', path: `/Users/x/.git/objects/${i}` }, `file event ${i}`),
      { urgency: 0.1, rule_match_strength: 0.5, personal_relevance: 0.5, novelty: 0.5, urgent: false },
    )
    counts[decision.mode]++
    pipeline.recordDelivered('file-repeated-open', decision.mode)
  } catch { throws++ }
}

// 500 focus-app switches to Slack
for (let i = 0; i < 500; i++) {
  try {
    const decision = await pipeline.evaluate(
      makeRequest('focus-slack-notify', 'notify', { kind: 'focus-app', app: 'Slack' }, `switched to Slack ${i}`),
      { urgency: 0.3, rule_match_strength: 1.0, personal_relevance: 0.4, novelty: 0.3, urgent: false },
    )
    counts[decision.mode]++
    pipeline.recordDelivered('focus-slack-notify', decision.mode)
  } catch { throws++ }
}

// 200 clipboard changes (mostly noise, but 10 are real URLs)
for (let i = 0; i < 200; i++) {
  const isUrl = i % 20 === 0
  try {
    const decision = await pipeline.evaluate(
      makeRequest('clip-url', 'add_to_memory', {
        kind: 'clipboard',
        body: isUrl ? `https://example.com/page${i}` : `random text ${i}`,
      }, 'clipboard changed'),
      { urgency: 0.2, rule_match_strength: isUrl ? 1.0 : 0.3, personal_relevance: 0.5, novelty: 0.6, urgent: false },
    )
    counts[decision.mode]++
    pipeline.recordDelivered('clip-url', decision.mode)
  } catch { throws++ }
}

// 5 ACTUALLY URGENT events (UrgencyFloor MUST let these through)
for (let i = 0; i < 5; i++) {
  try {
    const decision = await pipeline.evaluate(
      makeRequest('task-error-handler', 'task_error', {
        kind: 'task_error', task_id: `task-${i}`, error: 'something broke',
      }, 'task failed'),
      { urgency: 1.0, rule_match_strength: 1.0, personal_relevance: 1.0, novelty: 1.0, urgent: false },
    )
    counts[decision.mode]++
    if (decision.mode === 'interrupt') urgencyFloorTriggered++
    pipeline.recordDelivered('task-error-handler', decision.mode)
  } catch { throws++ }
}

// 3 URGENT keyword in reasoning (UrgencyFloor regex match)
for (let i = 0; i < 3; i++) {
  try {
    const decision = await pipeline.evaluate(
      makeRequest('focus-slack-notify', 'notify', { app: 'Slack' }, `URGENT: please respond ASAP ${i}`),
      { urgency: 1.0, rule_match_strength: 1.0, personal_relevance: 0.8, novelty: 1.0, urgent: false },
    )
    counts[decision.mode]++
    if (decision.mode === 'interrupt') urgencyFloorTriggered++
    pipeline.recordDelivered('focus-slack-notify', decision.mode)
  } catch { throws++ }
}

// 2 password-in-clipboard events (UrgencyFloor regex must catch)
for (let i = 0; i < 2; i++) {
  try {
    const decision = await pipeline.evaluate(
      makeRequest('clip-url', 'add_to_memory', {
        kind: 'clipboard',
        body: 'sk-proj-FAKEKEY1234567890abcdefghijklmn',
      }, 'clipboard contained API key'),
      { urgency: 1.0, rule_match_strength: 1.0, personal_relevance: 1.0, novelty: 1.0, urgent: false },
    )
    counts[decision.mode]++
    if (decision.mode === 'interrupt') urgencyFloorTriggered++
    pipeline.recordDelivered('clip-url', decision.mode)
  } catch { throws++ }
}

// ─── Summary ───
const total = Object.values(counts).reduce((a, b) => a + b, 0)
console.log(`Total events processed: ${total}`)
console.log('Decisions:')
for (const [mode, n] of Object.entries(counts)) {
  console.log(`  ${mode.padEnd(12)} ${String(n).padStart(6)}`)
}
console.log(`\nUrgency-floor triggers (should be 10 = 5 task_error + 3 URGENT + 2 password): ${urgencyFloorTriggered}/10`)
console.log(`Unexpected throws: ${throws}`)

console.log('\n─── PASS Criteria ───')
const passInterrupt = counts.interrupt <= 8 + 10   // base cap + urgency-floor bypasses
const passSurface = counts.surface <= 20
const passUrgency = urgencyFloorTriggered === 10
const passThrows = throws === 0

console.log(`  interrupts ≤ 18 (base cap 8 + 10 urgency-floor bypasses): ${counts.interrupt} → ${passInterrupt ? 'PASS' : 'FAIL'}`)
console.log(`  surfaces ≤ 20: ${counts.surface} → ${passSurface ? 'PASS' : 'FAIL'}`)
console.log(`  urgency-floor 10/10 always passed: ${urgencyFloorTriggered} → ${passUrgency ? 'PASS' : 'FAIL'}`)
console.log(`  zero unexpected throws: ${throws} → ${passThrows ? 'PASS' : 'FAIL'}`)

const allPassed = passInterrupt && passSurface && passUrgency && passThrows
console.log(`\n${allPassed ? '✅ ALL PASS' : '❌ FAIL'}`)
if (allPassed) {
  console.log(`\nThe 4,454-notification scenario reduced to ${counts.interrupt} interrupts + ${counts.surface} surfaces.`)
  console.log(`That's a ${((1 - counts.interrupt / 4454) * 100).toFixed(1)}% reduction in interrupt-tier notifications.`)
}

process.exit(allPassed ? 0 : 1)
