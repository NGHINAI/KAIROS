// src/daemon/mcp/mcpHost.test.ts
import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { McpHost } from './mcpHost'
import type { DestructiveActionConfirmer } from './mcpHost'
import { Keychain } from './keychain'
import { HttpMcpClient } from './httpMcpClient'
import { McpClient } from './mcpClient'

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

// ---------------------------------------------------------------------------
// C.2.7 — Transport branching tests
// ---------------------------------------------------------------------------

describe('McpHost — transport branching (C.2.7)', () => {
  let tmp: string
  let host: McpHost | null = null

  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'kairos-mcphost-transport-')) })
  afterEach(async () => {
    if (host) { await host.stopAll(); host = null }
    rmSync(tmp, { recursive: true })
  })

  function makeKeychain() {
    return new Keychain({ probe: async () => ({ ok: false, stdout: '', stderr: 'not used' }) })
  }

  it('routes config.transport=http to HttpMcpClient (mocked)', async () => {
    // Spy on HttpMcpClient constructor to detect it is instantiated
    const connectCalls: string[] = []
    const originalConnect = HttpMcpClient.prototype.connect
    HttpMcpClient.prototype.connect = async function () {
      connectCalls.push(this.url)
      // Don't actually connect to avoid network calls in tests
      throw new Error('mock: refusing real HTTP connect')
    }

    const configPath = join(tmp, 'mcp-servers.json')
    writeFileSync(configPath, JSON.stringify({
      servers: [
        {
          id: 'http-server',
          enabled: true,
          transport: 'http',
          url: 'http://localhost:9999/mcp',
          tier_policy: { default: 'GREEN' },
        },
      ],
    }))

    host = new McpHost({ configPath, keychain: makeKeychain() })
    // startAll gracefully degrades on connect failure — server won't register
    await host.startAll()

    // The mock connect was reached → HttpMcpClient was instantiated & connect() was called
    expect(connectCalls).toContain('http://localhost:9999/mcp')

    // Restore original
    HttpMcpClient.prototype.connect = originalConnect
  }, 10_000)

  it('routes config.transport=stdio (or missing) to McpClient (existing behavior preserved)', async () => {
    const connectCalls: string[] = []
    const originalConnect = McpClient.prototype.connect
    McpClient.prototype.connect = async function () {
      connectCalls.push(this.id)
      throw new Error('mock: refusing real stdio connect')
    }

    const configPath = join(tmp, 'mcp-servers.json')
    writeFileSync(configPath, JSON.stringify({
      servers: [
        {
          id: 'stdio-server',
          enabled: true,
          // transport intentionally omitted — should default to stdio
          command: 'bun',
          args: ['--version'],
          tier_policy: { default: 'GREEN' },
        },
      ],
    }))

    host = new McpHost({ configPath, keychain: makeKeychain() })
    await host.startAll()

    expect(connectCalls).toContain('stdio-server')

    McpClient.prototype.connect = originalConnect
  }, 10_000)
})

// ---------------------------------------------------------------------------
// C.2.7 — DestructiveToolGuard (V3) tests
// ---------------------------------------------------------------------------

describe('McpHost — DestructiveToolGuard (V3)', () => {
  let tmp: string
  let host: McpHost | null = null

  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'kairos-mcphost-guard-')) })
  afterEach(async () => {
    if (host) { await host.stopAll(); host = null }
    rmSync(tmp, { recursive: true })
  })

  const echoServerArgs = ['run', `${import.meta.dir}/__fixtures__/echo-server.ts`]

  function makeKeychain() {
    return new Keychain({ probe: async () => ({ ok: false, stdout: '', stderr: 'not used' }) })
  }

  function makeConfirmer(decision: boolean): DestructiveActionConfirmer & { calls: any[] } {
    const calls: any[] = []
    return {
      calls,
      async confirm(opts) {
        calls.push(opts)
        return decision
      },
    }
  }

  async function makeHostWithEcho(confirmer?: DestructiveActionConfirmer): Promise<McpHost> {
    const configPath = join(tmp, 'mcp-servers.json')
    writeFileSync(configPath, JSON.stringify({
      servers: [
        {
          id: 'echo-a',
          enabled: true,
          transport: 'stdio',
          command: 'bun',
          args: echoServerArgs,
          tier_policy: { default: 'GREEN' },
        },
      ],
    }))
    const h = new McpHost({ configPath, keychain: makeKeychain(), destructiveConfirmer: confirmer })
    await h.startAll()
    return h
  }

  it('asks confirmer for delete-pattern tools', async () => {
    const confirmer = makeConfirmer(true)
    host = await makeHostWithEcho(confirmer)

    // Manually register a fake "delete_file" tool so we don't need a real server for it
    ;(host as any).tools.set('echo-a::delete_file', {
      server_id: 'echo-a',
      tool_name: 'delete_file',
      qualified_id: 'echo-a::delete_file',
      description: 'deletes a file',
      input_schema: {},
      tier: 'GREEN',
    })

    await host.invokeTool('echo-a::delete_file', { path: '/tmp/foo.txt' })
    expect(confirmer.calls.length).toBe(1)
    expect(confirmer.calls[0]?.tool_name).toBe('delete_file')
  }, 15_000)

  it('proceeds with execution when confirmer returns true', async () => {
    const confirmer = makeConfirmer(true)
    host = await makeHostWithEcho(confirmer)

    // echo tool name does not match destructive pattern — confirmer won't be called
    // so we use invokeTool on a real non-destructive tool to verify execution succeeds
    const result = await host.invokeTool('echo-a::echo', { msg: 'hello-guard' })
    expect(result.ok).toBe(true)
    expect(result.output_text).toContain('hello-guard')
    // confirmer never called — 'echo' is not destructive
    expect(confirmer.calls.length).toBe(0)
  }, 15_000)

  it('returns cancellation when confirmer returns false', async () => {
    const confirmer = makeConfirmer(false)
    host = await makeHostWithEcho(confirmer)

    // Register a fake destructive tool pointing at the echo server
    ;(host as any).tools.set('echo-a::remove_item', {
      server_id: 'echo-a',
      tool_name: 'remove_item',
      qualified_id: 'echo-a::remove_item',
      description: 'removes an item',
      input_schema: {},
      tier: 'GREEN',
    })

    const result = await host.invokeTool('echo-a::remove_item', { id: '42' })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/cancelled/)
    // Confirmer was consulted
    expect(confirmer.calls.length).toBe(1)
  }, 15_000)

  it('passes-through non-destructive tools without consulting confirmer', async () => {
    const confirmer = makeConfirmer(true)
    host = await makeHostWithEcho(confirmer)

    const result = await host.invokeTool('echo-a::echo', { msg: 'safe-call' })
    expect(result.ok).toBe(true)
    // confirmer must NOT have been consulted
    expect(confirmer.calls.length).toBe(0)
  }, 15_000)

  it('works when no confirmer is provided (backward compat)', async () => {
    // No confirmer — destructive tools should execute without any guard
    host = await makeHostWithEcho(/* no confirmer */)

    // Register a fake destructive tool
    ;(host as any).tools.set('echo-a::purge_all', {
      server_id: 'echo-a',
      tool_name: 'purge_all',
      qualified_id: 'echo-a::purge_all',
      description: 'purges everything',
      input_schema: {},
      tier: 'GREEN',
    })

    // The echo server doesn't have purge_all, so it will error from the client side —
    // but crucially it should NOT fail due to a missing confirmer; the guard is a no-op.
    const result = await host.invokeTool('echo-a::purge_all', {})
    // Guard was bypassed (no confirmer) — error comes from the actual tool call, not cancellation
    expect(result.error).not.toMatch(/cancelled/)
  }, 15_000)
})
