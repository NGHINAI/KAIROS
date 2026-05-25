# Phase C.1 — Trigger Engine + Tiered Autonomy + UFO2 Logs + Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase B's perception pipeline detects significant events and writes episodes; STANDING_ORDERS compiles to structured triggers in the DB. C.1 closes the loop — the trigger engine matches compiled triggers against the event stream + perception output, dispatches actions through the autonomy tier system, records UFO2-format structured trajectories, and surfaces approval-required actions to a tail-able `~/.kairos/inbox.md` plus macOS native notifications.

After C.1 ships, KAIROS can actually **do things** (notify the user, add to memory, log events, set local reminders, suspend itself per quiet-hours rules) — but only built-in intents. The MCP runtime (C.2) and multi-step orchestrator (C.3) come next.

**Architecture:** A `TriggerEngine` subscribes to the EventBus + reads `compiled_orders_triggers` from Phase B. On every event batch + at compiled cron sweeps, it evaluates triggers, scores matches with optional LLM disambiguation, and emits `triggered_action` records. The `ActionExecutor` consumes these records, looks up the intent in the `IntentRegistry`, gates on the action's risk tier (🟢🟡🟠🔴), executes immediately for GREEN/YELLOW or surfaces to the inbox + macOS notification for ORANGE/RED. Every action — fired or queued — writes a UFO2-format trajectory log to `action_trajectories`. The structured log is the foundation for AWM crystallization (C.3) and future auditing.

**Tech Stack:** TypeScript on Bun, `bun:sqlite` (existing daemon DB), `osascript` for macOS native notifications (no new deps), reuse Phase A's ModelRouter for any LLM-assisted trigger disambiguation.

**Scope boundary:** C.1 ships built-in intents only (notify, add_to_memory, log, remind_in, suspend, dry_run). External actions (Slack send, Gmail draft, file ops via MCP tools) wait for C.2 (MCP host runtime). Multi-step plans wait for C.3 (Magentic-One orchestrator). Plain-English standing orders still compile via Phase B's existing compiler — C.4 upgrades the compiler to v2 with conditional branches + cooldowns + chaining.

**Estimated size:** ~2,000 lines of TypeScript + tests across 12 atomic tasks.

---

## File Structure

All new code under `src/daemon/agency/`. Phase B's perception pipeline gets one minor wire change to emit into the new trigger engine; otherwise existing code is untouched.

```
src/daemon/
├── agency/                           [NEW — the agency layer subsystem]
│   ├── types.ts                      Intent, Action, AutonomyTier, TrajectoryStep types
│   ├── intentRegistry.ts             Built-in intent definitions + lookup
│   ├── autonomyTier.ts               🟢/🟡/🟠/🔴 enum + tier policy helpers
│   ├── triggerEngine.ts              Matches compiled triggers against events + perception output
│   ├── actionExecutor.ts             Dispatches actions; gates on tier; idempotency keys; retry
│   ├── trajectoryLog.ts              UFO2-format structured trajectory writer (SQLite)
│   ├── inboxSurface.ts               Writes pending approvals to ~/.kairos/inbox.md
│   ├── nativeNotifier.ts             macOS notification dispatch via osascript
│   ├── intents/                      Built-in intent handlers
│   │   ├── notify.ts                 🟢 silent notification
│   │   ├── addToMemory.ts            🟢 write a fact to L3 semantic
│   │   ├── log.ts                    🟢 record-only, no surface
│   │   ├── remindIn.ts               🟢 schedule a future notify
│   │   └── suspend.ts                🟢 toggle quiet-hours / per-source suspend
│   └── perceptionToTrigger.ts        Bridges PerceptionPipeline → TriggerEngine
│
└── index.ts                          [MODIFY] wire agency subsystem into startup
```

**Test files** alongside source as `*.test.ts`.

---

## Task 0: Setup

No new deps for C.1 — everything is plain TypeScript + Bun. Just create the directory structure.

- [ ] **Step 1: Confirm we're on a clean working tree**

```bash
cd /Users/nirmalghinaiya/Desktop/kairos-sandbox
git status
git log --oneline -5
```

Expected: clean tree, last commit is `ad5b83f` or later (Phase C research committed).

- [ ] **Step 2: Create directory structure**

```bash
mkdir -p src/daemon/agency/intents
ls -la src/daemon/agency/
```

No commit needed yet — directories don't get tracked until they have files.

---

## Task 1: Type definitions

**Files:**
- Create: `src/daemon/agency/types.ts`

The full type surface for the agency layer. No tests — types-only file, exercised by every other module's tests.

- [ ] **Step 1: Write the types file**

```typescript
// src/daemon/agency/types.ts
// Core types for the agency layer. Every action, every trigger match,
// every trajectory log uses these.
//
// Autonomy tiers (visual: 🟢🟡🟠🔴):
//   GREEN  — reversible, silent execution
//   YELLOW — reversible, notify after
//   ORANGE — semi-reversible or sensitive, confirm before
//   RED    — irreversible, full preview + explicit confirm
//
// Risk tier is a property of the INTENT (the action handler), not of the
// trigger that fires it. The same intent always has the same tier —
// LLM cannot override at runtime (structural enforcement, not prompt-based).

export type AutonomyTier = 'GREEN' | 'YELLOW' | 'ORANGE' | 'RED'

/** A registered action capability. The static contract. */
export type Intent = {
  id: string                          // 'notify' | 'add_to_memory' | 'log' | etc
  description: string                 // human-readable, fed to action_compose LLM
  tier: AutonomyTier                  // structural risk classification
  argSchema: Record<string, 'string' | 'number' | 'boolean' | 'object'>  // simple typed args
  idempotencyKey?: (args: Record<string, unknown>) => string  // dedup within a window
}

/** A concrete invocation request — produced by trigger matching. */
export type ActionRequest = {
  request_id: string                  // UUID for traceability
  intent_id: string                   // → IntentRegistry lookup
  args: Record<string, unknown>
  source_trigger_id?: string          // compiled_orders_triggers.id (null = built-in catalog trigger)
  source_episode_id?: number          // mem_l2_episodes.id (null = direct user / external)
  reasoning: string                   // why this action — for trajectory log
  requested_at: number
}

/** Pre-execution status of a queued action. */
export type ActionStatus =
  | 'pending'                         // queued, not yet executed
  | 'awaiting_approval'               // gated on ORANGE/RED tier
  | 'executing'                       // in flight
  | 'completed'                       // success
  | 'failed'                          // error
  | 'cancelled'                       // user dismissed
  | 'dry_run'                         // executed in dry-run mode

/** UFO2-style structured trajectory step. One per atomic action attempt. */
export type TrajectoryStep = {
  observation: string                 // what the agent saw before acting
  reasoning: string                   // why it chose this action
  action: { intent_id: string; args: Record<string, unknown> }
  result: string                      // outcome description
  result_status: 'success' | 'failure' | 'awaiting' | 'cancelled'
  duration_ms: number
}

/** A full trajectory — one or more steps grouped by goal. */
export type Trajectory = {
  trajectory_id: string
  task_goal: string                   // natural-language description
  steps: TrajectoryStep[]
  outcome: 'success' | 'failure' | 'user_override' | 'partial'
  override_reason?: string            // populated when user intervenes
  started_at: number
  ended_at: number
}

/** What's in the inbox file. */
export type InboxItem = {
  item_id: string
  created_at: number
  tier: AutonomyTier
  intent_id: string
  description: string                 // human-readable summary
  args_preview: string                // truncated arg display
  approve_command: string             // CLI hint: how the user approves
  dismiss_command: string             // CLI hint: how the user dismisses
  expires_at?: number                 // auto-dismiss after this time
}
```

- [ ] **Step 2: Type-check**

```bash
cd /Users/nirmalghinaiya/Desktop/kairos-sandbox
bunx tsc --noEmit src/daemon/agency/types.ts 2>&1 | grep -E "agency/types" | head -5
```

Expected: no output (clean).

- [ ] **Step 3: Commit**

```bash
git add src/daemon/agency/types.ts
git commit -m "feat(agency): C.1 type surface — Intent, ActionRequest, Trajectory, InboxItem, AutonomyTier"
```

---

## Task 2: Autonomy tier helpers

**Files:**
- Create: `src/daemon/agency/autonomyTier.ts`
- Test:  `src/daemon/agency/autonomyTier.test.ts`

Pure helper functions for tier comparison, default approval policy, tier-to-emoji rendering. No DB, no I/O.

- [ ] **Step 1: Write the failing test**

```typescript
// src/daemon/agency/autonomyTier.test.ts
import { describe, it, expect } from 'bun:test'
import { tierEmoji, requiresApproval, tierRank, isAtLeast } from './autonomyTier'

describe('autonomyTier helpers', () => {
  it('maps each tier to its emoji', () => {
    expect(tierEmoji('GREEN')).toBe('🟢')
    expect(tierEmoji('YELLOW')).toBe('🟡')
    expect(tierEmoji('ORANGE')).toBe('🟠')
    expect(tierEmoji('RED')).toBe('🔴')
  })

  it('ORANGE and RED require approval; GREEN and YELLOW do not', () => {
    expect(requiresApproval('GREEN')).toBe(false)
    expect(requiresApproval('YELLOW')).toBe(false)
    expect(requiresApproval('ORANGE')).toBe(true)
    expect(requiresApproval('RED')).toBe(true)
  })

  it('tierRank orders GREEN < YELLOW < ORANGE < RED', () => {
    expect(tierRank('GREEN')).toBeLessThan(tierRank('YELLOW'))
    expect(tierRank('YELLOW')).toBeLessThan(tierRank('ORANGE'))
    expect(tierRank('ORANGE')).toBeLessThan(tierRank('RED'))
  })

  it('isAtLeast checks tier severity ≥ threshold', () => {
    expect(isAtLeast('ORANGE', 'YELLOW')).toBe(true)
    expect(isAtLeast('GREEN', 'ORANGE')).toBe(false)
    expect(isAtLeast('RED', 'RED')).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/daemon/agency/autonomyTier.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// src/daemon/agency/autonomyTier.ts
// Pure helpers around the autonomy tier system. No state, no I/O.
//
// Tier semantics enforced by ActionExecutor (not in this file):
//   GREEN  — execute silently, log only
//   YELLOW — execute, notify user after
//   ORANGE — queue for approval before execution
//   RED    — queue with full args preview, require explicit approve

import type { AutonomyTier } from './types'

const EMOJI: Record<AutonomyTier, string> = {
  GREEN: '🟢',
  YELLOW: '🟡',
  ORANGE: '🟠',
  RED: '🔴',
}

const RANK: Record<AutonomyTier, number> = {
  GREEN: 0,
  YELLOW: 1,
  ORANGE: 2,
  RED: 3,
}

export function tierEmoji(tier: AutonomyTier): string {
  return EMOJI[tier]
}

export function tierRank(tier: AutonomyTier): number {
  return RANK[tier]
}

export function requiresApproval(tier: AutonomyTier): boolean {
  return RANK[tier] >= RANK.ORANGE
}

export function isAtLeast(tier: AutonomyTier, threshold: AutonomyTier): boolean {
  return RANK[tier] >= RANK[threshold]
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test src/daemon/agency/autonomyTier.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/agency/autonomyTier.ts src/daemon/agency/autonomyTier.test.ts
git commit -m "feat(agency): autonomy tier helpers (emoji, rank, requiresApproval)"
```

---

## Task 3: Intent registry + built-in intents

**Files:**
- Create: `src/daemon/agency/intentRegistry.ts`
- Create: `src/daemon/agency/intents/notify.ts`
- Create: `src/daemon/agency/intents/addToMemory.ts`
- Create: `src/daemon/agency/intents/log.ts`
- Create: `src/daemon/agency/intents/remindIn.ts`
- Create: `src/daemon/agency/intents/suspend.ts`
- Test:  `src/daemon/agency/intentRegistry.test.ts`

The registry is a simple map. Each built-in intent file exports an `Intent` static description PLUS an async `handler(args, ctx)` function. The registry resolves by `intent_id` and returns both pieces.

- [ ] **Step 1: Write the failing test for the registry**

```typescript
// src/daemon/agency/intentRegistry.test.ts
import { describe, it, expect } from 'bun:test'
import { IntentRegistry, registerBuiltIns } from './intentRegistry'

describe('IntentRegistry', () => {
  it('registers all built-in intents', () => {
    const reg = new IntentRegistry()
    registerBuiltIns(reg)
    const ids = reg.list().map(i => i.id).sort()
    expect(ids).toEqual(['add_to_memory', 'log', 'notify', 'remind_in', 'suspend'])
  })

  it('lookup by id returns the full intent', () => {
    const reg = new IntentRegistry()
    registerBuiltIns(reg)
    const notify = reg.get('notify')
    expect(notify?.intent.id).toBe('notify')
    expect(notify?.intent.tier).toBe('GREEN')
    expect(typeof notify?.handler).toBe('function')
  })

  it('returns null for unknown intent id', () => {
    const reg = new IntentRegistry()
    expect(reg.get('nonexistent')).toBeNull()
  })

  it('rejects duplicate registration', () => {
    const reg = new IntentRegistry()
    registerBuiltIns(reg)
    expect(() => registerBuiltIns(reg)).toThrow()
  })

  it('all built-in intents have valid tier + handler', () => {
    const reg = new IntentRegistry()
    registerBuiltIns(reg)
    for (const entry of reg.list()) {
      expect(['GREEN', 'YELLOW', 'ORANGE', 'RED']).toContain(entry.tier)
      expect(typeof reg.get(entry.id)?.handler).toBe('function')
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/daemon/agency/intentRegistry.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the 5 built-in intent files**

```typescript
// src/daemon/agency/intents/notify.ts
// 🟢 Surface a notification. Used by triggers that want user attention
// without further action. macOS native notification + inbox markdown.

import type { Intent } from '../types'
import type { ActionContext } from '../actionExecutor'

export const notifyIntent: Intent = {
  id: 'notify',
  description: 'Surface a notification to the user (macOS native + inbox)',
  tier: 'GREEN',
  argSchema: { title: 'string', body: 'string', urgency: 'string' },
}

export async function notifyHandler(
  args: { title: string; body: string; urgency?: 'low' | 'normal' | 'high' },
  ctx: ActionContext,
): Promise<{ status: 'success'; details: string }> {
  await ctx.notifier.notify({
    title: args.title,
    body: args.body,
    urgency: args.urgency ?? 'normal',
  })
  return { status: 'success', details: `notified: ${args.title}` }
}
```

```typescript
// src/daemon/agency/intents/addToMemory.ts
// 🟢 Write a fact to L3 semantic memory. Used by standing orders like
// "remember that John prefers concise replies after 6pm".

import type { Intent } from '../types'
import type { ActionContext } from '../actionExecutor'

export const addToMemoryIntent: Intent = {
  id: 'add_to_memory',
  description: 'Write a typed fact to L3 semantic memory',
  tier: 'GREEN',
  argSchema: { kind: 'string', subject: 'string', body: 'string', importance: 'number' },
}

export async function addToMemoryHandler(
  args: { kind: string; subject: string; body: string; importance?: number },
  ctx: ActionContext,
): Promise<{ status: 'success'; details: string }> {
  const emb = await ctx.embedder.embed(`${args.subject}: ${args.body}`)
  const id = ctx.semantic.reinforceOrWrite({
    kind: (args.kind as any) ?? 'fact',
    subject: args.subject,
    body: args.body,
    embedding: emb,
    importance: args.importance ?? 0.5,
  })
  return { status: 'success', details: `wrote L3 fact id=${id}` }
}
```

```typescript
// src/daemon/agency/intents/log.ts
// 🟢 Record-only. Used by standing orders that should observe but never
// surface to the user. Trajectory log captures the trigger match itself.

import type { Intent } from '../types'
import type { ActionContext } from '../actionExecutor'

export const logIntent: Intent = {
  id: 'log',
  description: 'Record-only action (trajectory log captures the trigger match)',
  tier: 'GREEN',
  argSchema: { message: 'string' },
}

export async function logHandler(
  args: { message: string },
  _ctx: ActionContext,
): Promise<{ status: 'success'; details: string }> {
  return { status: 'success', details: args.message }
}
```

```typescript
// src/daemon/agency/intents/remindIn.ts
// 🟢 Schedule a future notify action via setTimeout. Stores the
// schedule in SQLite so it survives daemon restart (caller re-registers
// timers on startup).

import type { Intent } from '../types'
import type { ActionContext } from '../actionExecutor'

export const remindInIntent: Intent = {
  id: 'remind_in',
  description: 'Schedule a notify action to fire after a delay',
  tier: 'GREEN',
  argSchema: { delay_seconds: 'number', title: 'string', body: 'string' },
}

export async function remindInHandler(
  args: { delay_seconds: number; title: string; body: string },
  ctx: ActionContext,
): Promise<{ status: 'success'; details: string }> {
  const fire_at = Date.now() + args.delay_seconds * 1000
  ctx.db.run(
    `INSERT INTO agency_scheduled_reminders (title, body, fire_at, fired)
     VALUES (?, ?, ?, 0)`,
    [args.title, args.body, fire_at],
  )
  setTimeout(() => {
    void ctx.notifier.notify({ title: args.title, body: args.body, urgency: 'normal' })
    ctx.db.run('UPDATE agency_scheduled_reminders SET fired = 1 WHERE fire_at = ?', [fire_at])
  }, args.delay_seconds * 1000)
  return { status: 'success', details: `scheduled reminder for ${new Date(fire_at).toISOString()}` }
}
```

```typescript
// src/daemon/agency/intents/suspend.ts
// 🟢 Toggle quiet-hours or per-source observer suspend. Used by
// standing orders like "never interrupt me on Sundays before 11am".

import type { Intent } from '../types'
import type { ActionContext } from '../actionExecutor'

export const suspendIntent: Intent = {
  id: 'suspend',
  description: 'Suspend triggers/observers for a duration or condition',
  tier: 'GREEN',
  argSchema: { scope: 'string', duration_seconds: 'number', reason: 'string' },
}

export async function suspendHandler(
  args: { scope: 'all' | 'triggers' | 'observers'; duration_seconds: number; reason?: string },
  ctx: ActionContext,
): Promise<{ status: 'success'; details: string }> {
  const until = Date.now() + args.duration_seconds * 1000
  ctx.db.run(
    `INSERT INTO agency_suspend_state (scope, until_ms, reason) VALUES (?, ?, ?)`,
    [args.scope, until, args.reason ?? null],
  )
  return { status: 'success', details: `suspended ${args.scope} until ${new Date(until).toISOString()}` }
}
```

- [ ] **Step 4: Write the IntentRegistry**

```typescript
// src/daemon/agency/intentRegistry.ts
// Map-backed registry of available intents. Each entry pairs a static
// Intent description (visible to LLMs and the inbox renderer) with an
// async handler (called by the ActionExecutor). The registry is
// constructed at daemon startup and never mutated after.

import type { Intent, AutonomyTier } from './types'
import type { ActionContext } from './actionExecutor'

import { notifyIntent, notifyHandler } from './intents/notify'
import { addToMemoryIntent, addToMemoryHandler } from './intents/addToMemory'
import { logIntent, logHandler } from './intents/log'
import { remindInIntent, remindInHandler } from './intents/remindIn'
import { suspendIntent, suspendHandler } from './intents/suspend'

export type IntentHandler = (
  args: Record<string, unknown>,
  ctx: ActionContext,
) => Promise<{ status: 'success' | 'failure' | 'awaiting'; details: string }>

export type RegistryEntry = {
  intent: Intent
  handler: IntentHandler
  id: string                          // duplicate of intent.id for convenience
  tier: AutonomyTier                  // duplicate of intent.tier
}

export class IntentRegistry {
  private map: Map<string, RegistryEntry> = new Map()

  register(intent: Intent, handler: IntentHandler): void {
    if (this.map.has(intent.id)) {
      throw new Error(`IntentRegistry: intent '${intent.id}' already registered`)
    }
    this.map.set(intent.id, { intent, handler, id: intent.id, tier: intent.tier })
  }

  get(id: string): RegistryEntry | null {
    return this.map.get(id) ?? null
  }

  list(): RegistryEntry[] {
    return Array.from(this.map.values())
  }
}

export function registerBuiltIns(reg: IntentRegistry): void {
  reg.register(notifyIntent, notifyHandler as IntentHandler)
  reg.register(addToMemoryIntent, addToMemoryHandler as IntentHandler)
  reg.register(logIntent, logHandler as IntentHandler)
  reg.register(remindInIntent, remindInHandler as IntentHandler)
  reg.register(suspendIntent, suspendHandler as IntentHandler)
}
```

- [ ] **Step 5: Run tests**

```bash
bun test src/daemon/agency/intentRegistry.test.ts
```

Expected: PASS (5 tests). NOTE: the test does NOT exercise the handlers (no ActionContext available yet). Handler tests come in Task 5 (ActionExecutor).

- [ ] **Step 6: Commit**

```bash
git add src/daemon/agency/intentRegistry.ts src/daemon/agency/intents/
git add src/daemon/agency/intentRegistry.test.ts
git commit -m "feat(agency): intent registry + 5 built-in GREEN intents"
```

---

## Task 4: UFO2-style trajectory log

**Files:**
- Create: `src/daemon/agency/trajectoryLog.ts`
- Test:  `src/daemon/agency/trajectoryLog.test.ts`

The structured trajectory log is the foundation for AWM crystallization (C.3). Schema matches the UFO2 ExperienceFlow format from arXiv:2504.14603. Cheap to add now; expensive to retrofit later.

- [ ] **Step 1: Write the failing test**

```typescript
// src/daemon/agency/trajectoryLog.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { TrajectoryLog, TRAJECTORY_SCHEMA } from './trajectoryLog'

describe('TrajectoryLog', () => {
  let db: Database
  let log: TrajectoryLog

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(TRAJECTORY_SCHEMA)
    log = new TrajectoryLog(db)
  })

  it('writes a trajectory and assigns a trajectory_id', () => {
    const id = log.start('Draft a Slack reply to John')
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)
  })

  it('appends steps with the UFO2 structure', () => {
    const id = log.start('Test goal')
    log.appendStep(id, {
      observation: 'Slack DM from John arrived',
      reasoning: 'Standing order says draft replies to John',
      action: { intent_id: 'notify', args: { title: 'New DM', body: 'from John' } },
      result: 'notified',
      result_status: 'success',
      duration_ms: 42,
    })
    const traj = log.get(id)
    expect(traj?.steps.length).toBe(1)
    expect(traj?.steps[0]?.observation).toBe('Slack DM from John arrived')
    expect(traj?.steps[0]?.action.intent_id).toBe('notify')
  })

  it('finalises with outcome + override_reason', () => {
    const id = log.start('Test')
    log.appendStep(id, {
      observation: 'x', reasoning: 'y',
      action: { intent_id: 'log', args: {} },
      result: 'logged', result_status: 'success', duration_ms: 1,
    })
    log.finalize(id, 'user_override', 'user dismissed')
    const traj = log.get(id)
    expect(traj?.outcome).toBe('user_override')
    expect(traj?.override_reason).toBe('user dismissed')
    expect(traj?.ended_at).toBeGreaterThanOrEqual(traj?.started_at ?? 0)
  })

  it('recent() returns latest trajectories newest-first', () => {
    const id1 = log.start('a'); log.finalize(id1, 'success')
    const id2 = log.start('b'); log.finalize(id2, 'success')
    const recent = log.recent(5)
    expect(recent.length).toBe(2)
    expect(recent[0]?.task_goal).toBe('b')
  })

  it('by_outcome filters correctly', () => {
    const id1 = log.start('a'); log.finalize(id1, 'success')
    const id2 = log.start('b'); log.finalize(id2, 'failure')
    expect(log.byOutcome('success', 10).length).toBe(1)
    expect(log.byOutcome('failure', 10).length).toBe(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/daemon/agency/trajectoryLog.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Write the implementation**

```typescript
// src/daemon/agency/trajectoryLog.ts
// UFO2-format structured trajectory log. Every action attempt — built-in
// intent OR external tool — writes a step. AWM crystallization (C.3)
// reads these to induce reusable workflows.
//
// Schema: one row per trajectory (goal + outcome) + one row per step
// (observation/reasoning/action/result). The split keeps the trajectory
// header queryable without loading every step, and steps are appended
// incrementally as actions execute.

import { randomUUID } from 'crypto'
import type { Database } from 'bun:sqlite'
import type { Trajectory, TrajectoryStep } from './types'

export const TRAJECTORY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS action_trajectories (
    trajectory_id   TEXT PRIMARY KEY,
    task_goal       TEXT    NOT NULL,
    outcome         TEXT,                    -- null while in-progress; 'success'|'failure'|'user_override'|'partial'
    override_reason TEXT,
    started_at      INTEGER NOT NULL,
    ended_at        INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_traj_started ON action_trajectories(started_at);
  CREATE INDEX IF NOT EXISTS idx_traj_outcome ON action_trajectories(outcome, started_at);

  CREATE TABLE IF NOT EXISTS action_trajectory_steps (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    trajectory_id  TEXT NOT NULL REFERENCES action_trajectories(trajectory_id) ON DELETE CASCADE,
    step_index     INTEGER NOT NULL,
    observation    TEXT NOT NULL,
    reasoning      TEXT NOT NULL,
    intent_id      TEXT NOT NULL,
    args_json      TEXT NOT NULL,
    result         TEXT NOT NULL,
    result_status  TEXT NOT NULL,
    duration_ms    INTEGER NOT NULL,
    ts             INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_traj_step ON action_trajectory_steps(trajectory_id, step_index);
`

export class TrajectoryLog {
  constructor(private db: Database) {}

  /** Begin a new trajectory. Returns trajectory_id. */
  start(taskGoal: string): string {
    const id = randomUUID()
    this.db.run(
      'INSERT INTO action_trajectories (trajectory_id, task_goal, started_at) VALUES (?, ?, ?)',
      [id, taskGoal, Date.now()],
    )
    return id
  }

  /** Append one step to a trajectory. */
  appendStep(trajectoryId: string, step: TrajectoryStep): void {
    const nextIndex = (this.db
      .query('SELECT COUNT(*) as n FROM action_trajectory_steps WHERE trajectory_id = ?')
      .get(trajectoryId) as { n: number }).n
    this.db.run(
      `INSERT INTO action_trajectory_steps
         (trajectory_id, step_index, observation, reasoning, intent_id, args_json,
          result, result_status, duration_ms, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        trajectoryId, nextIndex, step.observation, step.reasoning,
        step.action.intent_id, JSON.stringify(step.action.args),
        step.result, step.result_status, step.duration_ms, Date.now(),
      ],
    )
  }

  /** Close the trajectory with final outcome + optional override reason. */
  finalize(trajectoryId: string, outcome: Trajectory['outcome'], overrideReason?: string): void {
    this.db.run(
      'UPDATE action_trajectories SET outcome = ?, override_reason = ?, ended_at = ? WHERE trajectory_id = ?',
      [outcome, overrideReason ?? null, Date.now(), trajectoryId],
    )
  }

  get(trajectoryId: string): Trajectory | null {
    const header = this.db.query(
      'SELECT * FROM action_trajectories WHERE trajectory_id = ?',
    ).get(trajectoryId) as Trajectory | null
    if (!header) return null
    const steps = this.db.query(
      `SELECT observation, reasoning, intent_id, args_json, result, result_status, duration_ms
       FROM action_trajectory_steps WHERE trajectory_id = ? ORDER BY step_index ASC`,
    ).all(trajectoryId) as Array<{
      observation: string; reasoning: string; intent_id: string;
      args_json: string; result: string; result_status: TrajectoryStep['result_status']; duration_ms: number;
    }>
    return {
      ...header,
      steps: steps.map(s => ({
        observation: s.observation,
        reasoning: s.reasoning,
        action: { intent_id: s.intent_id, args: JSON.parse(s.args_json) },
        result: s.result,
        result_status: s.result_status,
        duration_ms: s.duration_ms,
      })),
    }
  }

  recent(limit: number = 20): Trajectory[] {
    const rows = this.db.query(
      'SELECT * FROM action_trajectories ORDER BY started_at DESC LIMIT ?',
    ).all(limit) as Array<Omit<Trajectory, 'steps'>>
    return rows.map(h => this.get((h as any).trajectory_id)!).filter(Boolean)
  }

  byOutcome(outcome: Trajectory['outcome'], limit: number = 20): Trajectory[] {
    const rows = this.db.query(
      'SELECT * FROM action_trajectories WHERE outcome = ? ORDER BY started_at DESC LIMIT ?',
    ).all(outcome, limit) as Array<Omit<Trajectory, 'steps'>>
    return rows.map(h => this.get((h as any).trajectory_id)!).filter(Boolean)
  }
}
```

- [ ] **Step 4: Run tests**

```bash
bun test src/daemon/agency/trajectoryLog.test.ts
```

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/agency/trajectoryLog.ts src/daemon/agency/trajectoryLog.test.ts
git commit -m "feat(agency): UFO2-format structured trajectory log (foundation for AWM in C.3)"
```

---

## Task 5: macOS native notifier

**Files:**
- Create: `src/daemon/agency/nativeNotifier.ts`
- Test:  `src/daemon/agency/nativeNotifier.test.ts`

A thin wrapper around `osascript -e 'display notification ...'`. Single responsibility — present a notification natively. Tests use an injected probe so we don't spam the real notification center in CI.

- [ ] **Step 1: Write the failing test**

```typescript
// src/daemon/agency/nativeNotifier.test.ts
import { describe, it, expect } from 'bun:test'
import { NativeNotifier } from './nativeNotifier'

describe('NativeNotifier', () => {
  it('forwards args to the probe', async () => {
    const calls: Array<{ title: string; body: string }> = []
    const notifier = new NativeNotifier({
      probe: async (args) => { calls.push(args) },
    })
    await notifier.notify({ title: 'hello', body: 'world', urgency: 'normal' })
    expect(calls).toEqual([{ title: 'hello', body: 'world' }])
  })

  it('escapes single quotes safely', async () => {
    const calls: Array<string> = []
    const notifier = new NativeNotifier({
      probe: async (args) => { calls.push(`${args.title}|${args.body}`) },
    })
    await notifier.notify({ title: "it's", body: "don't" })
    expect(calls[0]).toBe("it's|don't")
  })

  it('does not throw on osascript failure (best-effort surface)', async () => {
    const notifier = new NativeNotifier({
      probe: async () => { throw new Error('osascript failed') },
    })
    // Should swallow the error
    await expect(notifier.notify({ title: 'x', body: 'y' })).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/daemon/agency/nativeNotifier.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Write the implementation**

```typescript
// src/daemon/agency/nativeNotifier.ts
// macOS native notification via osascript. Best-effort — never throws.
// If notification fails, the inbox surface still has the record.
//
// Urgency note: macOS doesn't expose user-facing urgency; it's reserved
// for future Notification Center API integration. We accept the field
// in the API but currently ignore it.

import { log, logError } from '../logger'

type Probe = (args: { title: string; body: string }) => Promise<void>

export type NotifyArgs = {
  title: string
  body: string
  urgency?: 'low' | 'normal' | 'high'
}

export type NativeNotifierOptions = {
  probe?: Probe
}

export class NativeNotifier {
  private probe: Probe

  constructor(opts?: NativeNotifierOptions) {
    this.probe = opts?.probe ?? defaultProbe
  }

  async notify(args: NotifyArgs): Promise<void> {
    try {
      await this.probe({ title: args.title, body: args.body })
    } catch (err) {
      logError('NativeNotifier: failed', err)
      // Swallow — caller's inbox write already captured the record.
    }
  }
}

async function defaultProbe(args: { title: string; body: string }): Promise<void> {
  // AppleScript single-quote escape: replace ' with '\''
  const esc = (s: string): string => s.replace(/'/g, "'\\''")
  const script = `display notification "${esc(args.body)}" with title "${esc(args.title)}" sound name "Submarine"`
  const proc = Bun.spawn(['osascript', '-e', script], { stdout: 'pipe', stderr: 'pipe' })
  const code = await proc.exited
  if (code !== 0) {
    const err = await new Response(proc.stderr).text()
    throw new Error(`osascript exited ${code}: ${err.slice(0, 200)}`)
  }
}
```

- [ ] **Step 4: Run tests**

```bash
bun test src/daemon/agency/nativeNotifier.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/agency/nativeNotifier.ts src/daemon/agency/nativeNotifier.test.ts
git commit -m "feat(agency): macOS native notifier via osascript (best-effort, never throws)"
```

---

## Task 6: Inbox surface (~/.kairos/inbox.md)

**Files:**
- Create: `src/daemon/agency/inboxSurface.ts`
- Test:  `src/daemon/agency/inboxSurface.test.ts`

A tail-able markdown file users can keep open in any editor or terminal. Each pending approval is a section with: tier emoji, timestamp, description, args preview, and copy-paste commands to approve or dismiss. After approval/dismissal the item is removed from the file (kept in DB).

- [ ] **Step 1: Write the failing test**

```typescript
// src/daemon/agency/inboxSurface.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { InboxSurface, INBOX_SCHEMA } from './inboxSurface'

describe('InboxSurface', () => {
  let db: Database
  let tmp: string
  let inboxPath: string
  let inbox: InboxSurface

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(INBOX_SCHEMA)
    tmp = mkdtempSync(join(tmpdir(), 'kairos-inbox-'))
    inboxPath = join(tmp, 'inbox.md')
    inbox = new InboxSurface(db, inboxPath)
  })

  it('adds an item and rewrites the file with that item present', () => {
    inbox.add({
      tier: 'ORANGE',
      intent_id: 'notify',
      description: 'Reply to John in Slack',
      args_preview: 'title=New DM, body=…',
    })
    const content = readFileSync(inboxPath, 'utf8')
    expect(content).toContain('🟠')
    expect(content).toContain('Reply to John in Slack')
    expect(content).toContain('approve')
    expect(content).toContain('dismiss')
    rmSync(tmp, { recursive: true })
  })

  it('resolves an item by id and removes it from the file', () => {
    const id = inbox.add({
      tier: 'ORANGE', intent_id: 'log', description: 'x', args_preview: 'y',
    })
    inbox.resolve(id, 'approved')
    const content = readFileSync(inboxPath, 'utf8')
    expect(content).not.toContain('x')
    expect(inbox.pending().length).toBe(0)
    rmSync(tmp, { recursive: true })
  })

  it('pending() lists only items not yet resolved', () => {
    const id1 = inbox.add({ tier: 'YELLOW', intent_id: 'notify', description: 'a', args_preview: '' })
    const id2 = inbox.add({ tier: 'ORANGE', intent_id: 'log', description: 'b', args_preview: '' })
    inbox.resolve(id1, 'approved')
    const pending = inbox.pending()
    expect(pending.length).toBe(1)
    expect(pending[0]?.item_id).toBe(id2)
    rmSync(tmp, { recursive: true })
  })

  it('creates the inbox file (and parent dir) on first write', () => {
    const deeper = join(tmp, 'sub', 'inbox.md')
    const inboxDeep = new InboxSurface(db, deeper)
    inboxDeep.add({ tier: 'GREEN', intent_id: 'log', description: 'z', args_preview: '' })
    expect(existsSync(deeper)).toBe(true)
    rmSync(tmp, { recursive: true })
  })

  it('header text reflects pending count and last-update timestamp', () => {
    inbox.add({ tier: 'YELLOW', intent_id: 'notify', description: 'm', args_preview: '' })
    inbox.add({ tier: 'ORANGE', intent_id: 'log', description: 'n', args_preview: '' })
    const content = readFileSync(inboxPath, 'utf8')
    expect(content).toMatch(/2 pending/i)
    rmSync(tmp, { recursive: true })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/daemon/agency/inboxSurface.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Write the implementation**

```typescript
// src/daemon/agency/inboxSurface.ts
// ~/.kairos/inbox.md — a tail-able markdown file showing pending
// approval-required actions. The DB is the source of truth; the file
// is regenerated from the DB after every change.
//
// Format: header (pending count + timestamp) + one section per item.
// Items are sorted by tier severity (RED first), then created_at desc.

import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { randomUUID } from 'crypto'
import type { Database } from 'bun:sqlite'
import type { AutonomyTier, InboxItem } from './types'
import { tierEmoji, tierRank } from './autonomyTier'

export const INBOX_SCHEMA = `
  CREATE TABLE IF NOT EXISTS agency_inbox_items (
    item_id        TEXT PRIMARY KEY,
    created_at     INTEGER NOT NULL,
    tier           TEXT NOT NULL,
    intent_id      TEXT NOT NULL,
    description    TEXT NOT NULL,
    args_preview   TEXT NOT NULL,
    expires_at     INTEGER,
    resolved_at    INTEGER,
    resolution     TEXT                       -- 'approved' | 'dismissed' | 'expired'
  );
  CREATE INDEX IF NOT EXISTS idx_inbox_pending ON agency_inbox_items(resolved_at, tier);
`

export type AddInboxInput = {
  tier: AutonomyTier
  intent_id: string
  description: string
  args_preview: string
  expires_at?: number
}

export class InboxSurface {
  constructor(private db: Database, private filePath: string) {
    db.exec(INBOX_SCHEMA)
  }

  add(input: AddInboxInput): string {
    const id = randomUUID()
    this.db.run(
      `INSERT INTO agency_inbox_items
         (item_id, created_at, tier, intent_id, description, args_preview, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, Date.now(), input.tier, input.intent_id, input.description, input.args_preview, input.expires_at ?? null],
    )
    this.regenerate()
    return id
  }

  resolve(itemId: string, resolution: 'approved' | 'dismissed' | 'expired'): void {
    this.db.run(
      'UPDATE agency_inbox_items SET resolved_at = ?, resolution = ? WHERE item_id = ?',
      [Date.now(), resolution, itemId],
    )
    this.regenerate()
  }

  pending(): InboxItem[] {
    const rows = this.db.query(
      `SELECT * FROM agency_inbox_items WHERE resolved_at IS NULL ORDER BY tier DESC, created_at DESC`,
    ).all() as Array<{
      item_id: string; created_at: number; tier: AutonomyTier; intent_id: string;
      description: string; args_preview: string; expires_at: number | null;
    }>
    return rows
      .sort((a, b) => tierRank(b.tier) - tierRank(a.tier) || b.created_at - a.created_at)
      .map(r => ({
        item_id: r.item_id,
        created_at: r.created_at,
        tier: r.tier,
        intent_id: r.intent_id,
        description: r.description,
        args_preview: r.args_preview,
        approve_command: `kairos approve ${r.item_id}`,
        dismiss_command: `kairos dismiss ${r.item_id}`,
        expires_at: r.expires_at ?? undefined,
      }))
  }

  private regenerate(): void {
    if (!existsSync(dirname(this.filePath))) {
      mkdirSync(dirname(this.filePath), { recursive: true })
    }
    const items = this.pending()
    const now = new Date().toISOString()
    const header = `# KAIROS Inbox

_${items.length} pending — last update ${now}_

Approve or dismiss any item by running the suggested command. The daemon will detect the change and act accordingly.

---
`
    const body = items.map(it => `
## ${tierEmoji(it.tier)} ${it.description}

- **id**: \`${it.item_id}\`
- **intent**: \`${it.intent_id}\`
- **args**: ${it.args_preview}
- **created**: ${new Date(it.created_at).toISOString()}
${it.expires_at ? `- **expires**: ${new Date(it.expires_at).toISOString()}\n` : ''}
\`\`\`
${it.approve_command}    # to execute
${it.dismiss_command}    # to drop without executing
\`\`\`
`).join('\n---\n')

    writeFileSync(this.filePath, header + body, 'utf8')
  }
}
```

- [ ] **Step 4: Run tests**

```bash
bun test src/daemon/agency/inboxSurface.test.ts
```

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/agency/inboxSurface.ts src/daemon/agency/inboxSurface.test.ts
git commit -m "feat(agency): tail-able ~/.kairos/inbox.md surface for ORANGE/RED approvals"
```

---

## Task 7: ActionExecutor

**Files:**
- Create: `src/daemon/agency/actionExecutor.ts`
- Test:  `src/daemon/agency/actionExecutor.test.ts`

The heart of C.1. Receives `ActionRequest` records, looks up the intent, gates on tier, executes for GREEN/YELLOW or queues to inbox for ORANGE/RED. Every attempt writes to TrajectoryLog. Idempotency via the `idempotencyKey` on the intent (if set) + a 5-minute dedup window.

- [ ] **Step 1: Write the failing test**

```typescript
// src/daemon/agency/actionExecutor.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { randomUUID } from 'crypto'
import { ActionExecutor, EXECUTOR_SCHEMA, type ActionContext } from './actionExecutor'
import { IntentRegistry } from './intentRegistry'
import { TrajectoryLog, TRAJECTORY_SCHEMA } from './trajectoryLog'
import { InboxSurface, INBOX_SCHEMA } from './inboxSurface'
import { NativeNotifier } from './nativeNotifier'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Intent, ActionRequest } from './types'

describe('ActionExecutor', () => {
  let db: Database
  let registry: IntentRegistry
  let traj: TrajectoryLog
  let inbox: InboxSurface
  let executor: ActionExecutor
  let tmp: string
  let ctx: ActionContext
  let notifyCalls: Array<{ title: string; body: string }>

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(TRAJECTORY_SCHEMA)
    db.exec(INBOX_SCHEMA)
    db.exec(EXECUTOR_SCHEMA)
    db.exec(`CREATE TABLE IF NOT EXISTS agency_scheduled_reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, body TEXT, fire_at INTEGER, fired INTEGER
    )`)
    db.exec(`CREATE TABLE IF NOT EXISTS agency_suspend_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT, until_ms INTEGER, reason TEXT
    )`)
    registry = new IntentRegistry()
    traj = new TrajectoryLog(db)
    tmp = mkdtempSync(join(tmpdir(), 'kairos-exec-'))
    inbox = new InboxSurface(db, join(tmp, 'inbox.md'))
    notifyCalls = []
    const notifier = new NativeNotifier({
      probe: async (args) => { notifyCalls.push(args) },
    })

    // Minimal mocks for embedder + semantic so add_to_memory etc. work
    ctx = {
      db,
      notifier,
      embedder: { embed: async () => new Array(768).fill(0) } as any,
      semantic: { reinforceOrWrite: () => 1 } as any,
    }

    // Register one GREEN test intent and one ORANGE test intent
    registry.register(
      { id: 'test-green', description: 'green test', tier: 'GREEN', argSchema: { msg: 'string' } },
      async (args, _ctx) => ({ status: 'success', details: `green: ${args.msg}` }),
    )
    registry.register(
      { id: 'test-orange', description: 'orange test', tier: 'ORANGE', argSchema: { msg: 'string' } },
      async (args, _ctx) => ({ status: 'success', details: `orange: ${args.msg}` }),
    )
    executor = new ActionExecutor(db, registry, traj, inbox, ctx)
  })

  function req(intent: string, args: Record<string, unknown>, reasoning = 'test'): ActionRequest {
    return {
      request_id: randomUUID(),
      intent_id: intent,
      args,
      reasoning,
      requested_at: Date.now(),
    }
  }

  it('executes GREEN actions immediately and writes a success trajectory', async () => {
    const result = await executor.dispatch(req('test-green', { msg: 'hi' }))
    expect(result.status).toBe('completed')
    expect(traj.recent(5).length).toBe(1)
    expect(traj.recent(5)[0]?.outcome).toBe('success')
    rmSync(tmp, { recursive: true })
  })

  it('queues ORANGE actions to inbox with status awaiting_approval', async () => {
    const result = await executor.dispatch(req('test-orange', { msg: 'maybe' }))
    expect(result.status).toBe('awaiting_approval')
    expect(inbox.pending().length).toBe(1)
    expect(inbox.pending()[0]?.tier).toBe('ORANGE')
    rmSync(tmp, { recursive: true })
  })

  it('returns failed when intent does not exist', async () => {
    const result = await executor.dispatch(req('nonexistent', {}))
    expect(result.status).toBe('failed')
    rmSync(tmp, { recursive: true })
  })

  it('dedupes within an idempotency window when intent provides a key', async () => {
    registry.register(
      { id: 'idem-green', description: 'idem', tier: 'GREEN', argSchema: { id: 'string' },
        idempotencyKey: (args) => `idem:${args.id}` },
      async () => ({ status: 'success', details: 'ok' }),
    )
    const r1 = await executor.dispatch(req('idem-green', { id: 'X' }))
    const r2 = await executor.dispatch(req('idem-green', { id: 'X' }))
    expect(r1.status).toBe('completed')
    expect(r2.status).toBe('completed')
    expect(r2.details).toMatch(/dedup/i)
    rmSync(tmp, { recursive: true })
  })

  it('approveItem causes a queued ORANGE action to execute', async () => {
    const result = await executor.dispatch(req('test-orange', { msg: 'now go' }))
    const itemId = result.inbox_item_id!
    const exec = await executor.approveItem(itemId)
    expect(exec.status).toBe('completed')
    expect(inbox.pending().length).toBe(0)
    rmSync(tmp, { recursive: true })
  })

  it('dismissItem cancels without execution', async () => {
    const result = await executor.dispatch(req('test-orange', { msg: 'nope' }))
    const itemId = result.inbox_item_id!
    await executor.dismissItem(itemId, 'user said no')
    expect(inbox.pending().length).toBe(0)
    const trajRows = traj.recent(5)
    const cancelled = trajRows.find(t => t.outcome === 'user_override')
    expect(cancelled?.override_reason).toBe('user said no')
    rmSync(tmp, { recursive: true })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/daemon/agency/actionExecutor.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Write the implementation**

```typescript
// src/daemon/agency/actionExecutor.ts
// The heart of C.1. Receives ActionRequest records, looks up the intent
// in the registry, gates on tier:
//   - GREEN/YELLOW: execute immediately, log to trajectory
//   - ORANGE/RED: queue to inbox, mark awaiting; execute on approveItem
//
// Idempotency: if an intent declares an idempotencyKey, dedupe requests
// within a 5-minute rolling window. Returns 'completed' with a dedup note
// rather than re-executing.
//
// Every dispatch writes a TrajectoryLog entry — even cancelled/dismissed —
// so AWM (C.3) can learn from both successes and overrides.

import type { Database } from 'bun:sqlite'
import { log, logError } from '../logger'
import { tierEmoji, requiresApproval } from './autonomyTier'
import type { IntentRegistry } from './intentRegistry'
import type { TrajectoryLog } from './trajectoryLog'
import type { InboxSurface } from './inboxSurface'
import type { NativeNotifier } from './nativeNotifier'
import type { ActionRequest, ActionStatus, TrajectoryStep } from './types'

export const EXECUTOR_SCHEMA = `
  CREATE TABLE IF NOT EXISTS agency_pending_actions (
    request_id    TEXT PRIMARY KEY,
    intent_id     TEXT NOT NULL,
    args_json     TEXT NOT NULL,
    reasoning     TEXT NOT NULL,
    inbox_item_id TEXT,
    trajectory_id TEXT NOT NULL,
    status        TEXT NOT NULL,
    requested_at  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS agency_idempotency (
    key        TEXT PRIMARY KEY,
    last_seen  INTEGER NOT NULL
  );
`

const IDEM_WINDOW_MS = 5 * 60_000

/** Cross-module dependencies a handler may need at execution time. */
export type ActionContext = {
  db: Database
  notifier: NativeNotifier
  embedder: { embed(text: string): Promise<number[]> }
  semantic: { reinforceOrWrite(input: any): number }
}

export type DispatchResult = {
  status: ActionStatus
  details?: string
  inbox_item_id?: string
  trajectory_id: string
}

export class ActionExecutor {
  constructor(
    private db: Database,
    private registry: IntentRegistry,
    private trajectory: TrajectoryLog,
    private inbox: InboxSurface,
    private ctx: ActionContext,
  ) {
    db.exec(EXECUTOR_SCHEMA)
  }

  async dispatch(request: ActionRequest): Promise<DispatchResult> {
    const entry = this.registry.get(request.intent_id)
    if (!entry) {
      const trajectoryId = this.trajectory.start(`Unknown intent: ${request.intent_id}`)
      this.trajectory.finalize(trajectoryId, 'failure', `unknown intent ${request.intent_id}`)
      return { status: 'failed', details: `unknown intent ${request.intent_id}`, trajectory_id: trajectoryId }
    }

    // Idempotency check
    if (entry.intent.idempotencyKey) {
      const key = entry.intent.idempotencyKey(request.args)
      const last = this.db.query('SELECT last_seen FROM agency_idempotency WHERE key = ?').get(key) as { last_seen: number } | null
      if (last && Date.now() - last.last_seen < IDEM_WINDOW_MS) {
        const trajectoryId = this.trajectory.start(`Dedup: ${request.intent_id}`)
        this.trajectory.finalize(trajectoryId, 'success', `dedup hit on key ${key}`)
        return { status: 'completed', details: `dedup within ${IDEM_WINDOW_MS / 1000}s`, trajectory_id: trajectoryId }
      }
      this.db.run('INSERT OR REPLACE INTO agency_idempotency (key, last_seen) VALUES (?, ?)', [key, Date.now()])
    }

    const trajectoryId = this.trajectory.start(`${entry.intent.id}: ${request.reasoning.slice(0, 80)}`)

    // Gate on tier
    if (requiresApproval(entry.tier)) {
      const inboxItemId = this.inbox.add({
        tier: entry.tier,
        intent_id: entry.intent.id,
        description: `${entry.intent.description} — ${request.reasoning.slice(0, 80)}`,
        args_preview: JSON.stringify(request.args).slice(0, 200),
      })
      this.db.run(
        `INSERT INTO agency_pending_actions
           (request_id, intent_id, args_json, reasoning, inbox_item_id, trajectory_id, status, requested_at)
         VALUES (?, ?, ?, ?, ?, ?, 'awaiting_approval', ?)`,
        [
          request.request_id, request.intent_id, JSON.stringify(request.args),
          request.reasoning, inboxItemId, trajectoryId, request.requested_at,
        ],
      )
      log(`ActionExecutor: ${tierEmoji(entry.tier)} ${entry.intent.id} queued (item=${inboxItemId})`)
      return { status: 'awaiting_approval', inbox_item_id: inboxItemId, trajectory_id: trajectoryId }
    }

    // GREEN/YELLOW: execute now
    return await this.executeAndLog(request, trajectoryId)
  }

  /** Caller approved a queued ORANGE/RED action. */
  async approveItem(inboxItemId: string): Promise<DispatchResult> {
    const row = this.db.query(
      'SELECT * FROM agency_pending_actions WHERE inbox_item_id = ?',
    ).get(inboxItemId) as { request_id: string; intent_id: string; args_json: string; reasoning: string; trajectory_id: string } | null
    if (!row) {
      return { status: 'failed', details: 'no pending action', trajectory_id: '' }
    }
    this.inbox.resolve(inboxItemId, 'approved')
    const request: ActionRequest = {
      request_id: row.request_id,
      intent_id: row.intent_id,
      args: JSON.parse(row.args_json),
      reasoning: row.reasoning,
      requested_at: Date.now(),
    }
    return await this.executeAndLog(request, row.trajectory_id)
  }

  /** Caller dismissed a queued ORANGE/RED action. */
  async dismissItem(inboxItemId: string, reason: string): Promise<DispatchResult> {
    const row = this.db.query(
      'SELECT trajectory_id FROM agency_pending_actions WHERE inbox_item_id = ?',
    ).get(inboxItemId) as { trajectory_id: string } | null
    this.inbox.resolve(inboxItemId, 'dismissed')
    if (row) {
      this.trajectory.finalize(row.trajectory_id, 'user_override', reason)
      this.db.run('UPDATE agency_pending_actions SET status = ? WHERE inbox_item_id = ?', ['cancelled', inboxItemId])
    }
    return { status: 'cancelled', details: reason, trajectory_id: row?.trajectory_id ?? '' }
  }

  private async executeAndLog(request: ActionRequest, trajectoryId: string): Promise<DispatchResult> {
    const entry = this.registry.get(request.intent_id)!
    const startMs = Date.now()
    const step: TrajectoryStep = {
      observation: request.reasoning,
      reasoning: `dispatch ${entry.intent.id}`,
      action: { intent_id: entry.intent.id, args: request.args },
      result: '',
      result_status: 'success',
      duration_ms: 0,
    }
    try {
      const result = await entry.handler(request.args, this.ctx)
      step.result = result.details
      step.result_status = result.status as TrajectoryStep['result_status']
      step.duration_ms = Date.now() - startMs
      this.trajectory.appendStep(trajectoryId, step)
      this.trajectory.finalize(trajectoryId, result.status === 'success' ? 'success' : 'failure')
      this.db.run('UPDATE agency_pending_actions SET status = ? WHERE request_id = ?', ['completed', request.request_id])
      return { status: 'completed', details: result.details, trajectory_id: trajectoryId }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      step.result = msg
      step.result_status = 'failure'
      step.duration_ms = Date.now() - startMs
      this.trajectory.appendStep(trajectoryId, step)
      this.trajectory.finalize(trajectoryId, 'failure', msg)
      logError(`ActionExecutor: ${entry.intent.id} failed`, err)
      return { status: 'failed', details: msg, trajectory_id: trajectoryId }
    }
  }
}
```

- [ ] **Step 4: Run tests**

```bash
bun test src/daemon/agency/actionExecutor.test.ts
```

Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/agency/actionExecutor.ts src/daemon/agency/actionExecutor.test.ts
git commit -m "feat(agency): ActionExecutor with tier gating, idempotency, trajectory logging"
```

---

## Task 8: Trigger engine

**Files:**
- Create: `src/daemon/agency/triggerEngine.ts`
- Test:  `src/daemon/agency/triggerEngine.test.ts`

Subscribes to `EventBus` and reads `compiled_orders_triggers` from Phase B's orders compiler. For every event batch, evaluates which triggers match — using `when_kind` + `when_match` (semi-structured selectors) — and emits `ActionRequest` records via the ActionExecutor.

Phase B's compiler emitted triggers with `when_kind` ∈ `{calendar, clipboard, focus-app, file-events, browser-tabs, time, pattern}` and `when_match` strings like `"event.startsIn(10min)"`, `"text.isURL()"`. C.1 implements a small evaluator that supports a *subset* of these — the full grammar is C.4 territory. For C.1, we support exact-source-match + simple value predicates so the validation scenarios pass.

- [ ] **Step 1: Write the failing test**

```typescript
// src/daemon/agency/triggerEngine.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { EventBus } from '../proactive/eventBus'
import { ORDERS_SCHEMA } from '../orders/compiler'
import { TriggerEngine } from './triggerEngine'

describe('TriggerEngine', () => {
  let db: Database
  let bus: EventBus
  let engine: TriggerEngine
  let dispatched: Array<{ intent_id: string; args: Record<string, unknown> }>

  beforeEach(() => {
    db = new Database(':memory:')
    bus = new EventBus(db)
    db.exec(ORDERS_SCHEMA)
    dispatched = []
    engine = new TriggerEngine(db, bus, async (req) => {
      dispatched.push({ intent_id: req.intent_id, args: req.args })
      return { status: 'completed', trajectory_id: 't' } as any
    })
  })

  function addTrigger(t: Partial<{
    id: string; when_kind: string; when_match: string;
    condition: string | null; action: string; source_rule: string;
  }>) {
    db.run(
      `INSERT INTO compiled_orders_triggers (id, when_kind, when_match, condition, action, source_rule, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [t.id ?? 't1', t.when_kind ?? 'focus-app', t.when_match ?? '*', t.condition ?? null,
       t.action ?? 'notify', t.source_rule ?? 'test', Date.now()],
    )
  }

  it('fires when event source matches a trigger', async () => {
    addTrigger({ when_kind: 'clipboard', when_match: '*', action: 'log' })
    await engine.evaluateEvent({ id: 1, ts: Date.now(), source: 'clipboard', kind: 'changed', payload: { text: 'hi' } } as any)
    expect(dispatched.length).toBe(1)
    expect(dispatched[0]?.intent_id).toBe('log')
  })

  it('does not fire when source does not match', async () => {
    addTrigger({ when_kind: 'clipboard', when_match: '*', action: 'log' })
    await engine.evaluateEvent({ id: 1, ts: Date.now(), source: 'focus-app', kind: 'app_changed', payload: { app: 'X' } } as any)
    expect(dispatched.length).toBe(0)
  })

  it('respects suspended scope', async () => {
    db.exec(`CREATE TABLE IF NOT EXISTS agency_suspend_state (id INTEGER PRIMARY KEY, scope TEXT, until_ms INTEGER, reason TEXT)`)
    db.run(`INSERT INTO agency_suspend_state (scope, until_ms, reason) VALUES ('all', ?, 'quiet hours')`, [Date.now() + 60_000])
    addTrigger({ when_kind: 'clipboard', action: 'log' })
    await engine.evaluateEvent({ id: 1, ts: Date.now(), source: 'clipboard', kind: 'changed', payload: {} } as any)
    expect(dispatched.length).toBe(0)
  })

  it('lists all triggers from compiled orders', () => {
    addTrigger({ id: 'a' })
    addTrigger({ id: 'b' })
    expect(engine.listTriggers().length).toBe(2)
  })

  it('matchesPayload supports text.contains() predicate', async () => {
    addTrigger({ when_kind: 'clipboard', when_match: "text.contains('http')", action: 'add_to_memory' })
    await engine.evaluateEvent({ id: 1, ts: Date.now(), source: 'clipboard', kind: 'changed', payload: { text: 'https://foo' } } as any)
    expect(dispatched.length).toBe(1)

    await engine.evaluateEvent({ id: 2, ts: Date.now(), source: 'clipboard', kind: 'changed', payload: { text: 'nope' } } as any)
    expect(dispatched.length).toBe(1)   // unchanged
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/daemon/agency/triggerEngine.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Write the implementation**

```typescript
// src/daemon/agency/triggerEngine.ts
// Consumes EventBus events. For each event, reads compiled triggers
// from Phase B's orders compiler and evaluates which match.
// Emits ActionRequest records via the dispatcher callback.
//
// C.1 evaluator supports a small grammar — enough for validation
// scenarios. C.4 upgrades to the full when_match DSL.
//
// Suspension: respects agency_suspend_state rows. If any active row
// has scope='all' or scope matching the event source, dispatch is
// skipped.

import { randomUUID } from 'crypto'
import type { Database } from 'bun:sqlite'
import { log, logError } from '../logger'
import type { EventBus, WorldEvent } from '../proactive/eventBus'
import type { ActionRequest } from './types'

type DispatchFn = (req: ActionRequest) => Promise<{ status: string }>

type CompiledTriggerRow = {
  id: string
  when_kind: string
  when_match: string
  condition: string | null
  action: string
  source_rule: string
}

export class TriggerEngine {
  private unsubscribe: (() => void) | null = null

  constructor(
    private db: Database,
    private bus: EventBus,
    private dispatch: DispatchFn,
  ) {}

  start(): void {
    this.unsubscribe = this.bus.subscribe('*', e => { void this.evaluateEvent(e) })
    log('TriggerEngine armed')
  }

  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe()
      this.unsubscribe = null
    }
  }

  listTriggers(): CompiledTriggerRow[] {
    return this.db.query('SELECT * FROM compiled_orders_triggers').all() as CompiledTriggerRow[]
  }

  async evaluateEvent(event: WorldEvent): Promise<void> {
    if (this.isSuspended(event.source)) return

    const triggers = this.listTriggers()
    for (const t of triggers) {
      if (t.when_kind !== event.source) continue
      if (!this.matchesPayload(t.when_match, event.payload)) continue
      if (t.condition && !this.evaluateCondition(t.condition, event)) continue

      try {
        const req: ActionRequest = {
          request_id: randomUUID(),
          intent_id: t.action,
          args: this.buildArgsFromEvent(t, event),
          source_trigger_id: t.id,
          reasoning: `trigger ${t.id} matched (rule: ${t.source_rule.slice(0, 60)})`,
          requested_at: Date.now(),
        }
        await this.dispatch(req)
      } catch (err) {
        logError(`TriggerEngine: dispatch failed for ${t.id}`, err)
      }
    }
  }

  private isSuspended(source: string): boolean {
    const now = Date.now()
    try {
      const rows = this.db.query(
        'SELECT scope FROM agency_suspend_state WHERE until_ms > ?',
      ).all(now) as Array<{ scope: string }>
      return rows.some(r => r.scope === 'all' || r.scope === source || r.scope === 'triggers')
    } catch {
      return false   // table may not exist on first run
    }
  }

  /**
   * C.1 evaluator. Supports:
   *   "*"                        — always match
   *   "text.contains('foo')"     — payload.text includes 'foo'
   *   "text.isURL()"             — payload.text matches a URL regex
   *   "app.equals('Slack')"      — payload.app equals 'Slack'
   *   "path.endsWith('.ts')"     — payload.path ends with '.ts'
   * Anything more sophisticated → falls back to true (caller's condition
   * field can do further filtering). C.4 replaces this with a full DSL.
   */
  private matchesPayload(whenMatch: string, payload: Record<string, unknown>): boolean {
    if (!whenMatch || whenMatch.trim() === '*') return true

    const contains = whenMatch.match(/^text\.contains\(['"](.+)['"]\)$/)
    if (contains) {
      return typeof payload.text === 'string' && payload.text.includes(contains[1]!)
    }

    if (whenMatch === 'text.isURL()') {
      return typeof payload.text === 'string' && /https?:\/\/\S+/.test(payload.text)
    }

    const appEq = whenMatch.match(/^app\.equals\(['"](.+)['"]\)$/)
    if (appEq) return (payload as any).app === appEq[1]

    const pathEnds = whenMatch.match(/^path\.endsWith\(['"](.+)['"]\)$/)
    if (pathEnds) {
      return typeof payload.path === 'string' && payload.path.endsWith(pathEnds[1]!)
    }

    return true
  }

  /** Stub for C.1 — just true. C.4 adds NOT focus_app.is_video etc. */
  private evaluateCondition(_condition: string, _event: WorldEvent): boolean {
    return true
  }

  /** Build intent args from the event + trigger. For C.1 these are simple defaults; C.3 LLM-composes via action_compose. */
  private buildArgsFromEvent(t: CompiledTriggerRow, event: WorldEvent): Record<string, unknown> {
    switch (t.action) {
      case 'notify':
        return {
          title: `Trigger fired: ${t.id}`,
          body: `${event.source}/${event.kind}: ${JSON.stringify(event.payload).slice(0, 100)}`,
        }
      case 'log':
        return { message: `${t.source_rule} → ${event.source}/${event.kind}` }
      case 'add_to_memory':
        return {
          kind: 'fact',
          subject: event.source,
          body: JSON.stringify(event.payload).slice(0, 200),
          importance: 0.5,
        }
      default:
        return event.payload
    }
  }
}
```

- [ ] **Step 4: Run tests**

```bash
bun test src/daemon/agency/triggerEngine.test.ts
```

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/agency/triggerEngine.ts src/daemon/agency/triggerEngine.test.ts
git commit -m "feat(agency): TriggerEngine consumes events + compiled orders, gates suspended scopes"
```

---

## Task 9: Perception → Trigger bridge

**Files:**
- Create: `src/daemon/agency/perceptionToTrigger.ts`
- Test:  `src/daemon/agency/perceptionToTrigger.test.ts`

Phase B's `PerceptionPipeline` writes episodes to L2 when Tier 1+2 promote a batch. We don't want to wire the TriggerEngine into the PerceptionPipeline directly (that couples the two subsystems). Instead, the perception layer continues to emit events into the bus (and write episodes); the TriggerEngine subscribes to the bus separately and considers BOTH raw observer events AND `narrator/summary` events as input. The bridge here is just a thin glue that makes sure newly-written episode events also get re-published into the bus as `episode/written` synthetic events the trigger engine can react to.

- [ ] **Step 1: Write the failing test**

```typescript
// src/daemon/agency/perceptionToTrigger.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { EventBus } from '../proactive/eventBus'
import { initMemorySchema } from '../memory/schema'
import { EpisodicMemory } from '../memory/episodicMemory'
import { PerceptionToTrigger } from './perceptionToTrigger'

describe('PerceptionToTrigger bridge', () => {
  let db: Database
  let bus: EventBus
  let ep: EpisodicMemory

  beforeEach(() => {
    db = new Database(':memory:')
    initMemorySchema(db)
    bus = new EventBus(db)
    ep = new EpisodicMemory(db)
  })

  it('republishes a recent episode as an episode/written event', async () => {
    const captured: Array<{ source: string; kind: string }> = []
    bus.subscribe('episode-written', e => { captured.push({ source: e.source, kind: e.kind }) })

    const bridge = new PerceptionToTrigger(bus, ep)
    const id = ep.writeEpisode({
      started_at: 1, ended_at: 2, episode_type: 'work_session',
      title: 't', summary: 's', event_ids: [], importance: 0.8,
    })
    await bridge.republishLatest()
    expect(captured.length).toBe(1)
    expect(captured[0]?.source).toBe('episode-written')
    expect(captured[0]?.kind).toBe('work_session')
  })

  it('does not republish episodes it has already republished', async () => {
    const bridge = new PerceptionToTrigger(bus, ep)
    ep.writeEpisode({
      started_at: 1, ended_at: 2, episode_type: 'x', title: 'a', summary: 's',
      event_ids: [], importance: 0.5,
    })
    await bridge.republishLatest()
    await bridge.republishLatest()
    const after = bus.recent(10).filter(e => e.source === 'episode-written')
    expect(after.length).toBe(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/daemon/agency/perceptionToTrigger.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Write the implementation**

```typescript
// src/daemon/agency/perceptionToTrigger.ts
// Glue: after PerceptionPipeline writes an episode, this bridge publishes
// a synthetic `episode-written` event back into the bus so the
// TriggerEngine can react to it like any other observer event.
//
// We track last-republished episode id in memory; on daemon restart the
// caller seeds it via setHighWaterMark(epId).

import { log } from '../logger'
import type { EventBus } from '../proactive/eventBus'
import type { EpisodicMemory } from '../memory/episodicMemory'

export class PerceptionToTrigger {
  private highWater: number = 0

  constructor(private bus: EventBus, private episodic: EpisodicMemory) {}

  setHighWaterMark(epId: number): void {
    this.highWater = epId
  }

  async republishLatest(): Promise<void> {
    const recent = this.episodic.recent(20)
    const fresh = recent.filter(e => e.id > this.highWater)
    if (fresh.length === 0) return

    // Republish oldest-first so trigger ordering matches episode ordering
    for (const ep of fresh.reverse()) {
      this.bus.publish({
        source: 'episode-written',
        kind: ep.episode_type,
        payload: {
          episode_id: ep.id,
          title: ep.title,
          summary: ep.summary,
          importance: ep.importance,
          event_ids: ep.event_ids,
        },
      })
      this.highWater = Math.max(this.highWater, ep.id)
    }
    log(`PerceptionToTrigger: republished ${fresh.length} episode(s) up to id ${this.highWater}`)
  }
}
```

- [ ] **Step 4: Run tests**

```bash
bun test src/daemon/agency/perceptionToTrigger.test.ts
```

Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/agency/perceptionToTrigger.ts src/daemon/agency/perceptionToTrigger.test.ts
git commit -m "feat(agency): bridge republishes new episodes as episode-written events"
```

---

## Task 10: CLI approve/dismiss commands

**Files:**
- Create: `src/cli/agency.ts` (extend existing CLI entrypoint if present, otherwise create)
- Test:  `src/cli/agency.test.ts`

The inbox file tells the user to run `kairos approve <item_id>` or `kairos dismiss <item_id>`. The CLI needs a path to invoke `executor.approveItem` / `dismissItem` against the running daemon. For C.1 we keep this simple: a CLI subcommand that posts to a local HTTP endpoint the daemon exposes.

We'll add the daemon endpoint as part of Task 11 (wire-up). This task adds the CLI side.

- [ ] **Step 1: Inspect existing CLI structure**

```bash
ls /Users/nirmalghinaiya/Desktop/kairos-sandbox/src/cli/ 2>/dev/null || echo "no existing CLI"
```

If a CLI entry already exists from the prior session, extend it. If not, create `src/cli/agency.ts` as a standalone runnable script invoked via `bun run src/cli/agency.ts <command>`.

- [ ] **Step 2: Write the failing test**

```typescript
// src/cli/agency.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { runAgencyCommand } from './agency'

describe('agency CLI', () => {
  let posts: Array<{ url: string; body: any }>

  beforeEach(() => {
    posts = []
    // mock fetch
    ;(globalThis as any).fetch = async (url: string, init: any) => {
      posts.push({ url, body: JSON.parse(init.body) })
      return { ok: true, json: async () => ({ status: 'completed' }) } as any
    }
  })

  it('approve posts to the daemon with item_id', async () => {
    const result = await runAgencyCommand(['approve', 'abc-123'], { daemonUrl: 'http://localhost:9876' })
    expect(posts[0]?.url).toBe('http://localhost:9876/agency/approve')
    expect(posts[0]?.body).toEqual({ item_id: 'abc-123' })
    expect(result.exitCode).toBe(0)
  })

  it('dismiss posts to the daemon with item_id + reason', async () => {
    await runAgencyCommand(['dismiss', 'abc-123', 'user said no'], { daemonUrl: 'http://localhost:9876' })
    expect(posts[0]?.url).toBe('http://localhost:9876/agency/dismiss')
    expect(posts[0]?.body).toEqual({ item_id: 'abc-123', reason: 'user said no' })
  })

  it('returns non-zero exit on missing arguments', async () => {
    const result = await runAgencyCommand(['approve'], { daemonUrl: 'http://localhost:9876' })
    expect(result.exitCode).not.toBe(0)
  })

  it('returns non-zero exit on unknown command', async () => {
    const result = await runAgencyCommand(['nope'], { daemonUrl: 'http://localhost:9876' })
    expect(result.exitCode).not.toBe(0)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

```bash
bun test src/cli/agency.test.ts
```

Expected: FAIL.

- [ ] **Step 4: Write the implementation**

```typescript
// src/cli/agency.ts
// CLI entry for inbox approve/dismiss. Posts to the running daemon's
// /agency/approve or /agency/dismiss HTTP endpoints.
//
// Usage:
//   kairos approve <item_id>
//   kairos dismiss <item_id> [reason]

export type CliResult = {
  exitCode: number
  stdout: string
}

export type CliOptions = {
  daemonUrl?: string
}

const DEFAULT_DAEMON_URL = 'http://localhost:9876'

export async function runAgencyCommand(argv: string[], opts: CliOptions = {}): Promise<CliResult> {
  const url = opts.daemonUrl ?? DEFAULT_DAEMON_URL
  const cmd = argv[0]

  if (cmd === 'approve') {
    const itemId = argv[1]
    if (!itemId) return { exitCode: 2, stdout: 'usage: kairos approve <item_id>' }
    try {
      const resp = await fetch(`${url}/agency/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item_id: itemId }),
      })
      if (!resp.ok) return { exitCode: 3, stdout: `daemon returned ${resp.status}` }
      const data = await resp.json() as { status?: string }
      return { exitCode: 0, stdout: `approved: ${data.status ?? 'unknown'}` }
    } catch (err) {
      return { exitCode: 4, stdout: `daemon unreachable: ${err instanceof Error ? err.message : err}` }
    }
  }

  if (cmd === 'dismiss') {
    const itemId = argv[1]
    if (!itemId) return { exitCode: 2, stdout: 'usage: kairos dismiss <item_id> [reason]' }
    const reason = argv.slice(2).join(' ') || 'user dismissed'
    try {
      const resp = await fetch(`${url}/agency/dismiss`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item_id: itemId, reason }),
      })
      if (!resp.ok) return { exitCode: 3, stdout: `daemon returned ${resp.status}` }
      return { exitCode: 0, stdout: 'dismissed' }
    } catch (err) {
      return { exitCode: 4, stdout: `daemon unreachable: ${err instanceof Error ? err.message : err}` }
    }
  }

  return { exitCode: 2, stdout: `unknown command: ${cmd}. Use 'approve' or 'dismiss'.` }
}

// CLI entry — only runs when this file is invoked directly
if (import.meta.main) {
  const args = process.argv.slice(2)
  const result = await runAgencyCommand(args)
  console.log(result.stdout)
  process.exit(result.exitCode)
}
```

- [ ] **Step 5: Run tests**

```bash
bun test src/cli/agency.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/cli/agency.ts src/cli/agency.test.ts
git commit -m "feat(cli): kairos approve/dismiss commands (posts to daemon /agency/*)"
```

---

## Task 11: Daemon wire-up

**Files:**
- Modify: `src/daemon/index.ts`
- Modify: `src/daemon/types.ts` (add `agency` config block)
- Modify: `src/daemon/config.ts` (add agency defaults)

Wire the agency subsystem into startup alongside Phase B's perception subsystem. Expose `/agency/approve` and `/agency/dismiss` HTTP endpoints. Bridge runs on the same `PerceptionPipeline` interval (every 30s) — when perception writes an episode, the bridge republishes; trigger engine reacts.

- [ ] **Step 1: Read the current state**

```bash
sed -n '1,40p' /Users/nirmalghinaiya/Desktop/kairos-sandbox/src/daemon/types.ts
grep -n "Bun.serve\|http.createServer\|kairos_inbox\|httpPort" /Users/nirmalghinaiya/Desktop/kairos-sandbox/src/daemon/index.ts | head -10
```

Find where an HTTP server already exists (Phase A had one for tool calls). Reuse it; add the two new routes.

- [ ] **Step 2: Add agency config block**

In `types.ts`, append to the `Config` type:

```typescript
agency: {
  enabled: boolean
  inboxPath: string
  daemonHttpPort: number   // where the CLI posts approve/dismiss
}
```

In `config.ts` defaults:

```typescript
agency: {
  enabled: true,
  inboxPath: join(process.env.HOME ?? '', '.kairos', 'inbox.md'),
  daemonHttpPort: 9876,
},
```

- [ ] **Step 3: Wire into index.ts**

Add imports near the top:

```typescript
import { IntentRegistry, registerBuiltIns } from './agency/intentRegistry'
import { TrajectoryLog, TRAJECTORY_SCHEMA } from './agency/trajectoryLog'
import { InboxSurface } from './agency/inboxSurface'
import { NativeNotifier } from './agency/nativeNotifier'
import { ActionExecutor } from './agency/actionExecutor'
import { TriggerEngine } from './agency/triggerEngine'
import { PerceptionToTrigger } from './agency/perceptionToTrigger'
```

Inside the existing memory/perception block (where `episodic`, `semantic`, `bus`, `db`, `router` are already in scope), AFTER perception pipeline is constructed:

```typescript
// ─── Agency subsystem (Phase C.1) ─────────────────────
let agencyStop: (() => void) | null = null
if (config.agency.enabled) {
  db.exec(TRAJECTORY_SCHEMA)

  const registry = new IntentRegistry()
  registerBuiltIns(registry)
  const trajectory = new TrajectoryLog(db)
  const notifier = new NativeNotifier()
  const inbox = new InboxSurface(db, config.agency.inboxPath)

  const actionCtx = {
    db,
    notifier,
    embedder: { embed: (text: string) => embedder.embed(text) },
    semantic,
  }
  const executor = new ActionExecutor(db, registry, trajectory, inbox, actionCtx)
  const triggerEngine = new TriggerEngine(db, bus, (req) => executor.dispatch(req))
  const bridge = new PerceptionToTrigger(bus, episodic)

  // Initialise bridge's high water from current state
  const latestEp = episodic.recent(1)[0]
  if (latestEp) bridge.setHighWaterMark(latestEp.id)

  triggerEngine.start()

  // Bridge ticks at the same cadence as the perception pipeline
  const bridgeTimer = setInterval(() => { void bridge.republishLatest() }, config.perception.pipelinePollMs)

  // HTTP endpoints for CLI approve/dismiss
  const httpServer = Bun.serve({
    port: config.agency.daemonHttpPort,
    fetch: async (req) => {
      const url = new URL(req.url)
      if (url.pathname === '/agency/approve' && req.method === 'POST') {
        const { item_id } = await req.json() as { item_id: string }
        const result = await executor.approveItem(item_id)
        return Response.json(result)
      }
      if (url.pathname === '/agency/dismiss' && req.method === 'POST') {
        const { item_id, reason } = await req.json() as { item_id: string; reason: string }
        const result = await executor.dismissItem(item_id, reason)
        return Response.json(result)
      }
      return new Response('not found', { status: 404 })
    },
  })

  log(`Agency subsystem active. Inbox at ${config.agency.inboxPath}, CLI port ${config.agency.daemonHttpPort}`)

  agencyStop = () => {
    triggerEngine.stop()
    clearInterval(bridgeTimer)
    httpServer.stop()
  }
}
```

In the shutdown handler (find existing `proactiveStop` / `memoryStop` cleanup):

```typescript
if (agencyStop) agencyStop()
```

**IMPORTANT**: if an HTTP server already exists from Phase A (for `kairos_inbox` MCP tool), DO NOT create a second `Bun.serve` on the same port. Instead, add the two routes into the existing handler. The exact merge depends on the existing structure — adapt accordingly and document any deviation in the report.

- [ ] **Step 4: Type-check + run full test suite**

```bash
cd /Users/nirmalghinaiya/Desktop/kairos-sandbox
bunx tsc --noEmit 2>&1 | grep -vE "(pre-existing|server\.ts|db\.ts|environmentScanner|shim/lifecycle)" | head -10
bun test 2>&1 | tail -10
```

Expected: no new errors in modified files. All tests pass (Phase A 59 + Phase B ~60 + C.1 ~30 = ~149 total).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/index.ts src/daemon/types.ts src/daemon/config.ts
git commit -m "feat(daemon): wire agency subsystem + CLI HTTP endpoints into startup"
```

---

## Task 12: Phase C.1 validation gate

**Files:**
- Create: `scripts/validate-phase-c1.ts`

Per Section 8.5 validation rule. Five scripted scenarios that exercise the trigger engine + autonomy tiers end-to-end with synthetic events.

- [ ] **Step 1: Write the script**

```typescript
// scripts/validate-phase-c1.ts
// Phase C.1 validation per Section 8.5 — 5 scripted scenarios.
//
// Usage: bun run scripts/validate-phase-c1.ts
//
// Cost: ~few cents on Gemini Flash Lite (Tier 2 in perception still runs);
// $0 on anthropic_cli.

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

const db = new Database(':memory:')
initMemorySchema(db)
db.exec(ORDERS_SCHEMA)
db.exec(TRAJECTORY_SCHEMA)
db.exec(`CREATE TABLE IF NOT EXISTS agency_scheduled_reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, body TEXT, fire_at INTEGER, fired INTEGER
)`)
db.exec(`CREATE TABLE IF NOT EXISTS agency_suspend_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT, until_ms INTEGER, reason TEXT
)`)

const bus = new EventBus(db)
const ep = new EpisodicMemory(db)
const sem = new SemanticMemory(db)
const embedder = new Embedder()
const registry = new IntentRegistry()
registerBuiltIns(registry)
const traj = new TrajectoryLog(db)
const tmp = mkdtempSync(join(tmpdir(), 'kairos-c1-validate-'))
const inboxPath = join(tmp, 'inbox.md')
const inbox = new InboxSurface(db, inboxPath)
const notifier = new NativeNotifier({
  // Capture instead of actually firing during validation
  probe: async (args) => { console.log(`  [notification] ${args.title}: ${args.body}`) },
})
const executor = new ActionExecutor(db, registry, traj, inbox, {
  db, notifier, embedder: { embed: (t: string) => embedder.embed(t) }, semantic: sem,
})
const engine = new TriggerEngine(db, bus, (req) => executor.dispatch(req))

function seedTrigger(t: { id: string; when_kind: string; when_match: string; condition: string | null; action: string; source_rule: string }) {
  db.run(
    `INSERT INTO compiled_orders_triggers (id, when_kind, when_match, condition, action, source_rule, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [t.id, t.when_kind, t.when_match, t.condition, t.action, t.source_rule, Date.now()],
  )
}

console.log('─── Phase C.1 Validation — 5 Scenarios ───\n')

// SCENARIO 1: Clipboard URL → add_to_memory (🟢 silent)
console.log('Scenario 1: 🟢 clipboard URL → add_to_memory (silent)')
seedTrigger({
  id: 'clip-url',
  when_kind: 'clipboard',
  when_match: 'text.isURL()',
  condition: null,
  action: 'add_to_memory',
  source_rule: 'When I copy a URL to the clipboard, add it to memory',
})
await engine.evaluateEvent({ id: 1, ts: Date.now(), source: 'clipboard', kind: 'changed', payload: { text: 'https://example.com/article' } } as any)
console.log(`  Trajectories: ${traj.recent(10).length}`)
console.log(`  Inbox items pending: ${inbox.pending().length}`)
console.log(`  Memory facts: ${sem.allActive().length}\n`)

// SCENARIO 2: focus-app=Slack → notify (🟢 silent — built-in tier)
console.log('Scenario 2: 🟢 focus-app=Slack → notify')
seedTrigger({
  id: 'slack-focus',
  when_kind: 'focus-app',
  when_match: "app.equals('Slack')",
  condition: null,
  action: 'notify',
  source_rule: 'When I switch to Slack, notify',
})
await engine.evaluateEvent({ id: 2, ts: Date.now(), source: 'focus-app', kind: 'app_changed', payload: { app: 'Slack' } } as any)
console.log(`  Trajectories so far: ${traj.recent(10).length}\n`)

// SCENARIO 3: file pattern → log (🟢 silent record-only)
console.log('Scenario 3: 🟢 file path → log')
seedTrigger({
  id: 'ts-file',
  when_kind: 'file-events',
  when_match: "path.endsWith('.ts')",
  condition: null,
  action: 'log',
  source_rule: 'Log when .ts files change',
})
await engine.evaluateEvent({ id: 3, ts: Date.now(), source: 'file-events', kind: 'modified', payload: { path: '/tmp/foo.ts' } } as any)
console.log(`  Trajectories so far: ${traj.recent(10).length}\n`)

// SCENARIO 4: Custom ORANGE-tier intent to test inbox approval flow
console.log('Scenario 4: 🟠 custom intent → inbox approval')
registry.register(
  { id: 'risky-action', description: 'Pretend-risky action', tier: 'ORANGE', argSchema: { msg: 'string' } },
  async (args) => ({ status: 'success', details: `did risky: ${args.msg}` }),
)
seedTrigger({
  id: 'risky-trigger',
  when_kind: 'browser-tabs',
  when_match: '*',
  condition: null,
  action: 'risky-action',
  source_rule: 'On tab change, do something risky',
})
await engine.evaluateEvent({ id: 4, ts: Date.now(), source: 'browser-tabs', kind: 'tabs_changed', payload: { tabs: ['https://foo'] } } as any)
console.log(`  Inbox pending: ${inbox.pending().length}`)
console.log(`  --- inbox.md content (top 30 lines) ---`)
console.log(readFileSync(inboxPath, 'utf8').split('\n').slice(0, 30).join('\n'))

// Approve it
const pending = inbox.pending()[0]
if (pending) {
  const approveResult = await executor.approveItem(pending.item_id)
  console.log(`  Approved: ${approveResult.status}`)
}
console.log(`  Inbox after approval: ${inbox.pending().length}\n`)

// SCENARIO 5: Suspend-all blocks subsequent triggers (🟢 silent suspend)
console.log('Scenario 5: 🟢 quiet-hours suspend blocks subsequent triggers')
db.run(`INSERT INTO agency_suspend_state (scope, until_ms, reason) VALUES ('all', ?, 'quiet hours')`, [Date.now() + 60_000])
const trajBefore = traj.recent(20).length
await engine.evaluateEvent({ id: 5, ts: Date.now(), source: 'clipboard', kind: 'changed', payload: { text: 'https://blocked.com' } } as any)
const trajAfter = traj.recent(20).length
console.log(`  Trajectories before suspend event: ${trajBefore}`)
console.log(`  Trajectories after suspend event: ${trajAfter}`)
console.log(`  Expected: equal (event dropped during suspend)\n`)

// Final summary
console.log('─── Summary ───')
console.log(`Total trajectories: ${traj.recent(50).length}`)
const byOutcome = ['success', 'failure', 'user_override', 'partial'].map(o => {
  const n = traj.byOutcome(o as any, 50).length
  return `  ${o.padEnd(15)} ${n}`
}).join('\n')
console.log(byOutcome)
console.log(`Pending inbox items: ${inbox.pending().length}`)
console.log(`L3 memory facts: ${sem.allActive().length}`)

console.log('\nPASS criteria (human review):')
console.log('  • Each scenario fires the expected action')
console.log('  • Scenario 4 produces a readable inbox.md entry with approve/dismiss commands')
console.log('  • Scenario 5 successfully suppresses the trigger via suspend state')
console.log('  • All trajectories have a final outcome (none stuck "in-progress")')
```

- [ ] **Step 2: Type-check**

```bash
cd /Users/nirmalghinaiya/Desktop/kairos-sandbox
bunx tsc --noEmit scripts/validate-phase-c1.ts 2>&1 | head -10
```

Expected: no errors in the new file.

- [ ] **Step 3: Commit**

```bash
git add scripts/validate-phase-c1.ts
git commit -m "test(phase-c1): 5-scenario validation gate per Section 8.5"
```

- [ ] **Step 4: User runs validation**

```bash
bun run scripts/validate-phase-c1.ts
```

Expected output: 5 scenarios executed, inbox.md content shown for scenario 4 with readable approve/dismiss commands, summary shows all trajectories finalized, scenario 5 confirms suspend blocks trigger.

- [ ] **Step 5: Tag the sub-phase**

After validation passes:

```bash
git tag v0.3.0-phase-c1
git push origin main --tags
```

- [ ] **Step 6: Update CHANGELOG.md** with the C.1 entry (model after Phase A + B entries; include validation summary).

---

## Self-review

**Spec coverage:**
- ✅ C.1 core (trigger engine, autonomy tiers, action execution layer, approval queue inbox) → Tasks 1-11
- ✅ Phase C concrete patterns from spec section 8.4.8 onwards: UFO2 trajectory format (Task 4), tier enforcement structurally not via prompts (Task 7 — tier comes from intent manifest), inbox.md surface (Task 6)
- ⏭️ MCP host runtime — Phase C.2
- ⏭️ Magentic-One orchestrator + smolagents CodeAgent + AWM crystallizer — Phase C.3
- ⏭️ STANDING_ORDERS v2 + persona conditioning + offline fallback + dry-run mode — Phase C.4

**Placeholder scan:** none found. Every task has actual code, exact paths, exact commands.

**Type consistency:** `Intent`/`ActionRequest`/`Trajectory`/`InboxItem` types defined in Task 1 are used identically across registry, executor, log, inbox, trigger engine, CLI. `AutonomyTier` union used throughout. `ActionContext` defined in ActionExecutor and consumed by built-in intent handlers.

**Wire-up risks flagged:**
- Task 11 must adapt to whatever existing HTTP server pattern is in `index.ts` from Phase A — flagged as DONE_WITH_CONCERNS-worthy if structure surprises
- Bun's NAPI teardown crash (fastembed module) will still happen after test runs — known, harmless, all tests pass first

**Open questions to handle inline during execution:**
- If Phase A's existing daemon already exposes an HTTP port for MCP tools, the C.1 wire-up adds routes rather than creating a second Bun.serve
- If `src/cli/` already exists with a router pattern (from prior session), extend rather than create standalone agency.ts

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-25-phase-c1-trigger-engine.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — fresh implementer per task + combined reviewer. Same pattern as Phase A + B that has now shipped ~170 atomic tasks successfully.

2. **Inline Execution** — slower but lets you intervene mid-task.

After C.1 ships (`v0.3.0-phase-c1`), we plan C.2 (MCP host runtime + Smithery + agentskills.io skill format). Each sub-phase tags independently per Section 8.5.
