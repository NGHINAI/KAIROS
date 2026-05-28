// src/daemon/mcp/mcpHost.ts
// Manages multiple MCP server connections. Loads config from JSON,
// resolves auth via keychain, starts enabled servers in parallel,
// exposes a unified tool list namespaced as serverId::toolName.
//
// C.2.7: supports both stdio (McpClient) and http/sse (HttpMcpClient)
// transports, normalises callTool() return shape across both, and
// guards destructive tool invocations behind an optional confirmer.

import { existsSync, readFileSync } from 'fs'
import { log, logError } from '../logger'
import { McpClient } from './mcpClient'
import { HttpMcpClient } from './httpMcpClient'
import type { Keychain } from './keychain'
import type { McpServerConfig, McpToolDescriptor, McpToolCallResult } from './types'

// ---------------------------------------------------------------------------
// DestructiveToolGuard types
// ---------------------------------------------------------------------------

export interface DestructiveActionConfirmer {
  /** Returns true if the user confirms the destructive action within `timeoutMs`. */
  confirm(opts: {
    tool_name: string
    args: Record<string, unknown>
    description: string
    timeout_ms: number
  }): Promise<boolean>
}

const DESTRUCTIVE_PATTERN = /delete|remove|archive|trash|purge|drop/i

// ---------------------------------------------------------------------------
// McpHost options
// ---------------------------------------------------------------------------

export type McpHostOptions = {
  configPath: string
  keychain: Keychain
  /** When provided, destructive-pattern tools require confirmation before execution. */
  destructiveConfirmer?: DestructiveActionConfirmer
}

// ---------------------------------------------------------------------------
// McpHost
// ---------------------------------------------------------------------------

export class McpHost {
  private clients: Map<string, McpClient | HttpMcpClient> = new Map()
  private tools: Map<string, McpToolDescriptor> = new Map()
  private readonly destructiveConfirmer?: DestructiveActionConfirmer

  constructor(private opts: McpHostOptions) {
    this.destructiveConfirmer = opts.destructiveConfirmer
  }

  async startAll(): Promise<void> {
    const cfg = this.loadConfig()
    const enabled = cfg.filter(s => s.enabled)

    await Promise.all(enabled.map(async (s) => {
      try {
        const client = await this.createClient(s)
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
            description: t.description ?? '',
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

    // V3 DestructiveToolGuard
    const guard = await this.maybeGuardDestructive(tool.tool_name, args)
    if (!guard.allowed) {
      return { ok: false, error: guard.cancellation }
    }

    return await this.invokeAndNormalize(client, tool.tool_name, args)
  }

  // ---------------------------------------------------------------------------
  // Sub-task B: transport-branching factory
  // ---------------------------------------------------------------------------

  private async createClient(config: McpServerConfig): Promise<McpClient | HttpMcpClient> {
    const transport = config.transport ?? 'stdio'   // back-compat: stdio is default
    if (transport === 'http' || transport === 'sse') {
      if (!config.url) throw new Error(`McpHost: ${config.id} has transport=${transport} but no url`)
      const headers = await this.resolveHeaders(config)
      return new HttpMcpClient({ url: config.url, headers })
    }
    // stdio path — inject auth env var from keychain if configured
    const env: Record<string, string> = {}
    if (config.auth_keychain) {
      const secret = await this.opts.keychain.get(config.auth_keychain.service, config.auth_keychain.account)
      if (secret) env[config.auth_keychain.env_var] = secret
    }
    return new McpClient(config, env)
  }

  private async resolveHeaders(config: McpServerConfig): Promise<Record<string, string>> {
    const headers = { ...(config.headers ?? {}) }
    for (const kc of config.headers_keychain ?? []) {
      const value = await this.opts.keychain.get(kc.service, kc.account)
      if (value) headers[kc.header_name] = value
    }
    return headers
  }

  // ---------------------------------------------------------------------------
  // Sub-task C: normalize callTool() return shape across both client types
  // ---------------------------------------------------------------------------

  private async invokeAndNormalize(
    client: McpClient | HttpMcpClient,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<McpToolCallResult> {
    try {
      const raw = await client.callTool(toolName, args)
      // McpClient already returns { ok, output_text?, error? } — pass through
      if (raw && typeof raw === 'object' && 'ok' in raw) {
        return raw as McpToolCallResult
      }
      // HttpMcpClient returns raw SDK result — normalize it
      const r = raw as any
      if (r?.isError === true) {
        const errText = (r?.content ?? []).map((c: any) => c.text ?? '').join('\n') || 'unknown error'
        return { ok: false, error: errText }
      }
      const outText = (r?.content ?? []).map((c: any) => c.text ?? '').join('\n')
      return { ok: true, output_text: outText }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  // ---------------------------------------------------------------------------
  // Sub-task D: V3 DestructiveToolGuard
  // ---------------------------------------------------------------------------

  private async maybeGuardDestructive(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ allowed: boolean; cancellation?: string }> {
    if (!this.destructiveConfirmer) return { allowed: true }
    if (!DESTRUCTIVE_PATTERN.test(toolName)) return { allowed: true }
    const desc = `${toolName} with args: ${JSON.stringify(args).slice(0, 200)}`
    const ok = await this.destructiveConfirmer.confirm({
      tool_name: toolName,
      args,
      description: desc,
      timeout_ms: 30_000,
    })
    if (!ok) return { allowed: false, cancellation: 'destructive action cancelled by user (or timeout)' }
    return { allowed: true }
  }

  // ---------------------------------------------------------------------------
  // Config loader
  // ---------------------------------------------------------------------------

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
