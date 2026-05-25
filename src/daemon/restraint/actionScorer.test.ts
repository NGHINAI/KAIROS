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
