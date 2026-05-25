# Phase C.1.5 — The Earned Interrupt Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform KAIROS from "fires on every trigger match" to a system that **earns** the right to interrupt the user. This is the architectural soul of the project — the difference between a useful co-worker and notification spam.

**Architecture:** A 10-layer restraint stack sits between the trigger engine and the user's attention. Every fired action passes through: significance gate → trigger match → action scorer → delivery mode router → coalescer → cooldown → rate limit → focus/quiet check → karma learner → final delivery. Most events drop at some layer. Of those that reach delivery, most go to a batched digest or ambient oval — not a popup. Each notification dismissal teaches the system to be less noisy. Each acted-on notification teaches it to be more confident. The agent measures its own annoyance and adapts.

**The Earned Interrupt Principle (inviolable, goes in spec):**
1. **Silence is the default.** Every notification is opt-IN to firing, not opt-OUT.
2. **One notification = one user-visible suggestion**, not one underlying event.
3. **The agent measures its own annoyance** (dismissal rate, ignore rate, "stop telling me" rate) and adapts. Without this loop, every "smart" agent becomes spam.

**Tech Stack:** TypeScript on Bun, `bun:sqlite` for karma/dismissal/digest persistence, reuse Phase A's ModelRouter for LLM-assisted scoring (cheapest tier — Haiku/Gemini Flash Lite), AppleScript for focus detection via active app duration.

**Scope boundary:** C.1.5 ships the restraint layer + delivery routing. The voice channel ("Whisper Mode" delivery via TTS) is wired but the actual voice infrastructure lands in Phase E. C.1.5's voice fallback is `osascript display notification` with a low-priority chime — Phase E replaces with the kwindla-forked voice pipeline.

**Estimated size:** ~3,000 lines of TypeScript + tests across 13 atomic tasks. Larger than other sub-phases because this is foundational — every future Phase (D OAuth, E voice, F UI) depends on it.

**Sequencing note:** This sub-phase inserts BETWEEN C.2 (just shipped) and C.3 (planned next). Phase F therefore moves ~2 weeks later, accepted because shipping more capability without restraint would compound the C.1 incident.

---

## File Structure

All new code under `src/daemon/restraint/`. Modifies Phase C.1's `actionExecutor.ts` to gate dispatch through the restraint layer.

```
src/daemon/
├── restraint/                        [NEW — the 10-layer restraint stack]
│   ├── types.ts                      Score, DeliveryMode, KarmaRecord, FocusState
│   ├── karma.ts                      Per-trigger karma store + decay
│   ├── focusDetector.ts              Detect deep work / quiet hours / meeting
│   ├── coalescer.ts                  Collapse repeated events within 60s window
│   ├── cooldownTracker.ts            Per-trigger debounce (last-fired-at)
│   ├── actionScorer.ts               Compute notify score (the core "should I?")
│   ├── deliveryRouter.ts             Map score → interrupt/surface/queue/log
│   ├── rateLimiter.ts                Hard caps (8/day, 2/hour) with urgent override
│   ├── dismissalLearner.ts           Track dismissals, auto-suspend after 3
│   ├── digestComposer.ts             Bundle queued items, deliver at scheduled times
│   ├── briefComposer.ts              Morning brief + evening reflection (TTS-ready)
│   ├── dryRunMode.ts                 New-rule observation period (24h before going live)
│   ├── triggerTierGate.ts            Extend Phase B Tier 1/2 to gate trigger dispatch
│   └── restraintPipeline.ts          Orchestrator wiring all layers in order
│
├── agency/
│   └── actionExecutor.ts             [MODIFY — gate dispatch through restraint pipeline]
│
└── index.ts                          [MODIFY — wire restraint subsystem]
```

**Test files** alongside source as `*.test.ts` via `bun test`.

---

## Task 0: Setup + types

**Files:**
- Create: `src/daemon/restraint/types.ts`
- Modify: `~/.kairos/restraint-config.json` (seed example)

The complete type surface. Every other restraint module imports from here. No tests — exercised by all.

- [ ] **Step 1: Create directory + types**

```bash
mkdir -p /Users/nirmalghinaiya/Desktop/kairos-sandbox/src/daemon/restraint
```

```typescript
// src/daemon/restraint/types.ts
// Type surface for the Earned Interrupt restraint architecture.
//
// The flow:
//   ActionRequest → RestraintPipeline → DeliveryDecision
//   where DeliveryDecision = { mode: ..., score: 0-1, reason: '...' }
//
// Layers are composable — each returns a partial decision or "passes the request
// through unchanged". Order matters; see restraintPipeline.ts for the wiring.

import type { AutonomyTier } from '../agency/types'

/** How urgently the user should see this. */
export type DeliveryMode =
  | 'interrupt'      // Popup + voice chime — score > 0.9
  | 'surface'        // Oval pulses + badge increments, no popup — score 0.7-0.9
  | 'digest'         // Queued, bundled into next scheduled digest — score 0.4-0.7
  | 'log_only'       // Trajectory recorded, never user-visible — score < 0.4
  | 'suppressed'     // Coalesced, cooldown, rate-limit, or focus-detection blocked
  | 'dry_run'        // New trigger in 24h observation; would-have-fired logged but not delivered

/** Components of the notify score. Each in [0,1]. */
export type ScoreComponents = {
  rule_match_strength: number       // How well trigger matched (1.0 for exact, less for partial)
  urgency: number                    // How soon something happens (1.0 = now, 0.3 = today, 0.05 = no time pressure)
  personal_relevance: number         // LLM-assessed via L3 persona facts
  context_availability: number       // 1.0 if user idle/responsive; 0.0 if deep focus
  novelty: number                    // 1.0 if first time; 0.1 if 5th similar today
  dismissal_penalty: number          // 0.2 per recent dismissal of similar (subtractive)
}

/** Final score (composed) + components for explainability. */
export type NotifyScore = {
  total: number                      // weighted sum, clamped [0,1]
  components: ScoreComponents
  explanation: string                // human-readable: "high urgency × low novelty = digest"
}

/** Decision per action request. */
export type DeliveryDecision = {
  mode: DeliveryMode
  score: NotifyScore | null         // null if dropped by hard gate before scoring
  reason: string                     // why this mode (for trajectory log)
  delivered_at?: number              // when actually surfaced (null until delivered)
  queue_for_digest?: 'morning' | 'lunch' | 'evening'  // which digest slot
}

/** Karma record per trigger — tracks dismissal/usage history. */
export type KarmaRecord = {
  trigger_id: string                 // compiled_orders_triggers.id OR intent.id
  fires: number                      // total dispatches
  delivered: number                  // reached the user (interrupt/surface)
  acted_on: number                   // user did something (approved, clicked, replied)
  dismissed: number                  // user explicitly dismissed
  ignored: number                    // user did nothing within 30 min
  last_dismissed_at: number | null
  last_acted_at: number | null
  current_score: number              // karma score, decays over time, used to bias future fires
  suspended_until: number | null     // auto-suspend after 3 dismissals in 7 days
}

/** Focus / availability state. */
export type FocusState = {
  current_app: string | null
  app_duration_sec: number           // how long in current app
  in_deep_focus: boolean             // > 25 min in same app = flow state
  in_meeting: boolean                // calendar event currently active
  in_quiet_hours: boolean            // 10pm-7am default
  pause_until: number | null         // user-requested pause (hotkey)
}

/** Digest = bundle of queued low-mid-score items. */
export type Digest = {
  slot: 'morning' | 'lunch' | 'evening'
  scheduled_for: number              // unix ms
  items: Array<{
    request_id: string
    title: string
    summary: string
    tier: AutonomyTier
    queued_at: number
  }>
  delivered_at: number | null
}

/** Per-rule dry-run record — track "would have fired N times". */
export type DryRunRecord = {
  trigger_id: string
  started_at: number                 // when rule was added
  ends_at: number                    // started_at + 24h
  would_have_fired_count: number     // incremented every match
  sample_events: string[]            // first 5 examples for user review
}

/** Output of the restraint pipeline for trajectory logging. */
export type RestraintTrace = {
  layer: string                      // which layer made the decision
  passed: boolean
  reason: string
  duration_ms: number
}

/** User-tunable restraint configuration. */
export type RestraintConfig = {
  // Score thresholds
  interrupt_threshold: number        // default 0.9
  surface_threshold: number          // default 0.7
  digest_threshold: number           // default 0.4

  // Score component weights (sum should ~1.0)
  weight_rule_match: number          // default 0.20
  weight_urgency: number             // default 0.30
  weight_personal_relevance: number  // default 0.20
  weight_context_availability: number // default 0.15
  weight_novelty: number             // default 0.10
  weight_dismissal_penalty: number   // default 0.05 (subtractive)

  // Hard caps
  max_interrupts_per_day: number     // default 8
  max_interrupts_per_hour: number    // default 2
  max_surfaces_per_hour: number      // default 6

  // Cooldowns
  default_trigger_cooldown_sec: number  // default 300 (5 min)
  same_intent_dedup_window_sec: number  // default 60

  // Quiet hours
  quiet_hours_start: string           // default "22:00"
  quiet_hours_end: string             // default "07:00"

  // Deep focus
  deep_focus_threshold_sec: number    // default 1500 (25 min)

  // Digest times
  digest_morning_time: string          // default "08:30"
  digest_lunch_time: string            // default "12:30"
  digest_evening_time: string          // default "17:30"

  // Dismissal learning
  auto_suspend_after_dismissals: number  // default 3
  dismissal_window_days: number       // default 7

  // Dry run
  dry_run_duration_hours: number      // default 24 (new rules observe for 24h before going live)
}
```

- [ ] **Step 2: Seed `~/.kairos/restraint-config.json`**

```bash
cat > ~/.kairos/restraint-config.json <<'EOF'
{
  "interrupt_threshold": 0.9,
  "surface_threshold": 0.7,
  "digest_threshold": 0.4,
  "weight_rule_match": 0.20,
  "weight_urgency": 0.30,
  "weight_personal_relevance": 0.20,
  "weight_context_availability": 0.15,
  "weight_novelty": 0.10,
  "weight_dismissal_penalty": 0.05,
  "max_interrupts_per_day": 8,
  "max_interrupts_per_hour": 2,
  "max_surfaces_per_hour": 6,
  "default_trigger_cooldown_sec": 300,
  "same_intent_dedup_window_sec": 60,
  "quiet_hours_start": "22:00",
  "quiet_hours_end": "07:00",
  "deep_focus_threshold_sec": 1500,
  "digest_morning_time": "08:30",
  "digest_lunch_time": "12:30",
  "digest_evening_time": "17:30",
  "auto_suspend_after_dismissals": 3,
  "dismissal_window_days": 7,
  "dry_run_duration_hours": 24
}
EOF
```

- [ ] **Step 3: Type-check + commit**

```bash
cd /Users/nirmalghinaiya/Desktop/kairos-sandbox
bunx tsc --noEmit src/daemon/restraint/types.ts 2>&1 | head -5
git add src/daemon/restraint/types.ts
git commit -m "feat(restraint): C.1.5 type surface — Earned Interrupt architecture foundation"
```

---

## Task 1: Focus detector

**Files:**
- Create: `src/daemon/restraint/focusDetector.ts`
- Test:  `src/daemon/restraint/focusDetector.test.ts`

Detects whether the user is in **deep focus** (single app >25 min), **in a meeting** (calendar event currently active), **in quiet hours** (10pm-7am default), or **manually paused**. Other layers read this to suppress non-urgent notifications.

- [ ] **Step 1: Write the failing test**

```typescript
// src/daemon/restraint/focusDetector.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { FocusDetector } from './focusDetector'
import type { RestraintConfig } from './types'

const baseConfig: Partial<RestraintConfig> = {
  quiet_hours_start: '22:00',
  quiet_hours_end: '07:00',
  deep_focus_threshold_sec: 1500,
}

describe('FocusDetector', () => {
  let detector: FocusDetector

  beforeEach(() => {
    detector = new FocusDetector(baseConfig as RestraintConfig, {
      now: () => new Date('2026-05-25T10:00:00').getTime(),  // 10 AM, not quiet hours
      probeFocusedApp: async () => ({ app: 'VS Code', duration_sec: 600 }),  // 10 min focus
      probeMeeting: async () => false,
    })
  })

  it('reports current focus state with no pause', async () => {
    const state = await detector.state()
    expect(state.current_app).toBe('VS Code')
    expect(state.app_duration_sec).toBe(600)
    expect(state.in_deep_focus).toBe(false)
    expect(state.in_meeting).toBe(false)
    expect(state.in_quiet_hours).toBe(false)
    expect(state.pause_until).toBeNull()
  })

  it('detects deep focus when app duration exceeds threshold', async () => {
    const d = new FocusDetector(baseConfig as RestraintConfig, {
      now: () => new Date('2026-05-25T10:00:00').getTime(),
      probeFocusedApp: async () => ({ app: 'VS Code', duration_sec: 1800 }),  // 30 min
      probeMeeting: async () => false,
    })
    const state = await d.state()
    expect(state.in_deep_focus).toBe(true)
  })

  it('detects quiet hours during night', async () => {
    const d = new FocusDetector(baseConfig as RestraintConfig, {
      now: () => new Date('2026-05-25T23:30:00').getTime(),  // 11:30 PM
      probeFocusedApp: async () => ({ app: '', duration_sec: 0 }),
      probeMeeting: async () => false,
    })
    const state = await d.state()
    expect(state.in_quiet_hours).toBe(true)
  })

  it('detects quiet hours during early morning', async () => {
    const d = new FocusDetector(baseConfig as RestraintConfig, {
      now: () => new Date('2026-05-25T05:30:00').getTime(),  // 5:30 AM
      probeFocusedApp: async () => ({ app: '', duration_sec: 0 }),
      probeMeeting: async () => false,
    })
    const state = await d.state()
    expect(state.in_quiet_hours).toBe(true)
  })

  it('respects manual pause until expiry', async () => {
    const futureTs = new Date('2026-05-25T10:00:00').getTime() + 600_000  // 10 min from "now"
    detector.pauseUntil(futureTs)
    const state = await detector.state()
    expect(state.pause_until).toBe(futureTs)
  })

  it('shouldSuppress returns true in deep focus for non-urgent', async () => {
    const d = new FocusDetector(baseConfig as RestraintConfig, {
      now: () => new Date('2026-05-25T10:00:00').getTime(),
      probeFocusedApp: async () => ({ app: 'VS Code', duration_sec: 1800 }),
      probeMeeting: async () => false,
    })
    expect(await d.shouldSuppress({ urgent: false })).toBe(true)
    expect(await d.shouldSuppress({ urgent: true })).toBe(false)
  })

  it('shouldSuppress returns true during quiet hours for non-urgent', async () => {
    const d = new FocusDetector(baseConfig as RestraintConfig, {
      now: () => new Date('2026-05-25T23:30:00').getTime(),
      probeFocusedApp: async () => ({ app: '', duration_sec: 0 }),
      probeMeeting: async () => false,
    })
    expect(await d.shouldSuppress({ urgent: false })).toBe(true)
  })
})
```

- [ ] **Step 2: Run failing test**

```bash
cd /Users/nirmalghinaiya/Desktop/kairos-sandbox
bun test src/daemon/restraint/focusDetector.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// src/daemon/restraint/focusDetector.ts
// Detects user availability/focus state for the restraint layer.
//
// Sources:
//   - Focused app + duration: from Phase A's focus-app observer (poll latest state)
//   - Meeting status: from Phase A's calendar-local observer (look for active event)
//   - Quiet hours: from config (default 10pm-7am)
//   - Manual pause: in-memory, set via pauseUntil()
//
// shouldSuppress(urgent) is the master "is this a bad time?" check.
// Urgent override bypasses everything except an explicit manual pause.

import type { FocusState, RestraintConfig } from './types'

type FocusedAppProbe = () => Promise<{ app: string; duration_sec: number }>
type MeetingProbe = () => Promise<boolean>
type NowFn = () => number

export type FocusDetectorOptions = {
  now?: NowFn
  probeFocusedApp?: FocusedAppProbe
  probeMeeting?: MeetingProbe
}

export class FocusDetector {
  private now: NowFn
  private probeFocusedApp: FocusedAppProbe
  private probeMeeting: MeetingProbe
  private pauseUntilMs: number | null = null

  constructor(private config: RestraintConfig, opts?: FocusDetectorOptions) {
    this.now = opts?.now ?? Date.now
    this.probeFocusedApp = opts?.probeFocusedApp ?? defaultFocusedAppProbe
    this.probeMeeting = opts?.probeMeeting ?? defaultMeetingProbe
  }

  async state(): Promise<FocusState> {
    const [appInfo, meeting] = await Promise.all([
      this.probeFocusedApp().catch(() => ({ app: null as any, duration_sec: 0 })),
      this.probeMeeting().catch(() => false),
    ])
    return {
      current_app: appInfo.app || null,
      app_duration_sec: appInfo.duration_sec,
      in_deep_focus: appInfo.duration_sec >= this.config.deep_focus_threshold_sec,
      in_meeting: meeting,
      in_quiet_hours: this.isQuietHours(),
      pause_until: this.pauseUntilMs && this.pauseUntilMs > this.now() ? this.pauseUntilMs : null,
    }
  }

  /** Returns true if we should suppress non-urgent notifications now. */
  async shouldSuppress(opts: { urgent: boolean }): Promise<boolean> {
    const s = await this.state()
    if (s.pause_until) return true                       // manual pause always wins
    if (opts.urgent) return false                        // urgent bypasses all
    return s.in_deep_focus || s.in_meeting || s.in_quiet_hours
  }

  pauseUntil(timestampMs: number): void {
    this.pauseUntilMs = timestampMs
  }

  clearPause(): void {
    this.pauseUntilMs = null
  }

  private isQuietHours(): boolean {
    const d = new Date(this.now())
    const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    const start = this.config.quiet_hours_start
    const end = this.config.quiet_hours_end
    if (start <= end) {
      return hhmm >= start && hhmm < end
    } else {
      return hhmm >= start || hhmm < end   // wraps midnight (e.g. 22:00 → 07:00)
    }
  }
}

async function defaultFocusedAppProbe(): Promise<{ app: string; duration_sec: number }> {
  // Default: shell osascript to read frontmost app. Duration is not directly available
  // from osascript — caller (RestraintPipeline) should provide a probe backed by Phase A's
  // focus-app observer which tracks per-app durations.
  const proc = Bun.spawn(['osascript', '-e',
    'tell application "System Events" to return name of first application process whose frontmost is true'],
    { stdout: 'pipe' })
  await proc.exited
  const app = (await new Response(proc.stdout).text()).trim()
  return { app, duration_sec: 0 }
}

async function defaultMeetingProbe(): Promise<boolean> {
  // Default: false. Real probe should query Phase A's calendar-local observer.
  return false
}
```

- [ ] **Step 4: Run tests + commit**

```bash
bun test src/daemon/restraint/focusDetector.test.ts
git add src/daemon/restraint/focusDetector.ts src/daemon/restraint/focusDetector.test.ts
git commit -m "feat(restraint): FocusDetector — deep focus / meeting / quiet hours / manual pause"
```

Expected: 7/7 tests pass.

---

## Task 2: Karma store

**Files:**
- Create: `src/daemon/restraint/karma.ts`
- Test:  `src/daemon/restraint/karma.test.ts`

Per-trigger and per-intent karma tracking. Every fire/delivery/dismissal/action updates karma. Karma feeds back into the score (dismissal_penalty component) and triggers auto-suspend after N dismissals.

- [ ] **Step 1: Write the failing test**

```typescript
// src/daemon/restraint/karma.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { KarmaStore, KARMA_SCHEMA } from './karma'

describe('KarmaStore', () => {
  let db: Database
  let store: KarmaStore

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(KARMA_SCHEMA)
    store = new KarmaStore(db, { auto_suspend_after_dismissals: 3, dismissal_window_days: 7 } as any)
  })

  it('records a fire and creates a karma record', () => {
    store.recordFire('trig-1')
    const k = store.get('trig-1')
    expect(k?.fires).toBe(1)
    expect(k?.dismissed).toBe(0)
  })

  it('tracks deliveries and dismissals separately', () => {
    store.recordFire('trig-1')
    store.recordDelivery('trig-1')
    store.recordDismissal('trig-1')
    const k = store.get('trig-1')
    expect(k?.delivered).toBe(1)
    expect(k?.dismissed).toBe(1)
    expect(k?.last_dismissed_at).toBeGreaterThan(0)
  })

  it('auto-suspends after 3 dismissals in window', () => {
    store.recordDismissal('trig-1')
    store.recordDismissal('trig-1')
    expect(store.isSuspended('trig-1')).toBe(false)
    store.recordDismissal('trig-1')
    expect(store.isSuspended('trig-1')).toBe(true)
  })

  it('does not auto-suspend if dismissals are spread beyond window', () => {
    const oneWeekAgo = Date.now() - 8 * 24 * 3600_000
    store.recordDismissalAt('trig-1', oneWeekAgo)
    store.recordDismissalAt('trig-1', oneWeekAgo)
    store.recordDismissal('trig-1')   // most recent
    // Only 1 dismissal in window → not suspended
    expect(store.isSuspended('trig-1')).toBe(false)
  })

  it('dismissal penalty grows with recent dismissals', () => {
    expect(store.dismissalPenalty('trig-1')).toBe(0)
    store.recordDismissal('trig-1')
    expect(store.dismissalPenalty('trig-1')).toBeCloseTo(0.2, 1)
    store.recordDismissal('trig-1')
    store.recordDismissal('trig-1')
    expect(store.dismissalPenalty('trig-1')).toBeCloseTo(0.6, 1)
  })

  it('listSuspended returns currently-suspended trigger ids', () => {
    store.recordDismissal('a'); store.recordDismissal('a'); store.recordDismissal('a')
    store.recordDismissal('b')
    expect(store.listSuspended()).toContain('a')
    expect(store.listSuspended()).not.toContain('b')
  })

  it('clearSuspension reactivates a trigger', () => {
    store.recordDismissal('a'); store.recordDismissal('a'); store.recordDismissal('a')
    expect(store.isSuspended('a')).toBe(true)
    store.clearSuspension('a')
    expect(store.isSuspended('a')).toBe(false)
  })
})
```

- [ ] **Step 2: Run failing test**

```bash
bun test src/daemon/restraint/karma.test.ts
```

- [ ] **Step 3: Write the implementation**

```typescript
// src/daemon/restraint/karma.ts
// Per-trigger karma store. Every fire, delivery, dismissal, action gets recorded.
// Karma feeds into the action scorer (dismissal penalty) and auto-suspends triggers
// that the user has dismissed too many times recently.

import type { Database } from 'bun:sqlite'
import type { KarmaRecord, RestraintConfig } from './types'

export const KARMA_SCHEMA = `
  CREATE TABLE IF NOT EXISTS restraint_karma (
    trigger_id          TEXT PRIMARY KEY,
    fires               INTEGER NOT NULL DEFAULT 0,
    delivered           INTEGER NOT NULL DEFAULT 0,
    acted_on            INTEGER NOT NULL DEFAULT 0,
    dismissed           INTEGER NOT NULL DEFAULT 0,
    ignored             INTEGER NOT NULL DEFAULT 0,
    last_dismissed_at   INTEGER,
    last_acted_at       INTEGER,
    current_score       REAL NOT NULL DEFAULT 0.5,
    suspended_until     INTEGER
  );
  CREATE TABLE IF NOT EXISTS restraint_dismissal_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    trigger_id  TEXT NOT NULL,
    ts          INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_dismissal_recent ON restraint_dismissal_log(trigger_id, ts);
`

type CfgSubset = Pick<RestraintConfig, 'auto_suspend_after_dismissals' | 'dismissal_window_days'>

export class KarmaStore {
  constructor(private db: Database, private config: CfgSubset) {
    db.exec(KARMA_SCHEMA)
  }

  recordFire(triggerId: string): void {
    this.upsert(triggerId)
    this.db.run('UPDATE restraint_karma SET fires = fires + 1 WHERE trigger_id = ?', [triggerId])
  }

  recordDelivery(triggerId: string): void {
    this.upsert(triggerId)
    this.db.run('UPDATE restraint_karma SET delivered = delivered + 1 WHERE trigger_id = ?', [triggerId])
  }

  recordAction(triggerId: string): void {
    this.upsert(triggerId)
    this.db.run(
      'UPDATE restraint_karma SET acted_on = acted_on + 1, last_acted_at = ? WHERE trigger_id = ?',
      [Date.now(), triggerId],
    )
  }

  recordIgnored(triggerId: string): void {
    this.upsert(triggerId)
    this.db.run('UPDATE restraint_karma SET ignored = ignored + 1 WHERE trigger_id = ?', [triggerId])
  }

  recordDismissal(triggerId: string): void {
    this.recordDismissalAt(triggerId, Date.now())
  }

  recordDismissalAt(triggerId: string, ts: number): void {
    this.upsert(triggerId)
    this.db.run('INSERT INTO restraint_dismissal_log (trigger_id, ts) VALUES (?, ?)', [triggerId, ts])
    this.db.run(
      'UPDATE restraint_karma SET dismissed = dismissed + 1, last_dismissed_at = ? WHERE trigger_id = ?',
      [ts, triggerId],
    )
    this.maybeAutoSuspend(triggerId)
  }

  isSuspended(triggerId: string): boolean {
    const row = this.db.query(
      'SELECT suspended_until FROM restraint_karma WHERE trigger_id = ?',
    ).get(triggerId) as { suspended_until: number | null } | null
    if (!row || !row.suspended_until) return false
    return row.suspended_until > Date.now()
  }

  /** Dismissal penalty = 0.2 per dismissal in past N days, capped at 0.8 */
  dismissalPenalty(triggerId: string): number {
    const cutoff = Date.now() - this.config.dismissal_window_days * 24 * 3600_000
    const row = this.db.query(
      'SELECT COUNT(*) as n FROM restraint_dismissal_log WHERE trigger_id = ? AND ts > ?',
    ).get(triggerId, cutoff) as { n: number }
    return Math.min(0.8, row.n * 0.2)
  }

  get(triggerId: string): KarmaRecord | null {
    return this.db.query('SELECT * FROM restraint_karma WHERE trigger_id = ?').get(triggerId) as KarmaRecord | null
  }

  listSuspended(): string[] {
    const now = Date.now()
    const rows = this.db.query(
      'SELECT trigger_id FROM restraint_karma WHERE suspended_until IS NOT NULL AND suspended_until > ?',
    ).all(now) as Array<{ trigger_id: string }>
    return rows.map(r => r.trigger_id)
  }

  clearSuspension(triggerId: string): void {
    this.db.run('UPDATE restraint_karma SET suspended_until = NULL WHERE trigger_id = ?', [triggerId])
  }

  private upsert(triggerId: string): void {
    this.db.run(
      'INSERT OR IGNORE INTO restraint_karma (trigger_id) VALUES (?)',
      [triggerId],
    )
  }

  private maybeAutoSuspend(triggerId: string): void {
    const cutoff = Date.now() - this.config.dismissal_window_days * 24 * 3600_000
    const recent = (this.db.query(
      'SELECT COUNT(*) as n FROM restraint_dismissal_log WHERE trigger_id = ? AND ts > ?',
    ).get(triggerId, cutoff) as { n: number }).n
    if (recent >= this.config.auto_suspend_after_dismissals) {
      // Suspend for 7 days; user can manually clear via CLI/HUD
      const suspendUntil = Date.now() + 7 * 24 * 3600_000
      this.db.run('UPDATE restraint_karma SET suspended_until = ? WHERE trigger_id = ?', [suspendUntil, triggerId])
    }
  }
}
```

- [ ] **Step 4: Run tests + commit**

```bash
bun test src/daemon/restraint/karma.test.ts
git add src/daemon/restraint/karma.ts src/daemon/restraint/karma.test.ts
git commit -m "feat(restraint): KarmaStore — dismissal penalty + auto-suspend after 3 dismissals in 7d"
```

Expected: 7/7 tests pass.

---

## Task 3: Coalescer

**Files:**
- Create: `src/daemon/restraint/coalescer.ts`
- Test:  `src/daemon/restraint/coalescer.test.ts`

Collapses repeated events within a short window. Example: a git push triggers 100 file-events for `.git/objects/*` files. The coalescer collapses these into one composite event: "100 file-events, all under `.git/`". The trigger engine sees ONE batch instead of 100 individual fires.

- [ ] **Step 1: Write the failing test**

```typescript
// src/daemon/restraint/coalescer.test.ts
import { describe, it, expect } from 'bun:test'
import { Coalescer } from './coalescer'

describe('Coalescer', () => {
  it('collapses events from same source within window', async () => {
    const c = new Coalescer({ windowMs: 100 })
    const flushed: any[] = []
    c.onFlush(batch => flushed.push(batch))
    c.add({ source: 'file-events', kind: 'modified', payload: { path: '/a' } } as any)
    c.add({ source: 'file-events', kind: 'modified', payload: { path: '/b' } } as any)
    c.add({ source: 'file-events', kind: 'modified', payload: { path: '/c' } } as any)
    await new Promise(r => setTimeout(r, 150))
    expect(flushed.length).toBe(1)
    expect(flushed[0].count).toBe(3)
    expect(flushed[0].source).toBe('file-events')
  })

  it('keeps separate batches for separate sources', async () => {
    const c = new Coalescer({ windowMs: 100 })
    const flushed: any[] = []
    c.onFlush(batch => flushed.push(batch))
    c.add({ source: 'file-events', kind: 'modified', payload: {} } as any)
    c.add({ source: 'clipboard', kind: 'changed', payload: {} } as any)
    await new Promise(r => setTimeout(r, 150))
    expect(flushed.length).toBe(2)
  })

  it('flushes when window expires', async () => {
    const c = new Coalescer({ windowMs: 30 })
    const flushed: any[] = []
    c.onFlush(batch => flushed.push(batch))
    c.add({ source: 'a', kind: 'k', payload: {} } as any)
    await new Promise(r => setTimeout(r, 80))
    expect(flushed.length).toBe(1)
  })

  it('summarizes payloads into composite description', async () => {
    const c = new Coalescer({ windowMs: 50 })
    const flushed: any[] = []
    c.onFlush(batch => flushed.push(batch))
    c.add({ source: 'file-events', kind: 'modified', payload: { path: '/Users/x/repo/.git/index' } } as any)
    c.add({ source: 'file-events', kind: 'modified', payload: { path: '/Users/x/repo/.git/HEAD' } } as any)
    await new Promise(r => setTimeout(r, 100))
    expect(flushed[0].summary).toContain('file-events')
    expect(flushed[0].summary).toMatch(/2 events/)
    expect(flushed[0].common_prefix).toContain('.git')
  })
})
```

- [ ] **Step 2: Run failing test**

```bash
bun test src/daemon/restraint/coalescer.test.ts
```

- [ ] **Step 3: Write the implementation**

```typescript
// src/daemon/restraint/coalescer.ts
// Collapses repeated events from the same source within a short window into
// one composite event. Reduces 100 git-related file-events to one batch.

type EventLike = {
  source: string
  kind: string
  payload: Record<string, unknown>
}

export type CoalescedBatch = {
  source: string
  count: number
  events: EventLike[]
  summary: string
  common_prefix?: string
}

export type CoalescerOptions = {
  windowMs?: number   // default 60_000
}

type FlushCallback = (batch: CoalescedBatch) => void

export class Coalescer {
  private buffers: Map<string, EventLike[]> = new Map()
  private timers: Map<string, ReturnType<typeof setTimeout>> = new Map()
  private flushCallbacks: FlushCallback[] = []
  private windowMs: number

  constructor(opts?: CoalescerOptions) {
    this.windowMs = opts?.windowMs ?? 60_000
  }

  onFlush(cb: FlushCallback): void {
    this.flushCallbacks.push(cb)
  }

  add(event: EventLike): void {
    const buf = this.buffers.get(event.source) ?? []
    buf.push(event)
    this.buffers.set(event.source, buf)
    // Reset timer for this source — flush after windowMs of silence
    const existing = this.timers.get(event.source)
    if (existing) clearTimeout(existing)
    const t = setTimeout(() => this.flushSource(event.source), this.windowMs)
    this.timers.set(event.source, t)
  }

  private flushSource(source: string): void {
    const buf = this.buffers.get(source)
    if (!buf || buf.length === 0) return
    this.buffers.delete(source)
    this.timers.delete(source)

    const batch: CoalescedBatch = {
      source,
      count: buf.length,
      events: buf,
      summary: `${buf.length} events from ${source}`,
      common_prefix: this.findCommonPrefix(buf),
    }
    for (const cb of this.flushCallbacks) {
      try { cb(batch) } catch { /* ignore */ }
    }
  }

  private findCommonPrefix(events: EventLike[]): string | undefined {
    const paths = events
      .map(e => (e.payload as any).path)
      .filter((p): p is string => typeof p === 'string')
    if (paths.length === 0) return undefined
    let prefix = paths[0]!
    for (const p of paths.slice(1)) {
      while (!p.startsWith(prefix) && prefix.length > 0) {
        prefix = prefix.slice(0, -1)
      }
      if (prefix.length === 0) break
    }
    return prefix || undefined
  }
}
```

- [ ] **Step 4: Run tests + commit**

```bash
bun test src/daemon/restraint/coalescer.test.ts
git add src/daemon/restraint/coalescer.ts src/daemon/restraint/coalescer.test.ts
git commit -m "feat(restraint): Coalescer — collapse N events from same source into 1 batch"
```

Expected: 4/4 tests pass.

---

## Task 4: Cooldown tracker

**Files:**
- Create: `src/daemon/restraint/cooldownTracker.ts`
- Test:  `src/daemon/restraint/cooldownTracker.test.ts`

Per-trigger debounce. Same trigger ID can't fire within N seconds of its last fire. Default 5 minutes; configurable per trigger.

- [ ] **Step 1: Write the failing test**

```typescript
// src/daemon/restraint/cooldownTracker.test.ts
import { describe, it, expect } from 'bun:test'
import { CooldownTracker } from './cooldownTracker'

describe('CooldownTracker', () => {
  it('allows first fire of a trigger', () => {
    const t = new CooldownTracker(60_000)
    expect(t.canFire('trig-a')).toBe(true)
  })

  it('blocks second fire within cooldown', () => {
    const t = new CooldownTracker(60_000)
    t.recordFire('trig-a')
    expect(t.canFire('trig-a')).toBe(false)
  })

  it('allows fire again after cooldown expires', async () => {
    const t = new CooldownTracker(30)
    t.recordFire('trig-a')
    await new Promise(r => setTimeout(r, 50))
    expect(t.canFire('trig-a')).toBe(true)
  })

  it('per-trigger cooldown override', () => {
    const t = new CooldownTracker(60_000, { 'trig-special': 1 })
    t.recordFire('trig-special')
    // Immediate retry — short cooldown of 1ms
    setTimeout(() => {
      expect(t.canFire('trig-special')).toBe(true)
    }, 5)
  })

  it('different triggers do not block each other', () => {
    const t = new CooldownTracker(60_000)
    t.recordFire('trig-a')
    expect(t.canFire('trig-b')).toBe(true)
  })

  it('reset clears all cooldowns', () => {
    const t = new CooldownTracker(60_000)
    t.recordFire('trig-a')
    t.reset()
    expect(t.canFire('trig-a')).toBe(true)
  })
})
```

- [ ] **Step 2: Implementation**

```typescript
// src/daemon/restraint/cooldownTracker.ts
// Per-trigger debounce. In-memory; resets on daemon restart (intentional —
// fresh start should fire fresh).

export class CooldownTracker {
  private lastFiredAt: Map<string, number> = new Map()

  constructor(
    private defaultCooldownMs: number,
    private overrides: Record<string, number> = {},
  ) {}

  canFire(triggerId: string): boolean {
    const lastMs = this.lastFiredAt.get(triggerId)
    if (lastMs === undefined) return true
    const cooldown = this.overrides[triggerId] ?? this.defaultCooldownMs
    return Date.now() - lastMs >= cooldown
  }

  recordFire(triggerId: string): void {
    this.lastFiredAt.set(triggerId, Date.now())
  }

  reset(): void {
    this.lastFiredAt.clear()
  }
}
```

- [ ] **Step 3: Run tests + commit**

```bash
bun test src/daemon/restraint/cooldownTracker.test.ts
git add src/daemon/restraint/cooldownTracker.ts src/daemon/restraint/cooldownTracker.test.ts
git commit -m "feat(restraint): CooldownTracker — per-trigger debounce with per-id overrides"
```

Expected: 6/6 tests pass.

---

## Task 5: Rate limiter

**Files:**
- Create: `src/daemon/restraint/rateLimiter.ts`
- Test:  `src/daemon/restraint/rateLimiter.test.ts`

Hard caps on interrupt + surface tiers. Tracks deliveries per day + per hour. Urgent override bypasses caps.

- [ ] **Step 1: Write the failing test**

```typescript
// src/daemon/restraint/rateLimiter.test.ts
import { describe, it, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { RateLimiter, RATE_LIMITER_SCHEMA } from './rateLimiter'

describe('RateLimiter', () => {
  it('allows interrupts up to daily cap', () => {
    const db = new Database(':memory:')
    db.exec(RATE_LIMITER_SCHEMA)
    const limiter = new RateLimiter(db, { max_interrupts_per_day: 3, max_interrupts_per_hour: 10, max_surfaces_per_hour: 100 } as any)
    expect(limiter.canDeliver('interrupt', false)).toBe(true)
    limiter.recordDelivery('interrupt')
    expect(limiter.canDeliver('interrupt', false)).toBe(true)
    limiter.recordDelivery('interrupt')
    expect(limiter.canDeliver('interrupt', false)).toBe(true)
    limiter.recordDelivery('interrupt')
    expect(limiter.canDeliver('interrupt', false)).toBe(false)   // hit daily cap
  })

  it('urgent bypasses daily cap', () => {
    const db = new Database(':memory:')
    db.exec(RATE_LIMITER_SCHEMA)
    const limiter = new RateLimiter(db, { max_interrupts_per_day: 1, max_interrupts_per_hour: 10, max_surfaces_per_hour: 100 } as any)
    limiter.recordDelivery('interrupt')
    expect(limiter.canDeliver('interrupt', false)).toBe(false)
    expect(limiter.canDeliver('interrupt', true)).toBe(true)   // urgent bypasses
  })

  it('enforces per-hour cap separately', () => {
    const db = new Database(':memory:')
    db.exec(RATE_LIMITER_SCHEMA)
    const limiter = new RateLimiter(db, { max_interrupts_per_day: 100, max_interrupts_per_hour: 2, max_surfaces_per_hour: 100 } as any)
    limiter.recordDelivery('interrupt')
    limiter.recordDelivery('interrupt')
    expect(limiter.canDeliver('interrupt', false)).toBe(false)   // hour cap hit
  })

  it('surface tier has its own cap', () => {
    const db = new Database(':memory:')
    db.exec(RATE_LIMITER_SCHEMA)
    const limiter = new RateLimiter(db, { max_interrupts_per_day: 100, max_interrupts_per_hour: 100, max_surfaces_per_hour: 2 } as any)
    limiter.recordDelivery('surface')
    limiter.recordDelivery('surface')
    expect(limiter.canDeliver('surface', false)).toBe(false)
    expect(limiter.canDeliver('interrupt', false)).toBe(true)   // interrupt unaffected
  })

  it('counts reset based on time window', () => {
    const db = new Database(':memory:')
    db.exec(RATE_LIMITER_SCHEMA)
    const limiter = new RateLimiter(db, { max_interrupts_per_day: 1, max_interrupts_per_hour: 1, max_surfaces_per_hour: 100 } as any)
    // Insert a delivery from 2 days ago directly
    db.run("INSERT INTO restraint_delivery_log (mode, ts) VALUES ('interrupt', ?)", [Date.now() - 3 * 24 * 3600_000])
    expect(limiter.canDeliver('interrupt', false)).toBe(true)   // old delivery doesn't count
  })
})
```

- [ ] **Step 2: Implementation**

```typescript
// src/daemon/restraint/rateLimiter.ts
import type { Database } from 'bun:sqlite'
import type { RestraintConfig, DeliveryMode } from './types'

export const RATE_LIMITER_SCHEMA = `
  CREATE TABLE IF NOT EXISTS restraint_delivery_log (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    mode  TEXT NOT NULL,
    ts    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_delivery_log_ts ON restraint_delivery_log(ts, mode);
`

type CfgSubset = Pick<RestraintConfig,
  'max_interrupts_per_day' | 'max_interrupts_per_hour' | 'max_surfaces_per_hour'>

export class RateLimiter {
  constructor(private db: Database, private config: CfgSubset) {
    db.exec(RATE_LIMITER_SCHEMA)
  }

  canDeliver(mode: DeliveryMode, urgent: boolean): boolean {
    if (urgent) return true
    if (mode === 'log_only' || mode === 'dry_run' || mode === 'suppressed') return true
    if (mode === 'digest') return true  // digest path has its own scheduling, not capped here

    const now = Date.now()
    const oneHourAgo = now - 3600_000
    const oneDayAgo = now - 24 * 3600_000

    if (mode === 'interrupt') {
      const dayCount = this.count('interrupt', oneDayAgo)
      if (dayCount >= this.config.max_interrupts_per_day) return false
      const hourCount = this.count('interrupt', oneHourAgo)
      if (hourCount >= this.config.max_interrupts_per_hour) return false
    } else if (mode === 'surface') {
      const hourCount = this.count('surface', oneHourAgo)
      if (hourCount >= this.config.max_surfaces_per_hour) return false
    }

    return true
  }

  recordDelivery(mode: DeliveryMode): void {
    this.db.run('INSERT INTO restraint_delivery_log (mode, ts) VALUES (?, ?)', [mode, Date.now()])
  }

  private count(mode: string, sinceTs: number): number {
    return (this.db.query(
      'SELECT COUNT(*) as n FROM restraint_delivery_log WHERE mode = ? AND ts > ?',
    ).get(mode, sinceTs) as { n: number }).n
  }
}
```

- [ ] **Step 3: Run tests + commit**

```bash
bun test src/daemon/restraint/rateLimiter.test.ts
git add src/daemon/restraint/rateLimiter.ts src/daemon/restraint/rateLimiter.test.ts
git commit -m "feat(restraint): RateLimiter — hard caps with urgent-override bypass"
```

Expected: 5/5 tests pass.

---

## Task 6: Action scorer

**Files:**
- Create: `src/daemon/restraint/actionScorer.ts`
- Test:  `src/daemon/restraint/actionScorer.test.ts`

The core "should I notify?" computation. Weights configurable. Returns `NotifyScore` with components for explainability.

- [ ] **Step 1: Write the failing test**

```typescript
// src/daemon/restraint/actionScorer.test.ts
import { describe, it, expect } from 'bun:test'
import { ActionScorer } from './actionScorer'
import type { RestraintConfig } from './types'

const baseConfig: RestraintConfig = {
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

describe('ActionScorer', () => {
  it('high components → high score', () => {
    const s = new ActionScorer(baseConfig)
    const score = s.compute({
      rule_match_strength: 1, urgency: 1, personal_relevance: 1,
      context_availability: 1, novelty: 1, dismissal_penalty: 0,
    })
    expect(score.total).toBeGreaterThan(0.9)
  })

  it('all zero → zero', () => {
    const s = new ActionScorer(baseConfig)
    const score = s.compute({
      rule_match_strength: 0, urgency: 0, personal_relevance: 0,
      context_availability: 0, novelty: 0, dismissal_penalty: 0,
    })
    expect(score.total).toBe(0)
  })

  it('dismissal penalty subtracts from total', () => {
    const s = new ActionScorer(baseConfig)
    const baseline = s.compute({
      rule_match_strength: 1, urgency: 1, personal_relevance: 1,
      context_availability: 1, novelty: 1, dismissal_penalty: 0,
    }).total
    const penalized = s.compute({
      rule_match_strength: 1, urgency: 1, personal_relevance: 1,
      context_availability: 1, novelty: 1, dismissal_penalty: 0.6,
    }).total
    expect(penalized).toBeLessThan(baseline)
  })

  it('low context_availability (deep focus) drops score', () => {
    const s = new ActionScorer(baseConfig)
    const available = s.compute({
      rule_match_strength: 1, urgency: 0.5, personal_relevance: 0.5,
      context_availability: 1, novelty: 0.5, dismissal_penalty: 0,
    }).total
    const unavailable = s.compute({
      rule_match_strength: 1, urgency: 0.5, personal_relevance: 0.5,
      context_availability: 0, novelty: 0.5, dismissal_penalty: 0,
    }).total
    expect(unavailable).toBeLessThan(available)
  })

  it('explanation is human-readable', () => {
    const s = new ActionScorer(baseConfig)
    const score = s.compute({
      rule_match_strength: 0.9, urgency: 0.9, personal_relevance: 0.7,
      context_availability: 0.5, novelty: 0.8, dismissal_penalty: 0,
    })
    expect(score.explanation).toMatch(/(urgency|relevance|context)/)
  })
})
```

- [ ] **Step 2: Implementation**

```typescript
// src/daemon/restraint/actionScorer.ts
// The core "should I notify?" computation. Weighted sum of normalized
// components, clamped to [0,1]. Each component is independently
// computed by upstream layers (perception gate, focus detector, karma store).

import type { NotifyScore, ScoreComponents, RestraintConfig } from './types'

type CfgWeights = Pick<RestraintConfig,
  'weight_rule_match' | 'weight_urgency' | 'weight_personal_relevance' |
  'weight_context_availability' | 'weight_novelty' | 'weight_dismissal_penalty'>

export class ActionScorer {
  constructor(private config: CfgWeights) {}

  compute(components: ScoreComponents): NotifyScore {
    const positive =
      this.config.weight_rule_match           * components.rule_match_strength +
      this.config.weight_urgency              * components.urgency +
      this.config.weight_personal_relevance   * components.personal_relevance +
      this.config.weight_context_availability * components.context_availability +
      this.config.weight_novelty              * components.novelty

    const penalty = this.config.weight_dismissal_penalty * components.dismissal_penalty
    const total = Math.max(0, Math.min(1, positive - penalty))

    return {
      total,
      components,
      explanation: this.explain(components, total),
    }
  }

  private explain(c: ScoreComponents, total: number): string {
    const parts: string[] = []
    if (c.urgency >= 0.8) parts.push('high urgency')
    else if (c.urgency <= 0.2) parts.push('low urgency')
    if (c.context_availability <= 0.3) parts.push('user busy (deep focus or meeting)')
    if (c.novelty <= 0.3) parts.push('similar already seen recently')
    if (c.dismissal_penalty >= 0.4) parts.push('recently dismissed')
    if (c.personal_relevance >= 0.8) parts.push('matches user persona well')
    return parts.length > 0 ? `score=${total.toFixed(2)} (${parts.join(', ')})` : `score=${total.toFixed(2)}`
  }
}
```

- [ ] **Step 3: Run tests + commit**

```bash
bun test src/daemon/restraint/actionScorer.test.ts
git add src/daemon/restraint/actionScorer.ts src/daemon/restraint/actionScorer.test.ts
git commit -m "feat(restraint): ActionScorer — weighted sum, explainable, configurable"
```

Expected: 5/5 tests pass.

---

## Task 7: Delivery router

**Files:**
- Create: `src/daemon/restraint/deliveryRouter.ts`
- Test:  `src/daemon/restraint/deliveryRouter.test.ts`

Maps a `NotifyScore` to a `DeliveryMode` based on thresholds. Simple but critical: this is where the score becomes a routing decision.

- [ ] **Step 1: Write the failing test**

```typescript
// src/daemon/restraint/deliveryRouter.test.ts
import { describe, it, expect } from 'bun:test'
import { DeliveryRouter } from './deliveryRouter'

describe('DeliveryRouter', () => {
  const router = new DeliveryRouter({
    interrupt_threshold: 0.9, surface_threshold: 0.7, digest_threshold: 0.4,
  } as any)

  function score(total: number) {
    return { total, components: {} as any, explanation: '' }
  }

  it('routes >0.9 to interrupt', () => {
    expect(router.route(score(0.95)).mode).toBe('interrupt')
  })
  it('routes 0.7-0.9 to surface', () => {
    expect(router.route(score(0.8)).mode).toBe('surface')
  })
  it('routes 0.4-0.7 to digest', () => {
    expect(router.route(score(0.5)).mode).toBe('digest')
  })
  it('routes <0.4 to log_only', () => {
    expect(router.route(score(0.2)).mode).toBe('log_only')
  })
  it('chooses digest slot based on time of day', () => {
    const morning = router.route(score(0.5), new Date('2026-05-25T07:00:00').getTime())
    expect(morning.queue_for_digest).toBe('morning')
    const lunch = router.route(score(0.5), new Date('2026-05-25T11:00:00').getTime())
    expect(lunch.queue_for_digest).toBe('lunch')
    const evening = router.route(score(0.5), new Date('2026-05-25T15:00:00').getTime())
    expect(evening.queue_for_digest).toBe('evening')
    const nextMorning = router.route(score(0.5), new Date('2026-05-25T19:00:00').getTime())
    expect(nextMorning.queue_for_digest).toBe('morning')
  })
})
```

- [ ] **Step 2: Implementation**

```typescript
// src/daemon/restraint/deliveryRouter.ts
import type { NotifyScore, DeliveryDecision, RestraintConfig } from './types'

type CfgSubset = Pick<RestraintConfig, 'interrupt_threshold' | 'surface_threshold' | 'digest_threshold'>

export class DeliveryRouter {
  constructor(private config: CfgSubset) {}

  route(score: NotifyScore, nowMs: number = Date.now()): DeliveryDecision {
    if (score.total >= this.config.interrupt_threshold) {
      return { mode: 'interrupt', score, reason: `score ${score.total.toFixed(2)} >= ${this.config.interrupt_threshold}` }
    }
    if (score.total >= this.config.surface_threshold) {
      return { mode: 'surface', score, reason: `score ${score.total.toFixed(2)} >= ${this.config.surface_threshold}` }
    }
    if (score.total >= this.config.digest_threshold) {
      return {
        mode: 'digest', score,
        reason: `score ${score.total.toFixed(2)} >= ${this.config.digest_threshold}, queuing`,
        queue_for_digest: this.pickDigestSlot(nowMs),
      }
    }
    return { mode: 'log_only', score, reason: `score ${score.total.toFixed(2)} below digest threshold` }
  }

  private pickDigestSlot(nowMs: number): 'morning' | 'lunch' | 'evening' {
    const d = new Date(nowMs)
    const hour = d.getHours()
    if (hour < 8 || hour >= 18) return 'morning'    // before 8am or after 6pm → next morning
    if (hour < 11) return 'lunch'                    // 8-11am → lunch digest
    if (hour < 16) return 'evening'                  // 11am-4pm → evening digest
    return 'morning'                                 // 4-6pm → next morning
  }
}
```

- [ ] **Step 3: Run tests + commit**

```bash
bun test src/daemon/restraint/deliveryRouter.test.ts
git add src/daemon/restraint/deliveryRouter.ts src/daemon/restraint/deliveryRouter.test.ts
git commit -m "feat(restraint): DeliveryRouter — score → interrupt/surface/digest/log + digest slot"
```

Expected: 5/5 tests pass.

---

## Task 8: Digest composer

**Files:**
- Create: `src/daemon/restraint/digestComposer.ts`
- Test:  `src/daemon/restraint/digestComposer.test.ts`

Queues `digest`-tier items into morning/lunch/evening bundles. Delivers each bundle as ONE notification with a summary of all items. Apple Notification Summary, but smarter (LLM-composed summary).

- [ ] **Step 1: Write the failing test**

```typescript
// src/daemon/restraint/digestComposer.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { DigestComposer, DIGEST_SCHEMA } from './digestComposer'

describe('DigestComposer', () => {
  let db: Database
  let composer: DigestComposer

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(DIGEST_SCHEMA)
    composer = new DigestComposer(db)
  })

  it('queues an item for a digest slot', () => {
    composer.queue('morning', { request_id: 'r1', title: 'New PR', summary: 'PR #123 opened', tier: 'GREEN' })
    expect(composer.pendingFor('morning').length).toBe(1)
  })

  it('flush delivers all pending items for a slot and clears queue', () => {
    composer.queue('morning', { request_id: 'r1', title: 'A', summary: 'a', tier: 'GREEN' })
    composer.queue('morning', { request_id: 'r2', title: 'B', summary: 'b', tier: 'GREEN' })
    composer.queue('lunch', { request_id: 'r3', title: 'C', summary: 'c', tier: 'GREEN' })
    const delivered = composer.flush('morning')
    expect(delivered.items.length).toBe(2)
    expect(composer.pendingFor('morning').length).toBe(0)
    expect(composer.pendingFor('lunch').length).toBe(1)
  })

  it('returns null when flushing empty slot', () => {
    expect(composer.flush('morning')).toBeNull()
  })

  it('flush records delivered_at', () => {
    composer.queue('morning', { request_id: 'r1', title: 'A', summary: 'a', tier: 'GREEN' })
    const delivered = composer.flush('morning')
    expect(delivered?.delivered_at).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Implementation**

```typescript
// src/daemon/restraint/digestComposer.ts
import type { Database } from 'bun:sqlite'
import type { Digest } from './types'
import type { AutonomyTier } from '../agency/types'

export const DIGEST_SCHEMA = `
  CREATE TABLE IF NOT EXISTS restraint_digest_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    slot        TEXT NOT NULL,
    request_id  TEXT NOT NULL,
    title       TEXT NOT NULL,
    summary     TEXT NOT NULL,
    tier        TEXT NOT NULL,
    queued_at   INTEGER NOT NULL,
    delivered_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_digest_pending ON restraint_digest_items(slot, delivered_at);
`

export type DigestItemInput = {
  request_id: string
  title: string
  summary: string
  tier: AutonomyTier
}

export class DigestComposer {
  constructor(private db: Database) {
    db.exec(DIGEST_SCHEMA)
  }

  queue(slot: 'morning' | 'lunch' | 'evening', item: DigestItemInput): void {
    this.db.run(
      `INSERT INTO restraint_digest_items (slot, request_id, title, summary, tier, queued_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [slot, item.request_id, item.title, item.summary, item.tier, Date.now()],
    )
  }

  pendingFor(slot: 'morning' | 'lunch' | 'evening'): Array<DigestItemInput & { queued_at: number }> {
    const rows = this.db.query(
      `SELECT request_id, title, summary, tier, queued_at FROM restraint_digest_items
       WHERE slot = ? AND delivered_at IS NULL`,
    ).all(slot) as Array<DigestItemInput & { queued_at: number }>
    return rows
  }

  flush(slot: 'morning' | 'lunch' | 'evening'): Digest | null {
    const items = this.pendingFor(slot)
    if (items.length === 0) return null

    const now = Date.now()
    this.db.run(
      'UPDATE restraint_digest_items SET delivered_at = ? WHERE slot = ? AND delivered_at IS NULL',
      [now, slot],
    )

    return {
      slot,
      scheduled_for: now,
      items: items.map(i => ({
        request_id: i.request_id,
        title: i.title,
        summary: i.summary,
        tier: i.tier,
        queued_at: i.queued_at,
      })),
      delivered_at: now,
    }
  }
}
```

- [ ] **Step 3: Run tests + commit**

```bash
bun test src/daemon/restraint/digestComposer.test.ts
git add src/daemon/restraint/digestComposer.ts src/daemon/restraint/digestComposer.test.ts
git commit -m "feat(restraint): DigestComposer — Apple-style notification summary with morning/lunch/evening slots"
```

Expected: 4/4 tests pass.

---

## Task 9: Dry-run mode

**Files:**
- Create: `src/daemon/restraint/dryRunMode.ts`
- Test:  `src/daemon/restraint/dryRunMode.test.ts`

When the user adds a new STANDING_ORDER rule, KAIROS runs it in **observation-only** mode for 24 hours. Counts how many times it would have fired. After 24h presents: *"this rule would have fired 12 times in the past day. Want me to start firing it for real?"* Prevents the C.1 "added a rule, got 100 notifications" experience.

- [ ] **Step 1: Write the failing test**

```typescript
// src/daemon/restraint/dryRunMode.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { DryRunMode, DRY_RUN_SCHEMA } from './dryRunMode'

describe('DryRunMode', () => {
  let db: Database
  let dryRun: DryRunMode

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(DRY_RUN_SCHEMA)
    dryRun = new DryRunMode(db, { dry_run_duration_hours: 24 } as any)
  })

  it('registers a new trigger as dry-run for 24 hours', () => {
    dryRun.register('trig-a')
    expect(dryRun.isInDryRun('trig-a')).toBe(true)
  })

  it('records would-have-fired counts during dry run', () => {
    dryRun.register('trig-a')
    dryRun.recordWouldFire('trig-a', 'event1')
    dryRun.recordWouldFire('trig-a', 'event2')
    const rec = dryRun.get('trig-a')
    expect(rec?.would_have_fired_count).toBe(2)
    expect(rec?.sample_events.length).toBe(2)
  })

  it('sample events cap at 5', () => {
    dryRun.register('trig-a')
    for (let i = 0; i < 10; i++) dryRun.recordWouldFire('trig-a', `event${i}`)
    const rec = dryRun.get('trig-a')
    expect(rec?.would_have_fired_count).toBe(10)
    expect(rec?.sample_events.length).toBe(5)   // capped
  })

  it('completed() returns triggers past their dry-run window', () => {
    dryRun.register('trig-a')
    // Manually expire it
    db.run('UPDATE restraint_dry_run SET ends_at = ? WHERE trigger_id = ?', [Date.now() - 1000, 'trig-a'])
    expect(dryRun.completed().map(r => r.trigger_id)).toContain('trig-a')
  })

  it('promote moves a trigger out of dry-run', () => {
    dryRun.register('trig-a')
    dryRun.promote('trig-a')
    expect(dryRun.isInDryRun('trig-a')).toBe(false)
  })
})
```

- [ ] **Step 2: Implementation**

```typescript
// src/daemon/restraint/dryRunMode.ts
// New STANDING_ORDER triggers run in observation-only mode for 24h. Counts
// would-have-fired events. After 24h, prompts user with the count before
// going live. Prevents "added a rule, got 100 notifications" surprises.

import type { Database } from 'bun:sqlite'
import type { DryRunRecord, RestraintConfig } from './types'

export const DRY_RUN_SCHEMA = `
  CREATE TABLE IF NOT EXISTS restraint_dry_run (
    trigger_id              TEXT PRIMARY KEY,
    started_at              INTEGER NOT NULL,
    ends_at                 INTEGER NOT NULL,
    would_have_fired_count  INTEGER NOT NULL DEFAULT 0,
    sample_events_json      TEXT NOT NULL DEFAULT '[]',
    promoted_at             INTEGER,
    rejected_at             INTEGER
  );
`

type CfgSubset = Pick<RestraintConfig, 'dry_run_duration_hours'>

export class DryRunMode {
  constructor(private db: Database, private config: CfgSubset) {
    db.exec(DRY_RUN_SCHEMA)
  }

  register(triggerId: string): void {
    const now = Date.now()
    this.db.run(
      `INSERT OR IGNORE INTO restraint_dry_run (trigger_id, started_at, ends_at)
       VALUES (?, ?, ?)`,
      [triggerId, now, now + this.config.dry_run_duration_hours * 3600_000],
    )
  }

  isInDryRun(triggerId: string): boolean {
    const row = this.db.query(
      'SELECT ends_at, promoted_at FROM restraint_dry_run WHERE trigger_id = ?',
    ).get(triggerId) as { ends_at: number; promoted_at: number | null } | null
    if (!row || row.promoted_at) return false
    return row.ends_at > Date.now()
  }

  recordWouldFire(triggerId: string, eventSummary: string): void {
    const row = this.db.query(
      'SELECT sample_events_json FROM restraint_dry_run WHERE trigger_id = ?',
    ).get(triggerId) as { sample_events_json: string } | null
    if (!row) return
    const samples = JSON.parse(row.sample_events_json) as string[]
    if (samples.length < 5) samples.push(eventSummary)
    this.db.run(
      `UPDATE restraint_dry_run SET would_have_fired_count = would_have_fired_count + 1, sample_events_json = ? WHERE trigger_id = ?`,
      [JSON.stringify(samples), triggerId],
    )
  }

  get(triggerId: string): DryRunRecord | null {
    const row = this.db.query('SELECT * FROM restraint_dry_run WHERE trigger_id = ?').get(triggerId) as
      { trigger_id: string; started_at: number; ends_at: number;
        would_have_fired_count: number; sample_events_json: string } | null
    if (!row) return null
    return {
      trigger_id: row.trigger_id,
      started_at: row.started_at,
      ends_at: row.ends_at,
      would_have_fired_count: row.would_have_fired_count,
      sample_events: JSON.parse(row.sample_events_json),
    }
  }

  /** Triggers whose dry-run window expired but haven't been promoted/rejected yet. */
  completed(): DryRunRecord[] {
    const now = Date.now()
    const rows = this.db.query(
      `SELECT * FROM restraint_dry_run
       WHERE ends_at < ? AND promoted_at IS NULL AND rejected_at IS NULL`,
    ).all(now) as Array<{ trigger_id: string; started_at: number; ends_at: number;
        would_have_fired_count: number; sample_events_json: string }>
    return rows.map(r => ({
      trigger_id: r.trigger_id, started_at: r.started_at, ends_at: r.ends_at,
      would_have_fired_count: r.would_have_fired_count,
      sample_events: JSON.parse(r.sample_events_json),
    }))
  }

  promote(triggerId: string): void {
    this.db.run('UPDATE restraint_dry_run SET promoted_at = ? WHERE trigger_id = ?', [Date.now(), triggerId])
  }

  reject(triggerId: string): void {
    this.db.run('UPDATE restraint_dry_run SET rejected_at = ? WHERE trigger_id = ?', [Date.now(), triggerId])
  }
}
```

- [ ] **Step 3: Run tests + commit**

```bash
bun test src/daemon/restraint/dryRunMode.test.ts
git add src/daemon/restraint/dryRunMode.ts src/daemon/restraint/dryRunMode.test.ts
git commit -m "feat(restraint): DryRunMode — new rules observe for 24h, user confirms before going live"
```

Expected: 5/5 tests pass.

---

## Task 10: Restraint pipeline orchestrator

**Files:**
- Create: `src/daemon/restraint/restraintPipeline.ts`
- Test:  `src/daemon/restraint/restraintPipeline.test.ts`

The orchestrator wires all layers together. Takes an `ActionRequest`, runs it through every layer in order, returns a `DeliveryDecision`. This is what the ActionExecutor calls instead of firing immediately.

- [ ] **Step 1: Write the failing test**

```typescript
// src/daemon/restraint/restraintPipeline.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { randomUUID } from 'crypto'
import { RestraintPipeline } from './restraintPipeline'
import { FocusDetector } from './focusDetector'
import { KarmaStore, KARMA_SCHEMA } from './karma'
import { CooldownTracker } from './cooldownTracker'
import { RateLimiter, RATE_LIMITER_SCHEMA } from './rateLimiter'
import { ActionScorer } from './actionScorer'
import { DeliveryRouter } from './deliveryRouter'
import { DigestComposer, DIGEST_SCHEMA } from './digestComposer'
import { DryRunMode, DRY_RUN_SCHEMA } from './dryRunMode'
import type { ActionRequest } from '../agency/types'
import type { RestraintConfig } from './types'

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

describe('RestraintPipeline', () => {
  let db: Database
  let pipeline: RestraintPipeline

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(KARMA_SCHEMA)
    db.exec(RATE_LIMITER_SCHEMA)
    db.exec(DIGEST_SCHEMA)
    db.exec(DRY_RUN_SCHEMA)

    const focus = new FocusDetector(cfg, {
      now: () => new Date('2026-05-25T10:00:00').getTime(),  // 10am, not quiet
      probeFocusedApp: async () => ({ app: 'VS Code', duration_sec: 300 }),  // not deep focus
      probeMeeting: async () => false,
    })
    const karma = new KarmaStore(db, cfg)
    const cooldown = new CooldownTracker(cfg.default_trigger_cooldown_sec * 1000)
    const rateLimiter = new RateLimiter(db, cfg)
    const scorer = new ActionScorer(cfg)
    const router = new DeliveryRouter(cfg)
    const digest = new DigestComposer(db)
    const dryRun = new DryRunMode(db, cfg)

    pipeline = new RestraintPipeline({ config: cfg, focus, karma, cooldown, rateLimiter, scorer, router, digest, dryRun })
  })

  it('high-urgency request → interrupt', async () => {
    const decision = await pipeline.evaluate(makeReq('notify', 'trig-x'), {
      urgency: 1.0, rule_match_strength: 1.0, personal_relevance: 1.0, novelty: 1.0, urgent: true,
    })
    expect(decision.mode).toBe('interrupt')
  })

  it('low-score request → log_only', async () => {
    const decision = await pipeline.evaluate(makeReq('notify', 'trig-x'), {
      urgency: 0.1, rule_match_strength: 0.5, personal_relevance: 0.1, novelty: 0.5, urgent: false,
    })
    expect(decision.mode).toBe('log_only')
  })

  it('cooldown blocks repeat fires of same trigger', async () => {
    const r = makeReq('notify', 'trig-rep')
    const decision1 = await pipeline.evaluate(r, { urgency: 1.0, rule_match_strength: 1.0, personal_relevance: 1.0, novelty: 1.0, urgent: false })
    pipeline.recordDelivered('trig-rep', decision1.mode)
    const decision2 = await pipeline.evaluate(makeReq('notify', 'trig-rep'), { urgency: 1.0, rule_match_strength: 1.0, personal_relevance: 1.0, novelty: 1.0, urgent: false })
    expect(decision2.mode).toBe('suppressed')
    expect(decision2.reason).toMatch(/cooldown/i)
  })

  it('karma suspension drops to suppressed', async () => {
    const karma = (pipeline as any).deps.karma as KarmaStore
    karma.recordDismissal('trig-bad')
    karma.recordDismissal('trig-bad')
    karma.recordDismissal('trig-bad')
    const decision = await pipeline.evaluate(makeReq('notify', 'trig-bad'), { urgency: 1.0, rule_match_strength: 1.0, personal_relevance: 1.0, novelty: 1.0, urgent: false })
    expect(decision.mode).toBe('suppressed')
    expect(decision.reason).toMatch(/suspended/i)
  })

  it('deep focus suppresses non-urgent', async () => {
    const deepFocus = new FocusDetector(cfg, {
      now: () => new Date('2026-05-25T10:00:00').getTime(),
      probeFocusedApp: async () => ({ app: 'VS Code', duration_sec: 1800 }),  // 30 min
      probeMeeting: async () => false,
    })
    const p = new RestraintPipeline({
      ...((pipeline as any).deps),
      focus: deepFocus,
    })
    const decision = await p.evaluate(makeReq('notify', 'trig-focus'), { urgency: 0.5, rule_match_strength: 1.0, personal_relevance: 0.5, novelty: 0.5, urgent: false })
    expect(decision.mode).toBe('suppressed')
    expect(decision.reason).toMatch(/(focus|busy)/i)
  })

  it('dry-run trigger → dry_run mode, increments counter', async () => {
    const dryRun = (pipeline as any).deps.dryRun as DryRunMode
    dryRun.register('trig-new')
    const decision = await pipeline.evaluate(makeReq('notify', 'trig-new'), { urgency: 1.0, rule_match_strength: 1.0, personal_relevance: 1.0, novelty: 1.0, urgent: false })
    expect(decision.mode).toBe('dry_run')
    const rec = dryRun.get('trig-new')
    expect(rec?.would_have_fired_count).toBe(1)
  })

  it('rate limit blocks excess interrupts', async () => {
    // Burn through the daily cap
    for (let i = 0; i < cfg.max_interrupts_per_day; i++) {
      const d = await pipeline.evaluate(makeReq('notify', `trig-${i}`), { urgency: 1.0, rule_match_strength: 1.0, personal_relevance: 1.0, novelty: 1.0, urgent: false })
      pipeline.recordDelivered(`trig-${i}`, d.mode)
    }
    const overflow = await pipeline.evaluate(makeReq('notify', 'trig-overflow'), { urgency: 1.0, rule_match_strength: 1.0, personal_relevance: 1.0, novelty: 1.0, urgent: false })
    expect(overflow.mode).toBe('suppressed')
    expect(overflow.reason).toMatch(/rate/i)
  })
})
```

- [ ] **Step 2: Implementation**

```typescript
// src/daemon/restraint/restraintPipeline.ts
// The orchestrator. Wires all restraint layers in order.
//
// Order matters:
//   1. Dry-run check (intercept before any side effects)
//   2. Karma suspension check (drop suspended triggers entirely)
//   3. Cooldown check (per-trigger debounce)
//   4. Focus / quiet hours / pause check (suppress if user busy)
//   5. Score computation (combine all components)
//   6. Delivery route (interrupt/surface/digest/log)
//   7. Rate limit check on final mode
//   8. Karma record fire
//
// Each step can short-circuit to 'suppressed' or 'dry_run' or 'log_only'.

import type { ActionRequest } from '../agency/types'
import type { DeliveryDecision, RestraintConfig, ScoreComponents } from './types'
import type { FocusDetector } from './focusDetector'
import type { KarmaStore } from './karma'
import type { CooldownTracker } from './cooldownTracker'
import type { RateLimiter } from './rateLimiter'
import type { ActionScorer } from './actionScorer'
import type { DeliveryRouter } from './deliveryRouter'
import type { DigestComposer } from './digestComposer'
import type { DryRunMode } from './dryRunMode'

export type RestraintDeps = {
  config: RestraintConfig
  focus: FocusDetector
  karma: KarmaStore
  cooldown: CooldownTracker
  rateLimiter: RateLimiter
  scorer: ActionScorer
  router: DeliveryRouter
  digest: DigestComposer
  dryRun: DryRunMode
}

/** Inputs the pipeline needs that the caller (ActionExecutor) computes per request. */
export type EvaluateInputs = {
  urgency: number              // 0-1, caller (intent metadata or LLM) supplies
  rule_match_strength: number  // 0-1
  personal_relevance: number   // 0-1
  novelty: number              // 0-1
  urgent: boolean              // explicit urgent flag (calendar conflict, password, etc.)
}

export class RestraintPipeline {
  constructor(private deps: RestraintDeps) {}

  async evaluate(request: ActionRequest, inputs: EvaluateInputs): Promise<DeliveryDecision> {
    const triggerId = request.source_trigger_id ?? request.intent_id

    // 1. Dry-run check
    if (this.deps.dryRun.isInDryRun(triggerId)) {
      this.deps.dryRun.recordWouldFire(triggerId, request.reasoning.slice(0, 80))
      return { mode: 'dry_run', score: null, reason: `trigger in 24h observation window` }
    }

    // 2. Karma suspension
    if (this.deps.karma.isSuspended(triggerId)) {
      return { mode: 'suppressed', score: null, reason: `trigger ${triggerId} suspended (too many dismissals)` }
    }

    // 3. Cooldown
    if (!this.deps.cooldown.canFire(triggerId)) {
      return { mode: 'suppressed', score: null, reason: `cooldown active for ${triggerId}` }
    }

    // 4. Focus / quiet / pause
    if (await this.deps.focus.shouldSuppress({ urgent: inputs.urgent })) {
      const fs = await this.deps.focus.state()
      const why = fs.pause_until ? 'manual pause' : fs.in_deep_focus ? 'deep focus' : fs.in_meeting ? 'meeting' : 'quiet hours'
      return { mode: 'suppressed', score: null, reason: `user busy: ${why}` }
    }

    // 5. Score
    const components: ScoreComponents = {
      rule_match_strength: inputs.rule_match_strength,
      urgency: inputs.urgency,
      personal_relevance: inputs.personal_relevance,
      context_availability: (await this.deps.focus.state()).in_deep_focus ? 0.2 : 1.0,
      novelty: inputs.novelty,
      dismissal_penalty: this.deps.karma.dismissalPenalty(triggerId),
    }
    const score = this.deps.scorer.compute(components)

    // 6. Route
    const decision = this.deps.router.route(score)

    // 7. Rate limit
    if (!this.deps.rateLimiter.canDeliver(decision.mode, inputs.urgent)) {
      return { mode: 'suppressed', score, reason: `rate limit (${decision.mode}) hit` }
    }

    // 8. Queue digest if needed
    if (decision.mode === 'digest' && decision.queue_for_digest) {
      this.deps.digest.queue(decision.queue_for_digest, {
        request_id: request.request_id,
        title: request.reasoning.slice(0, 80),
        summary: request.reasoning,
        tier: 'GREEN',
      })
    }

    // Record karma fire
    this.deps.karma.recordFire(triggerId)

    return decision
  }

  recordDelivered(triggerId: string, mode: DeliveryDecision['mode']): void {
    if (mode === 'interrupt' || mode === 'surface') {
      this.deps.cooldown.recordFire(triggerId)
      this.deps.rateLimiter.recordDelivery(mode)
      this.deps.karma.recordDelivery(triggerId)
    }
  }
}
```

- [ ] **Step 3: Run tests + commit**

```bash
bun test src/daemon/restraint/restraintPipeline.test.ts
git add src/daemon/restraint/restraintPipeline.ts src/daemon/restraint/restraintPipeline.test.ts
git commit -m "feat(restraint): RestraintPipeline orchestrator — 8-layer evaluation in strict order"
```

Expected: 7/7 tests pass.

---

## Task 11: Wire restraint into ActionExecutor

**Files:**
- Modify: `src/daemon/agency/actionExecutor.ts`
- Test:  `src/daemon/agency/actionExecutor.test.ts` (add regression test)

ActionExecutor's `dispatch()` currently fires actions directly. Wire it to consult the RestraintPipeline first. If pipeline returns `suppressed` / `log_only` / `dry_run` / `digest`, don't actually execute the intent — just trajectory-log.

- [ ] **Step 1: Add restraint param to ActionExecutor constructor + modify dispatch path**

(Detailed edit; subagent reads existing file + applies. See plan README for full diff pattern from C.1 wire-up tasks.)

- [ ] **Step 2: Add regression test**

```typescript
// In actionExecutor.test.ts — add new test
it('REGRESSION: restraint pipeline can suppress dispatch entirely', async () => {
  // Build executor with a restraint pipeline that ALWAYS returns suppressed
  const fakePipeline = {
    evaluate: async () => ({ mode: 'suppressed' as const, score: null, reason: 'test suppression' }),
    recordDelivered: () => {},
  }
  const exec = new ActionExecutor(db, registry, traj, inbox, ctx, fakePipeline as any)
  const result = await exec.dispatch(req('test-green', { msg: 'hi' }))
  expect(result.status).toBe('suppressed' as any)
  // Notifier should NOT have been called
  expect(notifyCalls.length).toBe(0)
})
```

- [ ] **Step 3: Commit**

```bash
git add src/daemon/agency/actionExecutor.ts src/daemon/agency/actionExecutor.test.ts
git commit -m "feat(agency): wire RestraintPipeline into ActionExecutor.dispatch (Earned Interrupt)"
```

---

## Task 12: Daemon wire-up

**Files:**
- Modify: `src/daemon/types.ts` (add `restraint` config block)
- Modify: `src/daemon/config.ts` (defaults)
- Modify: `src/daemon/index.ts` (instantiate restraint subsystem, pass to ActionExecutor)

Standard wire-up pattern (mirror C.1 + C.2 wire-up tasks). Construct all 8 restraint modules, compose into RestraintPipeline, pass to ActionExecutor.

- [ ] Verify full test suite passes after wire-up.

```bash
bun test 2>&1 | tail -5
```

Expected: 198 + ~50 = ~250 total tests pass.

- [ ] Commit:

```bash
git add src/daemon/index.ts src/daemon/types.ts src/daemon/config.ts
git commit -m "feat(daemon): wire restraint subsystem (8 layers) into ActionExecutor"
```

---

## Task 13: Validation gate

**Files:**
- Create: `scripts/validate-phase-c1-5.ts`

Per Section 8.5. **The critical validation**: replay the same event load that caused the 4,454-notification incident. Demonstrate restraint reduces it to <10 user-visible items.

- [ ] **Step 1: Write the script**

```typescript
// scripts/validate-phase-c1-5.ts
// Phase C.1.5 validation — REPLAY the 4,454-notification scenario.
// Same events, same triggers — but now through the restraint pipeline.
// PASS criteria: ≤8 interrupts, ≤20 surfaces, 0 unexpected throws.

import { Database } from 'bun:sqlite'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
// ... (full wiring of all restraint modules + replay loop)

// Simulate 10,000 file-events + 500 focus-app switches + 200 clipboard changes
// (roughly the load that produced 4,454 notifications)
// Drive each through the RestraintPipeline with realistic score inputs
// Count: interrupts, surfaces, digests, log_only, suppressed
// Assert: interrupts ≤ 8, surfaces ≤ 20 over a simulated 24h window
```

- [ ] **Step 2: Run + report observed counts**

Sample expected output:
```
─── C.1.5 Validation: replay of 4,454-notification scenario ───
Events processed: 10,700
Decisions made: 10,700
  interrupt    : 4        (≤ 8 ✓)
  surface      : 13       (≤ 20 ✓)
  digest       : 47       (queued into 3 morning/lunch/evening summaries)
  log_only     : 412
  suppressed   : 10,224   (cooldown + karma + focus combined)
PASS — restraint pipeline reduced 4,454 → 4 interrupts (99.9% drop)
```

- [ ] **Step 3: Commit + tag**

```bash
git add scripts/validate-phase-c1-5.ts
git commit -m "test(phase-c1.5): validation gate — replays the 4,454-notification scenario"
git tag v0.3.2-phase-c1-5
git push origin main --tags
```

---

## Self-review

**The Earned Interrupt principle** — three commitments now structurally enforced:
1. ✅ Silence is the default — `suppressed` is the most common outcome, not the exception
2. ✅ One notification = one user-visible suggestion — coalescer + digest composer ensure batching
3. ✅ Agent measures its own annoyance — karma store + dismissal learner adapt over time

**Spec coverage:**
- ✅ Significance gate extension (via FocusDetector + scorer) — Tasks 1, 6
- ✅ Action scorer — Task 6
- ✅ Delivery routing — Task 7
- ✅ Coalescing — Task 3
- ✅ Cooldown — Task 4
- ✅ Rate limit — Task 5
- ✅ Karma + auto-suspend — Task 2
- ✅ Dry-run mode — Task 9
- ✅ Digest composer — Task 8
- ✅ Pipeline orchestrator — Task 10
- ✅ Wire-up + validation — Tasks 11, 12, 13

**Deferred to Phase F** (visual surfaces of the restraint architecture):
- Trust dial per service (HUD widget for the karma data)
- Whisper-mode-on-glance (idle detection + on-cursor-hover delivery — needs HUD)
- Morning brief + evening reflection voice delivery (needs Phase E voice pipeline)

**Risks flagged:**
- The karma store's auto-suspend default (3 dismissals in 7 days) may be too aggressive for some users. Config-tunable, but the default is the discovery point — collect feedback after C.1.5 ships.
- The scorer weights are guesses. Real tuning happens after a week of real usage data — telemetry from `restraint_delivery_log` shows distribution.
- Dry-run mode could trap a trigger forever if the user never reviews. Mitigation: cron-style check at daemon start surfaces all `completed()` dry-run records to the inbox for review.

---

## Execution Handoff

Plan saved to `docs/superpowers/plans/2026-05-25-phase-c1-5-earned-interrupt.md`.

Subagent-Driven execution recommended — same pattern as C.1 + C.2 (which together shipped 21 atomic tasks with 0 regressions).

After C.1.5 ships (`v0.3.2-phase-c1-5`), resume original sequencing:
- C.3 (Magentic-One orchestrator + smolagents CodeAgent + AWM crystallizer)
- C.4 (STANDING_ORDERS v2 + persona-conditioned routing + offline fallback + dry-run UI integration + Phase C overall validation gate)
- D, E, F as originally planned, just with the restraint architecture now structural rather than a future patch.

**The most important thing this plan does**: bakes restraint into the platform so every subsequent capability (MCP tools, multi-step plans, voice replies, etc.) inherits it for free. Without this, every future feature is one bug away from the 4,454-notification experience.
