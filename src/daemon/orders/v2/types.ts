// src/daemon/orders/v2/types.ts
// Core types for STANDING_ORDERS v2 — the DSL Rule shape and its serialized form.

export type LifecycleState = 'pending' | 'active' | 'suspended' | 'dry_run' | 'legacy'
export type CreatedBy = 'voice' | 'manual' | 'crystallized' | 'migrated_v1'

export type Duration = string                       // "20h", "5m", "30s", "1d"

export type WhenCron    = { cron: string }
export type WhenAt      = { at: string }            // "5pm", "in 2 hours", absolute ISO
export type WhenEvent   = { event: string }
export type WhenState   = { state: StateSelector }
export type When = WhenCron | WhenAt | WhenEvent | WhenState

export type StateSelector =
  | { clipboard:    { contains?: string; is_url?: boolean } }
  | { focus_app:    { equals?: string; in?: string[] } }
  | { calendar:     { event_starts_in?: Duration } }
  | { file_events:  { path_matches?: string } }
  | { browser_tabs: { opened?: boolean } }
  | { pattern:      { repeats: number; window: Duration; same?: 'file' | 'app' | 'url' } }

/** Condition is a raw string in the source DSL; evaluator parses it. */
export type Condition = string

export type ActionBuiltIn      = { action: 'notify' | 'remind_later' | 'add_to_memory' | 'log' | 'suspend'; args: Record<string, unknown> }
export type ActionInvokeSkill  = { action: 'invoke_skill'; args: { slug: string; args?: Record<string, unknown> } }
export type ActionComposioTool = { action: 'composio_tool'; args: { toolkit: string; tool: string; args: Record<string, unknown> } }
export type ActionEmitEvent    = { action: 'emit_event'; args: { name: string; payload?: Record<string, unknown> } }
export type Action = ActionBuiltIn | ActionInvokeSkill | ActionComposioTool | ActionEmitEvent

/** In-memory rule (ms-epoch timestamps). Parser produces these; Store serializes to SQL. */
export type Rule = {
  schema_version: 1
  slug: string                          // ^[a-z0-9][a-z0-9-]{0,63}$
  when: When
  if?: Condition[]
  unless?: Condition[]
  do: Action[]
  cooldown_ms?: number                  // parsed from Duration string
  dry_run_until?: number                // ms epoch; undefined means not dry-running
  state: LifecycleState
  created_by: CreatedBy
  created_at: number                    // ms epoch
  /** English description body below the frontmatter (audit trail). */
  description?: string
}

/** A trigger context handed to ActionDispatcher when a rule fires. */
export type TriggerContext = {
  trigger: Record<string, unknown>      // event payload, perception data, or { fired_at }
  payload?: Record<string, unknown>     // for `when: event` rules
}

/** What ActionDispatcher returns. Allows chaining ${skill_output.X}. */
export type ActionResult = {
  ok: boolean
  output?: Record<string, unknown>
  error?: string
}
