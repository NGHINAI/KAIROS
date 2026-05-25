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
