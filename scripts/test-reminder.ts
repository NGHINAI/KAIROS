// scripts/test-reminder.ts
// Manual test of the remind_in intent — bypasses the trigger engine
// (the trigger→remind_in args path isn't wired until C.3's action composer).
//
// Usage: bun run scripts/test-reminder.ts [delay_seconds]
// Default: 15 seconds.
//
// After ~delay seconds you should see a macOS notification.

import { Database } from 'bun:sqlite'
import { randomUUID } from 'crypto'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { IntentRegistry, registerBuiltIns } from '../src/daemon/agency/intentRegistry'
import { TrajectoryLog, TRAJECTORY_SCHEMA } from '../src/daemon/agency/trajectoryLog'
import { InboxSurface } from '../src/daemon/agency/inboxSurface'
import { NativeNotifier } from '../src/daemon/agency/nativeNotifier'
import { ActionExecutor, EXECUTOR_SCHEMA } from '../src/daemon/agency/actionExecutor'

const delaySeconds = parseInt(process.argv[2] ?? '15', 10)

const db = new Database(':memory:')
db.exec(TRAJECTORY_SCHEMA)
db.exec(EXECUTOR_SCHEMA)
db.exec(`CREATE TABLE IF NOT EXISTS agency_inbox_items (
  item_id TEXT PRIMARY KEY, created_at INTEGER, tier TEXT, intent_id TEXT,
  description TEXT, args_preview TEXT, expires_at INTEGER, resolved_at INTEGER, resolution TEXT
)`)
db.exec(`CREATE TABLE IF NOT EXISTS agency_scheduled_reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, body TEXT, fire_at INTEGER, fired INTEGER NOT NULL DEFAULT 0
)`)

const registry = new IntentRegistry()
registerBuiltIns(registry)
const traj = new TrajectoryLog(db)
const tmp = mkdtempSync(join(tmpdir(), 'kairos-reminder-test-'))
const inbox = new InboxSurface(db, join(tmp, 'inbox.md'))
const notifier = new NativeNotifier()   // real macOS notifier

const executor = new ActionExecutor(db, registry, traj, inbox, {
  db,
  notifier,
  embedder: { embed: async () => new Array(768).fill(0) } as any,
  semantic: { reinforceOrWrite: () => 1 } as any,
})

console.log(`🟢 Dispatching remind_in with delay=${delaySeconds}s...`)
console.log(`   Watch for a macOS notification in ${delaySeconds} seconds.\n`)

const result = await executor.dispatch({
  request_id: randomUUID(),
  intent_id: 'remind_in',
  args: {
    delay_seconds: delaySeconds,
    title: 'KAIROS reminder',
    body: `Fired after ${delaySeconds}s — this proves the agency layer works.`,
  },
  reasoning: 'manual test of remind_in intent',
  requested_at: Date.now(),
})

console.log(`Dispatch result: ${result.status}`)
console.log(`Trajectory id: ${result.trajectory_id}`)
console.log(`\nWaiting ${delaySeconds + 2}s for the notification to fire + a moment of slack...`)

await new Promise(r => setTimeout(r, (delaySeconds + 2) * 1000))

const reminderRow = db.query('SELECT * FROM agency_scheduled_reminders').get() as any
console.log(`\nReminder DB row: fired=${reminderRow.fired === 1 ? '✅ YES' : '❌ NO'}`)
console.log(`Trajectory: ${JSON.stringify(traj.get(result.trajectory_id!), null, 2).slice(0, 500)}`)
