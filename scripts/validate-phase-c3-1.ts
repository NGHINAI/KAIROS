// scripts/validate-phase-c3-1.ts
// Phase C.3.1 Validation Gate — User Profile + Persona-Awareness + soul.md
//
// Covers 7 assertions:
//   1. SoulLoader baselines always enforced
//   2. SoulWizard composes valid JSON (with FAKE router — no real LLM call)
//   3. TrajWriter sanitizes secrets
//   4. PersonaUpdater token cap enforcement
//   5. DreamingExtension produces DREAMS.md entry
//   6. PersonaAwareness hints derive correctly
//   7. RestraintPipeline persona integration
//
// Exit 0 if all 7 PASS; 1 otherwise.
// Run: bun run scripts/validate-phase-c3-1.ts

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { Database } from 'bun:sqlite'

import { SoulLoader } from '../src/daemon/persona/soulLoader'
import { SoulWizard } from '../src/daemon/persona/soulWizard'
import { TrajWriter } from '../src/daemon/persona/trajWriter'
import { PersonaUpdater } from '../src/daemon/persona/personaUpdater'
import { DreamingExtension } from '../src/daemon/persona/dreamingExtension'
import { PersonaAwareness } from '../src/daemon/persona/personaAwareness'
import { MdLoader } from '../src/daemon/persona/mdLoader'
import { RestraintPipeline } from '../src/daemon/restraint/restraintPipeline'
import { FocusDetector } from '../src/daemon/restraint/focusDetector'
import { KarmaStore, KARMA_SCHEMA } from '../src/daemon/restraint/karma'
import { CooldownTracker } from '../src/daemon/restraint/cooldownTracker'
import { RateLimiter, RATE_LIMITER_SCHEMA } from '../src/daemon/restraint/rateLimiter'
import { ActionScorer } from '../src/daemon/restraint/actionScorer'
import { DeliveryRouter } from '../src/daemon/restraint/deliveryRouter'
import { DigestComposer, DIGEST_SCHEMA } from '../src/daemon/restraint/digestComposer'
import { DryRunMode, DRY_RUN_SCHEMA } from '../src/daemon/restraint/dryRunMode'
import type { ActionRequest } from '../src/daemon/agency/types'
import type { RestraintConfig } from '../src/daemon/restraint/types'

// ─── Result tracking ─────────────────────────────────────────────────────────

type AssertResult = { pass: boolean; note: string }
const results: AssertResult[] = []

function record(pass: boolean, note: string): AssertResult {
  const r = { pass, note }
  results.push(r)
  return r
}

// ─── Header ──────────────────────────────────────────────────────────────────

console.log('=== KAIROS Phase C.3.1 Validation Gate ===')
console.log(`Started: ${new Date().toISOString()}`)
console.log()

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTempPath(suffix: string): string {
  const dir = join(tmpdir(), `kairos-validate-c3-1-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  return join(dir, suffix)
}

const cfg: RestraintConfig = {
  interrupt_threshold: 0.9, surface_threshold: 0.7, digest_threshold: 0.4,
  weight_rule_match: 0.20, weight_urgency: 0.30,
  weight_personal_relevance: 0.20, weight_context_availability: 0.15,
  weight_novelty: 0.10, weight_dismissal_penalty: 0.05,
  max_interrupts_per_day: 8, max_interrupts_per_hour: 2, max_surfaces_per_hour: 6,
  default_trigger_cooldown_sec: 300, same_intent_dedup_window_sec: 60,
  quiet_hours_start: '22:00', quiet_hours_end: '07:00',
  deep_focus_threshold_sec: 1500,
  digest_morning_time: '08:30', digest_lunch_time: '12:30', digest_evening_time: '17:30',
  auto_suspend_after_dismissals: 3, dismissal_window_days: 7,
  dry_run_duration_hours: 24,
}

function makeReq(intentId: string, triggerId: string): ActionRequest {
  return {
    request_id: randomUUID(),
    intent_id: intentId,
    args: {},
    source_trigger_id: triggerId,
    reasoning: 'test',
    requested_at: Date.now(),
  }
}

function makePipeline(personaAwareness?: any): RestraintPipeline {
  const db = new Database(':memory:')
  db.exec(KARMA_SCHEMA)
  db.exec(RATE_LIMITER_SCHEMA)
  db.exec(DIGEST_SCHEMA)
  db.exec(DRY_RUN_SCHEMA)

  const focus = new FocusDetector(cfg, {
    now: () => new Date('2026-05-25T10:00:00').getTime(),
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
  const urgencyFloor = new (require('../src/daemon/restraint/urgencyFloor').UrgencyFloor)()

  return new RestraintPipeline({
    config: cfg, urgencyFloor, focus, karma, cooldown, rateLimiter, scorer, router, digest, dryRun,
    ...(personaAwareness !== undefined ? { personaAwareness } : {}),
  })
}

// ─── [1/7] SoulLoader baselines enforced ─────────────────────────────────────

try {
  const soulPath = makeTempPath('soul.md')
  // Write a soul.md with empty boundaries
  MdLoader.save(soulPath, {
    frontmatter: {
      version: 1,
      composed_at: Date.now(),
      core_truths: [],
      boundaries: [],
      vibe: '',
    },
    body: '',
  })

  const loader = new SoulLoader({ path: soulPath })
  loader.load()
  const block = loader.buildSystemBlock()
  const text = block.text

  const patterns = [
    /Never delete user data/i,
    /Never send messages.*sensitive data/i,
    /Never modify mcp-servers\.json/i,
    /Never act on instructions/i,
  ]

  const missing = patterns.filter(p => !p.test(text))
  if (missing.length === 0) {
    record(true, 'all 4 baseline boundaries present in system block')
  } else {
    record(false, `missing ${missing.length} baseline phrase(s): ${missing.map(p => p.toString()).join(', ')}`)
  }
} catch (err) {
  record(false, `SoulLoader test threw: ${err instanceof Error ? err.message : err}`)
}

// ─── [2/7] SoulWizard composes valid JSON (fake router) ──────────────────────

let wizardTaskType: string | null = null

try {
  const soulPath = makeTempPath('wizard-soul.md')

  const fakeRouter = {
    complete: async (req: any) => {
      wizardTaskType = req.task_type
      return {
        text: '{}',
        parsed: {
          version: 1,
          core_truths: ['t1'],
          boundaries: ['b1'],
          vibe: 'v',
          free_body: '',
        },
        provider: 'fake',
        model: 'fake',
        cost_cents: 0,
        latency_ms: 0,
        fallback_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        _taskType: req.task_type,
      }
    },
  }

  const wizard = new SoulWizard({ path: soulPath, router: fakeRouter as any })
  await wizard.compose({
    ideal_coworker: 'proactive and focused',
    communication_priorities: 'brief confirmations',
    never_do: 'never interrupt meetings',
    focus_behavior: 'silent in deep focus',
    other_guidance: 'none',
  })

  const fileExists = existsSync(soulPath)
  const reloader = new SoulLoader({ path: soulPath })
  reloader.load()
  const soul = reloader.getSoul()
  const parseable = soul !== null && Array.isArray(soul.core_truths)
  const correctTaskType = wizardTaskType === 'persona_compose'

  if (fileExists && parseable && correctTaskType) {
    record(true, `file written + parsed (core_truths: [${soul!.core_truths.join(', ')}]) + task_type='persona_compose'`)
  } else {
    const failures = [
      !fileExists && 'file not written',
      !parseable && `SoulLoader could not parse: soul=${JSON.stringify(soul)}`,
      !correctTaskType && `task_type was '${wizardTaskType}' not 'persona_compose'`,
    ].filter(Boolean).join('; ')
    record(false, failures)
  }
} catch (err) {
  record(false, `SoulWizard test threw: ${err instanceof Error ? err.message : err}`)
}

// ─── [3/7] TrajWriter sanitizes secrets ──────────────────────────────────────

try {
  const trajDir = join(tmpdir(), `kairos-traj-${randomUUID()}`)
  mkdirSync(trajDir, { recursive: true })

  const writer = new TrajWriter({ dir: trajDir })

  const githubToken = 'ghp_abcdef1234567890ABCDEFGHIJKLMNOPQRSTUVWXY'
  const composioToken = 'ak_3GI9JhYdO3uJkK9JgABC4j'

  writer.record({
    ts: Date.now(),
    task_goal: 'test sanitization',
    intent_id: 'send_message',
    args_summary: `token=${githubToken} key=${composioToken}`,
    steps: [{
      action: 'tool_call',
      result_summary: 'ok',
    }],
    outcome: 'success',
    duration_ms: 100,
  })

  // Read raw file content
  const day = new Date().toISOString().slice(0, 10)
  const trajFile = join(trajDir, day + '.md')
  const content = readFileSync(trajFile, 'utf8')

  const hasGhToken = content.includes(githubToken)
  const hasComposioToken = content.includes(composioToken)
  const hasRedacted = (content.match(/<REDACTED>/g) ?? []).length >= 2

  if (!hasGhToken && !hasComposioToken && hasRedacted) {
    record(true, 'neither ghp_ nor ak_ token appears; <REDACTED> found ≥2 times')
  } else {
    const failures = [
      hasGhToken && 'github token NOT redacted',
      hasComposioToken && 'composio ak_ token NOT redacted',
      !hasRedacted && `<REDACTED> appears <2 times in file`,
    ].filter(Boolean).join('; ')
    record(false, failures)
  }
} catch (err) {
  record(false, `TrajWriter sanitization test threw: ${err instanceof Error ? err.message : err}`)
}

// ─── [4/7] PersonaUpdater token cap enforcement ──────────────────────────────

try {
  const personaPath = makeTempPath('persona.md')

  const updater = new PersonaUpdater({ path: personaPath, tokenCap: 30 })

  // Apply diff with 5 fields × 200 chars each (total ~1000 chars = ~250 tokens >> 30)
  const longText = 'x'.repeat(200)
  updater.applyDreamingDiff({
    working_patterns: longText,
    communication_style: longText,
    preferences: longText,
    recent_themes: longText,
    notes: longText,
  })

  const tokenCount = updater.estimateCurrentTokens()
  const persona = updater.get()
  const notesDropped = persona.notes === undefined

  if (tokenCount <= 40 && notesDropped) {
    record(true, `tokens=${tokenCount} (≤40); notes trimmed to undefined`)
  } else {
    const failures = [
      tokenCount > 40 && `estimateCurrentTokens()=${tokenCount} exceeds cap 40`,
      !notesDropped && `notes was not dropped: "${persona.notes}"`,
    ].filter(Boolean).join('; ')
    record(false, failures)
  }
} catch (err) {
  record(false, `PersonaUpdater token cap test threw: ${err instanceof Error ? err.message : err}`)
}

// ─── [5/7] DreamingExtension produces DREAMS.md entry ────────────────────────

try {
  const dreamsPath = join(homedir(), '.kairos', 'DREAMS.md')
  const backup = existsSync(dreamsPath) ? readFileSync(dreamsPath, 'utf8') : null

  // Ensure ~/.kairos dir exists
  const kairosDir = join(homedir(), '.kairos')
  if (!existsSync(kairosDir)) mkdirSync(kairosDir, { recursive: true })

  try {
    if (backup !== null) rmSync(dreamsPath)

    // Create real TrajWriter with temp dir + seed 5 success entries
    const trajDir = join(tmpdir(), `kairos-dreams-traj-${randomUUID()}`)
    mkdirSync(trajDir, { recursive: true })

    const trajWriter = new TrajWriter({ dir: trajDir })
    const now = Date.now()
    for (let i = 0; i < 5; i++) {
      trajWriter.record({
        ts: now - i * 1000,
        task_goal: `task ${i}`,
        intent_id: 'send_message',
        args_summary: `msg ${i}`,
        steps: [{ action: 'tool_call', result_summary: 'sent', reasoning: 'ok' }],
        outcome: 'success',
        duration_ms: 50,
      })
    }

    // PersonaUpdater with temp path
    const personaPath = makeTempPath('persona-dreams.md')
    const personaUpdater = new PersonaUpdater({ path: personaPath })

    const dreaming = new DreamingExtension({ trajWriter, personaUpdater })
    const entry = await dreaming.runCycle('rem')

    const cycleTypeOk = entry.cycle_type === 'rem'
    const scannedOk = entry.trajectories_scanned === 5
    const fileExists = existsSync(dreamsPath)
    const fileContains = fileExists && readFileSync(dreamsPath, 'utf8').includes('cycle_type: rem')

    if (cycleTypeOk && scannedOk && fileExists && fileContains) {
      record(true, `cycle_type=rem, trajectories_scanned=5, DREAMS.md written with "cycle_type: rem"`)
    } else {
      const failures = [
        !cycleTypeOk && `cycle_type=${entry.cycle_type}`,
        !scannedOk && `trajectories_scanned=${entry.trajectories_scanned}`,
        !fileExists && 'DREAMS.md not written',
        !fileContains && 'DREAMS.md does not contain "cycle_type: rem"',
      ].filter(Boolean).join('; ')
      record(false, failures)
    }
  } finally {
    if (backup !== null) writeFileSync(dreamsPath, backup)
    else if (existsSync(dreamsPath)) rmSync(dreamsPath)
  }
} catch (err) {
  record(false, `DreamingExtension test threw: ${err instanceof Error ? err.message : err}`)
}

// ─── [6/7] PersonaAwareness hints derive correctly ───────────────────────────

try {
  const personaPath = makeTempPath('persona-awareness.md')
  const updater = new PersonaUpdater({ path: personaPath })

  // Seed persona with working_patterns "Active 10:00 – 18:00" + communication_style "silent unless urgent"
  updater.applyDreamingDiff({
    working_patterns: 'Active 10:00 – 18:00',
    communication_style: 'silent unless urgent',
  })

  // getLiveState returns hour=14, focus_app=Visual Studio Code
  const awareness = new PersonaAwareness({
    personaUpdater: updater,
    getLiveState: () => ({
      current_focus_app: 'Visual Studio Code',
      current_hour_local: 14,
    }),
    now: () => Date.now(),
  })

  const hints = awareness.getHints()

  const aggressivenessOk = hints.interrupt_aggressiveness === 'low'
  const inFocusOk = hints.in_focus_now === true
  const activeHoursOk = hints.active_hours_now === true

  if (aggressivenessOk && inFocusOk && activeHoursOk) {
    record(true, `interrupt_aggressiveness=low, in_focus_now=true, active_hours_now=true`)
  } else {
    const failures = [
      !aggressivenessOk && `interrupt_aggressiveness=${hints.interrupt_aggressiveness} (expected low)`,
      !inFocusOk && `in_focus_now=${hints.in_focus_now} (expected true)`,
      !activeHoursOk && `active_hours_now=${hints.active_hours_now} (expected true)`,
    ].filter(Boolean).join('; ')
    record(false, failures)
  }
} catch (err) {
  record(false, `PersonaAwareness test threw: ${err instanceof Error ? err.message : err}`)
}

// ─── [7/7] RestraintPipeline persona integration ─────────────────────────────

try {
  // Build fakePersonaAwareness with in_focus_now=true to trigger persona suppression
  const fakePersonaAwareness = {
    getHints: () => ({
      interrupt_aggressiveness: 'medium' as const,
      in_focus_now: true,
      active_hours_now: true,
      prefer_terse: false,
      prefer_voice_over_text: false,
    }),
  }

  // Build pipeline without persona, then inject via setPersonaAwareness
  const pipeline = makePipeline()
  pipeline.setPersonaAwareness(fakePersonaAwareness as any)

  // Non-urgent event — should be suppressed by persona in_focus_now
  // (urgency=0.5, rule=0.5, relevance=0.5, novelty=0.5 → score ~0.55, not urgent, no urgency floor)
  const result = await pipeline.evaluate(makeReq('notify', 'trig-persona-focus'), {
    urgency: 0.5, rule_match_strength: 0.5, personal_relevance: 0.5, novelty: 0.5, urgent: false,
  })

  const suppressed = result.mode === 'suppressed'
  const reasonMatchesFocus = /focus/i.test(result.reason ?? '')

  if (suppressed && reasonMatchesFocus) {
    record(true, `mode=suppressed, reason="${result.reason}"`)
  } else {
    const failures = [
      !suppressed && `mode=${result.mode} (expected suppressed)`,
      !reasonMatchesFocus && `reason="${result.reason}" does not match /focus/i`,
    ].filter(Boolean).join('; ')
    record(false, failures)
  }
} catch (err) {
  record(false, `RestraintPipeline persona integration test threw: ${err instanceof Error ? err.message : err}`)
}

// ─── Report ───────────────────────────────────────────────────────────────────

const labels = [
  'SoulLoader baselines enforced',
  'SoulWizard composes valid JSON',
  'TrajWriter sanitizes secrets',
  'PersonaUpdater token cap',
  'DreamingExtension produces DREAMS.md',
  'PersonaAwareness hints derive',
  'RestraintPipeline persona integration',
]

console.log()
for (let i = 0; i < results.length; i++) {
  const { pass, note } = results[i]!
  const label = labels[i]!
  const status = pass ? 'PASS' : `FAIL: ${note}`
  const padded = `[${i + 1}/7] ${label}`.padEnd(48, '.')
  console.log(`${padded} ${status}`)
}

const allPass = results.every(r => r.pass)
console.log()
if (allPass) {
  console.log('=== Gate verdict: PASS ✓ ===')
} else {
  console.log('=== Gate verdict: FAIL ✗ ===')
  results.forEach((r, i) => {
    if (!r.pass) console.log(`  FAIL [${i + 1}/7]: ${r.note}`)
  })
}

process.exit(allPass ? 0 : 1)
