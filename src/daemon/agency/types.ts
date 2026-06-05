// src/daemon/agency/types.ts
// Core types for the agency layer. Every action, every trigger match,
// every trajectory log uses these.
//
// Autonomy tiers (visual: 🟢🟡🟠🔴):
//   GREEN  — reversible, silent execution
//   YELLOW — reversible, notify after
//   ORANGE — semi-reversible or sensitive, confirm before
//   RED    — irreversible, full preview + explicit confirm
//
// Risk tier is a property of the INTENT (the action handler), not of the
// trigger that fires it. The same intent always has the same tier —
// LLM cannot override at runtime (structural enforcement, not prompt-based).

export type AutonomyTier = 'GREEN' | 'YELLOW' | 'ORANGE' | 'RED'

/** A registered action capability. The static contract. */
export type Intent = {
  id: string                          // 'notify' | 'add_to_memory' | 'log' | etc
  description: string                 // human-readable, fed to action_compose LLM
  tier: AutonomyTier                  // structural risk classification
  argSchema: Record<string, 'string' | 'number' | 'boolean' | 'object'>  // simple typed args
  idempotencyKey?: (args: Record<string, unknown>) => string  // dedup within a window
}

/** A concrete invocation request — produced by trigger matching. */
export type ActionRequest = {
  request_id: string                  // UUID for traceability
  intent_id: string                   // → IntentRegistry lookup
  args: Record<string, unknown>
  source_trigger_id?: string          // compiled_orders_triggers.id (null = built-in catalog trigger)
  source_episode_id?: number          // mem_l2_episodes.id (null = direct user / external)
  reasoning: string                   // why this action — for trajectory log
  requested_at: number
  source?: 'user' | 'proactive'       // 'user' = interactive/foreground (the user asked → bypasses
                                       // restraint debounce; tier/approval still applies). default 'proactive'.
}

/** Pre-execution status of a queued action. */
export type ActionStatus =
  | 'pending'                         // queued, not yet executed
  | 'awaiting_approval'               // gated on ORANGE/RED tier
  | 'executing'                       // in flight
  | 'completed'                       // success
  | 'failed'                          // error
  | 'cancelled'                       // user dismissed
  | 'dry_run'                         // executed in dry-run mode
  | 'suppressed'                      // restraint pipeline blocked delivery entirely
  | 'log_only'                        // scored below surface threshold; trajectory recorded only
  | 'digest'                          // queued into digest bundle; not delivered immediately

/** UFO2-style structured trajectory step. One per atomic action attempt. */
export type TrajectoryStep = {
  observation: string                 // what the agent saw before acting
  reasoning: string                   // why it chose this action
  action: { intent_id: string; args: Record<string, unknown> }
  result: string                      // outcome description
  result_status: 'success' | 'failure' | 'awaiting' | 'cancelled'
  duration_ms: number
}

/** A full trajectory — one or more steps grouped by goal. */
export type Trajectory = {
  trajectory_id: string
  task_goal: string                   // natural-language description
  steps: TrajectoryStep[]
  outcome: 'success' | 'failure' | 'user_override' | 'partial'
  override_reason?: string            // populated when user intervenes
  started_at: number
  ended_at: number
}

/** What's in the inbox file. */
export type InboxItem = {
  item_id: string
  created_at: number
  tier: AutonomyTier
  intent_id: string
  description: string                 // human-readable summary
  args_preview: string                // truncated arg display
  approve_command: string             // CLI hint: how the user approves
  dismiss_command: string             // CLI hint: how the user dismisses
  expires_at?: number                 // auto-dismiss after this time
}
