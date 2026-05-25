// scripts/validate-phase-c2.ts
// Phase C.2 validation per Section 8.5 — 5 scenarios for MCP host + agency integration.
//
// Usage: bun run scripts/validate-phase-c2.ts
// Cost: $0 — no LLM calls.
//
// User confirms scenario 4 manually by opening Reminders.app and checking
// for the "KAIROS C.2 test — <timestamp>" item.

import { Database } from 'bun:sqlite'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { McpHost } from '../src/daemon/mcp/mcpHost'
import { Keychain } from '../src/daemon/mcp/keychain'
import { SmitheryCli } from '../src/daemon/mcp/smithery'
import { registerMcpToolsAsIntents } from '../src/daemon/mcp/toolToIntent'
import { IntentRegistry, registerBuiltIns } from '../src/daemon/agency/intentRegistry'
import { TrajectoryLog, TRAJECTORY_SCHEMA } from '../src/daemon/agency/trajectoryLog'
import { InboxSurface, INBOX_SCHEMA } from '../src/daemon/agency/inboxSurface'
import { NativeNotifier } from '../src/daemon/agency/nativeNotifier'
import { ActionExecutor, EXECUTOR_SCHEMA } from '../src/daemon/agency/actionExecutor'

// ── Bootstrap in-memory DB ───────────────────────────────────────────────────

const db = new Database(':memory:')
db.exec(TRAJECTORY_SCHEMA)
db.exec(EXECUTOR_SCHEMA)
db.exec(INBOX_SCHEMA)

// ── Temp dir + config ────────────────────────────────────────────────────────

const tmp = mkdtempSync(join(tmpdir(), 'kairos-c2-validate-'))
const echoFixture = join(import.meta.dir, '..', 'src', 'daemon', 'mcp', '__fixtures__', 'echo-server.ts')
const remindersServer = join(import.meta.dir, '..', 'connectors', 'macos-reminders', 'server', 'index.ts')

const configPath = join(tmp, 'mcp-servers.json')
writeFileSync(configPath, JSON.stringify({
  servers: [
    {
      id: 'echo-test',
      enabled: true,
      transport: 'stdio',
      command: 'bun',
      args: ['run', echoFixture],
      tier_policy: { default: 'GREEN' },
    },
    {
      id: 'macos-reminders',
      enabled: true,
      transport: 'stdio',
      command: 'bun',
      args: ['run', remindersServer],
      tier_policy: {
        default: 'YELLOW',
        overrides: {
          list_reminders: 'GREEN',
          add_reminder: 'YELLOW',
          complete_reminder: 'ORANGE',
        },
      },
    },
  ],
}))

// ── Wire subsystems ──────────────────────────────────────────────────────────

const registry = new IntentRegistry()
registerBuiltIns(registry)
const traj = new TrajectoryLog(db)
const inbox = new InboxSurface(db, join(tmp, 'inbox.md'))
const notifier = new NativeNotifier({ probe: async () => { /* swallow during validation */ } })

console.log('─── Phase C.2 Validation — 5 Scenarios ───\n')

// ── SCENARIO 1: Echo server starts + 1 tool registered ──────────────────────

console.log('Scenario 1: Echo MCP server starts → tool registered as Intent')
const keychain = new Keychain()
const host = new McpHost({ configPath, keychain })
await host.startAll()
registerMcpToolsAsIntents(registry, host)
const echoIntent = registry.get('echo-test::echo')
const echoServerUp = host.listServers().some(s => s.id === 'echo-test')
console.log(`  echo-test server connected: ${echoServerUp}`)
console.log(`  echo-test::echo intent registered: ${echoIntent !== null}`)
console.log(`  Tier (default GREEN): ${echoIntent?.tier}\n`)

// ── SCENARIO 2: Invoke echo via ActionExecutor → success ────────────────────

console.log('Scenario 2: Invoke echo-test::echo via ActionExecutor')
const executor = new ActionExecutor(db, registry, traj, inbox, {
  db,
  notifier,
  embedder: { embed: async () => new Array(768).fill(0) } as any,
  semantic: { reinforceOrWrite: () => 1 } as any,
})
const echoResult = await executor.dispatch({
  request_id: randomUUID(),
  intent_id: 'echo-test::echo',
  args: { msg: 'C.2 validation alive' },
  reasoning: 'validation scenario 2',
  requested_at: Date.now(),
})
console.log(`  Status: ${echoResult.status}`)
console.log(`  Details: ${echoResult.details?.slice(0, 120)}\n`)

// ── SCENARIO 3: Reminders bundle starts → 3 tools registered ────────────────

console.log('Scenario 3: macos-reminders bundle → 3 tools, correct tier assignment')
const reminderTools = host.listAllTools().filter(t => t.server_id === 'macos-reminders')
console.log(`  Tools discovered: ${reminderTools.length}`)
for (const t of reminderTools) {
  console.log(`    ${t.qualified_id} → ${t.tier}`)
}

// ── SCENARIO 4: Add a real reminder via Intent ───────────────────────────────

console.log('\nScenario 4: add_reminder via Intent (check Reminders.app after run)')
const testTitle = `KAIROS C.2 test — ${new Date().toISOString().slice(0, 19)}`
const addResult = await executor.dispatch({
  request_id: randomUUID(),
  intent_id: 'macos-reminders::add_reminder',
  args: { title: testTitle },
  reasoning: 'validation scenario 4',
  requested_at: Date.now(),
})
console.log(`  Status: ${addResult.status}`)
console.log(`  Open Reminders.app — you should see a new item titled: ${testTitle}`)
console.log(`  (First run may prompt for Reminders access — approve in System Settings)`)

// ── SCENARIO 5: Smithery availability ───────────────────────────────────────

console.log('\nScenario 5: Smithery CLI availability check')
const smithery = new SmitheryCli()
const available = await smithery.isAvailable()
console.log(`  smithery CLI on PATH: ${available ? 'YES' : 'NO (gracefully degraded)'}`)
if (available) {
  const hits = await smithery.search('github')
  console.log(`  Search "github": ${hits.length} hits (top: ${hits[0]?.qualified_name ?? 'none'})`)
}

// ── Cleanup ──────────────────────────────────────────────────────────────────

await host.stopAll()
rmSync(tmp, { recursive: true })

console.log('\n─── Done ───')
console.log('PASS criteria (human review):')
console.log('  • Scenario 1: echo server reaches ready state, intent registered')
console.log('  • Scenario 2: dispatch returns completed, output contains "C.2 validation alive"')
console.log('  • Scenario 3: 3 tools registered with tiers list=GREEN, add=YELLOW, complete=ORANGE')
console.log('  • Scenario 4: open Reminders.app — new "KAIROS C.2 test ..." reminder visible')
console.log('  • Scenario 5: smithery either present + works, or graceful "NO" — no crash')
