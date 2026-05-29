// src/daemon/restraint/restraintPipeline.ts
// The orchestrator. Wires all restraint layers in order.
//
// Order matters:
//   0. URGENCY FLOOR check — if urgent → bypass ALL gates → interrupt
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
// Step 0 is the SAFEGUARD: explicit urgency always wins. Never silence
// something genuinely important.

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

import type { UrgencyFloor } from './urgencyFloor'
import type { PersonaAwareness } from '../persona/personaAwareness'
import { personaThresholdShift } from './personaShift'

export type RestraintDeps = {
  config: RestraintConfig
  urgencyFloor: UrgencyFloor    // NEW — the fire-alarm path
  focus: FocusDetector
  karma: KarmaStore
  cooldown: CooldownTracker
  rateLimiter: RateLimiter
  scorer: ActionScorer
  router: DeliveryRouter
  digest: DigestComposer
  dryRun: DryRunMode
  personaAwareness?: PersonaAwareness  // OPTIONAL — C.3.1 persona-driven threshold tuning
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

  /** Wire in PersonaAwareness after construction (C.3.1 persona subsystem). */
  setPersonaAwareness(awareness: PersonaAwareness): void {
    this.deps.personaAwareness = awareness
  }

  async evaluate(request: ActionRequest, inputs: EvaluateInputs): Promise<DeliveryDecision> {
    const triggerId = request.source_trigger_id ?? request.intent_id

    // 0. URGENCY FLOOR — explicit fire-alarm path. If this classifier
    // returns true, bypass karma/cooldown/focus/rate-limit entirely and
    // route straight to interrupt. This is Safeguard 1 — never silence
    // something genuinely important even when restraint says otherwise.
    if (this.deps.urgencyFloor.classify(request)) {
      this.deps.karma.recordFire(triggerId)
      return {
        mode: 'interrupt',
        score: null,
        reason: 'urgency floor matched — bypassing restraint gates',
      }
    }

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

    // 4b. Persona hints — query AFTER focus/urgency gates so urgency floor always wins (step 0)
    const hints = this.deps.personaAwareness?.getHints()
    if (hints?.in_focus_now) {
      // User is in deep focus / meeting per persona model → suppress non-urgent fires
      return { mode: 'suppressed', score: null, reason: 'persona: user in deep focus' }
    }

    // 5. Score
    const focusState = await this.deps.focus.state()
    const components: ScoreComponents = {
      rule_match_strength: inputs.rule_match_strength,
      urgency: inputs.urgency,
      personal_relevance: inputs.personal_relevance,
      context_availability: focusState.in_deep_focus ? 0.2 : 1.0,
      novelty: inputs.novelty,
      dismissal_penalty: this.deps.karma.dismissalPenalty(triggerId),
    }
    const score = this.deps.scorer.compute(components)

    // 5b. Persona threshold adjustment — raise or lower the effective digest floor
    if (hints?.interrupt_aggressiveness === 'low') {
      // User wants fewer interruptions: suppress anything that scores below threshold + 0.2
      const raisedFloor = this.deps.config.digest_threshold + 0.2
      if (score.total < raisedFloor) {
        return { mode: 'suppressed', score, reason: `persona: low interrupt_aggressiveness raised threshold to ${raisedFloor.toFixed(2)}` }
      }
    } else if (hints?.interrupt_aggressiveness === 'high') {
      // User is fine being interrupted: lower threshold by 0.1 — if score is above the reduced
      // digest floor, let it through to normal routing (router already handles the actual bucketing)
      const loweredFloor = Math.max(0, this.deps.config.digest_threshold - 0.1)
      if (score.total < this.deps.config.digest_threshold && score.total >= loweredFloor) {
        // Would have been log_only under default config but now qualifies for digest
        const decision = this.deps.router.route(score)
        // Override to at least digest
        return { ...decision, mode: decision.mode === 'log_only' ? 'digest' : decision.mode, reason: `persona: high interrupt_aggressiveness lowered threshold` }
      }
    }

    // 6. Route — apply persona threshold shift (C.4.2)
    const shift = personaThresholdShift(hints ?? null)
    const interruptT = this.deps.config.interrupt_threshold + shift
    const surfaceT   = this.deps.config.surface_threshold   + (shift * 0.5)
    const digestT    = this.deps.config.digest_threshold    + (shift * 0.25)

    let decision: DeliveryDecision
    if (score.total >= interruptT) {
      decision = { mode: 'interrupt', score, reason: `score ${score.total.toFixed(2)} >= ${interruptT.toFixed(2)} (persona-shifted)`, persona_snapshot: hints ?? null }
    } else if (score.total >= surfaceT) {
      decision = { mode: 'surface', score, reason: `score ${score.total.toFixed(2)} >= ${surfaceT.toFixed(2)} (persona-shifted)`, persona_snapshot: hints ?? null }
    } else if (score.total >= digestT) {
      decision = {
        mode: 'digest', score,
        reason: `score ${score.total.toFixed(2)} >= ${digestT.toFixed(2)}, queuing (persona-shifted)`,
        queue_for_digest: this.deps.router.route(score).queue_for_digest,
        persona_snapshot: hints ?? null,
      }
    } else {
      decision = { mode: 'log_only', score, reason: `score ${score.total.toFixed(2)} below digest threshold (persona-shifted)`, persona_snapshot: hints ?? null }
    }

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
