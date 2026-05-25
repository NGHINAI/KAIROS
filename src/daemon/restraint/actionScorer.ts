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
