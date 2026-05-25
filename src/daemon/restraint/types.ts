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
