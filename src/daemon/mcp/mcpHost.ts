// src/daemon/mcp/mcpHost.ts
// Manages multiple MCP server connections. Loads config from JSON,
// resolves auth via keychain, starts enabled servers in parallel,
// exposes a unified tool list namespaced as serverId::toolName.

import { existsSync, readFileSync } from 'fs'
import { log, logError } from '../logger'
import { McpClient } from './mcpClient'
import type { Keychain } from './keychain'
import type { McpServerConfig, McpToolDescriptor, McpToolCallResult } from './types'

export type McpHostOptions = {
  configPath: string
  keychain: Keychain
}

export class McpHost {
  private clients: Map<string, McpClient> = new Map()
  private tools: Map<string, McpToolDescriptor> = new Map()

  constructor(private opts: McpHostOptions) {}

  async startAll(): Promise<void> {
    const cfg = this.loadConfig()
    const enabled = cfg.filter(s => s.enabled)

    await Promise.all(enabled.map(async (s) => {
      try {
        const env: Record<string, string> = {}
        if (s.auth_keychain) {
          const secret = await this.opts.keychain.get(s.auth_keychain.service, s.auth_keychain.account)
          if (secret) env[s.auth_keychain.env_var] = secret
        }
        const client = new McpClient(s, env)
        await client.connect()
        this.clients.set(s.id, client)

        const listed = await client.listTools()
        for (const t of listed) {
          const qualified = `${s.id}::${t.name}`
          const tier = s.tier_policy.overrides?.[t.name] ?? s.tier_policy.default
          this.tools.set(qualified, {
            server_id: s.id,
            tool_name: t.name,
            qualified_id: qualified,
            description: t.description,
            input_schema: t.inputSchema,
            tier,
          })
        }
        log(`McpHost: ${s.id} ready (${listed.length} tools)`)
      } catch (err) {
        logError(`McpHost: ${s.id} failed to start`, err)
      }
    }))
  }

  async stopAll(): Promise<void> {
    await Promise.all(Array.from(this.clients.values()).map(c => c.disconnect()))
    this.clients.clear()
    this.tools.clear()
  }

  listServers(): { id: string }[] {
    return Array.from(this.clients.keys()).map(id => ({ id }))
  }

  listAllTools(): McpToolDescriptor[] {
    return Array.from(this.tools.values())
  }

  async invokeTool(qualifiedId: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    const tool = this.tools.get(qualifiedId)
    if (!tool) return { ok: false, error: `unknown tool: ${qualifiedId}` }
    const client = this.clients.get(tool.server_id)
    if (!client) return { ok: false, error: `server ${tool.server_id} not connected` }
    return await client.callTool(tool.tool_name, args)
  }

  private loadConfig(): McpServerConfig[] {
    if (!existsSync(this.opts.configPath)) return []
    try {
      const raw = JSON.parse(readFileSync(this.opts.configPath, 'utf8')) as { servers?: McpServerConfig[] }
      return raw.servers ?? []
    } catch (err) {
      logError(`McpHost: failed to parse config at ${this.opts.configPath}`, err)
      return []
    }
  }
}
