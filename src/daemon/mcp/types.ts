// src/daemon/mcp/types.ts
// Type surface for the MCP host subsystem.

import type { AutonomyTier } from '../agency/types'

/** Config for a single MCP server connection — from ~/.kairos/mcp-servers.json. */
export type McpServerConfig = {
  id: string                          // stable id, used as tool namespace ('github::search')
  enabled: boolean
  transport: 'stdio' | 'sse' | 'http'
  command?: string                    // for stdio
  args?: string[]
  env?: Record<string, string>        // additional env (auth comes via auth_keychain)
  url?: string                        // for sse/http
  auth_keychain?: {
    service: string                   // macOS keychain service name
    account: string                   // account/key id
    env_var: string                   // which env var the server expects (e.g. GITHUB_TOKEN)
  }
  tier_policy: {
    default: AutonomyTier             // default tier for tools without override
    overrides?: Record<string, AutonomyTier>  // per-tool override
  }
}

/** A tool exposed by an MCP server — discovered at connection time. */
export type McpToolDescriptor = {
  server_id: string                   // which server this tool came from
  tool_name: string                   // server-local name ('search')
  qualified_id: string                // namespaced ('github::search') — used as Intent.id
  description: string
  input_schema: unknown               // JSON Schema from the MCP server
  tier: AutonomyTier                  // assigned from server's tier_policy
}

/** Result of invoking an MCP tool. */
export type McpToolCallResult = {
  ok: boolean
  output_text?: string                // mainline output
  output_structured?: unknown         // if the server returned structured content
  error?: string
}

/** Smithery search result entry. */
export type SmitherySearchHit = {
  name: string
  qualified_name: string              // smithery's catalog id
  description: string
  install_count?: number
  url: string                         // server.smithery.ai/{name} or similar
}

/** agentskills.io SKILL.md frontmatter + body. */
export type SkillManifest = {
  name: string
  description: string                 // shown to LLMs at registry list time
  version?: string
  tier?: AutonomyTier                 // optional default tier for invocation
  trigger_pattern?: string            // optional inline trigger hint
}

export type LoadedSkill = {
  manifest: SkillManifest
  body: string                        // full SKILL.md markdown after frontmatter
  dir: string                         // skill directory path
  scripts?: string[]                  // file paths under scripts/
}
