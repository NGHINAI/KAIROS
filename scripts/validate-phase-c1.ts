// scripts/validate-phase-c1.ts
// Phase C.1 validation per Section 8.5 — 5 scripted scenarios.
// Exercises trigger engine + autonomy tiers + inbox surface end-to-end.
//
// Usage: bun run scripts/validate-phase-c1.ts
//
// Cost: $0 — no LLM calls. Pure integration test against in-memory DB.

import { Database } from 'bun:sqlite'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { EventBus } from '../src/daemon/proactive/eventBus'
import { initMemorySchema } from '../src/daemon/memory/schema'
import { EpisodicMemory } from '../src/daemon/memory/episodicMemory'
import { SemanticMemory } from '../src/daemon/memory/semanticMemory'
import { Embedder } from '../src/daemon/memory/embeddings'
import { ORDERS_SCHEMA } from '../src/daemon/orders/compiler'
import { IntentRegistry, registerBuiltIns } from '../src/daemon/agency/intentRegistry'
import { TrajectoryLog, TRAJECTORY_SCHEMA } from '../src/daemon/agency/trajectoryLog'
import { InboxSurface } from '../src/daemon/agency/inboxSurface'
import { NativeNotifier } from '../src/daemon/agency/nativeNotifier'
import { ActionExecutor } from '../src/daemon/agency/actionExecutor'
import { TriggerEngine } from '../src/daemon/agency/triggerEngine'
import type { WorldEvent } from '../src/daemon/proactive/eventBus'

// ── Bootstrap in-memory DB ───────────────────────────────────────────────────

const db = new Database(':memory:')
initMemorySchema(db)
db.exec(ORDERS_SCHEMA)
db.exec(TRAJECTORY_SCHEMA)
db.exec(`CREATE TABLE IF NOT EXISTS agency_scheduled_reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT,
  body TEXT,
  fire_at INTEGER,
  fired INTEGER
)`)
db.exec(`CREATE TABLE IF NOT EXISTS agency_suspend_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT,
  until_ms INTEGER,
  reason TEXT
)`)

// ── Wire subsystems ──────────────────────────────────────────────────────────

const bus = new EventBus(db)
const _ep = new EpisodicMemory(db)
const sem = new SemanticMemory(db)
const embedder = new Embedder()
const registry = new IntentRegistry()
registerBuiltIns(registry)
const traj = new TrajectoryLog(db)
const tmp = mkdtempSync(join(tmpdir(), 'kairos-c1-validate-'))
const inboxPath = join(tmp, 'inbox.md')
const inbox = new InboxSurface(db, inboxPath)

// Intercept notifications instead of firing real macOS alerts.
const captured: Array<{ title: string; body: string }> = []
const notifier = new NativeNotifier({
  probe: async (args) => {
    captured.push(args)
    console.log(`  [notification] ${args.title}: ${args.body}`)
  },
})

const executor = new ActionExecutor(db, registry, traj, inbox, {
  db,
  notifier,
  embedder: { embed: (t: string) => embedder.embed(t) },
  semantic: sem,
})

const engine = new TriggerEngine(db, bus, (req) => executor.dispatch(req))

// ── Helper: seed a compiled trigger row ─────────────────────────────────────

function seedTrigger(t: {
  id: string
  when_kind: string
  when_match: string
  condition: string | null
  action: string
  source_rule: string
}): void {
  db.run(
    `INSERT INTO compiled_orders_triggers
       (id, when_kind, when_match, condition, action, source_rule, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [t.id, t.when_kind, t.when_match, t.condition, t.action, t.source_rule, Date.now()],
  )
}

// ── Helper: build a WorldEvent without publishing to bus ────────────────────

function evt(
  id: number,
  source: string,
  kind: string,
  payload: Record<string, unknown>,
): WorldEvent {
  return { id, ts: Date.now(), source, kind, payload }
}

// ────────────────────────────────────────────────────────────────────────────

console.log('─── Phase C.1 Validation — 5 Scenarios ───\n')

// ── SCENARIO 1: Clipboard URL → add_to_memory (GREEN, silent) ───────────────

console.log('Scenario 1: 🟢 clipboard URL → add_to_memory (silent)')
seedTrigger({
  id: 'clip-url',
  when_kind: 'clipboard',
  when_match: 'text.isURL()',
  condition: null,
  action: 'add_to_memory',
  source_rule: 'When I copy a URL to the clipboard, add it to memory',
})
await engine.evaluateEvent(
  evt(1, 'clipboard', 'changed', { text: 'https://example.com/article' }),
)
const trajAfterS1 = traj.recent(10).length
const inboxAfterS1 = inbox.pending().length
const memAfterS1 = sem.allActive().length
console.log(`  Trajectories logged : ${trajAfterS1}`)
console.log(`  Inbox items pending : ${inboxAfterS1}  (expected: 0 — GREEN tier)`)
console.log(`  L3 memory facts     : ${memAfterS1}`)
console.log()

// ── SCENARIO 2: focus-app=Slack → notify (GREEN/YELLOW, silent) ─────────────

console.log('Scenario 2: 🟢 focus-app=Slack → notify')
seedTrigger({
  id: 'slack-focus',
  when_kind: 'focus-app',
  when_match: "app.equals('Slack')",
  condition: null,
  action: 'notify',
  source_rule: 'When I switch to Slack, send a notification',
})
const capturedBefore = captured.length
await engine.evaluateEvent(
  evt(2, 'focus-app', 'app_changed', { app: 'Slack' }),
)
const trajAfterS2 = traj.recent(10).length
console.log(`  Trajectories logged : ${trajAfterS2}`)
console.log(`  Notifications fired : ${captured.length - capturedBefore}  (expected: 1)`)
console.log()

// ── SCENARIO 3: file path .ts → log (GREEN, record-only) ────────────────────

console.log('Scenario 3: 🟢 file path → log (record-only)')
seedTrigger({
  id: 'ts-file',
  when_kind: 'file-events',
  when_match: "path.endsWith('.ts')",
  condition: null,
  action: 'log',
  source_rule: 'Log when .ts files change',
})
await engine.evaluateEvent(
  evt(3, 'file-events', 'modified', { path: '/tmp/foo.ts' }),
)
const trajAfterS3 = traj.recent(10).length
console.log(`  Trajectories logged : ${trajAfterS3}`)
console.log(`  Inbox items pending : ${inbox.pending().length}  (expected: 0 — log is GREEN)`)
console.log()

// ── SCENARIO 4: Custom ORANGE intent → inbox approval flow ──────────────────

console.log('Scenario 4: 🟠 custom ORANGE intent → inbox approval flow')

// Register a custom ORANGE-tier intent for this scenario.
registry.register(
  {
    id: 'risky-action',
    description: 'Simulated risky action requiring approval',
    tier: 'ORANGE',
    argSchema: { msg: 'string' },
  },
  async (args) => ({
    status: 'success',
    details: `risky-action executed with msg="${String(args['msg'] ?? '')}"`,
  }),
)

seedTrigger({
  id: 'risky-trigger',
  when_kind: 'browser-tabs',
  when_match: '*',
  condition: null,
  action: 'risky-action',
  source_rule: 'On browser tab change, perform a risky action',
})

await engine.evaluateEvent(
  evt(4, 'browser-tabs', 'tabs_changed', { tabs: ['https://foo.example'] }),
)

const pendingAfterFire = inbox.pending()
console.log(`  Inbox items pending : ${pendingAfterFire.length}  (expected: 1 — ORANGE queued)`)

if (pendingAfterFire.length > 0) {
  console.log(`  --- inbox.md preview (top 30 lines) ---`)
  const preview = readFileSync(inboxPath, 'utf8').split('\n').slice(0, 30).join('\n')
  console.log(preview)
  console.log(`  --- end inbox.md preview ---`)

  // Approve the queued item.
  const item = pendingAfterFire[0]!
  const approveResult = await executor.approveItem(item.item_id)
  console.log(`  Approve result      : ${approveResult.status}  (expected: completed)`)
  console.log(`  Inbox after approve : ${inbox.pending().length}  (expected: 0)`)
} else {
  console.log('  WARN: no pending inbox item found — approval flow skipped')
}
console.log()

// ── SCENARIO 5: Suspend-all blocks subsequent triggers ───────────────────────

console.log('Scenario 5: 🟢 quiet-hours suspend blocks subsequent triggers')
db.run(
  `INSERT INTO agency_suspend_state (scope, until_ms, reason)
   VALUES ('all', ?, 'quiet hours test')`,
  [Date.now() + 60_000],
)

const trajBeforeSuspend = traj.recent(50).length
await engine.evaluateEvent(
  evt(5, 'clipboard', 'changed', { text: 'https://blocked.com/should-not-appear' }),
)
const trajAfterSuspend = traj.recent(50).length

console.log(`  Trajectories before suspend event : ${trajBeforeSuspend}`)
console.log(`  Trajectories after  suspend event : ${trajAfterSuspend}`)
console.log(
  `  Expected: equal — event suppressed by suspend gate : ${trajBeforeSuspend === trajAfterSuspend ? 'PASS' : 'FAIL'}`,
)
console.log()

// ── Final Summary ────────────────────────────────────────────────────────────

const allTrajectories = traj.recent(100)
console.log('─── Summary ───')
console.log(`Total trajectories   : ${allTrajectories.length}`)

for (const outcome of ['success', 'failure', 'user_override', 'partial'] as const) {
  const n = traj.byOutcome(outcome, 100).length
  console.log(`  ${outcome.padEnd(15)} ${n}`)
}

console.log(`Pending inbox items  : ${inbox.pending().length}`)
console.log(`L3 memory facts      : ${sem.allActive().length}`)
console.log(`Inbox file           : ${inboxPath}`)

console.log('\nPASS criteria (human review):')
console.log('  • Scenario 1 — add_to_memory fires silently (0 inbox items, 1+ trajectory)')
console.log('  • Scenario 2 — notify fires silently (notification captured, 0 inbox items)')
console.log('  • Scenario 3 — log fires silently (record only, 0 inbox items)')
console.log('  • Scenario 4 — ORANGE intent queues to inbox.md with approve/dismiss commands; approved → status=completed')
console.log('  • Scenario 5 — suspend gate drops clipboard event (trajectory count unchanged)')
console.log('  • All trajectories have a final outcome (none stuck in-progress)')
