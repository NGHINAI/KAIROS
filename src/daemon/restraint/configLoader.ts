// src/daemon/restraint/configLoader.ts
// Loads RestraintConfig from a JSON file, falling back to built-in defaults
// if the file is absent or malformed. Defaults match the seed values from Task 0.

import { existsSync, readFileSync } from 'fs'
import type { RestraintConfig } from './types'

const DEFAULTS: RestraintConfig = {
  interrupt_threshold: 0.9,
  surface_threshold: 0.7,
  digest_threshold: 0.4,
  weight_rule_match: 0.20,
  weight_urgency: 0.30,
  weight_personal_relevance: 0.20,
  weight_context_availability: 0.15,
  weight_novelty: 0.10,
  weight_dismissal_penalty: 0.05,
  max_interrupts_per_day: 8,
  max_interrupts_per_hour: 2,
  max_surfaces_per_hour: 6,
  default_trigger_cooldown_sec: 300,
  same_intent_dedup_window_sec: 60,
  quiet_hours_start: '22:00',
  quiet_hours_end: '07:00',
  deep_focus_threshold_sec: 1500,
  digest_morning_time: '08:30',
  digest_lunch_time: '12:30',
  digest_evening_time: '17:30',
  auto_suspend_after_dismissals: 3,
  dismissal_window_days: 7,
  dry_run_duration_hours: 24,
}

export function loadRestraintConfig(path: string): RestraintConfig {
  if (!existsSync(path)) return DEFAULTS
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(path, 'utf8')) }
  } catch {
    return DEFAULTS
  }
}
