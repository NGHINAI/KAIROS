// src/daemon/restraint/personaShift.ts
// Pure helper: maps PersonaAwareness hints to a threshold delta.
// Positive = harder for the action to interrupt the user. Clamped to ±0.20.

import type { PersonaHints } from '../persona/types'

export function personaThresholdShift(hints: PersonaHints | null): number {
  if (!hints) return 0
  let shift = 0
  if (hints.interrupt_aggressiveness === 'low')  shift += 0.10
  if (hints.interrupt_aggressiveness === 'high') shift -= 0.05
  if (hints.in_focus_now)                        shift += 0.05
  if (!hints.active_hours_now)                   shift += 0.10
  return Math.max(-0.20, Math.min(0.20, shift))
}
