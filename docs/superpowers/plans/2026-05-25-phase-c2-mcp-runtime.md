# Phase C.2 — MCP Host Runtime + Smithery + Bespoke macOS Connectors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make KAIROS speak MCP. Embed `@modelcontextprotocol/sdk` (TS) in the daemon as a *client* (not just the existing server shim), connect to N configured MCP servers at startup, auto-register their tools as Intent entries in the agency registry with structural tier assignment, and add Smithery CLI integration for dynamic discovery + install of new servers. Ship at least one bespoke macOS connector (Reminders via AppleScript) as a `.mcpb` bundle to prove the bespoke path works.

After C.2 ships, every triggered action can call any tool on any connected MCP server. The connector ecosystem is no longer "what KAIROS implements" — it's "what the MCP world has built" (20,000+ servers as of May 2026).

**Architecture:** A new `src/daemon/mcp/` subsystem with: `mcpClient.ts` (single server connection wrapping the official SDK), `mcpHost.ts` (manages multiple servers + lifecycle), `toolToIntent.ts` (auto-registers each server's tools as Intent entries with tier from config), `smithery.ts` (shell-wraps Smithery CLI for search/add), `keychain.ts` (macOS Security framework via `/usr/bin/security` CLI for API keys), `skillLoader.ts` (agentskills.io SKILL.md format support for KAIROS-authored skills). A new bespoke connector at `connectors/macos-reminders/` packaged as `.mcpb` bundle proves the format. Daemon wire-up reads `~/.kairos/mcp-servers.json` and starts the host.

**Tech Stack:** TypeScript on Bun, `@modelcontextprotocol/sdk` (already in package.json, v1.0.4 — bump if SDK has moved), stdio transport for MCP, AppleScript via `osascript` for the Reminders bundle, `/usr/bin/security` shell-out for keychain.

**Scope boundary:** C.2 ships the static-configured MCP client. **Dynamic install during trigger fire** (the bet-big vision of "auto-acquire a connector when a triggered action needs it") composes naturally with C.3's Magentic-One orchestrator (which can re-plan and shell-out to Smithery as a planned step) — deferred to C.3. The agentskills.io SKILL.md loader in C.2 covers KAIROS's own bundled skills going forward; migrating existing prior-session skills/active/*.sh to the new format is out of scope here.

**Estimated size:** ~2,800 lines of TypeScript + tests across 11 atomic tasks. (Comparable to C.1's 12 tasks / ~2,000 LOC.)

---

## File Structure

All new code under `src/daemon/mcp/` plus one bespoke connector at `connectors/macos-reminders/`. The existing `src/shim/` (KAIROS as MCP server) is untouched — that's a separate codebase serving the inverse role.

```
src/daemon/
├── mcp/                              [NEW — KAIROS as MCP client]
│   ├── types.ts                      McpServerConfig, McpToolDescriptor, TierPolicy
│   ├── keychain.ts                   macOS keychain wrapper (security CLI shell-out)
│   ├── mcpClient.ts                  Single MCP server connection (spawn + JSON-RPC)
│   ├── mcpHost.ts                    Manages multiple servers, lifecycle, auth injection
│   ├── toolToIntent.ts               Registers each server's tools as Intent entries
│   ├── smithery.ts                   Smithery CLI wrapper (search, add, list installed)
│   └── skillLoader.ts                agentskills.io SKILL.md format loader (KAIROS skills)
│
├── agency/
│   ├── intentRegistry.ts             [MODIFY — accept dynamic registrations from MCP host]
│   └── intents/                      [unchanged — built-in 5 GREEN intents remain]
│
└── index.ts                          [MODIFY — wire MCP host into startup]

connectors/                           [NEW — bespoke .mcpb bundles]
└── macos-reminders/
    ├── manifest.json                 .mcpb spec
    ├── server/
    │   ├── index.ts                  MCP server implementation (stdio)
    │   └── reminders.ts              AppleScript reminder ops (list, add, complete)
    └── README.md                     installation + usage
```

Plus `~/.kairos/mcp-servers.json` as a user-editable config that lists which MCP servers to start with what auth.

---

## Task 0: Setup + SDK version verification

**Files:**
- Modify: `package.json` (if SDK bump needed)
- Create: `~/.kairos/mcp-servers.json` (seed example)

- [ ] **Step 1: Check current SDK version**

```bash
cd /Users/nirmalghinaiya/Desktop/kairos-sandbox
cat node_modules/@modelcontextprotocol/sdk/package.json | grep '"version"'
```

Note the version. If <2.0.0, bump:

```bash
bun add @modelcontextprotocol/sdk@latest
```

The 1.x → 2.x migration mostly adds new transports + tightens types; the `Client` class API for stdio is stable. If 2.x types differ from this plan's code snippets, adapt the implementation to match actual exports (the test assertions remain unchanged).

- [ ] **Step 2: Verify the SDK exports**

```bash
cat node_modules/@modelcontextprotocol/sdk/package.json | grep -A 20 '"exports"' | head -30
```

The plan uses these import paths (verify they exist):
- `'@modelcontextprotocol/sdk/client/index.js'` — `Client` class
- `'@modelcontextprotocol/sdk/client/stdio.js'` — `StdioClientTransport`

If paths have changed in the installed version, adjust imports in Task 3.

- [ ] **Step 3: Create the seed MCP servers config**

```bash
mkdir -p ~/.kairos
```

Write `~/.kairos/mcp-servers.json` (only create if absent — don't overwrite user edits):

```json
{
  "servers": [
    {
      "id": "macos-reminders",
      "enabled": false,
      "transport": "stdio",
      "command": "bun",
      "args": ["run", "/Users/nirmalghinaiya/Desktop/kairos-sandbox/connectors/macos-reminders/server/index.ts"],
      "tier_policy": {
        "default": "YELLOW",
        "overrides": {
          "list_reminders": "GREEN",
          "add_reminder": "YELLOW",
          "complete_reminder": "ORANGE",
          "delete_reminder": "RED"
        }
      }
    }
  ]
}
```

(`enabled: false` for the bundled connector — it gets enabled in Task 9 wire-up after the bundle is shipped.)

- [ ] **Step 4: Commit**

```bash
git add package.json bun.lock 2>/dev/null || true
git commit -m "deps(c2): verify @modelcontextprotocol/sdk + seed ~/.kairos/mcp-servers.json" --allow-empty
```

---

## Task 1: MCP type surface

**Files:**
- Create: `src/daemon/mcp/types.ts`

Types-only file. No tests — exercised by every other C.2 module.

- [ ] **Step 1: Write types.ts**

```typescript
// src/daemon/mcp/types.ts
// Type surface for the MCP host subsystem.
//
// We re-export a few types from @modelcontextprotocol/sdk via thin
// wrappers so downstream code doesn't depend on internal SDK paths
// (which have shifted between minor versions).

import type { AutonomyTier } from '../agency/types'

/** Config for a single MCP server connection — from ~/.kairos/mcp-servers.json. */
export type McpServerConfig = {
  id: string                          // stable id, used as tool namespace ('github::search')
  enabled: boolean
  transport: 'stdio' | 'sse' | 'http'
  command?: string                    // for stdio
  args?: string[]
  env?: Record<string, string>        // additional env (auth comes via auth_keychain)
  url?: string                        // for sse/http
  auth_keychain?: {
    service: string                   // macOS keychain service name
    account: string                   // account/key id
    env_var: string                   // which env var the server expects (e.g. GITHUB_TOKEN)
  }
  tier_policy: {
    default: AutonomyTier             // default tier for tools without override
    overrides?: Record<string, AutonomyTier>  // per-tool override
  }
}

/** A tool exposed by an MCP server — discovered at connection time. */
export type McpToolDescriptor = {
  server_id: string                   // which server this tool came from
  tool_name: string                   // server-local name ('search')
  qualified_id: string                // namespaced ('github::search') — used as Intent.id
  description: string
  input_schema: unknown               // JSON Schema from the MCP server
  tier: AutonomyTier                  // assigned from server's tier_policy
}

/** Result of invoking an MCP tool. */
export type McpToolCallResult = {
  ok: boolean
  output_text?: string                // mainline output
  output_structured?: unknown         // if the server returned structured content
  error?: string
}

/** Smithery search result entry. */
export type SmitherySearchHit = {
  name: string
  qualified_name: string              // smithery's catalog id
  description: string
  install_count?: number
  url: string                         // server.smithery.ai/{name} or similar
}

/** agentskills.io SKILL.md frontmatter + body. */
export type SkillManifest = {
  name: string
  description: string                 // shown to LLMs at registry list time
  version?: string
  tier?: AutonomyTier                 // optional default tier for invocation
  trigger_pattern?: string            // optional inline trigger hint
}

export type LoadedSkill = {
  manifest: SkillManifest
  body: string                        // full SKILL.md markdown after frontmatter
  dir: string                         // skill directory path
  scripts?: string[]                  // file paths under scripts/
}
```

- [ ] **Step 2: Type-check just this file**

```bash
cd /Users/nirmalghinaiya/Desktop/kairos-sandbox
bunx tsc --noEmit src/daemon/mcp/types.ts 2>&1 | head -5
```

Should produce no output specific to this file.

- [ ] **Step 3: Commit**

```bash
git add src/daemon/mcp/types.ts
git commit -m "feat(mcp): type surface — McpServerConfig, McpToolDescriptor, SkillManifest"
```

---

## Task 2: macOS keychain helper

**Files:**
- Create: `src/daemon/mcp/keychain.ts`
- Test:  `src/daemon/mcp/keychain.test.ts`

Bun has no native keychain binding; shell-wrap `/usr/bin/security`. Used by McpHost to inject API keys into MCP server subprocess env at spawn time without ever writing them to disk.

- [ ] **Step 1: Write the failing test**

```typescript
// src/daemon/mcp/keychain.test.ts
import { describe, it, expect } from 'bun:test'
import { Keychain } from './keychain'

describe('Keychain', () => {
  it('uses injected probe for testability', async () => {
    const calls: string[] = []
    const kc = new Keychain({
      probe: async (cmd) => { calls.push(cmd.join(' ')); return { ok: true, stdout: 'fake-secret-value', stderr: '' } },
    })
    const value = await kc.get('com.kairos.test', 'github')
    expect(value).toBe('fake-secret-value')
    expect(calls[0]).toContain('find-generic-password')
    expect(calls[0]).toContain('com.kairos.test')
    expect(calls[0]).toContain('github')
  })

  it('returns null when keychain item is missing', async () => {
    const kc = new Keychain({
      probe: async () => ({ ok: false, stdout: '', stderr: 'SecKeychainSearchCopyNext: The specified item could not be found' }),
    })
    expect(await kc.get('com.kairos.nope', 'nope')).toBeNull()
  })

  it('set() writes (delete-then-add) so updates work', async () => {
    const calls: string[][] = []
    const kc = new Keychain({
      probe: async (cmd) => { calls.push(cmd); return { ok: true, stdout: '', stderr: '' } },
    })
    await kc.set('com.kairos.test', 'github', 'new-token')
    // Expect: first delete-generic-password attempt, then add-generic-password
    expect(calls[0]?.join(' ')).toContain('delete-generic-password')
    expect(calls[1]?.join(' ')).toContain('add-generic-password')
    expect(calls[1]?.join(' ')).toContain('new-token')
  })

  it('set() succeeds even when delete fails (first-time write)', async () => {
    let n = 0
    const kc = new Keychain({
      probe: async () => {
        n++
        if (n === 1) return { ok: false, stdout: '', stderr: 'not found' }
        return { ok: true, stdout: '', stderr: '' }
      },
    })
    await expect(kc.set('com.kairos.test', 'gh', 'tok')).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/daemon/mcp/keychain.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// src/daemon/mcp/keychain.ts
// macOS keychain wrapper using /usr/bin/security CLI. No native binding
// required. Secrets never written to disk by KAIROS — they live in the
// system keychain and are injected as env vars at MCP server spawn time.

import { logError } from '../logger'

type ProbeResult = { ok: boolean; stdout: string; stderr: string }
type Probe = (cmd: string[]) => Promise<ProbeResult>

export type KeychainOptions = {
  probe?: Probe
}

export class Keychain {
  private probe: Probe

  constructor(opts?: KeychainOptions) {
    this.probe = opts?.probe ?? defaultProbe
  }

  /** Read a secret. Returns null when not found. */
  async get(service: string, account: string): Promise<string | null> {
    const result = await this.probe(['security', 'find-generic-password', '-s', service, '-a', account, '-w'])
    if (!result.ok) return null
    return result.stdout.trim()
  }

  /** Write a secret. Deletes any existing one first (idempotent overwrite). */
  async set(service: string, account: string, value: string): Promise<void> {
    // delete-generic-password fails harmlessly when no item exists
    await this.probe(['security', 'delete-generic-password', '-s', service, '-a', account])
    const result = await this.probe(['security', 'add-generic-password', '-s', service, '-a', account, '-w', value])
    if (!result.ok) {
      throw new Error(`Keychain set failed: ${result.stderr.slice(0, 200)}`)
    }
  }
}

async function defaultProbe(cmd: string[]): Promise<ProbeResult> {
  try {
    const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' })
    const code = await proc.exited
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    return { ok: code === 0, stdout, stderr }
  } catch (err) {
    logError('Keychain probe failed', err)
    return { ok: false, stdout: '', stderr: String(err) }
  }
}
```

- [ ] **Step 4: Run tests**

```bash
bun test src/daemon/mcp/keychain.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/mcp/keychain.ts src/daemon/mcp/keychain.test.ts
git commit -m "feat(mcp): macOS keychain wrapper (security CLI shell-out, no native binding)"
```

---

## Task 3: Single MCP server client

**Files:**
- Create: `src/daemon/mcp/mcpClient.ts`
- Test:  `src/daemon/mcp/mcpClient.test.ts`

Wraps `@modelcontextprotocol/sdk`'s `Client` + `StdioClientTransport`. One `McpClient` instance per connected server: connect, listTools, callTool, disconnect.

- [ ] **Step 1: Write the failing test**

The SDK's client requires real subprocess connection — hard to mock cleanly. Tests use a **real test MCP server** spawned from a tiny in-repo fixture (echoes one tool that just returns its args). This is the closest thing to integration testing without external dependencies.

Create the test fixture FIRST:

```typescript
// src/daemon/mcp/__fixtures__/echo-server.ts
// Tiny MCP server fixture used by mcpClient tests. Exposes one tool 'echo'
// that returns whatever was passed in. Run via: bun run src/daemon/mcp/__fixtures__/echo-server.ts

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const server = new Server({ name: 'echo-test', version: '0.0.1' }, { capabilities: { tools: {} } })

server.setRequestHandler({ method: 'tools/list' } as any, async () => ({
  tools: [{ name: 'echo', description: 'Echo back the input', inputSchema: { type: 'object', properties: { msg: { type: 'string' } } } }],
}))

server.setRequestHandler({ method: 'tools/call' } as any, async (req: any) => {
  const args = req.params?.arguments ?? {}
  return { content: [{ type: 'text', text: JSON.stringify(args) }] }
})

const transport = new StdioServerTransport()
await server.connect(transport)
```

(**Note:** If the SDK 2.x API uses different method-handler patterns — e.g. `server.tool('echo', schema, async (args) => ...)` instead of `setRequestHandler` — adapt the fixture. The test below only cares about the observable behavior.)

Then the test:

```typescript
// src/daemon/mcp/mcpClient.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
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
  let client: McpClient

  afterEach(async () => {
    if (client) await client.disconnect()
  })

  it('connects to a stdio MCP server and lists tools', async () => {
    client = new McpClient(echoServerConfig)
    await client.connect()
    const tools = await client.listTools()
    expect(tools.length).toBeGreaterThan(0)
    expect(tools.find(t => t.name === 'echo')).toBeDefined()
  }, 10_000)

  it('calls a tool and returns the result', async () => {
    client = new McpClient(echoServerConfig)
    await client.connect()
    const result = await client.callTool('echo', { msg: 'hello world' })
    expect(result.ok).toBe(true)
    expect(result.output_text).toContain('hello world')
  }, 10_000)

  it('reports ok=false on tool error', async () => {
    client = new McpClient(echoServerConfig)
    await client.connect()
    const result = await client.callTool('nonexistent_tool', {})
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
  }, 10_000)
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
mkdir -p src/daemon/mcp/__fixtures__
cd /Users/nirmalghinaiya/Desktop/kairos-sandbox
bun test src/daemon/mcp/mcpClient.test.ts
```

Expected: FAIL — `McpClient` not found.

- [ ] **Step 3: Write the implementation**

```typescript
// src/daemon/mcp/mcpClient.ts
// Wraps the official MCP TypeScript SDK as a single-server client.
// One McpClient per connected server; McpHost manages many.
//
// Lifecycle: new → connect() → listTools()/callTool() → disconnect()

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
      // SDK returns content as an array of typed blocks; extract text
      const textBlocks = (resp.content ?? []).filter((b: any) => b.type === 'text')
      const text = textBlocks.map((b: any) => b.text).join('')
      return { ok: !resp.isError, output_text: text, output_structured: resp }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  get id(): string { return this.cfg.id }
}
```

- [ ] **Step 4: Run tests**

```bash
bun test src/daemon/mcp/mcpClient.test.ts
```

Expected: PASS (3 tests). **If the SDK 2.x API has different method names** (e.g., `client.listTools` returns differently, or `callTool` signature differs), adjust the wrapper. The test behavior is what counts — adapt the wrapper to make them green.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/mcp/mcpClient.ts src/daemon/mcp/mcpClient.test.ts src/daemon/mcp/__fixtures__/
git commit -m "feat(mcp): single-server client wrapping @modelcontextprotocol/sdk stdio transport"
```

---

## Task 4: McpHost orchestrator

**Files:**
- Create: `src/daemon/mcp/mcpHost.ts`
- Test:  `src/daemon/mcp/mcpHost.test.ts`

Manages multiple McpClient instances. Loads server configs from a JSON file, resolves auth from keychain, starts enabled servers in parallel, exposes a unified tool list across all servers (namespaced as `serverId::toolName`).

- [ ] **Step 1: Write the failing test**

```typescript
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
  let host: McpHost

  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'kairos-mcphost-')) })
  afterEach(async () => {
    if (host) await host.stopAll()
    rmSync(tmp, { recursive: true })
  })

  it('loads config from disk and starts enabled servers', async () => {
    const configPath = join(tmp, 'mcp-servers.json')
    writeFileSync(configPath, JSON.stringify({
      servers: [
        { id: 'echo-a', enabled: true, transport: 'stdio', command: 'bun', args: echoServerArgs, tier_policy: { default: 'GREEN' } },
        { id: 'echo-b', enabled: false, transport: 'stdio', command: 'bun', args: echoServerArgs, tier_policy: { default: 'GREEN' } },
      ],
    }))
    host = new McpHost({ configPath, keychain: new Keychain({ probe: async () => ({ ok: false, stdout: '', stderr: 'not used' }) }) })
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
    host = new McpHost({ configPath, keychain: new Keychain({ probe: async () => ({ ok: false, stdout: '', stderr: '' }) }) })
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
    host = new McpHost({ configPath, keychain: new Keychain({ probe: async () => ({ ok: false, stdout: '', stderr: '' }) }) })
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
    host = new McpHost({ configPath, keychain: new Keychain({ probe: async () => ({ ok: false, stdout: '', stderr: '' }) }) })
    await host.startAll()
    const result = await host.invokeTool('echo-a::echo', { msg: 'routed' })
    expect(result.ok).toBe(true)
    expect(result.output_text).toContain('routed')
  }, 15_000)

  it('returns error for unknown qualified id', async () => {
    const configPath = join(tmp, 'mcp-servers.json')
    writeFileSync(configPath, JSON.stringify({ servers: [] }))
    host = new McpHost({ configPath, keychain: new Keychain({ probe: async () => ({ ok: false, stdout: '', stderr: '' }) }) })
    await host.startAll()
    const result = await host.invokeTool('nonexistent::tool', {})
    expect(result.ok).toBe(false)
  })

  it('returns empty config when file missing (graceful degrade)', async () => {
    host = new McpHost({ configPath: join(tmp, 'missing.json'), keychain: new Keychain({ probe: async () => ({ ok: false, stdout: '', stderr: '' }) }) })
    await host.startAll()
    expect(host.listServers().length).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/daemon/mcp/mcpHost.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
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
```

- [ ] **Step 4: Run tests**

```bash
bun test src/daemon/mcp/mcpHost.test.ts
```

Expected: PASS (6 tests). These tests actually spawn the echo-server fixture as a subprocess, so they take longer (~5-10s each).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/mcp/mcpHost.ts src/daemon/mcp/mcpHost.test.ts
git commit -m "feat(mcp): McpHost orchestrator (multi-server lifecycle, namespaced tools, keychain auth)"
```

---

## Task 5: MCP tool → Intent registration

**Files:**
- Create: `src/daemon/mcp/toolToIntent.ts`
- Test:  `src/daemon/mcp/toolToIntent.test.ts`
- Modify: `src/daemon/agency/intentRegistry.ts` (no behavior change — verify `register()` accepts dynamic intents)

Bridges MCP tools into the agency layer. Each MCP tool becomes an `Intent` (id = qualified_id, tier = from policy, handler = `mcpHost.invokeTool(qualified, args)`). The handler returns the right shape for `IntentHandler` — `{status, details}`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/daemon/mcp/toolToIntent.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { IntentRegistry } from '../agency/intentRegistry'
import { registerMcpToolsAsIntents } from './toolToIntent'
import type { McpHost } from './mcpHost'
import type { McpToolDescriptor, McpToolCallResult } from './types'

function fakeHost(tools: McpToolDescriptor[], invokeResult: McpToolCallResult): Pick<McpHost, 'listAllTools' | 'invokeTool'> {
  return {
    listAllTools: () => tools,
    invokeTool: async () => invokeResult,
  }
}

describe('registerMcpToolsAsIntents', () => {
  let registry: IntentRegistry

  beforeEach(() => { registry = new IntentRegistry() })

  it('registers each tool as an intent with id = qualified_id', () => {
    const host = fakeHost([
      { server_id: 'a', tool_name: 'echo', qualified_id: 'a::echo', description: 'echo', input_schema: {}, tier: 'GREEN' },
      { server_id: 'b', tool_name: 'send', qualified_id: 'b::send', description: 'send', input_schema: {}, tier: 'ORANGE' },
    ], { ok: true, output_text: 'done' })
    registerMcpToolsAsIntents(registry, host as McpHost)
    expect(registry.get('a::echo')).toBeTruthy()
    expect(registry.get('b::send')).toBeTruthy()
    expect(registry.get('a::echo')?.tier).toBe('GREEN')
    expect(registry.get('b::send')?.tier).toBe('ORANGE')
  })

  it('handler invokes mcpHost.invokeTool and returns success result', async () => {
    const host = fakeHost([
      { server_id: 'a', tool_name: 'echo', qualified_id: 'a::echo', description: 'echo', input_schema: {}, tier: 'GREEN' },
    ], { ok: true, output_text: 'echoed!' })
    registerMcpToolsAsIntents(registry, host as McpHost)
    const entry = registry.get('a::echo')!
    const result = await entry.handler({ msg: 'x' }, {} as any)
    expect(result.status).toBe('success')
    expect(result.details).toContain('echoed!')
  })

  it('handler returns failure on tool error', async () => {
    const host = fakeHost([
      { server_id: 'a', tool_name: 'broken', qualified_id: 'a::broken', description: '', input_schema: {}, tier: 'GREEN' },
    ], { ok: false, error: 'kaboom' })
    registerMcpToolsAsIntents(registry, host as McpHost)
    const entry = registry.get('a::broken')!
    const result = await entry.handler({}, {} as any)
    expect(result.status).toBe('failure')
    expect(result.details).toContain('kaboom')
  })

  it('skips re-registration when called twice (idempotent)', () => {
    const host = fakeHost([
      { server_id: 'a', tool_name: 'echo', qualified_id: 'a::echo', description: '', input_schema: {}, tier: 'GREEN' },
    ], { ok: true })
    registerMcpToolsAsIntents(registry, host as McpHost)
    expect(() => registerMcpToolsAsIntents(registry, host as McpHost)).not.toThrow()
    // Only one registration; second call is a no-op
    expect(registry.list().filter(e => e.id === 'a::echo').length).toBe(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/daemon/mcp/toolToIntent.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Write the implementation**

```typescript
// src/daemon/mcp/toolToIntent.ts
// Bridges MCP tools into the agency layer. Each tool becomes an Intent
// the ActionExecutor can dispatch via registry lookup.
//
// Idempotent: re-registering the same tool is a silent no-op (the
// underlying IntentRegistry throws on duplicate; we guard).

import { log } from '../logger'
import type { IntentRegistry } from '../agency/intentRegistry'
import type { McpHost } from './mcpHost'
import type { McpToolDescriptor } from './types'

export function registerMcpToolsAsIntents(registry: IntentRegistry, host: Pick<McpHost, 'listAllTools' | 'invokeTool'>): void {
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

/**
 * Extract a flat string→'string'/'number'/etc map from a JSON Schema object.
 * Best-effort — full JSON Schema is not modeled; the LLM action composer
 * (C.3) gets the raw schema separately for richer arg synthesis.
 */
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
      out[name] = 'object'   // unknown / array / nested → treat as opaque object
    }
  }
  return out
}
```

- [ ] **Step 4: Run tests**

```bash
bun test src/daemon/mcp/toolToIntent.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/mcp/toolToIntent.ts src/daemon/mcp/toolToIntent.test.ts
git commit -m "feat(mcp): register MCP tools as Intent entries with structural tier assignment"
```

---

## Task 6: Smithery CLI wrapper

**Files:**
- Create: `src/daemon/mcp/smithery.ts`
- Test:  `src/daemon/mcp/smithery.test.ts`

Shell-wraps the Smithery CLI (`@smithery/cli`) for `search` (catalog query) and `add` (install). If `smithery` is not on PATH, methods gracefully return empty/no-op so KAIROS doesn't crash. C.3 will compose this into dynamic install-on-need.

- [ ] **Step 1: Write the failing test**

```typescript
// src/daemon/mcp/smithery.test.ts
import { describe, it, expect } from 'bun:test'
import { SmitheryCli } from './smithery'

describe('SmitheryCli', () => {
  it('isAvailable() returns false when smithery is not installed', async () => {
    const cli = new SmitheryCli({
      probe: async () => ({ ok: false, stdout: '', stderr: 'command not found' }),
    })
    expect(await cli.isAvailable()).toBe(false)
  })

  it('isAvailable() returns true when smithery --version succeeds', async () => {
    const cli = new SmitheryCli({
      probe: async () => ({ ok: true, stdout: '1.2.3', stderr: '' }),
    })
    expect(await cli.isAvailable()).toBe(true)
  })

  it('search() parses JSON output into SmitherySearchHit array', async () => {
    const cli = new SmitheryCli({
      probe: async () => ({
        ok: true,
        stdout: JSON.stringify([
          { qualifiedName: 'github', name: 'github', description: 'GitHub MCP server', installCount: 5000, url: 'https://server.smithery.ai/github' },
          { qualifiedName: 'slack', name: 'slack', description: 'Slack', installCount: 3000, url: 'https://server.smithery.ai/slack' },
        ]),
        stderr: '',
      }),
    })
    const hits = await cli.search('messaging')
    expect(hits.length).toBe(2)
    expect(hits[0]?.qualified_name).toBe('github')
    expect(hits[0]?.install_count).toBe(5000)
  })

  it('search() returns empty array on parse error / smithery error', async () => {
    const cli = new SmitheryCli({
      probe: async () => ({ ok: true, stdout: 'not json', stderr: '' }),
    })
    expect(await cli.search('x')).toEqual([])
  })

  it('add() returns success/failure based on probe result', async () => {
    const ok = new SmitheryCli({ probe: async () => ({ ok: true, stdout: 'installed', stderr: '' }) })
    expect((await ok.add('github')).ok).toBe(true)
    const fail = new SmitheryCli({ probe: async () => ({ ok: false, stdout: '', stderr: 'auth required' }) })
    const r = await fail.add('github')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('auth required')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/daemon/mcp/smithery.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Write the implementation**

```typescript
// src/daemon/mcp/smithery.ts
// Shell wrapper for @smithery/cli. Used for dynamic MCP server
// discovery + install. Gracefully degrades if smithery is not on PATH.
//
// C.2 ships the wrapper. C.3's Magentic-One orchestrator composes
// install-on-need (search + add + restart McpHost) as a plan step.

import { logError } from '../logger'
import type { SmitherySearchHit } from './types'

type ProbeResult = { ok: boolean; stdout: string; stderr: string }
type Probe = (cmd: string[]) => Promise<ProbeResult>

export type SmitheryCliOptions = {
  probe?: Probe
}

export class SmitheryCli {
  private probe: Probe

  constructor(opts?: SmitheryCliOptions) {
    this.probe = opts?.probe ?? defaultProbe
  }

  async isAvailable(): Promise<boolean> {
    const r = await this.probe(['smithery', '--version'])
    return r.ok
  }

  /** Search the public Smithery catalog. Returns [] on error. */
  async search(query: string): Promise<SmitherySearchHit[]> {
    const r = await this.probe(['smithery', 'mcp', 'search', query, '--json'])
    if (!r.ok) return []
    try {
      const items = JSON.parse(r.stdout) as Array<{
        qualifiedName?: string; name?: string; description?: string;
        installCount?: number; url?: string
      }>
      return items.map(i => ({
        name: i.name ?? '',
        qualified_name: i.qualifiedName ?? i.name ?? '',
        description: i.description ?? '',
        install_count: i.installCount,
        url: i.url ?? '',
      }))
    } catch (err) {
      logError('SmitheryCli: search parse failed', err)
      return []
    }
  }

  /** Install an MCP server by qualified name or URL. */
  async add(target: string): Promise<{ ok: boolean; error?: string }> {
    const r = await this.probe(['smithery', 'mcp', 'add', target])
    if (!r.ok) return { ok: false, error: r.stderr.trim() || 'unknown' }
    return { ok: true }
  }
}

async function defaultProbe(cmd: string[]): Promise<ProbeResult> {
  try {
    const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' })
    const code = await proc.exited
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    return { ok: code === 0, stdout, stderr }
  } catch (err) {
    return { ok: false, stdout: '', stderr: err instanceof Error ? err.message : String(err) }
  }
}
```

- [ ] **Step 4: Run tests**

```bash
bun test src/daemon/mcp/smithery.test.ts
```

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/mcp/smithery.ts src/daemon/mcp/smithery.test.ts
git commit -m "feat(mcp): Smithery CLI wrapper (search, add, isAvailable graceful degrade)"
```

---

## Task 7: agentskills.io SKILL.md loader

**Files:**
- Create: `src/daemon/mcp/skillLoader.ts`
- Test:  `src/daemon/mcp/skillLoader.test.ts`

Adopts the agentskills.io standard for KAIROS-authored skills. Each skill = a directory with `SKILL.md` (YAML frontmatter + body) + optional `scripts/`. Progressive disclosure: registry list shows only `name + description`; full body loaded on activation.

For C.2 we ship the LOADER. Registering loaded skills as Intents follows the same path as MCP tools (Task 5) — handler runs the bundled scripts or returns the body to be passed back through action_compose (C.3).

- [ ] **Step 1: Write the failing test**

```typescript
// src/daemon/mcp/skillLoader.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SkillLoader } from './skillLoader'

describe('SkillLoader', () => {
  let tmp: string
  let loader: SkillLoader

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kairos-skill-'))
    loader = new SkillLoader(tmp)
  })

  function writeSkill(name: string, frontmatter: Record<string, string>, body: string) {
    const dir = join(tmp, name)
    mkdirSync(dir, { recursive: true })
    const fm = Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`).join('\n')
    writeFileSync(join(dir, 'SKILL.md'), `---\n${fm}\n---\n\n${body}`)
  }

  it('lists skills with name+description (progressive disclosure)', () => {
    writeSkill('draft-reply', { name: 'draft-reply', description: 'Draft a reply to a Slack message' }, 'Body content here.')
    writeSkill('summarize', { name: 'summarize', description: 'Summarize a long thread' }, 'Body.')
    const summaries = loader.listSummaries()
    expect(summaries.length).toBe(2)
    expect(summaries.find(s => s.name === 'draft-reply')?.description).toContain('Draft a reply')
    rmSync(tmp, { recursive: true })
  })

  it('load() returns full manifest + body', () => {
    writeSkill('x', { name: 'x', description: 'd', version: '1.0.0', tier: 'YELLOW' }, '# Body\n\nDetails.')
    const skill = loader.load('x')
    expect(skill?.manifest.name).toBe('x')
    expect(skill?.manifest.version).toBe('1.0.0')
    expect(skill?.manifest.tier).toBe('YELLOW')
    expect(skill?.body).toContain('# Body')
    rmSync(tmp, { recursive: true })
  })

  it('load() returns null when SKILL.md is missing', () => {
    mkdirSync(join(tmp, 'empty-dir'), { recursive: true })
    expect(loader.load('empty-dir')).toBeNull()
    rmSync(tmp, { recursive: true })
  })

  it('load() ignores invalid frontmatter and returns null', () => {
    const dir = join(tmp, 'bad')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), 'no frontmatter here, just body')
    expect(loader.load('bad')).toBeNull()
    rmSync(tmp, { recursive: true })
  })

  it('lists script files when scripts/ subdir exists', () => {
    writeSkill('with-scripts', { name: 'with-scripts', description: 'd' }, 'body')
    const dir = join(tmp, 'with-scripts')
    mkdirSync(join(dir, 'scripts'))
    writeFileSync(join(dir, 'scripts', 'do.sh'), '#!/bin/bash\necho hi')
    const skill = loader.load('with-scripts')
    expect(skill?.scripts?.length).toBe(1)
    expect(skill?.scripts?.[0]).toContain('do.sh')
    rmSync(tmp, { recursive: true })
  })

  it('returns empty list when skills root does not exist', () => {
    const missing = new SkillLoader(join(tmp, 'nope'))
    expect(missing.listSummaries()).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/daemon/mcp/skillLoader.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Write the implementation**

```typescript
// src/daemon/mcp/skillLoader.ts
// agentskills.io SKILL.md loader. Each skill = a directory with
// SKILL.md (YAML frontmatter + markdown body) + optional scripts/.
// Progressive disclosure: listSummaries() reads frontmatter only;
// load() reads full content + script list.
//
// Spec: https://agentskills.io

import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import type { SkillManifest, LoadedSkill } from './types'
import type { AutonomyTier } from '../agency/types'

export type SkillSummary = {
  name: string
  description: string
  version?: string
}

export class SkillLoader {
  constructor(private root: string) {}

  /** List skills with frontmatter only — cheap, used at registry list time. */
  listSummaries(): SkillSummary[] {
    if (!existsSync(this.root)) return []
    const entries = readdirSync(this.root)
    const out: SkillSummary[] = []
    for (const entry of entries) {
      const dir = join(this.root, entry)
      if (!statSync(dir).isDirectory()) continue
      const manifest = this.readFrontmatter(dir)
      if (manifest) {
        out.push({ name: manifest.name, description: manifest.description, version: manifest.version })
      }
    }
    return out
  }

  /** Load a single skill — full body + scripts list. */
  load(name: string): LoadedSkill | null {
    const dir = join(this.root, name)
    if (!existsSync(dir)) return null
    const skillFile = join(dir, 'SKILL.md')
    if (!existsSync(skillFile)) return null

    const content = readFileSync(skillFile, 'utf8')
    const parsed = parseFrontmatter(content)
    if (!parsed) return null

    const manifest: SkillManifest = {
      name: parsed.fm.name ?? name,
      description: parsed.fm.description ?? '',
      version: parsed.fm.version,
      tier: parsed.fm.tier as AutonomyTier | undefined,
      trigger_pattern: parsed.fm.trigger_pattern,
    }
    if (!manifest.name || !manifest.description) return null

    const scriptsDir = join(dir, 'scripts')
    const scripts: string[] = existsSync(scriptsDir)
      ? readdirSync(scriptsDir).map(f => join(scriptsDir, f))
      : []

    return { manifest, body: parsed.body, dir, scripts: scripts.length > 0 ? scripts : undefined }
  }

  private readFrontmatter(dir: string): SkillManifest | null {
    const skillFile = join(dir, 'SKILL.md')
    if (!existsSync(skillFile)) return null
    const content = readFileSync(skillFile, 'utf8')
    const parsed = parseFrontmatter(content)
    if (!parsed) return null
    if (!parsed.fm.name || !parsed.fm.description) return null
    return {
      name: parsed.fm.name,
      description: parsed.fm.description,
      version: parsed.fm.version,
      tier: parsed.fm.tier as AutonomyTier | undefined,
      trigger_pattern: parsed.fm.trigger_pattern,
    }
  }
}

function parseFrontmatter(text: string): { fm: Record<string, string>; body: string } | null {
  const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/)
  if (!match) return null
  const fmRaw = match[1]!
  const body = match[2] ?? ''
  const fm: Record<string, string> = {}
  for (const line of fmRaw.split('\n')) {
    const kv = line.match(/^([\w_]+)\s*:\s*(.+?)\s*$/)
    if (kv) fm[kv[1]!] = kv[2]!.replace(/^['"]|['"]$/g, '')
  }
  return { fm, body }
}
```

- [ ] **Step 4: Run tests**

```bash
bun test src/daemon/mcp/skillLoader.test.ts
```

Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/mcp/skillLoader.ts src/daemon/mcp/skillLoader.test.ts
git commit -m "feat(mcp): agentskills.io SKILL.md loader (progressive disclosure)"
```

---

## Task 8: Bespoke .mcpb bundle — macOS Reminders

**Files:**
- Create: `connectors/macos-reminders/manifest.json`
- Create: `connectors/macos-reminders/server/index.ts`
- Create: `connectors/macos-reminders/server/reminders.ts`
- Create: `connectors/macos-reminders/README.md`
- Test:  `connectors/macos-reminders/server/reminders.test.ts`

Bundle one bespoke macOS connector as an MCP server. Proves the `.mcpb` path works and gives KAIROS a non-third-party tool from day one. Tools: `list_reminders`, `add_reminder`, `complete_reminder`. (No `delete_reminder` for safety — that'd be RED tier.)

- [ ] **Step 1: Write the failing test for AppleScript wrapper**

```typescript
// connectors/macos-reminders/server/reminders.test.ts
import { describe, it, expect } from 'bun:test'
import { listReminders, addReminder, completeReminder } from './reminders'

describe('macOS reminders (via osascript)', () => {
  it('listReminders calls osascript and parses output', async () => {
    let cmd: string[] = []
    const result = await listReminders({
      probe: async (c) => { cmd = c; return { ok: true, stdout: 'Buy milk||2026-05-26\nCall mom||(no date)', stderr: '' } },
    })
    expect(cmd[0]).toBe('osascript')
    expect(result.length).toBe(2)
    expect(result[0]?.title).toBe('Buy milk')
    expect(result[0]?.due).toBe('2026-05-26')
    expect(result[1]?.due).toBeNull()
  })

  it('addReminder builds correct AppleScript with title only', async () => {
    let cmd: string[] = []
    await addReminder('Drink water', null, { probe: async (c) => { cmd = c; return { ok: true, stdout: '', stderr: '' } } })
    expect(cmd.join(' ')).toContain('make new reminder')
    expect(cmd.join(' ')).toContain('Drink water')
  })

  it('addReminder with due date includes the date in script', async () => {
    let cmd: string[] = []
    await addReminder('Standup', '2026-05-26T09:00:00Z', { probe: async (c) => { cmd = c; return { ok: true, stdout: '', stderr: '' } } })
    expect(cmd.join(' ')).toContain('2026')
  })

  it('completeReminder finds by title and marks completed', async () => {
    let cmd: string[] = []
    await completeReminder('Buy milk', { probe: async (c) => { cmd = c; return { ok: true, stdout: '', stderr: '' } } })
    expect(cmd.join(' ')).toContain('completed')
    expect(cmd.join(' ')).toContain('Buy milk')
  })
})
```

- [ ] **Step 2: Write reminders.ts AppleScript wrapper**

```typescript
// connectors/macos-reminders/server/reminders.ts
// AppleScript wrappers for the macOS Reminders.app.
// No third-party API; works on any Mac with Reminders enabled.

type ProbeResult = { ok: boolean; stdout: string; stderr: string }
type Probe = (cmd: string[]) => Promise<ProbeResult>

export type ReminderItem = {
  title: string
  due: string | null
}

const defaultProbe: Probe = async (cmd) => {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' })
  const code = await proc.exited
  return {
    ok: code === 0,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  }
}

const escapeAppleScript = (s: string) => s.replace(/"/g, '\\"')

export async function listReminders(opts: { probe?: Probe } = {}): Promise<ReminderItem[]> {
  const probe = opts.probe ?? defaultProbe
  const script = `
    tell application "Reminders"
      set output to ""
      repeat with r in reminders of default list whose completed is false
        try
          set d to short date string of (due date of r)
        on error
          set d to "(no date)"
        end try
        set output to output & (name of r) & "||" & d & "\n"
      end repeat
      return output
    end tell
  `
  const result = await probe(['osascript', '-e', script])
  if (!result.ok) return []
  return result.stdout
    .split('\n')
    .filter(l => l.includes('||'))
    .map(l => {
      const [title, due] = l.split('||').map(s => s.trim())
      return { title: title!, due: due === '(no date)' ? null : due! }
    })
}

export async function addReminder(title: string, dueIso: string | null, opts: { probe?: Probe } = {}): Promise<void> {
  const probe = opts.probe ?? defaultProbe
  const dueClause = dueIso ? `, due date:(date "${dueIso}")` : ''
  const script = `
    tell application "Reminders"
      tell default list
        make new reminder with properties {name:"${escapeAppleScript(title)}"${dueClause}}
      end tell
    end tell
  `
  const result = await probe(['osascript', '-e', script])
  if (!result.ok) throw new Error(`addReminder failed: ${result.stderr.slice(0, 200)}`)
}

export async function completeReminder(title: string, opts: { probe?: Probe } = {}): Promise<void> {
  const probe = opts.probe ?? defaultProbe
  const script = `
    tell application "Reminders"
      set found to (reminders of default list whose name is "${escapeAppleScript(title)}")
      if (count of found) > 0 then
        set completed of item 1 of found to true
      end if
    end tell
  `
  const result = await probe(['osascript', '-e', script])
  if (!result.ok) throw new Error(`completeReminder failed: ${result.stderr.slice(0, 200)}`)
}
```

- [ ] **Step 3: Run wrapper tests**

```bash
cd /Users/nirmalghinaiya/Desktop/kairos-sandbox
mkdir -p connectors/macos-reminders/server
bun test connectors/macos-reminders/server/reminders.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 4: Write the MCP server entry**

```typescript
// connectors/macos-reminders/server/index.ts
// Bespoke MCP server for macOS Reminders. Standalone — runs as a
// stdio child process spawned by KAIROS's McpHost.
//
// Run directly: bun run connectors/macos-reminders/server/index.ts

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { listReminders, addReminder, completeReminder } from './reminders'

const server = new Server(
  { name: 'macos-reminders', version: '0.1.0' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler({ method: 'tools/list' } as any, async () => ({
  tools: [
    {
      name: 'list_reminders',
      description: 'List incomplete reminders from the default Reminders list',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'add_reminder',
      description: 'Add a new reminder to the default list',
      inputSchema: {
        type: 'object',
        required: ['title'],
        properties: {
          title: { type: 'string' },
          due_iso: { type: 'string', description: 'Optional ISO 8601 due date' },
        },
      },
    },
    {
      name: 'complete_reminder',
      description: 'Mark a reminder as completed by title (first match)',
      inputSchema: {
        type: 'object',
        required: ['title'],
        properties: { title: { type: 'string' } },
      },
    },
  ],
}))

server.setRequestHandler({ method: 'tools/call' } as any, async (req: any) => {
  const name = req.params?.name
  const args = req.params?.arguments ?? {}
  try {
    if (name === 'list_reminders') {
      const items = await listReminders()
      return { content: [{ type: 'text', text: JSON.stringify(items, null, 2) }] }
    }
    if (name === 'add_reminder') {
      await addReminder(args.title, args.due_iso ?? null)
      return { content: [{ type: 'text', text: `Added: ${args.title}` }] }
    }
    if (name === 'complete_reminder') {
      await completeReminder(args.title)
      return { content: [{ type: 'text', text: `Completed: ${args.title}` }] }
    }
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
  } catch (err) {
    return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true }
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)
```

- [ ] **Step 5: Write manifest.json (.mcpb spec)**

```json
{
  "dxt_version": "0.1",
  "name": "macos-reminders",
  "display_name": "macOS Reminders",
  "version": "0.1.0",
  "description": "List, add, and complete reminders in the default macOS Reminders list",
  "author": { "name": "KAIROS" },
  "server": {
    "type": "node",
    "entry_point": "server/index.ts"
  },
  "tools": [
    { "name": "list_reminders", "description": "List incomplete reminders" },
    { "name": "add_reminder", "description": "Add a new reminder" },
    { "name": "complete_reminder", "description": "Mark a reminder completed" }
  ]
}
```

- [ ] **Step 6: Write README**

```markdown
# macos-reminders connector

Bespoke MCP server exposing macOS Reminders to KAIROS.

## Tools

- `list_reminders` — list all incomplete reminders in the default list (🟢 GREEN)
- `add_reminder` — add a new reminder, optionally with an ISO due date (🟡 YELLOW)
- `complete_reminder` — mark a reminder by title as completed (🟠 ORANGE — requires approval)

## Running standalone

```bash
bun run server/index.ts
```

(Then talk MCP JSON-RPC over stdio.)

## Wiring into KAIROS

Add to `~/.kairos/mcp-servers.json`:

```json
{
  "id": "macos-reminders",
  "enabled": true,
  "transport": "stdio",
  "command": "bun",
  "args": ["run", "/Users/<you>/Desktop/kairos-sandbox/connectors/macos-reminders/server/index.ts"],
  "tier_policy": {
    "default": "YELLOW",
    "overrides": {
      "list_reminders": "GREEN",
      "complete_reminder": "ORANGE"
    }
  }
}
```

Then restart the daemon.
```

- [ ] **Step 7: Commit**

```bash
git add connectors/macos-reminders/
git commit -m "feat(connectors): bespoke macos-reminders MCP server (list/add/complete via AppleScript)"
```

---

## Task 9: Daemon wire-up

**Files:**
- Modify: `src/daemon/index.ts`
- Modify: `src/daemon/types.ts` (add `mcp` config block)
- Modify: `src/daemon/config.ts` (defaults)

- [ ] **Step 1: Read current state**

```bash
sed -n '1,40p' /Users/nirmalghinaiya/Desktop/kairos-sandbox/src/daemon/types.ts
grep -n "config\.agency\|agencyStop\|registry" /Users/nirmalghinaiya/Desktop/kairos-sandbox/src/daemon/index.ts | head -15
```

- [ ] **Step 2: Add `mcp` block to Config**

In `types.ts`:
```typescript
mcp: {
  enabled: boolean
  configPath: string
  skillsRoot: string
}
```

In `config.ts` defaults:
```typescript
mcp: {
  enabled: true,
  configPath: join(process.env.HOME ?? '', '.kairos', 'mcp-servers.json'),
  skillsRoot: join(process.env.HOME ?? '', '.kairos', 'skills'),
},
```

- [ ] **Step 3: Wire MCP host into index.ts**

Inside the existing `if (config.proactive.enabled)` block (where `intentRegistry` is created in C.1 wire-up), add AFTER `registerBuiltIns(intentRegistry)`:

```typescript
// ─── MCP host (Phase C.2) ─────────────────────────
let mcpStop: (() => Promise<void>) | null = null
if (config.mcp.enabled) {
  const { McpHost } = await import('./mcp/mcpHost')
  const { Keychain } = await import('./mcp/keychain')
  const { registerMcpToolsAsIntents } = await import('./mcp/toolToIntent')
  const { SkillLoader } = await import('./mcp/skillLoader')

  const keychain = new Keychain()
  const mcpHost = new McpHost({ configPath: config.mcp.configPath, keychain })
  await mcpHost.startAll()
  registerMcpToolsAsIntents(intentRegistry, mcpHost)

  const skillLoader = new SkillLoader(config.mcp.skillsRoot)
  const skillCount = skillLoader.listSummaries().length
  if (skillCount > 0) log(`SkillLoader: ${skillCount} agentskills.io skill(s) available at ${config.mcp.skillsRoot}`)

  log(`MCP host active: ${mcpHost.listServers().length} server(s), ${mcpHost.listAllTools().length} tool(s) registered as intents`)

  mcpStop = async () => { await mcpHost.stopAll() }
}
```

In the existing shutdown handler (in `memoryStop` chain):
```typescript
if (mcpStop) await mcpStop()
```

**IMPORTANT**: the dynamic imports (`await import('./mcp/...')`) keep startup fast when `mcp.enabled=false` — the SDK isn't loaded unless needed.

- [ ] **Step 4: Type-check + full test suite**

```bash
cd /Users/nirmalghinaiya/Desktop/kairos-sandbox
bunx tsc --noEmit 2>&1 | grep -vE "(pre-existing|server\.ts|db\.ts|environmentScanner|shim/lifecycle)" | head -15
bun test 2>&1 | tail -10
```

Expected: no new errors in modified files. All tests pass (~190 total: A 59 + B 60 + C.1 45 + C.2 ~26).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/index.ts src/daemon/types.ts src/daemon/config.ts
git commit -m "feat(daemon): wire MCP host + SkillLoader into startup (dynamic import for cold-start speed)"
```

---

## Task 10: Phase C.2 validation gate

**Files:**
- Create: `scripts/validate-phase-c2.ts`

Per Section 8.5. Five scripted scenarios end-to-end:
1. Echo MCP server (fixture) starts via McpHost → 1 tool registered as Intent
2. Invoke `echo-test::echo` via ActionExecutor → success, args echoed back
3. Reminders bundle starts → 3 tools registered (`list_reminders` GREEN, `add_reminder` YELLOW, `complete_reminder` ORANGE)
4. Add a real reminder via Intent → AppleScript executes → verify in Reminders.app (user manual confirm)
5. Smithery `--version` graceful degrade — script reports availability

- [ ] **Step 1: Write the script**

```typescript
// scripts/validate-phase-c2.ts
// Phase C.2 validation per Section 8.5 — 5 scenarios for MCP host + agency integration.
//
// Usage: bun run scripts/validate-phase-c2.ts
// Cost: $0 — no LLM calls.

import { Database } from 'bun:sqlite'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { McpHost } from '../src/daemon/mcp/mcpHost'
import { Keychain } from '../src/daemon/mcp/keychain'
import { SmitheryCli } from '../src/daemon/mcp/smithery'
import { registerMcpToolsAsIntents } from '../src/daemon/mcp/toolToIntent'
import { IntentRegistry, registerBuiltIns } from '../src/daemon/agency/intentRegistry'
import { TrajectoryLog, TRAJECTORY_SCHEMA } from '../src/daemon/agency/trajectoryLog'
import { InboxSurface } from '../src/daemon/agency/inboxSurface'
import { NativeNotifier } from '../src/daemon/agency/nativeNotifier'
import { ActionExecutor, EXECUTOR_SCHEMA } from '../src/daemon/agency/actionExecutor'

const db = new Database(':memory:')
db.exec(TRAJECTORY_SCHEMA)
db.exec(EXECUTOR_SCHEMA)
db.exec(`CREATE TABLE IF NOT EXISTS agency_inbox_items (
  item_id TEXT PRIMARY KEY, created_at INTEGER, tier TEXT, intent_id TEXT,
  description TEXT, args_preview TEXT, expires_at INTEGER, resolved_at INTEGER, resolution TEXT
)`)

const tmp = mkdtempSync(join(tmpdir(), 'kairos-c2-validate-'))
const echoFixture = join(import.meta.dir, '..', 'src', 'daemon', 'mcp', '__fixtures__', 'echo-server.ts')
const remindersServer = join(import.meta.dir, '..', 'connectors', 'macos-reminders', 'server', 'index.ts')

const configPath = join(tmp, 'mcp-servers.json')
writeFileSync(configPath, JSON.stringify({
  servers: [
    { id: 'echo-test', enabled: true, transport: 'stdio', command: 'bun', args: ['run', echoFixture],
      tier_policy: { default: 'GREEN' } },
    { id: 'macos-reminders', enabled: true, transport: 'stdio', command: 'bun', args: ['run', remindersServer],
      tier_policy: { default: 'YELLOW',
        overrides: { list_reminders: 'GREEN', add_reminder: 'YELLOW', complete_reminder: 'ORANGE' } } },
  ],
}))

const registry = new IntentRegistry()
registerBuiltIns(registry)
const traj = new TrajectoryLog(db)
const inbox = new InboxSurface(db, join(tmp, 'inbox.md'))
const notifier = new NativeNotifier({ probe: async () => { /* swallow */ } })

console.log('─── Phase C.2 Validation — 5 Scenarios ───\n')

// SCENARIO 1: Echo server starts + 1 tool registered
console.log('Scenario 1: Echo MCP server starts → tool registered as Intent')
const keychain = new Keychain()
const host = new McpHost({ configPath, keychain })
await host.startAll()
registerMcpToolsAsIntents(registry, host)
const echoIntent = registry.get('echo-test::echo')
console.log(`  echo-test server connected: ${host.listServers().some(s => s.id === 'echo-test')}`)
console.log(`  echo-test::echo intent registered: ${echoIntent !== null}`)
console.log(`  Tier (default GREEN): ${echoIntent?.tier}\n`)

// SCENARIO 2: Invoke echo via ActionExecutor → success
console.log('Scenario 2: Invoke echo-test::echo via ActionExecutor')
const executor = new ActionExecutor(db, registry, traj, inbox, {
  db, notifier, embedder: { embed: async () => new Array(768).fill(0) } as any,
  semantic: { reinforceOrWrite: () => 1 } as any,
})
const echoResult = await executor.dispatch({
  request_id: randomUUID(), intent_id: 'echo-test::echo',
  args: { msg: 'C.2 validation alive' },
  reasoning: 'validation scenario 2', requested_at: Date.now(),
})
console.log(`  Status: ${echoResult.status}`)
console.log(`  Details: ${echoResult.details?.slice(0, 100)}\n`)

// SCENARIO 3: Reminders bundle starts → 3 tools registered with correct tiers
console.log('Scenario 3: macos-reminders bundle → 3 tools, correct tier assignment')
const reminderTools = host.listAllTools().filter(t => t.server_id === 'macos-reminders')
console.log(`  Tools discovered: ${reminderTools.length}`)
for (const t of reminderTools) {
  console.log(`    ${t.qualified_id} → ${t.tier}`)
}

// SCENARIO 4: Add a real reminder via Intent (USER CONFIRMS in Reminders.app)
console.log('\nScenario 4: 🟡 add_reminder via Intent (check Reminders.app after run)')
const addResult = await executor.dispatch({
  request_id: randomUUID(), intent_id: 'macos-reminders::add_reminder',
  args: { title: `KAIROS C.2 test — ${new Date().toISOString().slice(0, 19)}` },
  reasoning: 'validation scenario 4', requested_at: Date.now(),
})
console.log(`  Status: ${addResult.status}`)
console.log(`  Open Reminders.app — you should see a new item titled "KAIROS C.2 test — ..."`)

// SCENARIO 5: Smithery availability
console.log('\nScenario 5: Smithery CLI availability check')
const smithery = new SmitheryCli()
const available = await smithery.isAvailable()
console.log(`  smithery CLI on PATH: ${available ? 'YES' : 'NO (gracefully degraded)'}`)
if (available) {
  const hits = await smithery.search('github')
  console.log(`  Search "github": ${hits.length} hits (top: ${hits[0]?.qualified_name ?? 'none'})`)
}

// Cleanup
await host.stopAll()
rmSync(tmp, { recursive: true })

console.log('\n─── Done ───')
console.log('PASS criteria (human review):')
console.log('  • Scenario 1: echo server reaches ready state, intent registered')
console.log('  • Scenario 2: dispatch returns completed, output contains "C.2 validation alive"')
console.log('  • Scenario 3: 3 tools registered with correct tiers (list=GREEN, add=YELLOW, complete=ORANGE)')
console.log('  • Scenario 4: open Reminders.app — new "KAIROS C.2 test ..." reminder visible')
console.log('  • Scenario 5: smithery either present + works, or graceful "NO" — no crash')
```

- [ ] **Step 2: Type-check**

```bash
cd /Users/nirmalghinaiya/Desktop/kairos-sandbox
bunx tsc --noEmit scripts/validate-phase-c2.ts 2>&1 | head -10
```

Expected: no errors in this file.

- [ ] **Step 3: Commit**

```bash
git add scripts/validate-phase-c2.ts
git commit -m "test(phase-c2): 5-scenario validation gate per Section 8.5"
```

- [ ] **Step 4: User runs validation**

```bash
bun run scripts/validate-phase-c2.ts
```

User opens Reminders.app to confirm scenario 4. Pastes output for CHANGELOG update.

- [ ] **Step 5: Tag**

```bash
git tag v0.3.1-phase-c2
git push origin main --tags
```

---

## Self-review

**Spec coverage:**
- ✅ MCP host runtime (Section 8.4.8 #1 + Phase C bet-big extensions) → Tasks 3 (client), 4 (host), 5 (intent bridge), 9 (wire-up)
- ✅ Smithery CLI integration → Task 6
- ✅ agentskills.io skill format → Task 7
- ✅ Bespoke .mcpb bundle for macOS → Task 8 (reminders)
- ✅ Keychain auth → Task 2
- ⏭️ Dynamic install-on-need during trigger fire → deferred to C.3 (composes with Magentic-One orchestrator)
- ⏭️ Multi-step planning + orchestrator → C.3
- ⏭️ AWM crystallizer → C.3

**Placeholder scan:** none found. Every task has actual code, exact paths, exact commands. Test fixtures specified.

**Type consistency:** `McpServerConfig` shape consistent across types/client/host. `McpToolDescriptor.qualified_id` used as Intent.id throughout. `SkillManifest` matches both loader output + future Intent registration path. `Keychain` interface stable for the `auth_keychain` config consumer.

**Risks flagged:**
- SDK 2.x API may differ from the 1.0.4 shape this plan assumes — Task 0 verifies + Task 3/Task 8 may need adaptation. Tests express observable behavior so they remain valid even after wrapper changes.
- macOS Reminders permission prompt fires on first AppleScript call — user must approve once in System Settings → Privacy → Reminders → Bun terminal.
- Task 9 dynamic imports require Bun's ESM resolver to handle `'./mcp/mcpHost'` paths cleanly — confirmed working in the C.1 daemon wire-up pattern.

---

## Execution Handoff

Plan saved to `docs/superpowers/plans/2026-05-25-phase-c2-mcp-runtime.md`.

After C.2 ships (`v0.3.1-phase-c2`), we plan C.3 (Magentic-One orchestrator + smolagents CodeAgent + AWM crystallizer). Each sub-phase tags independently per Section 8.5.

**Two execution options:**
1. **Subagent-Driven (recommended)** — fresh implementer per task + reviewer. ~3 hours wall time, same pattern that shipped C.1.
2. **Inline Execution** — slower but visible per step.
