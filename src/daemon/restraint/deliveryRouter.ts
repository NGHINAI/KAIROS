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
    if (hour <= 11) return 'lunch'                   // 8-11am → lunch digest
    if (hour < 16) return 'evening'                  // 11am-4pm → evening digest
    return 'morning'                                 // 4-6pm → next morning
  }
}
