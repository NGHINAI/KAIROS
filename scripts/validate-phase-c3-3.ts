// scripts/validate-phase-c3-3.ts
// Phase C.3.3 Validation Gate — AWM (Agent Workflow Memory) subsystem
//
// Covers 14 assertions:
//   1. SKILL.md parser — accepts valid spec, rejects invalid (bad name, oversized description)
//   2. SkillWriter — write + read round-trip via loadSkillFromDir
//   3. UsageTracker — recordUse increments use_count + persists + failure_history bounded to 5
//   4. SkillStore — listActive returns only active state + rebuildFromDisk scans real files
//   5. SkillRegistry — progressive disclosure (metadata only vs. full body + view_count)
//   6. TsRunner — executes a trivial TS skill within timeout
//   7. PythonRunner — Composio Workbench (skippable if no COMPOSIO_API_KEY)
//   8. SkillDispatcher — routes scripts/main.ts → TsRunner; declarative → body; usage recorded
//   9. SkillCrystallizer — fake router returns valid JSON → produces SkillFile with required metadata
//  10. PersonaGate — duplicate cosine match enqueues nothing AND non-duplicate GREEN auto-promotes
//  11. ReviewQueue — enqueue → listPending → approve persists across re-opening same DB connection
//  12. AwmWorker — 3 fake matching trajectories → runOnce() reports candidates_found=1, promoted=1
//  13. Curator Phase 1 — 100d-old → archive; 50d-old → stale; pinned → stays active
//  14. End-to-end — SkillWriter → IntentRegistry.register(invoke_skill) → handler → TsRunner → use_count===1
//
// Exit 0 if all 14 PASS (skips count as pass); 1 otherwise.
// Run: bun run scripts/validate-phase-c3-3.ts

import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { Database } from 'bun:sqlite'

import { SkillMdError, loadSkillFromDir, serializeSkillMd } from '../src/daemon/skills/skillMd'
import { SkillWriter } from '../src/daemon/skills/skillWriter'
import { UsageTracker } from '../src/daemon/skills/usageTracker'
import { SkillStore } from '../src/daemon/skills/skillStore'
import { SkillRegistry } from '../src/daemon/skills/skillRegistry'
import { TsRunner } from '../src/daemon/skills/tsRunner'
import { SkillDispatcher } from '../src/daemon/skills/skillDispatcher'
import { SkillCrystallizer } from '../src/daemon/skills/crystallizer'
import { PersonaGate, type Embedder } from '../src/daemon/skills/personaGate'
import { ReviewQueue } from '../src/daemon/skills/reviewQueue'
import { AwmWorker } from '../src/daemon/skills/awmWorker'
import { Curator } from '../src/daemon/skills/curator'
import { IntentRegistry } from '../src/daemon/agency/intentRegistry'
import { registerInvokeSkillIntent } from '../src/daemon/skills/invokeSkillIntent'
import type { SkillFile, SkillCandidate } from '../src/daemon/skills/types'
import type { TrajEntry } from '../src/daemon/persona/types'

// ─── Result tracking ─────────────────────────────────────────────────────────

type AssertResult = { pass: boolean; note: string }
const results: AssertResult[] = []

function record(pass: boolean, note: string): AssertResult {
  const r = { pass, note }
  results.push(r)
  return r
}

// ─── Header ──────────────────────────────────────────────────────────────────

console.log('=== KAIROS Phase C.3.3 Validation Gate ===')
console.log(`Started: ${new Date().toISOString()}`)
console.log()

// ─── Helpers ─────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000

function makeTempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `kairos-c3-3-${label}-`))
}

/** Minimal valid SkillFile for use in tests. */
function makeSkillFile(slug: string, overrides: Partial<SkillFile> = {}): SkillFile {
  return {
    name: slug,
    description: `Test skill ${slug} — does X when Y happens. Useful for automated testing.`,
    slug,
    body: `# ${slug}\n\nStep 1: Do something useful.\nStep 2: Return the result.`,
    dir_path: '',
    has_scripts: false,
    has_references: false,
    ...overrides,
  }
}

/** Deterministic fake embedder — same text → same vector (cached). Different text → orthogonal. */
function makeFakeEmbedder(): Embedder {
  const cache = new Map<string, Float32Array>()
  let nextId = 0
  return {
    async warmup() {},
    async embed(text: string) {
      if (cache.has(text)) return cache.get(text)!
      const id = nextId++
      const v = new Float32Array(384)
      for (let i = 0; i < 384; i++) v[i] = Math.sin(id * 0.7 + i * 0.01)
      let norm = 0
      for (let i = 0; i < 384; i++) norm += v[i]! * v[i]!
      norm = Math.sqrt(norm)
      for (let i = 0; i < 384; i++) v[i] = v[i]! / norm
      cache.set(text, v)
      return v
    },
  }
}

/** Build a TrajEntry that passes AwmWorker's default thresholds (>5 steps, >30s). */
function makeTrajEntry(opts: {
  intent_id?: string
  actions?: string[]
  outcome?: TrajEntry['outcome']
  duration_ms?: number
}): TrajEntry {
  const actions = opts.actions ?? ['tool.a', 'tool.b', 'tool.c', 'tool.d', 'tool.e', 'tool.f']
  return {
    ts: Date.now(),
    task_goal: 'test trajectory',
    intent_id: opts.intent_id ?? 'send_message',
    args_summary: 'test args',
    steps: actions.map(a => ({ action: a, result_summary: 'ok' })),
    outcome: opts.outcome ?? 'success',
    duration_ms: opts.duration_ms ?? 60_000,
  }
}

// ─── [1/14] SKILL.md parser ───────────────────────────────────────────────────

try {
  const tmp = makeTempDir('1')
  const validSlug = 'my-test-skill'
  const validDir = join(tmp, validSlug)
  mkdirSync(validDir, { recursive: true })

  const validSkill: SkillFile = makeSkillFile(validSlug)
  const serialized = serializeSkillMd({ ...validSkill, dir_path: validDir })
  writeFileSync(join(validDir, 'SKILL.md'), serialized)

  const loaded = loadSkillFromDir(validDir)
  const validAccepted = loaded !== null && loaded.name === validSlug && loaded.description === validSkill.description

  // Bad name: uppercase letters violate /^[a-z0-9][a-z0-9-]*$/
  let badNameRejected = false
  try {
    serializeSkillMd({ ...validSkill, name: 'Bad_Name', slug: 'Bad_Name' })
  } catch (err) {
    if (err instanceof SkillMdError) badNameRejected = true
  }

  // Oversized description (>1024 chars)
  let bigDescRejected = false
  try {
    serializeSkillMd({ ...validSkill, description: 'x'.repeat(1025) })
  } catch (err) {
    if (err instanceof SkillMdError) bigDescRejected = true
  }

  if (validAccepted && badNameRejected && bigDescRejected) {
    record(true, `valid spec accepted; bad name rejected (SkillMdError); oversized description rejected (SkillMdError)`)
  } else {
    const failures = [
      !validAccepted && `valid skill not loaded (name=${loaded?.name})`,
      !badNameRejected && 'bad name did not throw SkillMdError',
      !bigDescRejected && 'oversized description did not throw SkillMdError',
    ].filter(Boolean).join('; ')
    record(false, failures)
  }
} catch (err) {
  record(false, `SKILL.md parser test threw: ${err instanceof Error ? err.message : err}`)
}

// ─── [2/14] SkillWriter — write + read round-trip ────────────────────────────

try {
  const tmp = makeTempDir('2')
  const writer = new SkillWriter({ root_dir: tmp })
  const slug = 'round-trip-skill'
  const skill = makeSkillFile(slug, {
    metadata: { 'kairos:autonomy_tier': 'GREEN', 'kairos:auto_crystallized': 'true' },
  })

  const dir = writer.write(skill)
  const loaded = loadSkillFromDir(dir)

  const nameOk = loaded?.name === slug
  const descOk = loaded?.description === skill.description
  const bodyOk = loaded?.body === skill.body
  const metaOk = loaded?.metadata?.['kairos:autonomy_tier'] === 'GREEN'

  if (nameOk && descOk && bodyOk && metaOk) {
    record(true, `wrote slug=${slug}, round-trip loaded with matching name/description/body/metadata`)
  } else {
    const failures = [
      !nameOk && `name mismatch: ${loaded?.name}`,
      !descOk && 'description mismatch',
      !bodyOk && 'body mismatch',
      !metaOk && `metadata mismatch: ${JSON.stringify(loaded?.metadata)}`,
    ].filter(Boolean).join('; ')
    record(false, failures)
  }
} catch (err) {
  record(false, `SkillWriter round-trip test threw: ${err instanceof Error ? err.message : err}`)
}

// ─── [3/14] UsageTracker — recordUse + persists + failure_history bounded ────

try {
  const tmp = makeTempDir('3')
  const tracker = new UsageTracker({ root_dir: tmp })
  const slug = 'tracker-test'
  tracker.initialize(slug)

  // Record 7 failures — history should only keep last 5
  for (let i = 0; i < 7; i++) {
    tracker.recordUse(slug, 10, false, `error-${i}`)
  }

  const usage = tracker.read(slug)
  const useCountOk = usage?.use_count === 7
  const historyBounded = (usage?.failure_history?.length ?? 0) === 5
  const lastErrorOk = usage?.failure_history?.at(-1)?.error === 'error-6'

  // Persist check: re-read by creating a NEW tracker pointing to same dir
  const tracker2 = new UsageTracker({ root_dir: tmp })
  const usage2 = tracker2.read(slug)
  const persistOk = usage2?.use_count === 7

  if (useCountOk && historyBounded && lastErrorOk && persistOk) {
    record(true, `use_count=7, failure_history.length=5 (bounded), last error=error-6, persists across new tracker instance`)
  } else {
    const failures = [
      !useCountOk && `use_count=${usage?.use_count} (expected 7)`,
      !historyBounded && `failure_history.length=${usage?.failure_history?.length} (expected 5)`,
      !lastErrorOk && `last error=${usage?.failure_history?.at(-1)?.error} (expected error-6)`,
      !persistOk && `use_count after re-read=${usage2?.use_count} (expected 7)`,
    ].filter(Boolean).join('; ')
    record(false, failures)
  }
} catch (err) {
  record(false, `UsageTracker test threw: ${err instanceof Error ? err.message : err}`)
}

// ─── [4/14] SkillStore — listActive + rebuildFromDisk ────────────────────────

try {
  const tmp = makeTempDir('4')
  const db = new Database(':memory:')
  const store = new SkillStore(db, { root_dir: tmp })

  // Plant 2 skills on disk + 1 stale in DB to verify listActive filtering
  for (const slug of ['store-a', 'store-b']) {
    const dir = join(tmp, slug)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'),
      `---\nname: ${slug}\ndescription: Store test skill ${slug}.\n---\n\nBody.\n`)
  }

  // Seed a stale row directly
  store.upsert({ slug: 'store-stale', name: 'store-stale', description: 'stale one', state: 'stale', pinned: false, last_used_at: 0, created_at: Date.now(), dir_path: join(tmp, 'store-stale') })

  // rebuildFromDisk should pick up only the real directories
  const count = store.rebuildFromDisk()
  const active = store.listActive()

  const countOk = count === 2
  const activeOnlyOk = active.length === 2 && active.every(r => r.state === 'active')
  const staleGoneOk = store.get('store-stale') === null  // rebuildFromDisk cleared and re-scanned

  if (countOk && activeOnlyOk && staleGoneOk) {
    record(true, `rebuildFromDisk scanned 2 real dirs; listActive returns 2 active rows; stale entry cleared by rebuild`)
  } else {
    const failures = [
      !countOk && `rebuildFromDisk returned ${count} (expected 2)`,
      !activeOnlyOk && `listActive returned ${active.length} rows, not all active`,
      !staleGoneOk && 'stale entry still present after rebuildFromDisk',
    ].filter(Boolean).join('; ')
    record(false, failures)
  }
} catch (err) {
  record(false, `SkillStore test threw: ${err instanceof Error ? err.message : err}`)
}

// ─── [5/14] SkillRegistry — progressive disclosure ───────────────────────────

try {
  const tmp = makeTempDir('5')
  const db = new Database(':memory:')
  const store = new SkillStore(db, { root_dir: tmp })
  const tracker = new UsageTracker({ root_dir: tmp })
  const registry = new SkillRegistry({ skillStore: store, usageTracker: tracker, rootDir: tmp })

  // Plant a skill on disk
  const slug = 'registry-skill'
  const dir = join(tmp, slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${slug}\ndescription: Registry progressive test skill.\n---\n\n# Body\n\nFull content here.\n`)

  registry.initialize()

  // listActiveMetadata: only name + description (no body)
  const metadata = registry.listActiveMetadata()
  const hasEntry = metadata.length === 1
  const hasNameDesc = metadata[0]?.name === slug && typeof metadata[0]?.description === 'string'
  const noBody = (metadata[0] as any)?.body === undefined

  // loadFullSkill: returns body AND increments view_count
  const full = registry.loadFullSkill(slug)
  const bodyPresent = full?.body.includes('Full content here')
  const usageAfter = tracker.read(slug)
  const viewCountOk = usageAfter?.view_count === 1

  if (hasEntry && hasNameDesc && noBody && bodyPresent && viewCountOk) {
    record(true, `listActiveMetadata: 1 entry, name+description present, no body field; loadFullSkill: body present, view_count=1`)
  } else {
    const failures = [
      !hasEntry && `metadata list has ${metadata.length} entries (expected 1)`,
      !hasNameDesc && 'name or description missing from metadata',
      !noBody && 'body unexpectedly present in metadata',
      !bodyPresent && 'full body not returned by loadFullSkill',
      !viewCountOk && `view_count=${usageAfter?.view_count} (expected 1)`,
    ].filter(Boolean).join('; ')
    record(false, failures)
  }
} catch (err) {
  record(false, `SkillRegistry progressive disclosure test threw: ${err instanceof Error ? err.message : err}`)
}

// ─── [6/14] TsRunner — executes trivial TS skill ─────────────────────────────

try {
  const tmp = makeTempDir('6')
  const runner = new TsRunner()

  // Write a trivial TS skill: export default async (args) => 'hello-' + args.name
  const scriptPath = join(tmp, 'main.ts')
  writeFileSync(scriptPath, `export default async function(args: any) { return 'hello-' + args.name }`)

  const result = await runner.execute(scriptPath, { name: 'kairos' })

  const okOk = result.ok === true
  const outputOk = typeof result.output === 'string' && result.output.includes('hello-kairos')
  const sandboxOk = result.sandbox === 'ts_worker'

  if (okOk && outputOk && sandboxOk) {
    record(true, `ok=true, output="${result.output}", sandbox=ts_worker`)
  } else {
    const failures = [
      !okOk && `ok=${result.ok}, error=${result.error}`,
      !outputOk && `output="${result.output}" (expected to contain "hello-kairos")`,
      !sandboxOk && `sandbox=${result.sandbox} (expected ts_worker)`,
    ].filter(Boolean).join('; ')
    record(false, failures)
  }
} catch (err) {
  record(false, `TsRunner test threw: ${err instanceof Error ? err.message : err}`)
}

// ─── [7/14] PythonRunner — Composio Workbench (skippable) ────────────────────

{
  const composioKey = process.env.COMPOSIO_API_KEY
  if (!composioKey || composioKey.startsWith('ak_your_')) {
    record(true, 'SKIP: COMPOSIO_API_KEY not set — PythonRunner Workbench test skipped')
  } else {
    // Opt-in only — Python Workbench runs cost real Composio compute.
    // Set KAIROS_VALIDATE_PYTHON=1 to exercise this path.
    if (process.env.KAIROS_VALIDATE_PYTHON !== '1') {
      record(true, 'SKIP: set KAIROS_VALIDATE_PYTHON=1 to run PythonRunner Workbench test')
    } else {
      let ComposioMod: any = null
      try {
        ComposioMod = await import('@composio/core')
      } catch {
        // Package not installed
      }
      if (!ComposioMod) {
        record(true, 'SKIP (no @composio/core) — PythonRunner Workbench test skipped')
      } else {
      try {
        const { PythonRunner } = await import('../src/daemon/skills/pythonRunner')
        const tmp = makeTempDir('7')
        const scriptPath = join(tmp, 'main.py')
        writeFileSync(scriptPath, `output = 'hello-python-' + str(args.get('name', 'world'))`)

        const Composio = ComposioMod.default
        const sdk = new Composio(composioKey)
        const composioClient = { sdk, apiKey: composioKey }

        const sessionCachePath = join(tmp, 'session.json')
        const runner = new PythonRunner({ composio: composioClient as any }, { session_cache_path: sessionCachePath })
        const result = await runner.execute(scriptPath, { name: 'kairos' })

        if (result.ok && typeof result.output === 'string') {
          record(true, `PythonRunner ok=true, output="${result.output?.slice(0, 80)}", sandbox=composio_workbench`)
        } else {
          record(false, `PythonRunner returned ok=false: ${result.error}`)
        }
      } catch (err) {
        record(false, `PythonRunner test threw: ${err instanceof Error ? err.message : err}`)
      }
      }
    }
  }
}

// ─── [8/14] SkillDispatcher — routing + usage recording ──────────────────────

try {
  const tmp = makeTempDir('8')
  const db = new Database(':memory:')
  const store = new SkillStore(db, { root_dir: tmp })
  const tracker = new UsageTracker({ root_dir: tmp })
  const registry = new SkillRegistry({ skillStore: store, usageTracker: tracker, rootDir: tmp })

  // Plant a TS skill
  const tsSlug = 'disp-ts-skill'
  const tsDir = join(tmp, tsSlug)
  mkdirSync(join(tsDir, 'scripts'), { recursive: true })
  writeFileSync(join(tsDir, 'SKILL.md'), `---\nname: ${tsSlug}\ndescription: Dispatcher TS routing test skill.\n---\n\nBody.\n`)
  writeFileSync(join(tsDir, 'scripts', 'main.ts'), `export default async (args: any) => 'ts-dispatch-ok'`)

  // Plant a declarative skill (no scripts/)
  const declSlug = 'disp-decl-skill'
  const declDir = join(tmp, declSlug)
  mkdirSync(declDir, { recursive: true })
  writeFileSync(join(declDir, 'SKILL.md'), `---\nname: ${declSlug}\ndescription: Dispatcher declarative routing test skill.\n---\n\nDeclarative body content.\n`)

  registry.initialize()

  // TsRunner — real instance
  const tsRunner = new TsRunner()

  // Fake PythonRunner (no Composio needed)
  const fakePython: any = {
    execute: async () => ({ ok: true, output: 'py', duration_ms: 5, sandbox: 'composio_workbench' }),
  }

  const dispatcher = new SkillDispatcher({ skillRegistry: registry, usageTracker: tracker, tsRunner, pythonRunner: fakePython })

  // Invoke TS skill
  const tsResult = await dispatcher.invoke(tsSlug, { x: 1 })
  const tsRouted = tsResult.ok && tsResult.sandbox === 'ts_worker' && tsResult.output?.includes('ts-dispatch-ok')

  // Invoke declarative skill
  const declResult = await dispatcher.invoke(declSlug, {})
  const declRouted = declResult.ok && declResult.sandbox === 'declarative' && declResult.output?.includes('Declarative body content')

  // Usage recorded for each invocation
  const tsUsage = tracker.read(tsSlug)
  const usageOk = tsUsage?.use_count === 1

  if (tsRouted && declRouted && usageOk) {
    record(true, `TS → ts_worker (ok); declarative → declarative (ok, body in output); use_count=1 after invocation`)
  } else {
    const failures = [
      !tsRouted && `TS routing failed: ok=${tsResult.ok}, sandbox=${tsResult.sandbox}, output=${tsResult.output}, error=${tsResult.error}`,
      !declRouted && `declarative routing failed: ok=${declResult.ok}, sandbox=${declResult.sandbox}`,
      !usageOk && `use_count=${tsUsage?.use_count} (expected 1)`,
    ].filter(Boolean).join('; ')
    record(false, failures)
  }
} catch (err) {
  record(false, `SkillDispatcher routing test threw: ${err instanceof Error ? err.message : err}`)
}

// ─── [9/14] SkillCrystallizer — fake router → valid SkillFile with metadata ──

try {
  // Build a fake router that returns a pre-canned JSON skill
  const fakeRouter = {
    complete: async (_req: any) => {
      const parsed = {
        name: 'crystallized-skill',
        description: 'Crystallized skill that does task X when pattern Y is detected.',
        body: '# Crystallized Skill\n\nStep 1: detect pattern.\nStep 2: act.',
        metadata: {
          'kairos:autonomy_tier': 'YELLOW',
          'kairos:auto_crystallized': 'true',
          'kairos:source_trajectories': '3',
        },
      }
      return {
        text: JSON.stringify(parsed),
        parsed,
        provider: 'fake',
        model: 'fake',
        cost_cents: 0,
        latency_ms: 0,
        fallback_count: 0,
        input_tokens: 0,
        output_tokens: 0,
      }
    },
  }

  const crystallizer = new SkillCrystallizer({ router: fakeRouter as any })

  const candidate: SkillCandidate = {
    cluster_id: 'abc123',
    trajectories: [
      makeTrajEntry({}),
      makeTrajEntry({}),
      makeTrajEntry({}),
    ],
    representative_signature: {
      intent_id: 'send_message',
      common_args: {},
      avg_tool_calls: 6,
      success_rate: 1.0,
    },
    occurrences: 3,
    first_seen_at: Date.now() - 10000,
    last_seen_at: Date.now(),
  }

  const skill = await crystallizer.crystallize(candidate)

  const nameOk = skill.name === 'crystallized-skill'
  const descOk = typeof skill.description === 'string' && skill.description.length > 0 && skill.description.length <= 1024
  const bodyOk = typeof skill.body === 'string' && skill.body.length > 0
  const tierOk = skill.metadata?.['kairos:autonomy_tier'] === 'YELLOW'
  const autoOk = skill.metadata?.['kairos:auto_crystallized'] === 'true'
  const srcOk = skill.metadata?.['kairos:source_trajectories'] === '3'

  if (nameOk && descOk && bodyOk && tierOk && autoOk && srcOk) {
    record(true, `name=${skill.name}, description len=${skill.description.length}, body present, metadata: tier=YELLOW, auto_crystallized=true, source_trajectories=3`)
  } else {
    const failures = [
      !nameOk && `name=${skill.name} (expected crystallized-skill)`,
      !descOk && `description invalid (len=${skill.description?.length})`,
      !bodyOk && 'body missing or empty',
      !tierOk && `tier=${skill.metadata?.['kairos:autonomy_tier']} (expected YELLOW)`,
      !autoOk && `auto_crystallized=${skill.metadata?.['kairos:auto_crystallized']} (expected true)`,
      !srcOk && `source_trajectories=${skill.metadata?.['kairos:source_trajectories']} (expected 3)`,
    ].filter(Boolean).join('; ')
    record(false, failures)
  }
} catch (err) {
  record(false, `SkillCrystallizer test threw: ${err instanceof Error ? err.message : err}`)
}

// ─── [10/14] PersonaGate — dedup + GREEN auto-promote ────────────────────────

try {
  const tmp = makeTempDir('10')
  const db = new Database(':memory:')
  const store = new SkillStore(db, { root_dir: tmp })
  const writer = new SkillWriter({ root_dir: tmp })
  const queue = new ReviewQueue(db)
  const embedder = makeFakeEmbedder()

  // Track bodies per slug so the gate can embed existing skill content
  const bodies: Record<string, string> = {}

  const gate = new PersonaGate({
    skillStore: store,
    skillWriter: writer,
    reviewQueue: queue,
    embedder,
    loadExistingSkillContent: (dirPath: string) => {
      const slug = dirPath.split('/').pop()!
      return bodies[slug] ?? null
    },
  })

  // 1. Plant an existing GREEN skill — auto-promotes
  const first = makeSkillFile('pg-first', {
    description: 'Send a Slack reminder to a channel.',
    body: 'Body content for pg-first',
    metadata: { 'kairos:autonomy_tier': 'GREEN' },
  })
  const v1 = await gate.evaluate(first)
  bodies['pg-first'] = first.body

  const firstPromoted = v1.approved === true && (v1 as any).promoted === true

  // 2. Try a duplicate (same description + body → same embedding → cosine=1 > 0.85)
  const duplicate = makeSkillFile('pg-dup', {
    description: 'Send a Slack reminder to a channel.',  // identical
    body: 'Body content for pg-first',                    // identical → same embedding
    metadata: { 'kairos:autonomy_tier': 'GREEN' },
  })
  const v2 = await gate.evaluate(duplicate)
  const dupDetected = v2.is_duplicate === true && v2.approved === false

  // 3. Duplicate enqueues nothing
  const pendingAfterDup = queue.listPending().length
  const nothingEnqueued = pendingAfterDup === 0

  if (firstPromoted && dupDetected && nothingEnqueued) {
    record(true, `GREEN non-duplicate auto-promoted; duplicate detected (cosine>0.85); no review queue entry for duplicate`)
  } else {
    const failures = [
      !firstPromoted && `first skill not promoted: approved=${v1.approved}, promoted=${(v1 as any).promoted}`,
      !dupDetected && `duplicate not detected: is_duplicate=${v2.is_duplicate}, approved=${v2.approved}`,
      !nothingEnqueued && `queue has ${pendingAfterDup} entries (expected 0)`,
    ].filter(Boolean).join('; ')
    record(false, failures)
  }
} catch (err) {
  record(false, `PersonaGate test threw: ${err instanceof Error ? err.message : err}`)
}

// ─── [11/14] ReviewQueue — enqueue → listPending → approve + persistence ─────

try {
  const tmp = makeTempDir('11')
  const dbPath = join(tmp, 'review.db')

  // First connection: enqueue + approve
  const db1 = new Database(dbPath)
  const queue1 = new ReviewQueue(db1)

  const skill = makeSkillFile('rq-orange', {
    metadata: { 'kairos:autonomy_tier': 'ORANGE' },
  })
  const verdict = {
    approved: false,
    tier: 'ORANGE' as const,
    is_duplicate: false,
    needs_human_review: true,
    reason: 'ORANGE tier requires human review',
  }

  const id = queue1.enqueue(skill, verdict)
  const pendingBefore = queue1.listPending()
  const enqueuedOk = pendingBefore.length === 1 && pendingBefore[0]?.id === id

  // Approve via the same connection
  queue1.approve(id)
  const rowAfterApprove = queue1.get(id)
  const approvedOk = rowAfterApprove?.status === 'approved'

  // Close first connection and open a second — verify persistence
  db1.close()
  const db2 = new Database(dbPath)
  const queue2 = new ReviewQueue(db2)
  const rowFromDb2 = queue2.get(id)
  const persistedOk = rowFromDb2?.status === 'approved' && rowFromDb2?.skill?.name === 'rq-orange'
  db2.close()

  if (enqueuedOk && approvedOk && persistedOk) {
    record(true, `enqueue ok (id=${id}); listPending found 1; approve transitions to 'approved'; persists across new DB connection`)
  } else {
    const failures = [
      !enqueuedOk && `enqueue failed: pending.length=${pendingBefore.length}, id=${id}`,
      !approvedOk && `approval failed: status=${rowAfterApprove?.status}`,
      !persistedOk && `persistence failed: db2 row status=${rowFromDb2?.status}, skill.name=${rowFromDb2?.skill?.name}`,
    ].filter(Boolean).join('; ')
    record(false, failures)
  }
} catch (err) {
  record(false, `ReviewQueue persistence test threw: ${err instanceof Error ? err.message : err}`)
}

// ─── [12/14] AwmWorker — 3 matching trajectories → candidates=1, promoted=1 ──

try {
  // 3 identical action sequences that meet all thresholds
  const actions = ['tool.a', 'tool.b', 'tool.c', 'tool.d', 'tool.e', 'tool.f']
  const fakeEntries: TrajEntry[] = [
    makeTrajEntry({ actions }),
    makeTrajEntry({ actions }),
    makeTrajEntry({ actions }),
  ]

  let crystallizeCalls = 0
  let evaluateCalls = 0

  const fakeDeps = {
    trajWriter: {
      listDays: () => ['2026-05-28'],
      readDay: (_day: string) => fakeEntries,
    },
    crystallizer: {
      async crystallize(_cand: SkillCandidate): Promise<SkillFile> {
        crystallizeCalls++
        return makeSkillFile('awm-skill', { metadata: { 'kairos:autonomy_tier': 'GREEN' } })
      },
    },
    personaGate: {
      async evaluate(_s: SkillFile) {
        evaluateCalls++
        return {
          approved: true,
          tier: 'GREEN' as const,
          is_duplicate: false,
          needs_human_review: false,
          reason: 'auto-promoted (GREEN tier)',
          promoted: true,
        }
      },
    },
  }

  const worker = new AwmWorker(fakeDeps, { min_occurrences: 3 })
  const report = await worker.runOnce()

  const candidatesOk = report.candidates_found === 1
  const promotedOk = report.promoted === 1
  const errorsOk = report.errors === 0
  const crystallizeCalledOk = crystallizeCalls === 1
  const evaluateCalledOk = evaluateCalls === 1

  if (candidatesOk && promotedOk && errorsOk && crystallizeCalledOk && evaluateCalledOk) {
    record(true, `candidates_found=1, promoted=1, errors=0; crystallize called 1x; evaluate called 1x`)
  } else {
    const failures = [
      !candidatesOk && `candidates_found=${report.candidates_found} (expected 1)`,
      !promotedOk && `promoted=${report.promoted} (expected 1)`,
      !errorsOk && `errors=${report.errors} (expected 0)`,
      !crystallizeCalledOk && `crystallize called ${crystallizeCalls}x (expected 1)`,
      !evaluateCalledOk && `evaluate called ${evaluateCalls}x (expected 1)`,
    ].filter(Boolean).join('; ')
    record(false, failures)
  }
} catch (err) {
  record(false, `AwmWorker test threw: ${err instanceof Error ? err.message : err}`)
}

// ─── [13/14] Curator Phase 1 — stale, archive, pinned ────────────────────────

try {
  const tmp = makeTempDir('13')
  const archive = join(tmp, '.archive')
  const db = new Database(':memory:')
  const store = new SkillStore(db, { root_dir: tmp })
  const tracker = new UsageTracker({ root_dir: tmp })
  const writer = new SkillWriter({ root_dir: tmp })
  const curator = new Curator(
    { skillStore: store, usageTracker: tracker, skillWriter: writer },
    { root_dir: tmp, archive_dir: archive, stale_threshold_days: 30, archive_threshold_days: 90 },
  )

  const now = Date.now()

  // Helper: plant a skill with desired usage timestamps
  function plantSkill(slug: string, opts: {
    last_used_at: number; created_at: number; pinned?: boolean; state?: 'active' | 'stale'
  }): string {
    const skill = makeSkillFile(slug)
    const dir = writer.write(skill, { force: true })
    tracker.initialize(slug)
    const u = tracker.read(slug)!
    u.last_used_at = opts.last_used_at
    u.created_at = opts.created_at
    u.pinned = !!opts.pinned
    u.state = opts.state ?? 'active'
    writeFileSync(tracker.pathFor(slug), JSON.stringify(u, null, 2))
    store.upsert({
      slug, name: slug, description: skill.description,
      state: u.state, pinned: u.pinned, tier: 'YELLOW',
      last_used_at: u.last_used_at, created_at: u.created_at,
      dir_path: dir,
    })
    return dir
  }

  // 100d-old (last_used = now-100d, created = now-200d) → should archive (was stale)
  const oldDir = plantSkill('curator-old', {
    last_used_at: now - 100 * DAY_MS,
    created_at: now - 200 * DAY_MS,
    state: 'stale',    // already stale; should trigger archive at 90d
  })

  // 50d-old → should become stale (>30d but <90d)
  plantSkill('curator-medium', {
    last_used_at: now - 50 * DAY_MS,
    created_at: now - 80 * DAY_MS,
    state: 'active',
  })

  // Pinned + 200d-old → should stay active
  plantSkill('curator-pinned', {
    last_used_at: now - 200 * DAY_MS,
    created_at: now - 300 * DAY_MS,
    pinned: true,
    state: 'active',
  })

  const report = await curator.runOnce(now)

  const archivedOk = report.phase1.archived.includes('curator-old')
  const staleOk = report.phase1.marked_stale.includes('curator-medium')
  const pinnedSafeOk = !report.phase1.archived.includes('curator-pinned') && !report.phase1.marked_stale.includes('curator-pinned')

  // Verify the archive dir move
  const oldDirGone = !existsSync(oldDir)
  const archiveDirPresent = existsSync(join(archive, 'curator-old'))

  if (archivedOk && staleOk && pinnedSafeOk && oldDirGone && archiveDirPresent) {
    record(true, `100d-old archived (dir moved to .archive/); 50d-old → stale; pinned 200d-old stays active`)
  } else {
    const failures = [
      !archivedOk && `curator-old not archived (archived=[${report.phase1.archived}])`,
      !staleOk && `curator-medium not stale (stale=[${report.phase1.marked_stale}])`,
      !pinnedSafeOk && 'curator-pinned was incorrectly archived or marked stale',
      !oldDirGone && `old dir still exists at ${oldDir}`,
      !archiveDirPresent && `archive dir not found at ${join(archive, 'curator-old')}`,
    ].filter(Boolean).join('; ')
    record(false, failures)
  }
} catch (err) {
  record(false, `Curator Phase 1 test threw: ${err instanceof Error ? err.message : err}`)
}

// ─── [14/14] End-to-end — SkillWriter → IntentRegistry → invoke_skill → TsRunner → use_count===1

try {
  const tmp = makeTempDir('14')
  const db = new Database(':memory:')
  const store = new SkillStore(db, { root_dir: tmp })
  const tracker = new UsageTracker({ root_dir: tmp })
  const registry = new SkillRegistry({ skillStore: store, usageTracker: tracker, rootDir: tmp })

  // 1. Write a real skill with a TS script via SkillWriter
  const slug = 'e2e-skill'
  const writer = new SkillWriter({ root_dir: tmp })
  const skill = makeSkillFile(slug, {
    metadata: { 'kairos:autonomy_tier': 'GREEN' },
  })
  writer.write(skill, {
    scripts: [{
      filename: 'main.ts',
      content: `export default async function(args: any) { return 'e2e-result-' + (args.tag ?? 'none') }`,
    }],
  })

  // 2. Initialize registry (scans disk → picks up the new skill)
  registry.initialize()

  // 3. Build SkillDispatcher with real TsRunner
  const tsRunner = new TsRunner()
  const fakePy: any = { execute: async () => ({ ok: false, error: 'not used', duration_ms: 0, sandbox: 'composio_workbench' }) }
  const dispatcher = new SkillDispatcher({ skillRegistry: registry, usageTracker: tracker, tsRunner, pythonRunner: fakePy })

  // 4. Register invoke_skill intent
  const intentReg = new IntentRegistry()
  registerInvokeSkillIntent(intentReg, { dispatcher })

  // 5. Call the handler directly (no HTTP, no daemon)
  const entry = intentReg.get('invoke_skill')!
  const fakeCtx: any = {
    db,
    notifier: { notify: async () => {} },
    embedder: { embed: async () => [] },
    semantic: { reinforceOrWrite: () => 0 },
  }
  const handlerResult = await entry.handler({ slug, args: { tag: 'test' } }, fakeCtx)

  const handlerOk = handlerResult.status === 'success'
  const detailsOk = handlerResult.details.includes('e2e-result-test')

  // 6. Verify usage_count === 1 (dispatcher.invoke increments it)
  const usage = tracker.read(slug)
  const useCountOk = usage?.use_count === 1

  if (handlerOk && detailsOk && useCountOk) {
    record(true, `SkillWriter wrote, registry loaded, intent invoked, handler returned success with output "e2e-result-test", use_count=1`)
  } else {
    const failures = [
      !handlerOk && `handler status=${handlerResult.status}, details=${handlerResult.details}`,
      !detailsOk && `details="${handlerResult.details}" does not contain "e2e-result-test"`,
      !useCountOk && `use_count=${usage?.use_count} (expected 1)`,
    ].filter(Boolean).join('; ')
    record(false, failures)
  }
} catch (err) {
  record(false, `End-to-end test threw: ${err instanceof Error ? err.message : err}`)
}

// ─── Report ───────────────────────────────────────────────────────────────────

const labels = [
  'SKILL.md parser — valid/invalid spec',
  'SkillWriter write + read round-trip',
  'UsageTracker recordUse + persistence + bounded history',
  'SkillStore listActive + rebuildFromDisk',
  'SkillRegistry progressive disclosure',
  'TsRunner executes trivial TS skill',
  'PythonRunner Workbench (skippable)',
  'SkillDispatcher routing + usage recorded',
  'SkillCrystallizer fake router → SkillFile',
  'PersonaGate dedup + GREEN auto-promote',
  'ReviewQueue enqueue→approve persists across DB reopen',
  'AwmWorker 3 trajectories → candidates=1 promoted=1',
  'Curator Phase 1 stale/archive/pinned transitions',
  'End-to-end SkillWriter→IntentRegistry→invoke_skill→TsRunner',
]

console.log()
for (let i = 0; i < results.length; i++) {
  const { pass, note } = results[i]!
  const label = labels[i]!
  const status = pass ? (note.startsWith('SKIP') ? `SKIP: ${note.slice(5).trim()}` : 'PASS') : `FAIL: ${note}`
  const padded = `[${String(i + 1).padStart(2, '0')}/14] ${label}`.padEnd(62, '.')
  console.log(`${padded} ${status}`)
}

const allPass = results.every(r => r.pass)
const skipCount = results.filter(r => r.pass && r.note.startsWith('SKIP')).length
const passCount = results.filter(r => r.pass && !r.note.startsWith('SKIP')).length
const failCount = results.filter(r => !r.pass).length

console.log()
console.log(`Summary: ${passCount} PASS, ${skipCount} SKIP, ${failCount} FAIL`)
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
