// scripts/validate-phase-c4-1.ts — Phase C.4.1 Validation Gate
// 14 assertions across the STANDING_ORDERS v2 subsystem.
// Run: bun run scripts/validate-phase-c4-1.ts. Exit 0 if all PASS.

import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'

import { OrdersParser } from '../src/daemon/orders/v2/parser'
import { OrdersStore } from '../src/daemon/orders/v2/store'
import { ReactiveEvaluator } from '../src/daemon/orders/v2/reactiveEvaluator'
import { ConditionEvaluator } from '../src/daemon/orders/v2/conditionEvaluator'
import { DryRunLogger } from '../src/daemon/orders/v2/dryRunLogger'
import { ScheduleAdapter } from '../src/daemon/orders/v2/scheduleAdapter'
import { ActionDispatcher } from '../src/daemon/orders/v2/actionDispatcher'
import { RulesEventBus } from '../src/daemon/orders/v2/eventBus'
import { OrdersAuthor } from '../src/daemon/orders/v2/author'
import { buildApprovalPrompt } from '../src/daemon/orders/v2/approvalPrompt'
import type { Rule } from '../src/daemon/orders/v2/types'

// ─── Result tracking ──────────────────────────────────────────────────────────

type AssertResult = { pass: boolean; note: string }
const results: AssertResult[] = []
function record(pass: boolean, note: string): AssertResult {
  const r = { pass, note }
  results.push(r)
  return r
}

// ─── Header ───────────────────────────────────────────────────────────────────

console.log('=== KAIROS Phase C.4.1 Validation Gate ===')
console.log(`Started: ${new Date().toISOString()}`)
console.log()

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir(n: string): string {
  return mkdtempSync(join(tmpdir(), `kairos-c41-${n}-`))
}

function fakeIntentRegistry() {
  const calls: any[] = []
  return {
    reg: {
      get: (id: string) => ({
        handler: async (args: any) => { calls.push({ id, args }); return { status: 'success' as const, details: 'ok' } },
      }),
    },
    calls,
  }
}

function fakeSkillDispatcher() {
  const calls: any[] = []
  return {
    dispatcher: {
      invoke: async (slug: string, args: any) => {
        calls.push({ slug, args })
        return { ok: true, output: 'fake-' + slug, duration_ms: 1, sandbox: 'declarative' as const }
      },
    },
    calls,
  }
}

function fakeComposio() {
  return {
    invokeTool: async (_toolkit: string, _tool: string, _args: any) => ({ ok: true, output: 'composio-ok' }),
  }
}

function makeValidRule(slug: string, overrides: Partial<Rule> = {}): Rule {
  return {
    schema_version: 1,
    slug,
    when: { state: { clipboard: { contains: 'urgent' } } },
    do: [{ action: 'notify', args: { message: 'matched' } }],
    state: 'active',
    created_by: 'manual',
    created_at: Date.now(),
    ...overrides,
  }
}

// ─── [1/14] OrdersParser — valid accept + 3 invalid rejections ───────────────

try {
  const parser = new OrdersParser()

  // Valid rule
  const validText = `## my-rule
---
schema_version: 1
when:
  cron: "0 9 * * 1-5"
do:
  - action: notify
    args:
      message: "standup time"
state: active
created_by: manual
created_at: 2026-05-28T10:00:00Z
---
Brief description.
`
  const validResult = parser.parseString(validText)
  const validAccepted = validResult.rules.length === 1 && validResult.errors.length === 0 && validResult.rules[0]!.slug === 'my-rule'

  // Bad slug (uppercase letters)
  const badSlugText = `## BadSlug
---
schema_version: 1
when:
  event: foo
do:
  - action: log
    args:
      message: x
state: active
created_by: manual
created_at: 2026-05-28T10:00:00Z
---
`
  const badSlugResult = parser.parseString(badSlugText)
  // Parser header regex only allows lowercase; bad slug is either skipped or errors
  const badSlugRejected = badSlugResult.rules.length === 0

  // Multi-when (both cron and event)
  const multiWhenText = `## x
---
schema_version: 1
when:
  cron: "* * * * *"
  event: foo
do:
  - action: log
    args:
      message: x
state: active
created_by: manual
created_at: 2026-05-28T10:00:00Z
---
`
  const multiWhenResult = parser.parseString(multiWhenText)
  const multiWhenRejected = multiWhenResult.rules.length === 0 && multiWhenResult.errors.length > 0

  // Unknown schema_version
  const badVersionText = `## x
---
schema_version: 99
when:
  event: foo
do:
  - action: log
    args:
      message: x
state: active
created_by: manual
created_at: 2026-05-28T10:00:00Z
---
`
  const badVersionResult = parser.parseString(badVersionText)
  const badVersionRejected = badVersionResult.rules.length === 0 && badVersionResult.errors.length > 0

  if (validAccepted && badSlugRejected && multiWhenRejected && badVersionRejected) {
    record(true, `valid rule accepted (slug=my-rule); bad slug rejected; multi-when rejected (${multiWhenResult.errors[0]?.error?.slice(0, 40)}); bad schema_version rejected`)
  } else {
    const failures = [
      !validAccepted && `valid rule not accepted: rules=${validResult.rules.length}, errors=${validResult.errors.length}`,
      !badSlugRejected && `bad slug not rejected: rules=${badSlugResult.rules.length}`,
      !multiWhenRejected && `multi-when not rejected: rules=${multiWhenResult.rules.length}, errors=${multiWhenResult.errors.length}`,
      !badVersionRejected && `bad schema_version not rejected: rules=${badVersionResult.rules.length}, errors=${badVersionResult.errors.length}`,
    ].filter(Boolean).join('; ')
    record(false, failures)
  }
} catch (err) {
  record(false, `OrdersParser test threw: ${err instanceof Error ? err.message : err}`)
}

// ─── [2/14] OrdersStore — upsert + replaceAll + get round-trip ───────────────

try {
  const db = new Database(':memory:')
  const store = new OrdersStore(db)

  const r1 = makeValidRule('rule-a', { when: { cron: '0 9 * * *' } })
  const r2 = makeValidRule('rule-b', { when: { event: 'foo' } })

  store.upsert(r1)
  store.upsert(r2)

  const gotA = store.get('rule-a')
  const gotB = store.get('rule-b')
  const getOk = gotA?.slug === 'rule-a' && gotB?.slug === 'rule-b'

  // replaceAll with only r1 — r2 should be removed
  const r1Updated = { ...r1, state: 'dry_run' as const }
  store.replaceAll([r1Updated])

  const afterA = store.get('rule-a')
  const afterB = store.get('rule-b')
  const replaceAllOk = afterA?.state === 'dry_run' && afterB === null

  const all = store.listAll()
  const listAllOk = all.length === 1 && all[0]!.slug === 'rule-a'

  if (getOk && replaceAllOk && listAllOk) {
    record(true, `upsert 2 rules; get round-trips correctly; replaceAll updated rule-a state=dry_run and removed rule-b; listAll=1`)
  } else {
    const failures = [
      !getOk && `get failed: gotA.slug=${gotA?.slug}, gotB.slug=${gotB?.slug}`,
      !replaceAllOk && `replaceAll failed: afterA.state=${afterA?.state}, afterB=${afterB}`,
      !listAllOk && `listAll failed: length=${all.length}`,
    ].filter(Boolean).join('; ')
    record(false, failures)
  }
} catch (err) {
  record(false, `OrdersStore test threw: ${err instanceof Error ? err.message : err}`)
}

// ─── [3/14] ReactiveEvaluator — clipboard rule fires on matching event ────────

try {
  const db = new Database(':memory:')
  const store = new OrdersStore(db)
  const dispatcherCalls: any[] = []
  const fakeDispatch = {
    dispatch: async (actions: any, ctx: any) => { dispatcherCalls.push({ actions, ctx }); return { ok: true } },
  }

  const evaluator = new ReactiveEvaluator({
    store,
    dispatcher: fakeDispatch,
    conditionEvaluator: new ConditionEvaluator(),
    dryRunLogger: new DryRunLogger(store),
    getPersonaState: () => ({ is_in_meeting: false }),
  })

  const rule = makeValidRule('clip-urgent', { when: { state: { clipboard: { contains: 'urgent' } } } })
  store.upsert(rule)

  // Matching event — should fire
  await evaluator.handleEvent('clipboard', { text: 'urgent fix needed' })
  const firedOnMatch = dispatcherCalls.length === 1

  // Non-matching event — should not fire
  await evaluator.handleEvent('clipboard', { text: 'hello world' })
  const noExtraFire = dispatcherCalls.length === 1

  if (firedOnMatch && noExtraFire) {
    record(true, `clipboard event "urgent fix needed" fired the rule; "hello world" was skipped; dispatcher called 1x total`)
  } else {
    const failures = [
      !firedOnMatch && `expected 1 dispatch call after matching event, got ${dispatcherCalls.length}`,
      !noExtraFire && `expected no extra fire after non-matching event, total calls=${dispatcherCalls.length}`,
    ].filter(Boolean).join('; ')
    record(false, failures)
  }
} catch (err) {
  record(false, `ReactiveEvaluator clipboard test threw: ${err instanceof Error ? err.message : err}`)
}

// ─── [4/14] ReactiveEvaluator — unless persona.is_in_meeting skips rule ───────

try {
  const db = new Database(':memory:')
  const store = new OrdersStore(db)
  const dispatcherCalls: any[] = []
  const fakeDispatch = {
    dispatch: async (actions: any, ctx: any) => { dispatcherCalls.push({ actions, ctx }); return { ok: true } },
  }

  const evaluator = new ReactiveEvaluator({
    store,
    dispatcher: fakeDispatch,
    conditionEvaluator: new ConditionEvaluator(),
    dryRunLogger: new DryRunLogger(store),
    getPersonaState: () => ({ is_in_meeting: true }),
  })

  const rule = makeValidRule('clip-unless', {
    when: { state: { clipboard: { contains: 'urgent' } } },
    unless: ['persona.is_in_meeting'],
  })
  store.upsert(rule)

  await evaluator.handleEvent('clipboard', { text: 'urgent thing' })
  const skipped = dispatcherCalls.length === 0

  if (skipped) {
    record(true, `rule with unless: persona.is_in_meeting correctly skipped when persona.is_in_meeting=true; dispatcher not called`)
  } else {
    record(false, `expected 0 dispatcher calls but got ${dispatcherCalls.length}`)
  }
} catch (err) {
  record(false, `ReactiveEvaluator unless test threw: ${err instanceof Error ? err.message : err}`)
}

// ─── [5/14] ScheduleAdapter — at: "in 1 second" fires within 1500ms ──────────

try {
  const db = new Database(':memory:')
  const store = new OrdersStore(db)
  const fired: string[] = []

  const adapter = new ScheduleAdapter({
    store,
    onFire: async (rule, _ctx) => { fired.push(rule.slug) },
  })

  const rule: Rule = {
    schema_version: 1,
    slug: 'instant-fire',
    when: { at: 'in 1 second' },
    do: [{ action: 'log', args: { message: 'x' } }],
    state: 'active',
    created_by: 'manual',
    created_at: Date.now(),
  }
  store.upsert(rule)
  adapter.register(rule)

  await new Promise(res => setTimeout(res, 1500))
  adapter.stopAll()

  const didFire = fired.includes('instant-fire')
  if (didFire) {
    record(true, `at: "in 1 second" fired within 1500ms; slug=instant-fire in fired array`)
  } else {
    record(false, `at: "in 1 second" did not fire within 1500ms; fired=[${fired.join(', ')}]`)
  }
} catch (err) {
  record(false, `ScheduleAdapter at: test threw: ${err instanceof Error ? err.message : err}`)
}

// ─── [6/14] ScheduleAdapter — cron registration does not throw ───────────────

try {
  const db = new Database(':memory:')
  const store = new OrdersStore(db)
  const adapter = new ScheduleAdapter({
    store,
    onFire: async (_rule, _ctx) => {},
  })

  const rule: Rule = {
    schema_version: 1,
    slug: 'every-minute',
    when: { cron: '* * * * *' },
    do: [{ action: 'log', args: { message: 'tick' } }],
    state: 'active',
    created_by: 'manual',
    created_at: Date.now(),
  }
  store.upsert(rule)

  let threw = false
  try {
    adapter.register(rule)
  } catch {
    threw = true
  }

  const registered = adapter.registeredSlugs().includes('every-minute')
  adapter.stopAll()

  if (!threw && registered) {
    record(true, `cron "* * * * *" registered without throwing; slug appears in registeredSlugs()`)
  } else {
    const failures = [
      threw && 'register threw an error',
      !registered && `slug not in registeredSlugs: [${adapter.registeredSlugs().join(', ')}]`,
    ].filter(Boolean).join('; ')
    record(false, failures)
  }
} catch (err) {
  record(false, `ScheduleAdapter cron test threw: ${err instanceof Error ? err.message : err}`)
}

// ─── [7/14] ActionDispatcher — routes invoke_skill to fake skill dispatcher ───

try {
  const skl = fakeSkillDispatcher()
  const reg = fakeIntentRegistry()
  const bus = new RulesEventBus()

  const dispatcher = new ActionDispatcher({
    intentRegistry: reg.reg as any,
    skillDispatcher: skl.dispatcher as any,
    composio: fakeComposio() as any,
    eventBus: bus,
  })

  const result = await dispatcher.dispatch(
    [{ action: 'invoke_skill', args: { slug: 'my-cool-skill', args: { x: 1 } } }],
    { trigger: {} },
  )

  const okOk = result.ok === true
  const skillCalled = skl.calls.length === 1 && skl.calls[0]?.slug === 'my-cool-skill'
  const argsOk = skl.calls[0]?.args?.x === 1
  const outputOk = result.output !== undefined

  if (okOk && skillCalled && argsOk && outputOk) {
    record(true, `invoke_skill routed to fake skill dispatcher; ok=true; slug=my-cool-skill; args={x:1}; output present`)
  } else {
    const failures = [
      !okOk && `result.ok=${result.ok}, error=${result.error}`,
      !skillCalled && `skill calls: ${JSON.stringify(skl.calls)}`,
      !argsOk && `args: ${JSON.stringify(skl.calls[0]?.args)}`,
      !outputOk && 'output was undefined',
    ].filter(Boolean).join('; ')
    record(false, failures)
  }
} catch (err) {
  record(false, `ActionDispatcher invoke_skill test threw: ${err instanceof Error ? err.message : err}`)
}

// ─── [8/14] ActionDispatcher — emit_event chains into ReactiveEvaluator ───────

try {
  const db = new Database(':memory:')
  const store = new OrdersStore(db)
  const condEval = new ConditionEvaluator()
  const dryLog = new DryRunLogger(store)
  const bus = new RulesEventBus()

  // Downstream rule: fires when event "order-classified" is emitted
  const downstreamCalls: any[] = []
  const downstreamDispatch = {
    dispatch: async (actions: any, ctx: any) => { downstreamCalls.push({ actions, ctx }); return { ok: true } },
  }
  const reactiveEval = new ReactiveEvaluator({
    store,
    dispatcher: downstreamDispatch,
    conditionEvaluator: condEval,
    dryRunLogger: dryLog,
    getPersonaState: () => ({}),
  })

  // Register the event listener so RulesEventBus feeds ReactiveEvaluator
  bus.on('order-classified', (payload) => {
    reactiveEval.handleEvent('event', { name: 'order-classified', payload })
  })

  // Downstream rule stored in DB
  const downstreamRule: Rule = {
    schema_version: 1, slug: 'on-classified',
    when: { event: 'order-classified' },
    do: [{ action: 'notify', args: { message: 'classified' } }],
    state: 'active', created_by: 'manual', created_at: Date.now(),
  }
  store.upsert(downstreamRule)

  // ActionDispatcher that will emit the event
  const reg = fakeIntentRegistry()
  const skl = fakeSkillDispatcher()
  const dispatcher = new ActionDispatcher({
    intentRegistry: reg.reg as any,
    skillDispatcher: skl.dispatcher as any,
    composio: fakeComposio() as any,
    eventBus: bus,
  })

  // Dispatch emit_event action
  await dispatcher.dispatch(
    [{ action: 'emit_event', args: { name: 'order-classified', payload: { importance: 'high' } } }],
    { trigger: {} },
  )

  // Give the async chain a tick to settle
  await new Promise(res => setTimeout(res, 10))

  const eventEmitted = bus.listenerCount('order-classified') >= 1
  const downstreamFired = downstreamCalls.length >= 1

  if (eventEmitted && downstreamFired) {
    record(true, `emit_event dispatched; bus has listener; downstream rule "on-classified" fired; downstreamCalls=${downstreamCalls.length}`)
  } else {
    const failures = [
      !eventEmitted && `bus has no listeners for "order-classified"`,
      !downstreamFired && `downstream rule did not fire; downstreamCalls=${downstreamCalls.length}`,
    ].filter(Boolean).join('; ')
    record(false, failures)
  }
} catch (err) {
  record(false, `ActionDispatcher emit_event chain test threw: ${err instanceof Error ? err.message : err}`)
}

// ─── [9/14] ConditionEvaluator — predicates ──────────────────────────────────

try {
  const ev = new ConditionEvaluator()

  // persona.X == "Y"
  const personaEq = ev.evaluate('persona.role == "admin"', { persona: { role: 'admin' } })
  const personaNeq = ev.evaluate('persona.role == "admin"', { persona: { role: 'user' } })

  // payload.X > 5
  const payloadGt = ev.evaluate('payload.score > 5', { payload: { score: 10 } })
  const payloadGtFail = ev.evaluate('payload.score > 5', { payload: { score: 3 } })

  // time.between("22:00","07:00") — wrap-around midnight window
  // Use a fixed "now" at 23:00 (should be in the window)
  const midnight23h = new Date()
  midnight23h.setHours(23, 0, 0, 0)
  const inWindow = ev.evaluate('time.between("22:00","07:00")', { now: midnight23h.getTime() })

  // Use a fixed "now" at 12:00 (should NOT be in the window)
  const noon = new Date()
  noon.setHours(12, 0, 0, 0)
  const outWindow = ev.evaluate('time.between("22:00","07:00")', { now: noon.getTime() })

  if (personaEq && !personaNeq && payloadGt && !payloadGtFail && inWindow && !outWindow) {
    record(true, `persona.role=="admin" → true/false OK; payload.score>5 → true/false OK; time.between("22:00","07:00") at 23h=true, at 12h=false`)
  } else {
    const failures = [
      !personaEq && 'persona.role=="admin" returned false (expected true)',
      personaNeq && 'persona.role=="admin" returned true with role=user (expected false)',
      !payloadGt && 'payload.score>5 returned false with score=10 (expected true)',
      payloadGtFail && 'payload.score>5 returned true with score=3 (expected false)',
      !inWindow && 'time.between("22:00","07:00") returned false at 23h (expected true)',
      outWindow && 'time.between("22:00","07:00") returned true at 12h (expected false)',
    ].filter(Boolean).join('; ')
    record(false, failures)
  }
} catch (err) {
  record(false, `ConditionEvaluator test threw: ${err instanceof Error ? err.message : err}`)
}

// ─── [10/14] Dry-run rule fires to dry_run log instead of dispatching ─────────

try {
  const db = new Database(':memory:')
  const store = new OrdersStore(db)
  const dispatcherCalls: any[] = []
  const fakeDispatch = {
    dispatch: async (actions: any, ctx: any) => { dispatcherCalls.push({ actions, ctx }); return { ok: true } },
  }

  const now = Date.now()
  const evaluator = new ReactiveEvaluator({
    store,
    dispatcher: fakeDispatch,
    conditionEvaluator: new ConditionEvaluator(),
    dryRunLogger: new DryRunLogger(store),
    getPersonaState: () => ({}),
    nowFn: () => now,
  } as any)

  const dryRule: Rule = {
    schema_version: 1, slug: 'dry-rule',
    when: { state: { clipboard: { contains: 'test' } } },
    do: [{ action: 'notify', args: { message: 'dry fire' } }],
    state: 'dry_run',
    dry_run_until: now + 60_000,   // still in dry-run window
    created_by: 'voice',
    created_at: now,
  }
  store.upsert(dryRule)

  await evaluator.handleEvent('clipboard', { text: 'test message' })

  const noRealDispatch = dispatcherCalls.length === 0
  const dryLogs = store.listDryRunLog('dry-rule')
  const dryLogged = dryLogs.length === 1
  const dryStateOk = store.getState('dry-rule') !== null

  if (noRealDispatch && dryLogged) {
    record(true, `dry-run rule did not dispatch; logged 1 dry-run entry; slug=dry-rule in orders_dry_run_log`)
  } else {
    const failures = [
      !noRealDispatch && `unexpected real dispatch: ${dispatcherCalls.length} calls`,
      !dryLogged && `dry-run log has ${dryLogs.length} entries (expected 1)`,
    ].filter(Boolean).join('; ')
    record(false, failures)
  }
} catch (err) {
  record(false, `Dry-run test threw: ${err instanceof Error ? err.message : err}`)
}

// ─── [11/14] buildApprovalPrompt aggregates dry-run fires ────────────────────

try {
  const db = new Database(':memory:')
  const store = new OrdersStore(db)
  const dryLogger = new DryRunLogger(store)

  const now = Date.now()
  const rule: Rule = {
    schema_version: 1, slug: 'ap-rule',
    when: { state: { clipboard: { contains: 'x' } } },
    do: [{ action: 'notify', args: { message: 'ap fire' } }],
    state: 'dry_run',
    dry_run_until: now - 1,   // dry-run window has just expired
    created_by: 'voice',
    created_at: now - 48 * 60 * 60 * 1000,
  }
  store.upsert(rule)

  // Simulate 3 dry-run fires
  const actions = rule.do
  const ctx = { trigger: { text: 'x' } }
  for (let i = 0; i < 3; i++) {
    dryLogger.logFire(rule, actions, ctx, now - (3 - i) * 60_000)
  }

  const prompt = buildApprovalPrompt(rule, dryLogger, now)

  const titleOk = prompt.title.includes('ap-rule') && prompt.title.includes('dry-run')
  const bodyOk = prompt.body.includes('3')
  const actionsOk = prompt.actions.includes('approve') && prompt.actions.includes('reject') && prompt.actions.includes('tune')
  const slugOk = prompt.slug === 'ap-rule'

  if (titleOk && bodyOk && actionsOk && slugOk) {
    record(true, `buildApprovalPrompt: slug=ap-rule; title mentions dry-run; body contains "3"; actions=[approve,reject,tune]`)
  } else {
    const failures = [
      !titleOk && `title="${prompt.title}" (expected slug + dry-run)`,
      !bodyOk && `body="${prompt.body?.slice(0, 80)}" does not contain "3"`,
      !actionsOk && `actions=${JSON.stringify(prompt.actions)} missing expected values`,
      !slugOk && `slug=${prompt.slug} (expected ap-rule)`,
    ].filter(Boolean).join('; ')
    record(false, failures)
  }
} catch (err) {
  record(false, `buildApprovalPrompt test threw: ${err instanceof Error ? err.message : err}`)
}

// ─── [12/14] Cooldown enforcement — fires once, re-evaluate skips ─────────────

try {
  const db = new Database(':memory:')
  const store = new OrdersStore(db)
  const dispatcherCalls: any[] = []
  const fakeDispatch = {
    dispatch: async (actions: any, ctx: any) => { dispatcherCalls.push({ actions, ctx }); return { ok: true } },
  }

  const evaluator = new ReactiveEvaluator({
    store,
    dispatcher: fakeDispatch,
    conditionEvaluator: new ConditionEvaluator(),
    dryRunLogger: new DryRunLogger(store),
    getPersonaState: () => ({}),
  })

  const rule = makeValidRule('cooldown-rule', {
    when: { state: { clipboard: { contains: 'ping' } } },
    cooldown_ms: 60_000,   // 60 second cooldown
  })
  store.upsert(rule)

  // First fire — should dispatch
  await evaluator.handleEvent('clipboard', { text: 'ping' })
  const firstFired = dispatcherCalls.length === 1

  // Immediate re-evaluate — should be blocked by cooldown
  await evaluator.handleEvent('clipboard', { text: 'ping again' })
  const secondBlocked = dispatcherCalls.length === 1

  // Verify fire_count in store
  const state = store.getState('cooldown-rule')
  const fireCountOk = state?.fire_count === 1

  if (firstFired && secondBlocked && fireCountOk) {
    record(true, `first fire dispatched (fire_count=1); immediate re-fire blocked by 60s cooldown; dispatcher called 1x total`)
  } else {
    const failures = [
      !firstFired && `first fire: dispatcherCalls=${dispatcherCalls.length} (expected 1)`,
      !secondBlocked && `cooldown not enforced: dispatcherCalls=${dispatcherCalls.length} after second event`,
      !fireCountOk && `fire_count=${state?.fire_count} (expected 1)`,
    ].filter(Boolean).join('; ')
    record(false, failures)
  }
} catch (err) {
  record(false, `Cooldown enforcement test threw: ${err instanceof Error ? err.message : err}`)
}

// ─── [13/14] OrdersAuthor — speech → rule round trip ─────────────────────────

try {
  const tmp = makeTempDir('13')
  const filePath = join(tmp, 'STANDING_ORDERS.md')
  const db = new Database(':memory:')
  const store = new OrdersStore(db)
  const parser = new OrdersParser()

  const fakeRouterResponse = {
    proposed_rule: {
      when: { cron: '0 9 * * 1' },
      do: [{ action: 'notify', args: { message: 'send standup' } }],
    },
    slug_suggestion: 'monday-standup',
    similar_existing: null,
    confidence: 0.9,
  }

  const fakeRouter = {
    async complete(_req: any) {
      return { parsed: fakeRouterResponse, text: JSON.stringify(fakeRouterResponse) } as any
    },
  }

  const author = new OrdersAuthor({ router: fakeRouter as any, store, parser, filePath })
  const result = await author.handleSpeech('remind me every Monday at 9am to send the standup')

  const slugOk = result.created_slug === 'monday-standup'
  const noError = !result.error

  // Verify file was written with a valid rule block
  const fileContent = existsSync(filePath) ? readFileSync(filePath, 'utf8') : ''
  const fileHasSlug = fileContent.includes('## monday-standup')
  const fileHasFrontmatter = fileContent.includes('schema_version:')
  const fileHasDryRun = fileContent.includes('state: dry_run')

  // Verify store contains the new rule
  const storedRule = store.get('monday-standup')
  const storeOk = storedRule?.slug === 'monday-standup' && storedRule.state === 'dry_run' && storedRule.created_by === 'voice'

  // Verify the file can be re-parsed
  const reparsed = parser.parseFile(filePath)
  const reparsedOk = reparsed.rules.some(r => r.slug === 'monday-standup')

  if (slugOk && noError && fileHasSlug && fileHasFrontmatter && fileHasDryRun && storeOk && reparsedOk) {
    record(true, `OrdersAuthor speech→file→store round-trip; created_slug=monday-standup; file has frontmatter; state=dry_run; re-parse succeeds`)
  } else {
    const failures = [
      !slugOk && `created_slug=${result.created_slug} (expected monday-standup)`,
      !noError && `error=${result.error}`,
      !fileHasSlug && 'file missing ## monday-standup',
      !fileHasFrontmatter && 'file missing schema_version',
      !fileHasDryRun && 'file missing state: dry_run',
      !storeOk && `store: slug=${storedRule?.slug}, state=${storedRule?.state}, created_by=${storedRule?.created_by}`,
      !reparsedOk && `re-parse failed; found slugs=[${reparsed.rules.map(r => r.slug).join(',')}], errors=[${reparsed.errors.map(e => e.error).join(';')}]`,
    ].filter(Boolean).join('; ')
    record(false, failures)
  }
} catch (err) {
  record(false, `OrdersAuthor speech→rule test threw: ${err instanceof Error ? err.message : err}`)
}

// ─── [14/14] End-to-end: speech → file → parse → store → reactive fire ───────

try {
  const tmp = makeTempDir('14')
  const filePath = join(tmp, 'STANDING_ORDERS.md')
  const db = new Database(':memory:')
  const store = new OrdersStore(db)
  const parser = new OrdersParser()

  // Step 1: OrdersAuthor — fake router produces a clipboard-triggered rule (active, not dry-run)
  const e2eRouterResponse = {
    proposed_rule: {
      when: { state: { clipboard: { contains: 'e2e-test' } } },
      do: [{ action: 'invoke_skill', args: { slug: 'handle-clipboard', args: {} } }],
    },
    slug_suggestion: 'e2e-clipboard-handler',
    similar_existing: null,
    confidence: 1.0,
  }
  const fakeRouter = {
    async complete(_req: any) {
      return { parsed: e2eRouterResponse, text: JSON.stringify(e2eRouterResponse) } as any
    },
  }
  const author = new OrdersAuthor({ router: fakeRouter as any, store, parser, filePath })
  const authorResult = await author.handleSpeech('whenever I copy something with e2e-test run handle-clipboard')

  const authorOk = authorResult.created_slug !== null && !authorResult.error

  // Step 2: Re-parse the file the Author just wrote
  const reparsed = parser.parseFile(filePath)
  const parsedRule = reparsed.rules.find(r => r.slug === authorResult.created_slug!)
  const parseOk = parsedRule !== undefined

  // Step 3: Override the parsed rule in the store so it is ACTIVE (not dry_run) — so reactive evaluator will dispatch
  if (parsedRule) {
    const activeRule = { ...parsedRule, state: 'active' as const, dry_run_until: undefined }
    store.upsert(activeRule)
  }

  // Step 4: Wire up ActionDispatcher + ReactiveEvaluator with fake skill dispatcher
  const skl = fakeSkillDispatcher()
  const reg = fakeIntentRegistry()
  const bus = new RulesEventBus()

  const actionDispatcher = new ActionDispatcher({
    intentRegistry: reg.reg as any,
    skillDispatcher: skl.dispatcher as any,
    composio: fakeComposio() as any,
    eventBus: bus,
  })

  const reactiveEvaluator = new ReactiveEvaluator({
    store,
    dispatcher: actionDispatcher,
    conditionEvaluator: new ConditionEvaluator(),
    dryRunLogger: new DryRunLogger(store),
    getPersonaState: () => ({}),
  })

  // Step 5: Fire a clipboard event that should trigger the rule
  await reactiveEvaluator.handleEvent('clipboard', { text: 'e2e-test payload here' })

  // Step 6: Verify fake skill dispatcher was called
  const skillCalled = skl.calls.length >= 1 && skl.calls[0]?.slug === 'handle-clipboard'
  const ruleStateOk = store.getState(authorResult.created_slug!)?.fire_count === 1

  if (authorOk && parseOk && skillCalled && ruleStateOk) {
    record(true, `E2E: speech → author wrote file (slug=${authorResult.created_slug}); file re-parsed OK; store activated; clipboard event fired → invoke_skill dispatched to fake skill; fire_count=1`)
  } else {
    const failures = [
      !authorOk && `author failed: created_slug=${authorResult.created_slug}, error=${authorResult.error}`,
      !parseOk && `file re-parse failed; rules=[${reparsed.rules.map(r => r.slug).join(',')}], errors=[${reparsed.errors.map(e => e.error).join(';')}]`,
      !skillCalled && `skill dispatcher not called (calls=${skl.calls.length}); calls=${JSON.stringify(skl.calls)}`,
      !ruleStateOk && `fire_count=${store.getState(authorResult.created_slug!)?.fire_count} (expected 1)`,
    ].filter(Boolean).join('; ')
    record(false, failures)
  }
} catch (err) {
  record(false, `End-to-end test threw: ${err instanceof Error ? err.message : err}`)
}

// ─── Report ───────────────────────────────────────────────────────────────────

const labels = [
  'OrdersParser valid+invalid',
  'OrdersStore upsert+replaceAll',
  'ReactiveEvaluator clipboard fire',
  'ReactiveEvaluator unless persona.is_in_meeting',
  'ScheduleAdapter at: 1s fires',
  'ScheduleAdapter cron registration',
  'ActionDispatcher → invoke_skill',
  'ActionDispatcher → emit_event chain',
  'ConditionEvaluator predicates',
  'Dry-run logs instead of dispatches',
  'ApprovalPrompt aggregates dry-run fires',
  'Cooldown skips re-fire',
  'OrdersAuthor speech→rule',
  'End-to-end speech→fire',
]

console.log()
for (let i = 0; i < results.length; i++) {
  const { pass, note } = results[i]!
  const status = pass ? 'PASS' : `FAIL: ${note}`
  const padded = `[${String(i + 1).padStart(2, '0')}/14] ${labels[i]}`.padEnd(56, '.')
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
    if (!r.pass) console.log(`  FAIL [${String(i + 1).padStart(2, '0')}/14]: ${r.note}`)
  })
}

process.exit(allPass ? 0 : 1)
