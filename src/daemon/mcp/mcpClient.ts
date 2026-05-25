// src/daemon/mcp/mcpClient.ts
// Wraps @modelcontextprotocol/sdk Client + StdioClientTransport as a
// single-server connection. McpHost (Task 4) manages many of these.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { log, logError } from '../logger'
import type { McpServerConfig, McpToolCallResult } from './types'

export type McpToolListing = {
  name: string
  description: string
  inputSchema: unknown
}

export class McpClient {
  private client: Client | null = null
  private connected = false

  constructor(private cfg: McpServerConfig, private env: Record<string, string> = {}) {}

  async connect(): Promise<void> {
    if (this.connected) return
    if (this.cfg.transport !== 'stdio') {
      throw new Error(`McpClient: only stdio supported in C.2 (got ${this.cfg.transport})`)
    }
    if (!this.cfg.command) throw new Error('McpClient: stdio transport requires command')

    const transport = new StdioClientTransport({
      command: this.cfg.command,
      args: this.cfg.args ?? [],
      env: { ...process.env, ...(this.cfg.env ?? {}), ...this.env } as Record<string, string>,
    })
    this.client = new Client({ name: 'kairos', version: '0.3.0' }, { capabilities: {} })
    await this.client.connect(transport)
    this.connected = true
    log(`McpClient: connected to ${this.cfg.id}`)
  }

  async disconnect(): Promise<void> {
    if (!this.connected || !this.client) return
    try {
      await this.client.close()
    } catch (err) {
      logError(`McpClient: ${this.cfg.id} close failed`, err)
    }
    this.connected = false
    this.client = null
  }

  async listTools(): Promise<McpToolListing[]> {
    if (!this.client) throw new Error('McpClient: not connected')
    const resp = await this.client.listTools()
    return (resp.tools ?? []).map(t => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema,
    }))
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    if (!this.client) throw new Error('McpClient: not connected')
    try {
      const resp = await this.client.callTool({ name, arguments: args })
      const content = (resp as any).content ?? []
      const textBlocks = content.filter((b: any) => b.type === 'text')
      const text = textBlocks.map((b: any) => b.text).join('')
      const isError = (resp as any).isError ?? false
      if (isError) {
        return { ok: false, error: text || 'Tool returned an error', output_structured: resp }
      }
      return { ok: true, output_text: text, output_structured: resp }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  get id(): string { return this.cfg.id }
}
