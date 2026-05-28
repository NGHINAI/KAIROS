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
    const urgencyFloor = new (require('./urgencyFloor').UrgencyFloor)()

    pipeline = new RestraintPipeline({ config: cfg, urgencyFloor, focus, karma, cooldown, rateLimiter, scorer, router, digest, dryRun })
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

  // SAFEGUARD 1 REGRESSION: urgency floor must bypass ALL gates, even
  // suspension + cooldown + rate-limit + deep focus. The fire-alarm path.
  it('SAFEGUARD: urgency-floor request bypasses karma suspension', async () => {
    const karma = (pipeline as any).deps.karma as KarmaStore
    karma.recordDismissal('trig-fire'); karma.recordDismissal('trig-fire'); karma.recordDismissal('trig-fire')
    expect(karma.isSuspended('trig-fire')).toBe(true)
    // Send a system_critical request — UrgencyFloor recognizes this
    const decision = await pipeline.evaluate(
      { request_id: 'r', intent_id: 'system_critical', args: { kind: 'low_disk' }, source_trigger_id: 'trig-fire', reasoning: 'disk full', requested_at: Date.now() },
      { urgency: 1.0, rule_match_strength: 1.0, personal_relevance: 1.0, novelty: 1.0, urgent: false },
    )
    expect(decision.mode).toBe('interrupt')
    expect(decision.reason).toMatch(/urgency floor/i)
  })

  it('SAFEGUARD: urgency-floor request bypasses cooldown', async () => {
    const r1 = makeReq('notify', 'trig-x')
    const d1 = await pipeline.evaluate(r1, { urgency: 1.0, rule_match_strength: 1.0, personal_relevance: 1.0, novelty: 1.0, urgent: false })
    pipeline.recordDelivered('trig-x', d1.mode)
    // Immediate retry: ordinary request would be cooldown-suppressed
    const ordinary = await pipeline.evaluate(makeReq('notify', 'trig-x'), { urgency: 1.0, rule_match_strength: 1.0, personal_relevance: 1.0, novelty: 1.0, urgent: false })
    expect(ordinary.mode).toBe('suppressed')
    // But urgency-floor (URGENT in reasoning) breaks through
    const urgent = await pipeline.evaluate(
      { ...makeReq('notify', 'trig-x'), reasoning: 'URGENT: server down' },
      { urgency: 1.0, rule_match_strength: 1.0, personal_relevance: 1.0, novelty: 1.0, urgent: false },
    )
    expect(urgent.mode).toBe('interrupt')
  })

  it('SAFEGUARD: urgency-floor request bypasses deep focus', async () => {
    const deepFocus = new FocusDetector(cfg, {
      now: () => new Date('2026-05-25T10:00:00').getTime(),
      probeFocusedApp: async () => ({ app: 'VS Code', duration_sec: 1800 }),
      probeMeeting: async () => false,
    })
    const p = new RestraintPipeline({ ...((pipeline as any).deps), focus: deepFocus })
    const decision = await p.evaluate(
      { request_id: 'r', intent_id: 'task_error', args: { kind: 'task_error', task_id: 't1', error: 'oops' }, reasoning: 'task failed', requested_at: Date.now() },
      { urgency: 1.0, rule_match_strength: 1.0, personal_relevance: 1.0, novelty: 1.0, urgent: false },
    )
    expect(decision.mode).toBe('interrupt')
  })
})

// ---------------------------------------------------------------------------
// C.3.1 — PersonaAwareness integration tests
// ---------------------------------------------------------------------------

describe('RestraintPipeline — PersonaAwareness integration (C.3.1)', () => {
  let db: Database

  function makePersonaAwareness(overrides: Record<string, unknown> = {}): any {
    return {
      getHints: () => ({
        interrupt_aggressiveness: 'medium',
        in_focus_now: false,
        active_hours_now: true,
        prefer_terse: false,
        prefer_voice_over_text: false,
        ...overrides,
      }),
    }
  }

  function makePipeline(personaAwareness?: any): RestraintPipeline {
    db = new Database(':memory:')
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
    const urgencyFloor = new (require('./urgencyFloor').UrgencyFloor)()

    return new RestraintPipeline({
      config: cfg, urgencyFloor, focus, karma, cooldown, rateLimiter, scorer, router, digest, dryRun,
      ...(personaAwareness !== undefined ? { personaAwareness } : {}),
    })
  }

  // Score calculation reference (cfg weights: rule=0.20, urgency=0.30, relevance=0.20, ctx=0.15, novelty=0.10):
  //   borderline inputs (urgency=0.5, rule=0.5, relevance=0.5, novelty=0.5, ctx=1.0):
  //     score = 0.10 + 0.15 + 0.10 + 0.15 + 0.05 = 0.55  (above digest 0.40, below raised floor 0.60)
  //   below-threshold inputs (urgency=0.3, rule=0.3, relevance=0.3, novelty=0.3, ctx=1.0):
  //     score = 0.06 + 0.09 + 0.06 + 0.15 + 0.03 = 0.39  (below digest 0.40, above low-aggressiveness floor 0.30)

  it('suppresses non-urgent fire when persona.in_focus_now === true', async () => {
    const pipe = makePipeline(makePersonaAwareness({ in_focus_now: true }))
    const result = await pipe.evaluate(makeReq('notify', 'trig-focus-persona'), {
      urgency: 0.5, rule_match_strength: 0.5, personal_relevance: 0.5, novelty: 0.5, urgent: false,
    })
    expect(result.mode).toBe('suppressed')
    expect(result.reason ?? '').toMatch(/focus/i)
  })

  it('does NOT suppress URGENT fire even when in_focus_now', async () => {
    const pipe = makePipeline(makePersonaAwareness({ in_focus_now: true }))
    // urgency floor: URGENT keyword in reasoning bypasses all gates
    const result = await pipe.evaluate(
      { ...makeReq('notify', 'trig-urgent-focus'), reasoning: 'URGENT: server down' },
      { urgency: 1.0, rule_match_strength: 1.0, personal_relevance: 1.0, novelty: 1.0, urgent: false },
    )
    expect(result.mode).not.toBe('suppressed')
  })

  it('low interrupt_aggressiveness raises the effective threshold — borderline event suppressed', async () => {
    const pipe = makePipeline(makePersonaAwareness({ interrupt_aggressiveness: 'low' }))
    // score ≈ 0.55 — above default digest floor (0.40) but below raised floor (0.60)
    const result = await pipe.evaluate(makeReq('notify', 'trig-low-agg'), {
      urgency: 0.5, rule_match_strength: 0.5, personal_relevance: 0.5, novelty: 0.5, urgent: false,
    })
    expect(result.mode).toBe('suppressed')
    expect(result.reason ?? '').toMatch(/low interrupt_aggressiveness/i)
  })

  it('high interrupt_aggressiveness lowers the threshold — sub-threshold event routed as digest', async () => {
    const pipe = makePipeline(makePersonaAwareness({ interrupt_aggressiveness: 'high' }))
    // score ≈ 0.39 — below default digest floor (0.40) but above lowered floor (0.30) → digest
    const result = await pipe.evaluate(makeReq('notify', 'trig-high-agg'), {
      urgency: 0.3, rule_match_strength: 0.3, personal_relevance: 0.3, novelty: 0.3, urgent: false,
    })
    expect(result.mode).not.toBe('suppressed')
    expect(result.mode).not.toBe('log_only')
  })

  it('no PersonaAwareness dep = existing behavior preserved (no regressions)', async () => {
    const pipe = makePipeline(/* no personaAwareness */)
    // score ≈ 0.55 — default config → digest (above 0.40, below surface 0.70)
    const result = await pipe.evaluate(makeReq('notify', 'trig-no-persona'), {
      urgency: 0.5, rule_match_strength: 0.5, personal_relevance: 0.5, novelty: 0.5, urgent: false,
    })
    expect(result).toBeDefined()
    // With no persona dep, borderline score 0.55 falls in digest bucket (default thresholds)
    expect(result.mode).toBe('digest')
  })
})
