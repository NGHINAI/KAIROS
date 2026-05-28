// src/daemon/persona/types.ts
// Type surface for the KAIROS .md file family (soul.md, persona.md, traj.md, DREAMS.md).

// ── soul.md (agent identity — written once via wizard) ────────────────────────

/** OpenClaw-derived: Core Truths + Boundaries + Vibe. */
export type SoulFile = {
  version: number              // schema version; bumped on breaking changes
  composed_at: number          // ms epoch when wizard produced this
  core_truths: string[]        // anti-sycophancy: things KAIROS will/won't compromise on
  boundaries: string[]         // hard rules ("never delete without confirmation")
  vibe: string                 // 2-sentence character sketch (NOT a job description)
  // Frontmatter-free body text (rendered as-is in system prompt). Used for additional persona text.
  free_body: string
}

// ── persona.md (USER model — live, Dreaming-updated, ≤500 tokens) ────────────

/** Hermes-derived: the user-knowledge file. Lives in prefix cache; size-disciplined. */
export type PersonaFile = {
  version: number
  last_updated_at: number      // ms epoch — set by Dreaming or nudge
  // Observation-driven sections — empty until Dreaming has enough data
  working_patterns?: string    // e.g. "Typically active 09:30–18:00 Mon-Fri Eastern; deep-focus 14:00–16:30."
  communication_style?: string // e.g. "Prefers terse confirmations. Doesn't want play-by-play."
  preferences?: string         // e.g. "Likes weekly summaries on Sundays. Hates morning interruptions before coffee."
  recent_themes?: string       // e.g. "Working on Phase C.3 plan. Frustrated with LangGraph complexity."
  // Free-form additions (small): nudges captured in-session
  notes?: string
}

// ── traj.md entries (one file per day, append-only) ──────────────────────────

/** UFO2 ExperienceFlow-derived. Written after every agency action. Read by Dreaming (now) + AWM (later in C.3.3). */
export type TrajEntry = {
  ts: number                   // ms epoch
  task_goal: string            // what the agent was trying to do
  intent_id: string            // which agency intent fired (e.g., 'connect_service')
  args_summary: string         // sanitized args (NO secrets — apply same SECRET_PATTERNS as C.1.5 UrgencyFloor)
  steps: TrajStep[]
  outcome: 'success' | 'failed' | 'cancelled' | 'partial'
  user_override_reason?: string // present if user reversed the action
  duration_ms: number
  llm_cost_cents?: number      // optional cost tracking from C.2.6 CacheStats
}

export type TrajStep = {
  observation?: string         // what the agent saw
  reasoning?: string           // what it decided + why (≤200 chars)
  action: string               // what it actually did (tool name + sanitized args)
  result_summary: string       // brief outcome
}

// ── DREAMS.md entries (consolidation diary) ──────────────────────────────────

/** Hermes-derived: a write-only audit trail of every Dreaming cycle. */
export type DreamCycleEntry = {
  ts: number
  cycle_type: 'light' | 'rem' | 'deep'   // Hermes' 3-phase model
  trajectories_scanned: number
  observations_promoted_to_persona: number
  persona_diff_summary: string         // what changed in persona.md
  notes?: string
}

// ── Persona-Awareness behavior hints exposed to other subsystems ─────────────

/** Read by RestraintPipeline, ModelRouter, agency layer to adjust behavior. */
export type PersonaHints = {
  // Earned Interrupt thresholds (read by C.1.5 RestraintPipeline)
  interrupt_aggressiveness: 'low' | 'medium' | 'high'   // derived from persona communication_style
  in_focus_now: boolean        // current state, not historical pattern (live observation)
  active_hours_now: boolean    // is current time within user's typical active hours?

  // Communication style
  prefer_terse: boolean
  prefer_voice_over_text: boolean

  // Cost preferences (optional — affects ModelRouter)
  prefer_quality_over_cost?: boolean   // user said "use the smartest model even if it costs more"
}

// ── Combined .md file family handle ──────────────────────────────────────────

export type MdFileFamily = {
  soul: SoulFile | null              // null before wizard runs
  persona: PersonaFile               // never null; empty fields if no observations yet
  // traj.md + DREAMS.md are append-only files, not full structs in memory
}
