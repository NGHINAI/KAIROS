// scripts/live-test-phase-d-gmail.ts
// Live end-to-end test of Phase D against real Composio + your real Gmail.
//
// Flow:
//   1. Simulates KAIROS hearing "monitor my emails"
//   2. Checks if Gmail is connected; if not, kicks off OAuth (browser opens)
//   3. Waits for OAuth completion (polls every 3s, up to 10 min)
//   4. Looks up GMAIL_NEW_GMAIL_MESSAGE trigger type
//   5. Creates a Composio trigger instance bound to your Gmail account
//   6. Subscribes to the Pusher channel via composio.triggers.subscribe()
//   7. Listens for 10 minutes, printing every incoming event live
//   8. Cleans up: deletes the trigger instance, unsubscribes
//
// Run: bun run scripts/live-test-phase-d-gmail.ts
// Requires: COMPOSIO_API_KEY in .env (already set)

import { exec } from 'child_process'
import { Database } from 'bun:sqlite'

import { ComposioClient } from '../src/daemon/connectors/composioClient'
import { TriggerListener } from '../src/daemon/connectors/triggers/listener'
import { TriggerEventLog } from '../src/daemon/connectors/triggers/eventLog'
import { TriggerNormalizer } from '../src/daemon/connectors/triggers/normalizer'
import { TriggerMetrics } from '../src/daemon/connectors/triggers/metrics'

const USER_ID = 'local'
const TOOLKIT = 'gmail'
const TRIGGER_SLUG = 'GMAIL_NEW_GMAIL_MESSAGE'
const LISTEN_DURATION_MS = 10 * 60 * 1000   // 10 minutes
const POLL_INTERVAL_MS = 3000                // poll OAuth completion every 3s
const OAUTH_TIMEOUT_MS = 10 * 60 * 1000      // give user 10 min to complete OAuth

const apiKey = process.env.COMPOSIO_API_KEY
if (!apiKey) {
  console.error('✗ COMPOSIO_API_KEY not set in environment. Check .env')
  process.exit(1)
}

console.log('═════════════════════════════════════════════════════════════')
console.log('  KAIROS Phase D — Live Gmail end-to-end test')
console.log('═════════════════════════════════════════════════════════════')
console.log()

// ─── Step 1: Simulate the user speech ───────────────────────────────────────
console.log('🗣️  Simulating: you say to KAIROS, "monitor my emails"')
console.log()

// ─── Step 2: Initialize Composio ────────────────────────────────────────────
console.log('[1/7] Initializing Composio client...')
const composio = new ComposioClient({ apiKey })
console.log('       ✓ ComposioClient ready')

// ─── Step 3: Check existing Gmail connection ────────────────────────────────
console.log()
console.log('[2/7] Checking if Gmail is already connected for userId=' + USER_ID + '...')

async function findGmailConnection(connId?: string): Promise<{ id: string; status: string } | null> {
  // If we know the specific connection ID we just initiated, fetch it directly — more reliable
  if (connId) {
    try {
      const sdk: any = (composio as any).sdk
      const acc = await sdk.connectedAccounts.get(connId)
      if (acc) {
        const status = (acc.status ?? '').toString().toLowerCase()
        return { id: acc.id ?? connId, status: status === 'active' ? 'active' : status }
      }
    } catch { /* fall through to list */ }
  }
  // Otherwise list all and defensively match
  const accounts = await composio.listConnectedAccounts({ userId: USER_ID })
  return accounts.find(a => String(a.toolkit_slug ?? '').toLowerCase() === TOOLKIT) ?? null
}

let connection = await findGmailConnection()
if (connection && connection.status === 'active') {
  console.log(`       ✓ Gmail already connected (account=${connection.id})`)
} else {
  if (connection) {
    console.log(`       ⚠  Found Gmail connection with status=${connection.status}; will start fresh OAuth`)
  } else {
    console.log('       ⚠  No Gmail connection found')
  }

  // ─── Step 4: Surface the ConnectGuard-style prompt ────────────────────────
  console.log()
  console.log('🔔 INBOX PROMPT  (this is what KAIROS surfaces to the user via inbox + native notif):')
  console.log('   ┌────────────────────────────────────────────────────────┐')
  console.log('   │ KAIROS needs Gmail access                              │')
  console.log('   │                                                        │')
  console.log("   │ I'd like to monitor your incoming emails for the rule  │")
  console.log("   │ you just spoke. Click below to grant access.           │")
  console.log('   └────────────────────────────────────────────────────────┘')
  console.log()
  console.log('[3/7] Starting OAuth flow...')

  // Get/create the auth config for Gmail (Composio managed OAuth)
  const authConfigId = await composio.getOrCreateAuthConfig(TOOLKIT)
  console.log(`       authConfigId = ${authConfigId}`)

  // Initiate the link
  const linkResult = await composio.linkConnection({ userId: USER_ID, authConfigId })
  console.log(`       Connection initiated: id=${linkResult.connection_id}`)
  console.log(`       Redirect URL: ${linkResult.redirect_url}`)
  console.log()
  console.log('🌐 Opening browser for OAuth...')
  exec(`open "${linkResult.redirect_url}"`, () => {})
  console.log()
  console.log(`Waiting up to ${OAUTH_TIMEOUT_MS / 60000} minutes for you to complete OAuth...`)
  console.log('   (sign into Gmail, grant access — KAIROS will detect completion automatically)')
  console.log()

  // ─── Step 5: Poll until OAuth completes ─────────────────────────────────
  const oauthStart = Date.now()
  let lastStatus = ''
  while (Date.now() - oauthStart < OAUTH_TIMEOUT_MS) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
    connection = await findGmailConnection(linkResult.connection_id)
    if (connection && connection.status !== lastStatus) {
      console.log(`   → connection.status = ${connection.status}`)
      lastStatus = connection.status
    }
    if (connection?.status === 'active') {
      console.log('       ✓ Gmail connected!')
      break
    }
  }

  if (!connection || connection.status !== 'active') {
    console.log('       ✗ OAuth timed out without completion. Exiting.')
    process.exit(1)
  }
}

console.log()
console.log(`[4/7] Looking up trigger schema for ${TRIGGER_SLUG}...`)

let triggerType: any = null
try {
  // Real @composio/core@0.10.0 method is camelCase: triggers.getType(slug)
  const sdk: any = (composio as any).sdk
  triggerType = await sdk.triggers.getType(TRIGGER_SLUG)
} catch (err) {
  console.log(`       ⚠  Schema lookup error: ${err instanceof Error ? err.message : err}`)
  console.log('       Continuing with empty triggerConfig...')
}

if (triggerType) {
  // Unwrap nested JSON-schema if present
  const config = triggerType.config ?? triggerType.configSchema ?? triggerType.config_schema ?? {}
  const fields = config?.properties ? Object.keys(config.properties) : Object.keys(config)
  console.log(`       ✓ Schema loaded. triggerConfig fields: ${fields.join(', ') || '(none)'}`)
}

// ─── Step 6: Create a trigger instance ──────────────────────────────────────
console.log()
console.log(`[5/7] Creating trigger instance for ${TRIGGER_SLUG} bound to your Gmail account...`)

let triggerId: string | null = null
try {
  const sdk: any = (composio as any).sdk
  // Real @composio/core@0.10.0 signature: triggers.create(userId, slug, body)
  const result = await sdk.triggers.create(USER_ID, TRIGGER_SLUG, {
    connectedAccountId: connection!.id,
    triggerConfig: {},
  })
  triggerId = result.triggerId ?? result.id ?? result.trigger_id
  console.log(`       ✓ Trigger instance created: triggerId=${triggerId}`)
} catch (err) {
  console.log(`       ✗ Failed to create trigger instance: ${err instanceof Error ? err.message : err}`)
  console.log('       Will attempt to subscribe anyway — events may still arrive for existing instances')
}

// ─── Step 7: Start the production TriggerListener against real Composio ─────
console.log()
console.log('[6/7] Starting production TriggerListener (apiKey → real Composio Pusher channel)...')

const db = new Database(':memory:')
const eventLog = new TriggerEventLog(db)
const normalizer = new TriggerNormalizer()
const metrics = new TriggerMetrics(db)

// In-process bus for this test — just log every published event
const perceptionBus = {
  publish: (kind: string, payload: any) => {
    console.log()
    console.log(`📨 Perception bus received: kind=${kind}`)
    const env = payload as any
    console.log(`   trigger_slug:    ${env.trigger_slug}`)
    console.log(`   toolkit:         ${env.toolkit}`)
    console.log(`   event_id:        ${env.event_id}`)
    console.log(`   payload (first 5 keys):`)
    const keys = Object.keys(env.payload ?? {}).slice(0, 5)
    for (const k of keys) {
      const v = JSON.stringify(env.payload[k])
      console.log(`     ${k}: ${v?.slice(0, 100)}${(v?.length ?? 0) > 100 ? '...' : ''}`)
    }
    console.log()
  },
}

// Use the PRODUCTION TriggerListener — same code that runs in the daemon
const liveListener = new TriggerListener({
  apiKey: apiKey,
  eventLog,
  normalizer,
  perceptionBus,
  metrics,
  onHealthChange: (h) => console.log(`   [listener] health → ${h}`),
})

try {
  await liveListener.start()
  console.log(`       ✓ TriggerListener subscribed. Health: ${liveListener.getHealth()}`)
} catch (err) {
  console.log(`       ✗ Subscribe failed: ${err instanceof Error ? err.message : err}`)
  if (err instanceof Error) {
    console.log()
    console.log('       Full error:')
    console.log('       name:', err.name)
    console.log('       message:', err.message)
    console.log('       cause:', (err as any).cause)
    console.log('       stack:')
    console.log((err.stack ?? '').split('\n').map(l => '         ' + l).join('\n'))
  }
  console.log()
  console.log('═══ EXITING ═══')
  process.exit(1)
}

// ─── Step 8: Listen for 10 minutes ──────────────────────────────────────────
console.log()
console.log(`[7/7] Listening for ${LISTEN_DURATION_MS / 60000} minutes. Send yourself a test email to see it arrive.`)
console.log('       (Gmail polls every ~15 min; an email might take that long to appear)')
console.log('       Press Ctrl+C to stop early.')
console.log()
console.log('─── live event feed ─────────────────────────────────────────')

const startedAt = Date.now()
const interval = setInterval(() => {
  const minsLeft = Math.max(0, Math.floor((LISTEN_DURATION_MS - (Date.now() - startedAt)) / 60000))
  process.stdout.write(`\r   ⏱  ${minsLeft} min left | events seen: ${eventLog.listAll().length} | health: ${liveListener.getHealth()}        `)
}, 5000)

async function cleanup() {
  clearInterval(interval)
  console.log('\n')
  console.log('─── cleanup ─────────────────────────────────────────────────')
  console.log('Stopping TriggerListener...')
  await liveListener.stop().catch(() => {})

  if (triggerId) {
    console.log(`Deleting trigger instance ${triggerId}...`)
    try {
      await sdk.triggers.delete(triggerId)
      console.log('   ✓ Trigger instance deleted')
    } catch (err) {
      console.log(`   ⚠  Could not delete trigger: ${err instanceof Error ? err.message : err}`)
    }
  }

  console.log()
  console.log('═════════════════════════════════════════════════════════════')
  console.log('  Test complete.')
  console.log(`  Total events received: ${eventLog.listAll().length}`)
  console.log('═════════════════════════════════════════════════════════════')
  process.exit(0)
}

process.on('SIGINT', cleanup)

setTimeout(cleanup, LISTEN_DURATION_MS)

// Keep the event loop alive
await new Promise(() => {})
