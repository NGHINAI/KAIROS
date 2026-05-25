// src/daemon/mcp/mcpClient.test.ts
import { describe, it, expect, afterEach } from 'bun:test'
import { McpClient } from './mcpClient'
import type { McpServerConfig } from './types'

const echoServerConfig: McpServerConfig = {
  id: 'echo-test',
  enabled: true,
  transport: 'stdio',
  command: 'bun',
  args: ['run', `${import.meta.dir}/__fixtures__/echo-server.ts`],
  tier_policy: { default: 'GREEN' },
}

describe('McpClient', () => {
  let client: McpClient | null = null

  afterEach(async () => {
    if (client) {
      await client.disconnect()
      client = null
    }
  })

  it('connects to a stdio MCP server and lists tools', async () => {
    client = new McpClient(echoServerConfig)
    await client.connect()
    const tools = await client.listTools()
    expect(tools.length).toBeGreaterThan(0)
    expect(tools.find(t => t.name === 'echo')).toBeDefined()
  }, 15_000)

  it('calls a tool and returns the result', async () => {
    client = new McpClient(echoServerConfig)
    await client.connect()
    const result = await client.callTool('echo', { msg: 'hello world' })
    expect(result.ok).toBe(true)
    expect(result.output_text).toContain('hello world')
  }, 15_000)

  it('reports ok=false on tool error', async () => {
    client = new McpClient(echoServerConfig)
    await client.connect()
    const result = await client.callTool('nonexistent_tool', {})
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
  }, 15_000)
})
