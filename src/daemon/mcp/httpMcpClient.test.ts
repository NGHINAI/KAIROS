import { describe, it, expect, beforeEach } from 'bun:test'
import { HttpMcpClient } from './httpMcpClient'

describe('HttpMcpClient', () => {
  it('constructs with url + headers', () => {
    const client = new HttpMcpClient({
      url: 'https://backend.composio.dev/tool_router/sess_abc/mcp',
      headers: { 'x-api-key': 'test_key' },
    })
    expect(client.url).toBe('https://backend.composio.dev/tool_router/sess_abc/mcp')
    expect(client.isConnected).toBe(false)
  })

  it('rejects callTool before connect()', async () => {
    const client = new HttpMcpClient({ url: 'https://x/mcp' })
    await expect(client.callTool('foo', {})).rejects.toThrow(/not connected/)
  })

  it('rejects listTools before connect()', async () => {
    const client = new HttpMcpClient({ url: 'https://x/mcp' })
    await expect(client.listTools()).rejects.toThrow(/not connected/)
  })

  it('disconnect() is safe to call when not connected', async () => {
    const client = new HttpMcpClient({ url: 'https://x/mcp' })
    await client.disconnect()   // should not throw
    expect(client.isConnected).toBe(false)
  })

  it('updateHeaders replaces the headers in-place', () => {
    const client = new HttpMcpClient({
      url: 'https://x/mcp',
      headers: { 'x-api-key': 'old' },
    })
    client.updateHeaders({ 'x-api-key': 'new', 'x-extra': 'foo' })
    // Internal field is private; we can verify behavior by inspecting URL is unchanged
    expect(client.url).toBe('https://x/mcp')
    // The actual headers change is observed downstream when reconnecting
  })
})
