// src/daemon/connectors/triggers/types.ts
// Canonical types for the Phase D trigger subsystem.

/** Normalized event envelope — every Composio payload mapped to this shape. */
export type NormalizedEvent = {
  trigger_slug: string                     // 'GMAIL_NEW_GMAIL_MESSAGE'
  toolkit: string                          // 'gmail'
  payload: Record<string, unknown>         // the inner data the user filters on
  raw: Record<string, unknown>             // original full Composio payload (for debug)
  received_at: number                      // ms epoch
  event_id: string                         // idempotency key
  connected_account_id?: string
  user_id?: string
}

/** Cached schema returned by composio.triggers.get_type(slug). */
export type TriggerType = {
  slug: string
  toolkit: string
  config_schema: Record<string, unknown>   // JSON schema for triggerConfig
  payload_schema: Record<string, unknown>  // JSON schema for event payload
  description: string
}

/** Trigger instance bookkeeping (refcounted). */
export type TriggerInstanceRow = {
  trigger_id: string                       // Composio 'ti_xxx'
  trigger_slug: string
  connected_account_id: string
  config_hash: string                      // sha256 of triggerConfig used
  created_at: number
  rule_count: number
}

/** Connection prompt outcomes. */
export type ConnectionOutcome = 'ready' | 'pending' | 'timeout'

/** Health states for TriggerListener. */
export type ListenerHealth = 'healthy' | 'degraded' | 'offline'
