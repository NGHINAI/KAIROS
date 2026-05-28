// src/daemon/skills/types.ts
// Types for the AWM (Agent Workflow Memory) subsystem.
// Follows agentskills.io open standard (Dec 2025) with KAIROS-specific metadata extensions.

import type { AutonomyTier } from '../agency/types'

/** State machine per Hermes Curator: active → stale → archived. */
export type SkillState = 'active' | 'stale' | 'archived' | 'pending_review'

/** Parsed SKILL.md content (agentskills.io spec + KAIROS extensions in metadata). */
export type SkillFile = {
  // ── agentskills.io REQUIRED fields ─────────────────────────
  name: string                            // 1-64 chars, lowercase alphanumeric + hyphens; matches directory name
  description: string                     // 1-1024 chars; explicitly states WHAT and WHEN

  // ── agentskills.io OPTIONAL fields ─────────────────────────
  license?: string                        // SPDX license identifier
  compatibility?: string                  // max 500 chars; environment requirements
  allowed_tools?: string[]                // experimental; space-separated tool IDs
  metadata?: Record<string, string>       // free-form. KAIROS uses this for extensions.

  // ── Loaded from filesystem ──────────────────────────────────
  slug: string                            // = name; also the directory name
  body: string                            // markdown body after frontmatter (full skill instructions)
  dir_path: string                        // absolute path to skill directory
  has_scripts: boolean                    // true if scripts/ dir exists with files
  has_references: boolean                 // true if references/ dir exists
}

/** Hermes `.usage.json` schema — 10 fields exactly. Stored alongside SKILL.md. */
export type SkillUsage = {
  use_count: number                       // invocation count (incremented on each execution)
  view_count: number                      // metadata-only access count (loaded but not invoked)
  last_used_at: number                    // ms epoch, 0 if never
  last_viewed_at: number                  // ms epoch, 0 if never
  patch_count: number                     // times the skill has been patched by Curator
  last_patched_at: number                 // ms epoch, 0 if never
  created_at: number                      // ms epoch when skill first crystallized
  state: SkillState
  pinned: boolean                         // user explicitly pinned — never stale/archive
  archived_at: number                     // ms epoch, 0 if never archived
  // Plus an unofficial flag for Curator scheduling
  curator_review_flag?: boolean           // set true when skill execution fails
  failure_history?: Array<{ ts: number; error: string }>   // bounded to last 5
}

/** A candidate from trajectory analysis, before persona gate / crystallization. */
export type SkillCandidate = {
  cluster_id: string                      // hash of trajectory signature
  trajectories: any[]                     // TrajEntry[] — from C.3.1 TrajWriter
  representative_signature: {
    intent_id: string
    common_args: Record<string, unknown>
    avg_tool_calls: number
    success_rate: number
  }
  occurrences: number                     // how many times this pattern appeared
  first_seen_at: number
  last_seen_at: number
}

/** Result of skill execution. */
export type SkillExecutionResult = {
  ok: boolean
  output?: string                         // for Python: the `output` variable. For TS: return value serialized
  error?: string
  duration_ms: number
  sandbox: 'ts_worker' | 'composio_workbench' | 'declarative'
  // For declarative skills, output is what the LLM-driven action produced
}

/** Persona-gate verdict for a candidate skill. */
export type PersonaGateVerdict = {
  approved: boolean
  tier: AutonomyTier
  is_duplicate: boolean
  similar_existing?: string               // slug of similar skill if dedup found one
  needs_human_review: boolean
  reason: string
}

export type SkillsConfig = {
  enabled?: boolean
  dir?: string                            // ~/.kairos/skills/
  archive_dir?: string                    // ~/.kairos/skills/.archive/
  curator?: {
    cycle_interval_days?: number          // default 7
    idle_gate_minutes?: number            // default 120 (2h)
    stale_threshold_days?: number         // default 30
    archive_threshold_days?: number       // default 90
  }
  induction?: {
    min_tool_calls?: number               // default 5 (Hermes)
    min_occurrences?: number              // default 3
  }
  execution?: {
    ts_timeout_ms?: number                // default 30000
    python_timeout_ms?: number            // default 60000
  }
}
