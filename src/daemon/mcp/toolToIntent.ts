// src/daemon/mcp/toolToIntent.ts
// Bridges MCP tools into the agency Intent registry. Each tool
// becomes an Intent the ActionExecutor can dispatch.
//
// Idempotent: re-registering a tool is a silent no-op (skip if exists).

import { log } from '../logger'
import type { IntentRegistry } from '../agency/intentRegistry'
import type { McpHost } from './mcpHost'

export function registerMcpToolsAsIntents(
  registry: IntentRegistry,
  host: Pick<McpHost, 'listAllTools' | 'invokeTool'>,
): void {
  let registered = 0
  for (const tool of host.listAllTools()) {
    if (registry.get(tool.qualified_id)) continue   // idempotent — skip existing

    registry.register(
      {
        id: tool.qualified_id,
        description: `[${tool.server_id}] ${tool.description}`,
        tier: tool.tier,
        argSchema: extractSimpleSchema(tool.input_schema),
      },
      async (args) => {
        const result = await host.invokeTool(tool.qualified_id, args)
        if (result.ok) {
          return { status: 'success', details: result.output_text ?? '(no output)' }
        }
        return { status: 'failure', details: result.error ?? 'unknown error' }
      },
    )
    registered++
  }
  if (registered > 0) log(`Registered ${registered} MCP tool(s) as intents`)
}

function extractSimpleSchema(schema: unknown): Record<string, 'string' | 'number' | 'boolean' | 'object'> {
  const out: Record<string, 'string' | 'number' | 'boolean' | 'object'> = {}
  if (typeof schema !== 'object' || !schema) return out
  const props = (schema as any).properties
  if (!props || typeof props !== 'object') return out
  for (const [name, def] of Object.entries(props)) {
    const t = (def as any)?.type
    if (t === 'string' || t === 'number' || t === 'boolean' || t === 'object') {
      out[name] = t
    } else {
      out[name] = 'object'   // unknown / array / nested → opaque object
    }
  }
  return out
}
