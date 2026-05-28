// src/daemon/persona/personaAwareness.ts
// Derives PersonaHints from persona.md + live focus state.
// Consumed by RestraintPipeline (Task 8), ModelRouter (optional), and agency response composition.
//
// Cached for ~10s to avoid disk I/O thrash on hot paths.

import type { PersonaFile, PersonaHints } from './types'
import type { PersonaUpdater } from './personaUpdater'

const CACHE_TTL_MS = 10_000

/** Caller provides live state — keeps this module decoupled from observer implementation. */
export type LiveState = {
  current_focus_app?: string                 // e.g. 'com.apple.Notes', 'Slack', null
  is_in_meeting?: boolean                    // optional — overridden true forces in_focus_now
  current_hour_local?: number                // 0-23 — caller computes from new Date()
  current_day_of_week?: number               // 0=Sun, 6=Sat
}

export type PersonaAwarenessDeps = {
  personaUpdater: PersonaUpdater
  getLiveState: () => LiveState              // injection — daemon wires to FocusAppObserver + clock
  /** Optional override for testing — default uses Date.now() */
  now?: () => number
}

export class PersonaAwareness {
  private cached: { hints: PersonaHints; at: number } | null = null

  constructor(private deps: PersonaAwarenessDeps) {}

  /** Returns derived hints. Cached for CACHE_TTL_MS. */
  getHints(): PersonaHints {
    const now = (this.deps.now ?? (() => Date.now()))()
    if (this.cached && now - this.cached.at < CACHE_TTL_MS) return this.cached.hints

    const persona = this.deps.personaUpdater.get()
    const live = this.deps.getLiveState()
    const hints = this.derive(persona, live)
    this.cached = { hints, at: now }
    return hints
  }

  /** Force recomputation on next call (e.g., after a nudge). */
  invalidate(): void {
    this.cached = null
  }

  private derive(persona: PersonaFile, live: LiveState): PersonaHints {
    return {
      interrupt_aggressiveness: this.deriveInterruptAggressiveness(persona),
      in_focus_now: this.deriveInFocusNow(persona, live),
      active_hours_now: this.deriveActiveHoursNow(persona, live),
      prefer_terse: this.derivePreferTerse(persona),
      prefer_voice_over_text: this.derivePreferVoiceOverText(persona),
      prefer_quality_over_cost: this.derivePreferQuality(persona),
    }
  }

  private deriveInterruptAggressiveness(persona: PersonaFile): 'low' | 'medium' | 'high' {
    const text = [persona.communication_style, persona.preferences, persona.notes]
      .filter(Boolean).join(' ').toLowerCase()
    // Heuristic — search for opt-in/opt-out signals
    if (/silent.*unless.*urgent|don'?t (interrupt|bother)|quiet|leave me alone/.test(text)) return 'low'
    if (/notify (me )?for everything|tell me everything|aggressive|all updates/.test(text)) return 'high'
    return 'medium'   // default
  }

  private deriveInFocusNow(persona: PersonaFile, live: LiveState): boolean {
    if (live.is_in_meeting === true) return true
    // Focus-app heuristics: code editors, design tools, video apps
    const focusApps = /code|editor|figma|sketch|webstorm|zoom|meet|teams|premiere/i
    if (live.current_focus_app && focusApps.test(live.current_focus_app)) return true
    return false
  }

  private deriveActiveHoursNow(persona: PersonaFile, live: LiveState): boolean {
    const hour = live.current_hour_local
    if (typeof hour !== 'number') return true   // unknown — assume active to avoid suppressing
    // Parse working_patterns if present
    const wp = persona.working_patterns ?? ''
    const m = wp.match(/(\d{1,2}):?(\d{2})?[\s–-]+(\d{1,2}):?(\d{2})?/)
    if (m) {
      const start = parseInt(m[1] ?? '9', 10)
      const end = parseInt(m[3] ?? '18', 10)
      return hour >= start && hour <= end
    }
    // Fallback: 9-18
    return hour >= 9 && hour <= 18
  }

  private derivePreferTerse(persona: PersonaFile): boolean {
    const text = [persona.communication_style, persona.preferences, persona.notes]
      .filter(Boolean).join(' ').toLowerCase()
    return /terse|brief|short|concise|no preamble|skip.*explanation/.test(text)
  }

  private derivePreferVoiceOverText(persona: PersonaFile): boolean {
    const text = [persona.communication_style, persona.preferences, persona.notes]
      .filter(Boolean).join(' ').toLowerCase()
    return /voice over text|prefer voice|speak.*to me/.test(text)
  }

  private derivePreferQuality(persona: PersonaFile): boolean | undefined {
    const text = [persona.preferences, persona.notes].filter(Boolean).join(' ').toLowerCase()
    if (/use.*best.*model|smartest model|don'?t (skimp|cheap)|quality over cost/.test(text)) return true
    if (/cheapest|save money|cost over quality/.test(text)) return false
    return undefined
  }
}
