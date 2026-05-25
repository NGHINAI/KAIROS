// src/daemon/mcp/mcpHost.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { McpHost } from './mcpHost'
import { Keychain } from './keychain'

const echoServerArgs = ['run', `${import.meta.dir}/__fixtures__/echo-server.ts`]

describe('McpHost', () => {
  let tmp: string
  let host: McpHost | null = null

  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'kairos-mcphost-')) })
  afterEach(async () => {
    if (host) { await host.stopAll(); host = null }
    rmSync(tmp, { recursive: true })
  })

  function makeKeychain() {
    return new Keychain({ probe: async () => ({ ok: false, stdout: '', stderr: 'not used' }) })
  }

  it('loads config from disk and starts enabled servers', async () => {
    const configPath = join(tmp, 'mcp-servers.json')
    writeFileSync(configPath, JSON.stringify({
      servers: [
        { id: 'echo-a', enabled: true, transport: 'stdio', command: 'bun', args: echoServerArgs, tier_policy: { default: 'GREEN' } },
        { id: 'echo-b', enabled: false, transport: 'stdio', command: 'bun', args: echoServerArgs, tier_policy: { default: 'GREEN' } },
      ],
    }))
    host = new McpHost({ configPath, keychain: makeKeychain() })
    await host.startAll()
    expect(host.listServers().length).toBe(1)
    expect(host.listServers()[0]?.id).toBe('echo-a')
  }, 15_000)

  it('lists tools across all started servers, namespaced as serverId::toolName', async () => {
    const configPath = join(tmp, 'mcp-servers.json')
    writeFileSync(configPath, JSON.stringify({
      servers: [
        { id: 'echo-a', enabled: true, transport: 'stdio', command: 'bun', args: echoServerArgs, tier_policy: { default: 'GREEN' } },
      ],
    }))
    host = new McpHost({ configPath, keychain: makeKeychain() })
    await host.startAll()
    const tools = host.listAllTools()
    expect(tools.find(t => t.qualified_id === 'echo-a::echo')).toBeDefined()
  }, 15_000)

  it('assigns tier per tier_policy (default for non-overridden, override for matched)', async () => {
    const configPath = join(tmp, 'mcp-servers.json')
    writeFileSync(configPath, JSON.stringify({
      servers: [
        { id: 'echo-a', enabled: true, transport: 'stdio', command: 'bun', args: echoServerArgs,
          tier_policy: { default: 'YELLOW', overrides: { echo: 'GREEN' } } },
      ],
    }))
    host = new McpHost({ configPath, keychain: makeKeychain() })
    await host.startAll()
    const tools = host.listAllTools()
    const echo = tools.find(t => t.tool_name === 'echo')
    expect(echo?.tier).toBe('GREEN')
  }, 15_000)

  it('invokeTool routes by qualified id', async () => {
    const configPath = join(tmp, 'mcp-servers.json')
    writeFileSync(configPath, JSON.stringify({
      servers: [
        { id: 'echo-a', enabled: true, transport: 'stdio', command: 'bun', args: echoServerArgs, tier_policy: { default: 'GREEN' } },
      ],
    }))
    host = new McpHost({ configPath, keychain: makeKeychain() })
    await host.startAll()
    const result = await host.invokeTool('echo-a::echo', { msg: 'routed' })
    expect(result.ok).toBe(true)
    expect(result.output_text).toContain('routed')
  }, 15_000)

  it('returns error for unknown qualified id', async () => {
    const configPath = join(tmp, 'mcp-servers.json')
    writeFileSync(configPath, JSON.stringify({ servers: [] }))
    host = new McpHost({ configPath, keychain: makeKeychain() })
    await host.startAll()
    const result = await host.invokeTool('nonexistent::tool', {})
    expect(result.ok).toBe(false)
  })

  it('returns empty config when file missing (graceful degrade)', async () => {
    host = new McpHost({ configPath: join(tmp, 'missing.json'), keychain: makeKeychain() })
    await host.startAll()
    expect(host.listServers().length).toBe(0)
  })
})
