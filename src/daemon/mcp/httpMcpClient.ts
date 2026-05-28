// src/daemon/mcp/httpMcpClient.ts
// HTTP/SSE transport variant of McpClient. Used for hosted MCP servers
// like Composio that expose the MCP protocol over Streamable HTTP.
//
// Live spike (scripts/spike-composio-mcp.ts) confirmed Streamable HTTP works
// against Composio's MCP endpoint. SSEClientTransport not needed at this time
// but may be required for other providers in the future.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

export type HttpMcpClientOptions = {
  url: string
  headers?: Record<string, string>
  clientName?: string
  clientVersion?: string
}

export type McpTool = {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export class HttpMcpClient {
  public readonly url: string
  private headers: Record<string, string>
  private client: Client | null = null
  private transport: StreamableHTTPClientTransport | null = null
  private readonly clientName: string
  private readonly clientVersion: string

  constructor(opts: HttpMcpClientOptions) {
    this.url = opts.url
    this.headers = opts.headers ?? {}
    this.clientName = opts.clientName ?? 'kairos-daemon'
    this.clientVersion = opts.clientVersion ?? '0.3.5'
  }

  async connect(): Promise<void> {
    if (this.client) return
    this.client = new Client(
      { name: this.clientName, version: this.clientVersion },
      { capabilities: {} },
    )
    this.transport = new StreamableHTTPClientTransport(new URL(this.url), {
      requestInit: { headers: this.headers },
    })
    await this.client.connect(this.transport)
  }

  async listTools(): Promise<McpTool[]> {
    if (!this.client) throw new Error('HttpMcpClient: not connected — call connect() first')
    const result = await this.client.listTools()
    return (result.tools ?? []).map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as any,
    }))
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.client) throw new Error('HttpMcpClient: not connected — call connect() first')
    const result = await this.client.callTool({ name, arguments: args })
    return result
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close()
      this.client = null
      this.transport = null
    }
  }

  /** Replace headers (e.g., after a Composio session is refreshed and the URL+headers change).
   *  Caller should typically disconnect() then reconnect() with new URL/headers; this helper is
   *  for in-place updates where the URL stayed the same but headers rotated. */
  updateHeaders(newHeaders: Record<string, string>): void {
    this.headers = newHeaders
  }

  get isConnected(): boolean {
    return this.client !== null
  }
}
