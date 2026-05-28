// src/daemon/connectors/types.ts
// Types for the Composio Connector subsystem.

export type ToolkitSlug = string   // e.g. 'slack', 'gmail', 'github'

export type ConnectionStatus = 'pending' | 'active' | 'expired' | 'revoked' | 'failed'

export type Connection = {
  user_id: string                  // KAIROS local user id (typically 'local' for single-user daemon)
  toolkit_slug: ToolkitSlug
  connection_id: string            // Composio-assigned ID
  auth_config_id: string           // Composio-assigned auth config (per-toolkit, shared across users)
  status: ConnectionStatus
  created_at: number               // ms epoch
  last_polled_at?: number          // ms epoch — last time we verified status with Composio
  expired_at?: number              // ms epoch — when status flipped to 'expired'
}

export type ToolkitInfo = {
  slug: ToolkitSlug
  display_name: string
  description: string
  auth_type: 'oauth' | 'api_key' | 'no_auth' | 'unknown'
  managed_auth_supported: boolean  // true if Composio's managed OAuth covers this toolkit
  tools_count: number              // count of tools the toolkit exposes
}

export type ConnectFlowResult = {
  status: 'success' | 'failed' | 'cancelled'
  toolkit_slug: ToolkitSlug
  connection_id?: string
  duration_ms: number
  error?: string
}

export type ComposioConfig = {
  enabled: boolean                 // default true if api_key present
  api_key?: string                 // read from env at boot
  session_id?: string              // cached session id for resume across restarts
  base_url?: string                // defaults to https://backend.composio.dev
  poll_interval_ms?: number        // default 5 min
  default_toolkits?: ToolkitSlug[] // toolkits the session is opened with on boot (e.g., already-connected)
}

export type ComposioMcpSession = {
  session_id: string
  url: string                      // session.mcp.url
  headers: Record<string, string>  // session.mcp.headers
  toolkits: ToolkitSlug[]
  created_at: number
}
