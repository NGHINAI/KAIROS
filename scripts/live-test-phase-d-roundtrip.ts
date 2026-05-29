// scripts/live-test-phase-d-roundtrip.ts
//
// Full reactive round-trip live test for Phase D.
//
//   Real Calendar event → Composio Pusher → TriggerListener → TriggerNormalizer
//     → perception bus → ReactiveEvaluator → rule match → ConditionEvaluator
//     → cooldown → ActionDispatcher → ComposioToolResolver → real Gmail send
//
// Closes the proactive loop: Google Calendar → KAIROS → Google Gmail.
//
// HARD guard rails (env-overridable):
//   KAIROS_LIVE_APPROVE=yes        REQUIRED to actually send. Default = dry-run.
//   KAIROS_LIVE_MAX_ACTIONS=3      Script exits after N fires (runaway catcher).
//   KAIROS_LIVE_COOLDOWN_SEC=600   Rule cooldown (rule cannot refire within 10 min).
//   KAIROS_LIVE_DURATION_MIN=20    Hard wall-clock cap; teardown after.
//   KAIROS_LIVE_RECIPIENT          Email TO address. Default = nghinaiya81@gmail.com.
//   KAIROS_LIVE_ORGANIZER          Event organizer to filter on. Default = nghinaiya81@gmail.com.
//
// Run:
//   # First pass — dry-run, no email sent, just proves the chain
//   bun scripts/live-test-phase-d-roundtrip.ts
//
//   # Second pass — real send
//   KAIROS_LIVE_APPROVE=yes bun scripts/live-test-phase-d-roundtrip.ts

import { Database } from 'bun:sqlite'

import { ComposioClient } from '../src/daemon/connectors/composioClient'
import { TriggerListener } from '../src/daemon/connectors/triggers/listener'
import { TriggerEventLog } from '../src/daemon/connectors/triggers/eventLog'
import { TriggerNormalizer } from '../src/daemon/connectors/triggers/normalizer'
import { TriggerMetrics } from '../src/daemon/connectors/triggers/metrics'
import { TriggerSchemaCache } from '../src/daemon/connectors/triggers/schemaCache'
import { TriggerInstanceManager } from '../src/daemon/connectors/triggers/instanceManager'

import { ReactiveEvaluator } from '../src/daemon/orders/v2/reactiveEvaluator'
import { ActionDispatcher } from '../src/daemon/orders/v2/actionDispatcher'
import { ConditionEvaluator } from '../src/daemon/orders/v2/conditionEvaluator'
import { DryRunLogger } from '../src/daemon/orders/v2/dryRunLogger'
import { RulesEventBus } from '../src/daemon/orders/v2/eventBus'
import type { Rule } from '../src/daemon/orders/v2/types'

// NOTE: We bypass ComposioToolResolver. Its refresh() calls sdk.tools.list() which
// does not exist on @composio/core@0.10.0 (correct path is sdk.tools.getRawComposioTools).
// Tracked as a separate fix; for this round-trip test we use a static slug map.
const STATIC_TOOL_MAP: Record<string, string> = {
  'gmail:send_email': 'GMAIL_SEND_EMAIL',
}

// ─── Guard rails ─────────────────────────────────────────────────────────────
const APPROVE = process.env.KAIROS_LIVE_APPROVE === 'yes'
const MAX_ACTIONS = Number(process.env.KAIROS_LIVE_MAX_ACTIONS ?? 3)
const COOLDOWN_MS = Number(process.env.KAIROS_LIVE_COOLDOWN_SEC ?? 600) * 1000
const DURATION_MS = Number(process.env.KAIROS_LIVE_DURATION_MIN ?? 20) * 60 * 1000
const RECIPIENT = process.env.KAIROS_LIVE_RECIPIENT ?? 'nghinaiya81@gmail.com'
const ORGANIZER = process.env.KAIROS_LIVE_ORGANIZER ?? 'nghinaiya81@gmail.com'
const USER_ID = 'local'
const TRIGGER_SLUG = 'GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_CREATED_TRIGGER'

const apiKey = process.env.COMPOSIO_API_KEY
if (!apiKey) { console.error('✗ COMPOSIO_API_KEY not set in .env'); process.exit(1) }

console.log('═════════════════════════════════════════════════════════════')
console.log('  KAIROS Phase D — Reactive ROUND-TRIP live test')
console.log('═════════════════════════════════════════════════════════════')
console.log()
console.log(`  Mode:         ${APPROVE ? '🔴 REAL SEND (KAIROS_LIVE_APPROVE=yes)' : '🟢 DRY-RUN (default)'}`)
console.log(`  Recipient:    ${RECIPIENT}`)
console.log(`  Organizer:    ${ORGANIZER}  (rule filters on payload.organizer_email)`)
console.log(`  Max actions:  ${MAX_ACTIONS}`)
console.log(`  Cooldown:     ${COOLDOWN_MS / 1000}s`)
console.log(`  Duration cap: ${DURATION_MS / 60000} min`)
console.log()

const log = (tag: string, msg: string) => console.log(`  [${tag.padEnd(12)}] ${msg}`)

// ─── Boot Composio ───────────────────────────────────────────────────────────
log('boot', 'initializing ComposioClient...')
const composio = new ComposioClient({ apiKey })
const sdk: any = (composio as any).sdk

// Verify both Gmail + Calendar connected
log('boot', 'verifying gmail + googlecalendar connections...')
const accounts = await composio.listConnectedAccounts({ userId: USER_ID })
const gmailConn = accounts.find(a => String(a.toolkit_slug ?? '').toLowerCase() === 'gmail' && String(a.status ?? '').toLowerCase() === 'active')
const calConn = accounts.find(a => String(a.toolkit_slug ?? '').toLowerCase() === 'googlecalendar' && String(a.status ?? '').toLowerCase() === 'active')
if (!gmailConn) { console.error('✗ no active Gmail connection. Connect via the existing live-test script first.'); process.exit(1) }
if (!calConn) { console.error('✗ no active Google Calendar connection. Connect first.'); process.exit(1) }
log('boot', `✓ gmail account=${gmailConn.id}`)
log('boot', `✓ googlecalendar account=${calConn.id}`)

// ─── Static tool slug map (bypasses broken ComposioToolResolver) ─────────────
log('boot', `static tool map: ${JSON.stringify(STATIC_TOOL_MAP)}`)

// ─── Boot Phase D listener stack ─────────────────────────────────────────────
const db = new Database(':memory:')
const eventLog = new TriggerEventLog(db)
const metrics = new TriggerMetrics(db)
const normalizer = new TriggerNormalizer()

const schemaCache = new TriggerSchemaCache({
  composio: { sdk: { triggers: { getType: (slug: string) => sdk.triggers.getType(slug) } } } as any,
  slugsToLoad: [TRIGGER_SLUG],
})
await schemaCache.initialize()
normalizer.setToolkitLookup((slug: string) => schemaCache.getType(slug)?.toolkit ?? null)
log('boot', '✓ schemaCache initialized + normalizer wired to authoritative toolkit lookup')

const instanceMgr = new TriggerInstanceManager({
  db,
  composio: { triggers: { create: sdk.triggers.create.bind(sdk.triggers), listActive: sdk.triggers.listActive.bind(sdk.triggers), delete: sdk.triggers.delete.bind(sdk.triggers) } },
  userId: USER_ID,
})

// ─── Build the test rule ─────────────────────────────────────────────────────
const rule: Rule = {
  schema_version: 1,
  slug: 'live-roundtrip-test',
  when: { state: { incoming_event: { trigger: TRIGGER_SLUG } } },
  if: [`payload.organizer_email == "${ORGANIZER}"`],
  do: [
    {
      action: 'composio_tool',
      args: {
        toolkit: 'gmail',
        tool: 'send_email',
        args: {
          recipient_email: RECIPIENT,
          subject: '[KAIROS LIVE TEST] New calendar event detected',
          body: 'KAIROS reactive path fired end-to-end via Composio Pusher.\n\nEvent ID: ${payload.event_id}\nCalendar: ${payload.calendar_id}\nStart: ${payload.start_time}\nEnd: ${payload.end_time}\nOrganizer: ${payload.organizer_email}\n\n(This email was sent automatically by the live-test script.)',
        },
      },
    },
  ],
  cooldown_ms: COOLDOWN_MS,
  state: 'active',
  created_by: 'manual',
  created_at: Date.now(),
}

// ─── Minimal in-memory OrdersStore ────────────────────────────────────────────
const ruleState = new Map<string, { last_fired_at: number }>()
const store: any = {
  listActiveByWhenKind(kind: 'state' | 'event') {
    if (kind === 'state' && 'state' in rule.when) return [rule]
    return []
  },
  getState(slug: string) { return ruleState.get(slug) ?? null },
  recordFire(slug: string, now: number) { ruleState.set(slug, { last_fired_at: now }) },
}

// ─── ReactiveEvaluator + ActionDispatcher ────────────────────────────────────
const conditionEvaluator = new ConditionEvaluator()
const dryRunLoggerDb = new Database(':memory:')
const dryRunLogger = new DryRunLogger(dryRunLoggerDb as any)
const eventBus = new RulesEventBus()

// Action counter + kill switch
let actionsFired = 0

// Composio adapter for the dispatcher
const composioAdapter = {
  resolver: {
    resolveOrRefresh: async (toolkit: string, tool: string) =>
      STATIC_TOOL_MAP[`${toolkit.toLowerCase()}:${tool.toLowerCase()}`] ?? null,
  },
  executeTool: async (args: { toolName: string; userId: string; arguments: any }) => {
    actionsFired++
    log('composio', `📤 executeTool: ${args.toolName}`)
    log('composio', `   userId:    ${args.userId}`)
    log('composio', `   args:      ${JSON.stringify(args.arguments, null, 2).replace(/\n/g, '\n              ')}`)
    if (!APPROVE) {
      log('composio', '🟢 DRY-RUN: not actually calling Composio (set KAIROS_LIVE_APPROVE=yes to send)')
      return { dryRun: true }
    }
    log('composio', '🔴 REAL SEND: calling composio.executeTool (fixed wrapper)...')
    try {
      const result = await composio.executeTool({
        toolName: args.toolName,
        userId: args.userId,
        arguments: args.arguments,
      })
      log('composio', `✓ Composio response: ${JSON.stringify(result).slice(0, 300)}${JSON.stringify(result).length > 300 ? '…' : ''}`)
      return result
    } catch (err) {
      log('composio', `✗ SDK threw: ${err instanceof Error ? err.message : String(err)}`)
      throw err
    }
  },
  userId: USER_ID,
}

const dispatcher = new ActionDispatcher({
  intentRegistry: { get: () => null },
  skillDispatcher: { invoke: async () => ({ ok: false, error: 'no skills in this test', duration_ms: 0, sandbox: 'none' }) },
  composio: composioAdapter,
  eventBus,
})

const reactive = new ReactiveEvaluator({
  store,
  dispatcher,
  conditionEvaluator,
  dryRunLogger,
  getPersonaState: () => ({}),
})

// ─── Perception bus shim → routes to reactive ────────────────────────────────
const perceptionBus = {
  publish: (kind: string, payload: any) => {
    log('bus', `publish('${kind}', envelope event_id=${payload?.event_id ?? '?'})`)
    if (kind === 'incoming_event') {
      log('reactive', `handleEvent('incoming_event') — checking ${store.listActiveByWhenKind('state').length} state rule(s)`)
      void reactive.handleEvent('incoming_event', payload).then(() => {
        log('reactive', `evaluation complete (actionsFired=${actionsFired}/${MAX_ACTIONS})`)
        if (actionsFired >= MAX_ACTIONS) {
          log('killswitch', `🛑 MAX_ACTIONS=${MAX_ACTIONS} reached — initiating teardown`)
          void teardown('max actions reached').then(() => process.exit(0))
        }
      })
    }
  },
}

// ─── TriggerListener (real Pusher subscription) ──────────────────────────────
log('boot', 'starting TriggerListener (real Pusher)...')
const listener = new TriggerListener({
  apiKey,
  eventLog,
  normalizer,
  perceptionBus,
  metrics,
  onHealthChange: (h: any) => log('listener', `health → ${h}`),
})
await listener.start()
log('boot', '✓ TriggerListener subscribed')

// ─── Create the Composio Calendar trigger instance ───────────────────────────
log('boot', 'creating Composio trigger instance...')
let triggerId: string | null = null
try {
  triggerId = await instanceMgr.acquireForRule(rule.slug, TRIGGER_SLUG, {}, calConn.id)
  log('boot', `✓ trigger instance: ${triggerId}`)
} catch (err) {
  console.error('✗ failed to create trigger instance:', err)
  await listener.stop()
  process.exit(1)
}

// ─── Teardown ────────────────────────────────────────────────────────────────
let tearingDown = false
async function teardown(reason: string): Promise<void> {
  if (tearingDown) return
  tearingDown = true
  console.log()
  console.log('─── cleanup ─────────────────────────────────────────────────')
  log('teardown', `reason: ${reason}`)
  try { await listener.stop() } catch { /* swallow */ }
  log('teardown', '✓ listener stopped')
  if (triggerId) {
    try {
      await instanceMgr.releaseForRule(rule.slug, triggerId)
      log('teardown', `✓ trigger instance deleted: ${triggerId}`)
    } catch (e) { log('teardown', `⚠  delete failed: ${e}`) }
  }
  console.log()
  console.log('═════════════════════════════════════════════════════════════')
  console.log(`  Round-trip test complete. Actions fired: ${actionsFired}`)
  console.log(`  Mode: ${APPROVE ? 'REAL SEND' : 'DRY-RUN'}`)
  console.log('═════════════════════════════════════════════════════════════')
}

process.on('SIGINT', () => { void teardown('SIGINT').then(() => process.exit(0)) })
process.on('SIGTERM', () => { void teardown('SIGTERM').then(() => process.exit(0)) })

// ─── Run ────────────────────────────────────────────────────────────────────
console.log()
console.log('─── ready ────────────────────────────────────────────────────')
console.log()
console.log('  📅 Now add a Google Calendar event with YOU as organizer.')
console.log('     (Composio polls Calendar every ~5-15 min; be patient.)')
console.log()
console.log(`  Waiting up to ${DURATION_MS / 60000} min. Press Ctrl-C to stop sooner.`)
console.log()

// Heartbeat
const startedAt = Date.now()
const heartbeat = setInterval(() => {
  const left = Math.ceil((DURATION_MS - (Date.now() - startedAt)) / 60000)
  process.stdout.write(`\r  ⏱  ${left} min left | actions: ${actionsFired}/${MAX_ACTIONS} | health: ${listener.getHealth()}        `)
}, 5000)

await new Promise(r => setTimeout(r, DURATION_MS))
clearInterval(heartbeat)
console.log()
await teardown('duration cap')
process.exit(0)
