// src/daemon/agents/intentToolBridge.ts
// Bridges agency Intent-registry entries (connect-service, disconnect-service,
// setup_service, MCP tools, reminders, …) into ToolDefs the smart-tier Planner
// can actually call. Without this the voice conductor's LLM has no way to TAKE
// ACTIONS — it can only talk. Mirrors skillsAsTools()/registerMcpToolsAsIntents().
//
// Dispatch goes through the injected `dispatch` fn (wired to the ActionExecutor
// in daemon boot) so the restraint/approval pipeline still applies — the bridge
// never calls intent handlers directly, which would bypass safety gating.

import type { ToolDef } from "./types"

/** Minimal shape of an IntentRegistry entry we depend on. */
interface RegistryEntryLike {
  id: string
  tier: string
  intent: { id: string; description?: string; argSchema?: Record<string, string> }
}

interface RegistryLike {
  list(): RegistryEntryLike[]
}

export interface IntentsAsToolsDeps {
  registry: RegistryLike
  /** Dispatch an intent by its ORIGINAL id through the ActionExecutor. */
  dispatch: (id: string, args: any) => Promise<{ status: string; details: string }>
  /** Optional predicate — return false to hide an intent from the LLM. */
  filter?: (entry: RegistryEntryLike) => boolean
}

/** OpenAI/Agents function names allow [a-zA-Z0-9_-]. MCP qualified ids use
 *  `server::tool`, so `::` (and any other stray char) collapses to `_`. */
function toToolName(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_")
}

/** argSchema is a flat {name: 'string'|'number'|'boolean'|'object'} map
 *  (see toolToIntent.extractSimpleSchema). Lift it to a JSON Schema object. */
function toJsonSchema(argSchema: Record<string, string> | undefined): Record<string, any> {
  const properties: Record<string, any> = {}
  for (const [name, type] of Object.entries(argSchema ?? {})) {
    properties[name] = { type }
  }
  return { type: "object", properties, required: [] }
}

export function intentsAsTools(deps: IntentsAsToolsDeps): ToolDef[] {
  const entries = deps.filter ? deps.registry.list().filter(deps.filter) : deps.registry.list()
  return entries.map((e) => ({
    name: toToolName(e.id),
    description: e.intent.description ?? e.id,
    parameters: toJsonSchema(e.intent.argSchema),
    // Dispatch the ORIGINAL id (not the sanitized tool name) through the executor.
    execute: async (args: any) => deps.dispatch(e.id, args ?? {}),
  }))
}
