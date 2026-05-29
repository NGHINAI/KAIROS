// scripts/validate-phase-d.ts — Phase D validation gate.
// 20 assertions across the Composio Triggers subsystem.
// Run: bun run scripts/validate-phase-d.ts
// Exit 0 if all 20 PASS; 1 otherwise.

import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'

import { OrdersStore } from '../src/daemon/orders/v2/store'
import { OrdersParser } from '../src/daemon/orders/v2/parser'
import { OrdersAuthor } from '../src/daemon/orders/v2/author'
import { ReactiveEvaluator } from '../src/daemon/orders/v2/reactiveEvaluator'
import { ConditionEvaluator } from '../src/daemon/orders/v2/conditionEvaluator'
import { DryRunLogger } from '../src/daemon/orders/v2/dryRunLogger'
import { TriggerListener } from '../src/daemon/connectors/triggers/listener'
import { TriggerEventLog } from '../src/daemon/connectors/triggers/eventLog'
import { TriggerNormalizer } from '../src/daemon/connectors/triggers/normalizer'
import { TriggerInstanceManager } from '../src/daemon/connectors/triggers/instanceManager'
import { TriggerSchemaCache } from '../src/daemon/connectors/triggers/schemaCache'
import { TriggerMetrics } from '../src/daemon/connectors/triggers/metrics'
import { ConnectGuard } from '../src/daemon/connectors/triggers/connectGuard'

// ─── Result tracking ──────────────────────────────────────────────────────────

type AssertResult = { pass: boolean; note: string }
const results: AssertResult[] = []
function record(pass: boolean, note: string) { results.push({ pass, note }) }

// ─── Header ───────────────────────────────────────────────────────────────────

console.log('=== KAIROS Phase D Validation Gate ===')
console.log(`Started: ${new Date().toISOString()}`)
console.log()

const homeBase = mkdtempSync(join(tmpdir(), 'kairos-phase-d-'))

// ─── Fakes ────────────────────────────────────────────────────────────────────

function fakeComposioSDK() {
  const instances: any[] = []
  let pusherTriggerHandler: ((event: any) => void) | null = null
  let pusherDisconnected = false

  const fakePusher = {
    subscribe(_channelName: string) {
      const ch: any = { handlers: {} as Record<string, (data?: any) => void> }
      // Auto-succeed subscription
      setTimeout(() => ch.handlers['pusher:subscription_succeeded']?.(), 0)
      return {
        bind(event: string, handler: (data?: any) => void) {
          ch.handlers[event] = handler
          if (event === 'trigger_to_client') pusherTriggerHandler = handler
        },
      }
    },
    disconnect() { pusherDisconnected = true },
    connection: {
      bind(_event: string, _handler: any) {},
      state: 'connected',
    },
  }

  return {
    // Real Composio API shape (camelCase, positional create signature)
    triggers: {
      create: async (userId: string, slug: string, body?: any) => {
        const id = 'ti_' + Math.random().toString(36).slice(2, 8)
        instances.push({ triggerId: id, slug, userId, ...body })
        return { triggerId: id }
      },
      listActive: async () => ({ items: instances }),
      delete: async (id: string) => {
        const idx = instances.findIndex(i => i.triggerId === id)
        if (idx >= 0) instances.splice(idx, 1)
      },
    },
    // composio.sdk.triggers.getType — used by TriggerSchemaCache
    sdk: {
      triggers: {
        getType: async (slug: string) => ({
          slug,
          toolkit: { slug: slug.toLowerCase().split('_')[0] },
          config: {},
          payload: {},
          description: `${slug} trigger`,
        }),
      },
    },
    // Listener uses these injected dependencies (fetchCredentials + pusherFactory)
    fetchCredentials: async () => ({ pusherKey: 'pk-test', pusherCluster: 'mt1', projectId: 'proj-test' }),
    pusherFactory: async () => fakePusher,
    // test helper: deliver a raw event to the subscriber (bound to 'trigger_to_client')
    deliver: (e: any) => pusherTriggerHandler?.(e),
    instances,
    isSubscribed: () => pusherTriggerHandler !== null,
    isDisconnected: () => pusherDisconnected,
  } as any
}

function fakeRouter(seq: any[]) {
  let i = 0
  return {
    complete: async (_req: any) => ({ parsed: seq[Math.min(i++, seq.length - 1)] }),
  }
}

function fakeBus() {
  const subscribers: Array<(kind: string, payload: any) => void> = []
  const calls: any[] = []
  return {
    publish: (kind: string, payload: any) => {
      calls.push({ kind, payload })
      for (const s of subscribers) s(kind, payload)
    },
    subscribe: (handler: (kind: string, payload: any) => void) => { subscribers.push(handler) },
    calls,
  } as any
}

function fakeConnectionStore(connected: string[] = []) {
  return {
    listActive: (_uid: string) => connected.map(slug => ({ toolkit_slug: slug })),
  } as any
}

// ─── T+00:00 — Boot subsystem with fakes (2 assertions) ──────────────────────

const composio = fakeComposioSDK()
const db = new Database(':memory:')
const bus = fakeBus()
let listener: TriggerListener | null = null

try {
  const evtLog = new TriggerEventLog(db)
  const norm = new TriggerNormalizer()
  const metrics = new TriggerMetrics(db)
  listener = new TriggerListener({
    apiKey: 'ak-test',
    fetchCredentials: composio.fetchCredentials,
    pusherFactory: composio.pusherFactory,
    eventLog: evtLog,
    normalizer: norm,
    perceptionBus: bus,
    metrics,
  })
  await listener.start()
  record(true, 'T+00:00 listener started')
  record(composio.isSubscribed(), 'T+00:00 composio subscribed')
} catch (e) {
  record(false, 'T+00:00 boot: ' + (e instanceof Error ? e.message : e))
  record(false, 'T+00:00 composio subscribed: skipped')
}

// ─── T+00:05 — User speaks 3 rules (Slack, GitHub, Gmail) (3 assertions) ──────

const store = new OrdersStore(db)
const parser = new OrdersParser()
const filePath = join(homeBase, 'STANDING_ORDERS.md')
writeFileSync(filePath, '# KAIROS Standing Orders\n')

// TriggerSchemaCache expects { composio: { sdk: { triggers: { get_type } } } }
const schemaCache = new TriggerSchemaCache({
  composio: composio as any,
  cachePath: join(homeBase, 'schema-cache.json'),
})
await schemaCache.initialize()

const instanceManager = new TriggerInstanceManager({
  db,
  composio: composio as any,
  userId: 'local',
})

const connectGuard = new ConnectGuard({
  connectionStore: fakeConnectionStore(['slack', 'github', 'gmail']),
  connectionFlow: { link: async () => ({ url: 'https://composio/oauth' }) } as any,
  inbox: { add: () => {} } as any,
  nativeNotifier: { notify: async () => {} } as any,
  onConnectionComplete: () => {},
  userId: 'local',
})

const rulesToCreate = [
  {
    router: fakeRouter([{
      proposed_rule: {
        when: { state: { incoming_event: { trigger: 'SLACK_RECEIVE_MESSAGE' } } },
        do: [{ action: 'notify', args: { message: 'slack msg' } }],
      },
      slug_suggestion: 'r-slack',
      similar_existing: null,
      confidence: 1,
    }]),
    label: 'slack rule',
    slug: 'r-slack',
  },
  {
    router: fakeRouter([{
      proposed_rule: {
        when: { state: { incoming_event: { trigger: 'GITHUB_COMMIT_EVENT' } } },
        do: [{ action: 'notify', args: { message: 'gh commit' } }],
      },
      slug_suggestion: 'r-github',
      similar_existing: null,
      confidence: 1,
    }]),
    label: 'github rule',
    slug: 'r-github',
  },
  {
    router: fakeRouter([{
      proposed_rule: {
        when: { state: { incoming_event: { trigger: 'GMAIL_NEW_GMAIL_MESSAGE' } } },
        do: [{ action: 'notify', args: { message: 'new gmail' } }],
      },
      slug_suggestion: 'r-gmail',
      similar_existing: null,
      confidence: 1,
    }]),
    label: 'gmail rule',
    slug: 'r-gmail',
  },
]

for (const r of rulesToCreate) {
  try {
    const author = new OrdersAuthor({
      router: r.router as any,
      store,
      parser,
      filePath,
      schemaCache,
      instanceManager,
      connectGuard,
    })
    const result = await author.handleSpeech('notify me about ' + r.label)
    record(result.created_slug === r.slug, `T+00:05 ${r.label} compiled (slug=${result.created_slug})`)
  } catch (e) {
    record(false, `T+00:05 ${r.label}: ${e instanceof Error ? e.message : e}`)
  }
}

// ─── T+00:10 — Pusher delivers 3 matching events (3 assertions) ───────────────

const dispatchCalls: any[] = []
const evaluator = new ReactiveEvaluator({
  store,
  dispatcher: {
    dispatch: async (actions: any, ctx: any) => {
      dispatchCalls.push({ actions, ctx })
      return { ok: true }
    },
  } as any,
  conditionEvaluator: new ConditionEvaluator(),
  dryRunLogger: new DryRunLogger(store),
  getPersonaState: () => ({ is_in_meeting: false }),
})

// Wire bus → evaluator: bus publishes 'incoming_event', evaluator handles it
bus.subscribe((kind: string, payload: any) => {
  evaluator.handleEvent(kind, payload).catch(() => {})
})

// Flip the 3 rules from dry_run → active so they fire for real
for (const r of rulesToCreate) {
  const stored = store.get(r.slug)
  if (stored) {
    store.upsert({ ...stored, state: 'active', dry_run_until: undefined })
  }
}

const events = [
  { triggerSlug: 'SLACK_RECEIVE_MESSAGE', toolkitSlug: 'slack', id: 'e-slack-1', data: { channel: '#general' } },
  { triggerSlug: 'GITHUB_COMMIT_EVENT', toolkitSlug: 'github', id: 'e-gh-1', data: { repo: 'k/k' } },
  { triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE', toolkitSlug: 'gmail', id: 'e-gm-1', data: { from: 'x@y.z' } },
]

for (const e of events) {
  composio.deliver(e)
}
await new Promise(r => setTimeout(r, 150))

try {
  record(dispatchCalls.length === 3, `T+00:10 3 events fired (dispatches=${dispatchCalls.length})`)
  record(
    dispatchCalls.some(c => c.ctx.trigger?.trigger_slug === 'SLACK_RECEIVE_MESSAGE'),
    'T+00:10 slack event matched',
  )
  record(
    dispatchCalls.some(c => c.ctx.trigger?.trigger_slug === 'GMAIL_NEW_GMAIL_MESSAGE'),
    'T+00:10 gmail event matched',
  )
} catch (e) {
  record(false, 'T+00:10: ' + (e instanceof Error ? e.message : e))
  record(false, 'T+00:10 slack: skipped')
  record(false, 'T+00:10 gmail: skipped')
}

// ─── T+00:15 — Idempotent re-delivery suppressed (2 assertions) ───────────────

const dispatchCountBefore = dispatchCalls.length
// Re-deliver same event id
composio.deliver({ triggerSlug: 'SLACK_RECEIVE_MESSAGE', toolkitSlug: 'slack', id: 'e-slack-1', data: {} })
await new Promise(r => setTimeout(r, 80))

try {
  record(dispatchCalls.length === dispatchCountBefore, `T+00:15 duplicate did not re-fire (dispatches=${dispatchCalls.length}, before=${dispatchCountBefore})`)
  const rows = db.query(
    `SELECT COUNT(*) as n FROM composio_trigger_events WHERE toolkit = 'slack' AND event_id = 'e-slack-1'`,
  ).get() as any
  record(rows.n === 1, `T+00:15 eventLog deduped (rows=${rows.n})`)
} catch (e) {
  record(false, 'T+00:15: ' + (e instanceof Error ? e.message : e))
  record(false, 'T+00:15 eventLog deduped: skipped')
}

// ─── T+00:20 — Dry-run gate respected (2 assertions) ─────────────────────────

try {
  const dryRule = {
    schema_version: 1 as const,
    slug: 'r-dry',
    when: { state: { incoming_event: { trigger: 'NOTION_NEW_PAGE' } } } as any,
    do: [{ action: 'notify' as const, args: { message: 'dry notion' } }],
    state: 'dry_run' as const,
    dry_run_until: Date.now() + 60_000,
    created_by: 'manual' as const,
    created_at: Date.now(),
  }
  store.upsert(dryRule)
  const dispatchBefore = dispatchCalls.length
  composio.deliver({ triggerSlug: 'NOTION_NEW_PAGE', toolkitSlug: 'notion', id: 'e-dry-1', data: {} })
  await new Promise(r => setTimeout(r, 80))
  record(dispatchCalls.length === dispatchBefore, `T+00:20 dry-run did not dispatch live (before=${dispatchBefore}, after=${dispatchCalls.length})`)
  const dryLogs = store.listDryRunLog('r-dry')
  record(dryLogs.length === 1, `T+00:20 dry-run logged (logs=${dryLogs.length})`)
} catch (e) {
  record(false, 'T+00:20: ' + (e instanceof Error ? e.message : e))
  record(false, 'T+00:20 dry-run logged: skipped')
}

// ─── T+00:25 — Cooldown skips burst (2 assertions) ────────────────────────────

try {
  const cdRule = {
    schema_version: 1 as const,
    slug: 'r-cd',
    when: { state: { incoming_event: { trigger: 'LINEAR_ISSUE_UPDATED' } } } as any,
    do: [{ action: 'notify' as const, args: { message: 'linear' } }],
    state: 'active' as const,
    cooldown_ms: 60_000,
    created_by: 'manual' as const,
    created_at: Date.now(),
  }
  store.upsert(cdRule)
  const cdBefore = dispatchCalls.length
  composio.deliver({ triggerSlug: 'LINEAR_ISSUE_UPDATED', toolkitSlug: 'linear', id: 'e-cd-1', data: {} })
  await new Promise(r => setTimeout(r, 40))
  composio.deliver({ triggerSlug: 'LINEAR_ISSUE_UPDATED', toolkitSlug: 'linear', id: 'e-cd-2', data: {} })
  composio.deliver({ triggerSlug: 'LINEAR_ISSUE_UPDATED', toolkitSlug: 'linear', id: 'e-cd-3', data: {} })
  await new Promise(r => setTimeout(r, 80))
  // Only first fire allowed by cooldown
  record(dispatchCalls.length === cdBefore + 1, `T+00:25 cooldown skipped burst (fired=${dispatchCalls.length - cdBefore})`)
  const s = store.getState('r-cd')
  record(s?.fire_count === 1, `T+00:25 fire_count=${s?.fire_count}`)
} catch (e) {
  record(false, 'T+00:25: ' + (e instanceof Error ? e.message : e))
  record(false, 'T+00:25 fire_count: skipped')
}

// ─── T+00:30 — ConnectGuard for unconnected toolkit (2 assertions) ────────────

try {
  const inboxItems: any[] = []
  const notifs: any[] = []
  const guard = new ConnectGuard({
    connectionStore: fakeConnectionStore([]),  // nothing connected
    connectionFlow: { link: async () => ({ url: 'https://composio/oauth' }) } as any,
    inbox: { add: (item: any) => inboxItems.push(item) } as any,
    nativeNotifier: { notify: async (m: string) => { notifs.push(m) } } as any,
    onConnectionComplete: () => {},
    userId: 'local',
  })
  const out = await guard.ensureConnected('notion', 'rule-q')
  record(out === 'pending' && inboxItems.length === 1, `T+00:30 inbox surfaced (out=${out}, items=${inboxItems.length})`)
  record(notifs.length === 1, `T+00:30 native notif surfaced (notifs=${notifs.length})`)
} catch (e) {
  record(false, 'T+00:30: ' + (e instanceof Error ? e.message : e))
  record(false, 'T+00:30 native notif: skipped')
}

// ─── T+00:35 — Refcount: two rules share one instance (1 assertion) ───────────

try {
  const im2 = new TriggerInstanceManager({
    db: new Database(':memory:'),
    composio: composio as any,
    userId: 'local',
  })
  const id1 = await im2.acquireForRule('r1', 'X', { repo: 'r' }, 'ca_1')
  const id2 = await im2.acquireForRule('r2', 'X', { repo: 'r' }, 'ca_1')
  const instances = im2.listInstances()
  record(
    id1 === id2 && instances[0]?.rule_count === 2,
    `T+00:35 refcount (id1=id2: ${id1 === id2}, rc=${instances[0]?.rule_count})`,
  )
} catch (e) {
  record(false, 'T+00:35: ' + (e instanceof Error ? e.message : e))
}

// ─── T+00:40 — Reconcile-on-boot detects orphan (1 assertion) ────────────────

try {
  const composioForReconcile = fakeComposioSDK()
  const im3 = new TriggerInstanceManager({
    db: new Database(':memory:'),
    composio: composioForReconcile as any,
    userId: 'local',
  })
  await im3.acquireForRule('a', 'X', {}, 'ca_1')
  // Simulate remote deleted all instances
  composioForReconcile.triggers.listActive = async () => ({ items: [] })
  const report = await im3.reconcile()
  record(report.orphaned_local.length === 1, `T+00:40 orphan detected (n=${report.orphaned_local.length})`)
} catch (e) {
  record(false, 'T+00:40: ' + (e instanceof Error ? e.message : e))
}

// ─── T+00:45 — Health change to degraded (1 assertion) ────────────────────────

try {
  const healths: string[] = []
  const fakeLiveSDK = fakeComposioSDK()
  const liveListener = new TriggerListener({
    apiKey: 'ak-test',
    fetchCredentials: fakeLiveSDK.fetchCredentials,
    pusherFactory: fakeLiveSDK.pusherFactory,
    eventLog: new TriggerEventLog(new Database(':memory:')),
    normalizer: new TriggerNormalizer(),
    perceptionBus: fakeBus(),
    metrics: new TriggerMetrics(new Database(':memory:')),
    onHealthChange: (h: any) => healths.push(h),
  })
  await liveListener.start()
  // setHealth is private; cast to any to invoke it in the test
  ;(liveListener as any).setHealth('degraded')
  await liveListener.stop()
  record(healths.includes('degraded'), `T+00:45 health degraded fired (healths=${healths.join(',')})`)
} catch (e) {
  record(false, 'T+00:45: ' + (e instanceof Error ? e.message : e))
}

// ─── T+02:00 — Shutdown no leaks (1 assertion) ────────────────────────────────

try {
  if (listener) await listener.stop()
  record(true, 'T+02:00 listener stopped cleanly')
} catch (e) {
  record(false, 'T+02:00 stop: ' + (e instanceof Error ? e.message : e))
}

// ─── Report ───────────────────────────────────────────────────────────────────

const labels = [
  '[T+00:00] listener started',
  '[T+00:00] composio subscribed',
  '[T+00:05] slack rule compiled',
  '[T+00:05] github rule compiled',
  '[T+00:05] gmail rule compiled',
  '[T+00:10] 3 events fired',
  '[T+00:10] slack matched',
  '[T+00:10] gmail matched',
  '[T+00:15] duplicate not re-fired',
  '[T+00:15] eventLog deduped',
  '[T+00:20] dry-run skip dispatch',
  '[T+00:20] dry-run logged',
  '[T+00:25] cooldown skipped burst',
  '[T+00:25] fire_count = 1',
  '[T+00:30] inbox surfaced',
  '[T+00:30] native notif surfaced',
  '[T+00:35] refcount shared instance',
  '[T+00:40] orphan reconciled',
  '[T+00:45] health degraded fired',
  '[T+02:00] shutdown clean',
]

console.log()
for (let i = 0; i < results.length; i++) {
  const { pass, note } = results[i]!
  const status = pass ? 'PASS' : `FAIL: ${note}`
  const padded = `[${String(i + 1).padStart(2, '0')}/20] ${labels[i] ?? '(unlabeled)'}`.padEnd(56, '.')
  console.log(`${padded} ${status}`)
}

const allPass = results.every(r => r.pass)
const passCount = results.filter(r => r.pass).length
const failCount = results.filter(r => !r.pass).length

console.log()
console.log(`Summary: ${passCount} PASS, ${failCount} FAIL`)
console.log()
if (allPass) {
  console.log('=== Gate verdict: PASS ✓ ===')
} else {
  console.log('=== Gate verdict: FAIL ✗ ===')
  results.forEach((r, i) => {
    if (!r.pass) console.log(`  FAIL [${String(i + 1).padStart(2, '0')}/20]: ${r.note}`)
  })
}

try { rmSync(homeBase, { recursive: true, force: true }) } catch {}
process.exit(allPass ? 0 : 1)
