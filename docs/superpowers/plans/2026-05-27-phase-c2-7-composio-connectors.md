# Phase C.2.7 — Composio Connectors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make all 500+ Composio integrations (Slack, Gmail, Notion, Linear, GitHub, etc.) available to KAIROS via a single `COMPOSIO_API_KEY`. Users connect their personal accounts with a 3-click OAuth flow; KAIROS's agency layer can then invoke those services' tools directly via Composio's hosted MCP server. NO BYOC — Composio's managed OAuth apps are used for every integration.

**SCOPE: Reactive Only (v1).** C.2.7 ships REACTIVE remote integration only — the agent can ACT on remote services when asked. PROACTIVE remote monitoring (e.g., "tell me when Mark Cuban emails") is explicitly DEFERRED to a future phase (provisionally C.2.8 "Proactive Remote Monitoring + Cloud Relay") because it requires KAIROS Cloud infrastructure to route per-user trigger events without leaking events between tenants at scale. KAIROS's existing LOCAL proactivity (clipboard, file events, focus app, calendar, Hermes Dreaming, STANDING_ORDERS triggers — all from Phases A/B/C.1/C.1.5) continues to work unchanged.

**What ships in C.2.7 (Path 3 scope):**
- ✓ All 500+ Composio integrations available as MCP tools for the agent
- ✓ Connection flow: voice-first auth (auto-open browser, Earned Interrupt restraint) for explicit "connect X" and in-chat-auth meta-tool triggered flows
- ✓ Disconnect intent + token expiry polling
- ✓ Session resume on daemon restart

**What is explicitly NOT in C.2.7 (deferred to C.2.8):**
- ✗ `composio.triggers.subscribe()` / Pusher WebSocket listener
- ✗ MonitoringRuleStore + "tell me when X happens" voice intents
- ✗ TriggerRouter (incoming event → rule matching → notification)
- ✗ KAIROS Cloud trigger relay (multi-user routing)
- ✗ Remote event monitoring of any kind

**Architecture:** Composio is wired in as ONE new MCP server config in `~/.kairos/mcp-servers.json` (`id: 'composio'`). KAIROS's existing `McpHost` (built in C.2) handles tool registration and routing — Composio's tools auto-register as agency intents via the existing `toolToIntent` pipeline. The new code surfaces are: (a) **ConnectionFlow** that drives Composio's `session.authorize()` + reuses `OAuthCallbackHandler` from C.2.5 to capture the OAuth redirect on localhost, (b) **ComposioSessionManager** that creates/resumes a ToolRouter session and exposes its MCP URL dynamically, (c) **HttpMcpClient** because the existing `McpClient` only speaks stdio — Composio's MCP is HTTP/SSE, (d) **ConnectionStore** persists per-user toolkit→connection_id mappings in SQLite, (e) **TokenExpiryPoller** polls `connectedAccounts.list()` every 5 minutes and surfaces "reconnect needed" events, (f) **connect_service / disconnect_service intents** wire the flows into the agency layer.

**Tech Stack additions:**
- `@composio/core@^1.x` (TypeScript SDK)
- The Composio MCP endpoint speaks the 2025-03-26 MCP spec via Streamable HTTP transport
- Reuses existing `OAuthCallbackHandler` (C.2.5), `McpHost` (C.2), `Keychain` (C.2), `IntentRegistry` (C.1)

**Critical API guidance (verified from Composio docs + GitHub repos, 2026-05-27):**

| Use this API | NOT this API |
|---|---|
| `composio.connectedAccounts.link(userId, authConfigId, { callbackUrl })` — POSITIONAL args | ~~`composio.connectedAccounts.initiate(...)`~~ — deprecated for new orgs since 2026-05-08, all orgs from 2026-07-03; also: `link()` takes positional args, NOT an options object |
| `composio.create(userId, { toolkits, manageConnections: true, workbench: { enable: false } })` | `composio.create()` WITHOUT `workbench: { enable: false }` — defaults to spawning a Python sandbox + exposing `COMPOSIO_REMOTE_WORKBENCH` / `COMPOSIO_REMOTE_BASH_TOOL` tools KAIROS doesn't want |
| `connectionRequest.waitForConnection(timeout_ms)` returned by `link()` | Manual polling of `listConnectedAccounts` to confirm ACTIVE status |
| `session.update({ toolkits: [...allKnownSlugs] })` to add toolkits | ~~`session.toolkits.add([slug])`~~ — does NOT exist; `session.toolkits()` is a read-only query |
| `session.mcp.url` + `session.mcp.headers` (read from live session) | Hardcoded `https://mcp.composio.dev/...` URLs |
| `use_composio_managed_auth: true` (default for managed mode) | BYOC custom credentials (out of scope for v1) |
| ToolRouter session pattern (auto-handles connection state) | Per-tool-call SDK invocation |
| `manageConnections: true` (default) — keeps Composio's in-chat auth meta-tool active | `manageConnections: false` — disables in-chat auth (we want it enabled) |

**User-confirmed scope decisions:**

| Decision | Choice | Rationale |
|---|---|---|
| OAuth callback mechanism | Localhost via `OAuthCallbackHandler` (C.2.5) | Standard desktop-app pattern, zero new infrastructure, already tested |
| Token expiry detection | Poll `connectedAccounts.list()` every 5 min | Simple, no Cloud dependency, ~12 API calls/hr/user negligible |
| Multi-account support | Single account per provider in v1 | Schema simpler; multi-account upgrade in Phase F |
| Auth modes supported in v1 | Managed auth only | Covers 500+ integrations; BYOC fallback deferred |
| Deployment model | **Model A: KAIROS Cloud shared key (no BYO)** | One Composio API key serves all KAIROS users; users never see Composio. KAIROS team owns the Composio relationship + billing. |

## Two coexisting connection paths (voice-first auth, no chat UI)

KAIROS has NO chat UI — only voice input + voice output, hotkey-activated. Composio's "in-chat auth" documentation assumes a chat surface where the agent posts clickable URLs. KAIROS translates this to voice-first: agent speaks the announcement AND auto-opens the browser simultaneously.

Composio supports **two parallel auth flows** that both feed into the same `ConnectionStore`:

```
Path A — Explicit voice request from user:
  User: "Connect my Gmail" (or via the eventual Phase F HUD)
    → connect_service intent fires
    → ConnectionFlow.connect()
    → Earned Interrupt restraint check (C.1.5): is now a good moment?
       └─ If deep focus / meeting: defer, surface later via inbox
       └─ Otherwise proceed
    → KAIROS speaks: "Opening Gmail authorization now."
    → KAIROS auto-opens browser to Composio auth URL (no voice confirmation needed)
    → user sees Composio's Allow page → clicks Allow
    → localhost callback captures completion (OAuthCallbackHandler from C.2.5)
    → linkResult._raw.waitForConnection(30_000) resolves
    → KAIROS speaks: "Gmail connected. [continues original task]"
    → ConnectionStore.upsert()

Path B — In-chat-auth equivalent (agent-initiated mid-task):
  Agent decides to call slack_send_message for unconnected user
    → Composio's COMPOSIO_MANAGE_CONNECTIONS meta-tool fires
    → returns a Connect URL in the tool-result
    → Agent (LLM, KAIROS-side) sees the URL in the result
    → Agent's response handler detects this is an auth-needed result
    → KAIROS triggers the same connect_service intent flow (Path A) with that URL
    → user proceeds through voice + browser as in Path A
    → Agent retries the original slack_send_message call
```

**Both paths require `manageConnections: true`** (the default for `composio.create()`). The plan must NEVER disable this flag. Keeping in-chat auth on is what makes KAIROS feel "alive" — it discovers needed integrations on demand rather than forcing the user through Settings UI.

**Why "auto-open browser without voice confirmation":** Voice round-trips are 3-5 seconds. If the user explicitly asked to connect, they want it done now. If the agent inferred the need, the Earned Interrupt restraint is the gate — if it's not a good moment, Earned Interrupt defers the whole flow; if it IS a good moment, the user is already engaged with KAIROS and a 2-second browser pop-up isn't a surprise.

The plan's Tasks 3 + 8 build Path A. Path B's URL-detection-and-redirect is wired in Task 8's intent handler — when the agent returns a result containing a Composio Connect URL, the intent recognizes it and delegates to ConnectionFlow with that URL. No additional KAIROS code is needed beyond URL detection.

---

**How the Composio API key reaches the daemon (Model A):**

```
Phase F+ (Cloud exists):
  KAIROS Cloud config endpoint  →  daemon fetches on startup  →  env var COMPOSIO_API_KEY set in process

Phase E and earlier (Cloud doesn't exist yet):
  Developer (Nirmal) sets COMPOSIO_API_KEY in shell or .env  →  daemon reads on startup

Either way:  process.env.COMPOSIO_API_KEY  is the daemon's single source of truth.
NO local keychain storage of the Composio API key. NO setup-composio.ts script. NO BYO path.
```

**Estimated size:** ~2,700 LOC of TypeScript + tests across 12 atomic tasks. Comparable scale to C.2.5 (Seamless Onboarding).

---

## File Structure

```
src/daemon/connectors/                       [NEW — Composio integration subsystem]
├── types.ts                                  Connection, ToolkitInfo, ComposioConfig
├── composioClient.ts                         Wraps @composio/core SDK
├── composioSessionManager.ts                 ToolRouter session lifecycle, MCP URL provider
├── connectionFlow.ts                         Drives session.authorize + OAuthCallbackHandler
├── connectionStore.ts                        SQLite: (user_id, toolkit_slug, connection_id, status)
├── tokenExpiryPoller.ts                      Polls connectedAccounts.list every 5 min
├── connectServiceIntent.ts                   "connect_service" agency intent
└── disconnectServiceIntent.ts                "disconnect_service" agency intent

src/daemon/mcp/                              [MODIFY — add HTTP transport]
├── httpMcpClient.ts                          [NEW] HTTP/SSE transport for McpClient interface
├── mcpClient.ts                              [unchanged — stdio variant stays]
├── mcpHost.ts                                [MODIFY — branch on config.transport: 'stdio' vs 'http']
└── types.ts                                  [MODIFY — extend McpServerConfig with headers + url]

src/daemon/
├── types.ts                                  [MODIFY — composio config block]
├── config.ts                                 [MODIFY — defaults + KAIROS_COMPOSIO_API_KEY env]
└── index.ts                                  [MODIFY — instantiate Composio subsystem]
```

**Test files** alongside source. Each new module has its own `*.test.ts`.

---

## Task 0: Dependencies + Types

**Files:**
- Modify: `package.json`
- Create: `src/daemon/connectors/types.ts`

- [ ] **Step 1: Install Composio SDK**

```bash
cd /Users/nirmalghinaiya/Desktop/kairos-sandbox
bun add @composio/core@^1
```

Verify the installed version in `package.json`. If `@composio/core` has peer-dep warnings about `zod`, `@modelcontextprotocol/sdk`, or `eventsource`, install those too — but they should be transitive from existing deps.

- [ ] **Step 2: Write `types.ts`**

```typescript
// src/daemon/connectors/types.ts
// Types for the Composio Connector subsystem.

export type ToolkitSlug = string   // e.g. 'slack', 'gmail', 'github'

export type ConnectionStatus = 'pending' | 'active' | 'expired' | 'revoked' | 'failed'

export type Connection = {
  user_id: string                  // KAIROS local user id (typically 'local' for single-user daemon)
  toolkit_slug: ToolkitSlug
  connection_id: string            // Composio-assigned ID
  auth_config_id: string           // Composio-assigned auth config (per-toolkit, shared across users)
  status: ConnectionStatus
  created_at: number               // ms epoch
  last_polled_at?: number          // ms epoch — last time we verified status with Composio
  expired_at?: number              // ms epoch — when status flipped to 'expired'
}

export type ToolkitInfo = {
  slug: ToolkitSlug
  display_name: string
  description: string
  auth_type: 'oauth' | 'api_key' | 'no_auth' | 'unknown'
  managed_auth_supported: boolean  // true if Composio's managed OAuth covers this toolkit
  tools_count: number              // count of tools the toolkit exposes
}

export type ConnectFlowResult = {
  status: 'success' | 'failed' | 'cancelled'
  toolkit_slug: ToolkitSlug
  connection_id?: string
  duration_ms: number
  error?: string
}

export type ComposioConfig = {
  enabled: boolean                 // default true if api_key present
  api_key?: string                 // read from keychain at boot
  session_id?: string              // cached session id for resume across restarts
  base_url?: string                // defaults to https://backend.composio.dev
  poll_interval_ms?: number        // default 5 min
  default_toolkits?: ToolkitSlug[] // toolkits the session is opened with on boot (e.g., already-connected)
}

export type ComposioMcpSession = {
  session_id: string
  url: string                      // session.mcp.url
  headers: Record<string, string>  // session.mcp.headers
  toolkits: ToolkitSlug[]
  created_at: number
}
```

- [ ] **Step 3: Commit**

```bash
git add package.json bun.lockb src/daemon/connectors/types.ts
git commit -m "feat(connectors): C.2.7 type surface + @composio/core dependency"
```

---

## Task 1: ComposioClient Wrapper

**Files:**
- Create: `src/daemon/connectors/composioClient.ts`
- Create: `src/daemon/connectors/composioClient.test.ts`

Thin wrapper around `@composio/core` that:
- Reads API key from Keychain (`com.kairos.composio / api_key`)
- Exposes typed methods we actually use: `listToolkits`, `createAuthConfig`, `listAuthConfigs`, `linkConnection`, `listConnectedAccounts`, `deleteConnection`, `executeTool`
- Centralizes error handling

- [ ] **Step 1: Test**

```typescript
// src/daemon/connectors/composioClient.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { ComposioClient } from './composioClient'

describe('ComposioClient', () => {
  it('throws when no API key is provided', () => {
    expect(() => new ComposioClient({ apiKey: '' })).toThrow(/api[_ ]?key/i)
  })

  it('exposes the SDK as `sdk` property for low-level access', () => {
    const c = new ComposioClient({ apiKey: 'test_key' })
    expect(c.sdk).toBeDefined()
  })

  it('listToolkits returns paginated results', async () => {
    const fakeSdk: any = {
      toolkits: {
        get: async () => ({ items: [{ slug: 'slack', name: 'Slack' }, { slug: 'gmail', name: 'Gmail' }] }),
      },
    }
    const c = new ComposioClient({ apiKey: 'test', _sdk: fakeSdk })
    const result = await c.listToolkits({ limit: 100 })
    expect(result.length).toBe(2)
    expect(result[0].slug).toBe('slack')
  })

  it('linkConnection wraps connectedAccounts.link with POSITIONAL args', async () => {
    const calls: any[] = []
    const fakeSdk: any = {
      connectedAccounts: {
        // Note positional signature: (userId, authConfigId, options?)
        link: async (userId: string, authConfigId: string, options: any) => {
          calls.push({ userId, authConfigId, options })
          return { connection_id: 'conn_abc', redirect_url: 'https://...', waitForConnection: async () => ({ status: 'ACTIVE' }) }
        },
      },
    }
    const c = new ComposioClient({ apiKey: 'test', _sdk: fakeSdk })
    const result = await c.linkConnection({ userId: 'u1', authConfigId: 'ac_1', callbackUrl: 'http://localhost:1234/cb' })
    expect(calls[0].userId).toBe('u1')
    expect(calls[0].authConfigId).toBe('ac_1')
    expect(calls[0].options).toEqual({ callbackUrl: 'http://localhost:1234/cb' })
    expect(result.connection_id).toBe('conn_abc')
    expect(result._raw).toBeDefined()   // raw SDK return — used by ConnectionFlow for waitForConnection()
  })

  it('listConnectedAccounts filters by status', async () => {
    const fakeSdk: any = {
      connectedAccounts: {
        list: async (args: any) => ({ items: [{ id: 'c1', status: 'ACTIVE' }, { id: 'c2', status: 'EXPIRED' }] }),
      },
    }
    const c = new ComposioClient({ apiKey: 'test', _sdk: fakeSdk })
    const all = await c.listConnectedAccounts({ userId: 'u1' })
    expect(all.length).toBe(2)
  })

  it('does NOT call deprecated initiate()', async () => {
    const fakeSdk: any = {
      connectedAccounts: {
        link: async () => ({ connection_id: 'c1', waitForConnection: async () => ({ status: 'ACTIVE' }) }),
        initiate: async () => { throw new Error('initiate is deprecated — this should never be called') },
      },
    }
    const c = new ComposioClient({ apiKey: 'test', _sdk: fakeSdk })
    await c.linkConnection({ userId: 'u1', authConfigId: 'ac_1' })   // must use link(), not initiate()
  })
})
```

- [ ] **Step 2: Implementation**

```typescript
// src/daemon/connectors/composioClient.ts
// Thin wrapper around @composio/core. Centralizes API key handling,
// typed method surface, and the deprecation guarantee
// (we use connectedAccounts.link, never the deprecated initiate).

import { Composio } from '@composio/core'
import type { Connection, ToolkitInfo, ConnectionStatus } from './types'

export type ComposioClientOptions = {
  apiKey: string
  baseUrl?: string
  _sdk?: any  // injection for tests
}

export type LinkConnectionArgs = {
  userId: string
  authConfigId: string
  callbackUrl?: string  // for OAuth toolkits
  config?: any          // for api_key / no_auth toolkits
}

export type LinkConnectionResult = {
  connection_id: string
  redirect_url?: string  // present for OAuth flows
  status: ConnectionStatus
  /** The raw SDK return value. Has `.waitForConnection(timeout_ms)` method.
   *  Task 3's ConnectionFlow uses this instead of manually polling listConnectedAccounts. */
  _raw: any
}

export class ComposioClient {
  public sdk: any  // @composio/core Composio instance

  constructor(opts: ComposioClientOptions) {
    if (!opts.apiKey) throw new Error('ComposioClient: api_key is required')
    this.sdk = opts._sdk ?? new Composio({
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl ?? 'https://backend.composio.dev',
    })
  }

  async listToolkits(opts: { limit?: number; cursor?: string } = {}): Promise<ToolkitInfo[]> {
    const page = await this.sdk.toolkits.get({ limit: opts.limit ?? 100, cursor: opts.cursor })
    return (page.items ?? []).map((t: any) => ({
      slug: t.slug,
      display_name: t.name ?? t.slug,
      description: t.description ?? '',
      auth_type: this.detectAuthType(t),
      managed_auth_supported: t.managed_auth_supported ?? this.guessManagedAuthSupport(t),
      tools_count: t.tools_count ?? 0,
    }))
  }

  async getOrCreateAuthConfig(toolkitSlug: string): Promise<string> {
    // Idempotent: look up existing managed auth config for this toolkit, create if missing
    const existing = await this.sdk.authConfigs.list({ toolkit: toolkitSlug })
    const managed = existing?.items?.find((c: any) => c.type === 'use_composio_managed_auth')
    if (managed) return managed.id
    const created = await this.sdk.authConfigs.create(toolkitSlug, { type: 'use_composio_managed_auth' })
    return created.id
  }

  async linkConnection(args: LinkConnectionArgs): Promise<LinkConnectionResult> {
    // NOTE: deprecated `initiate()` is NOT used. `link()` is the current API.
    // IMPORTANT: link() takes POSITIONAL args (userId, authConfigId, options?), not an options object.
    // The `config` field belongs to the deprecated initiate() — link() does NOT accept it.
    const result = await this.sdk.connectedAccounts.link(
      args.userId,
      args.authConfigId,
      args.callbackUrl ? { callbackUrl: args.callbackUrl } : undefined,
    )
    return {
      connection_id: result.connection_id ?? result.id,
      redirect_url: result.redirect_url ?? result.redirectUrl,
      status: this.normalizeStatus(result.status ?? 'pending'),
      // The returned object has a waitForConnection() method — Task 3 will use it
      // to wait for the connection to reach ACTIVE status without manual polling.
      _raw: result,
    }
  }

  async listConnectedAccounts(opts: { userId?: string; statuses?: string[] } = {}): Promise<Array<{
    id: string; toolkit_slug: string; status: ConnectionStatus; auth_config_id: string
  }>> {
    const page = await this.sdk.connectedAccounts.list({
      userId: opts.userId,
      statuses: opts.statuses,
    })
    return (page.items ?? []).map((c: any) => ({
      id: c.id,
      toolkit_slug: c.toolkit ?? c.toolkit_slug,
      status: this.normalizeStatus(c.status),
      auth_config_id: c.auth_config_id ?? c.authConfigId,
    }))
  }

  async deleteConnection(connectionId: string): Promise<void> {
    await this.sdk.connectedAccounts.delete(connectionId)
  }

  async executeTool(args: { toolName: string; userId: string; arguments: any }): Promise<any> {
    // Direct SDK execution path (not via MCP). Used when KAIROS calls a tool
    // programmatically, not via the LLM's MCP-driven tool selection.
    return this.sdk.tools.execute({
      toolName: args.toolName,
      userId: args.userId,
      arguments: args.arguments,
    })
  }

  private detectAuthType(t: any): 'oauth' | 'api_key' | 'no_auth' | 'unknown' {
    const schemes: string[] = t.auth_schemes ?? t.authSchemes ?? []
    if (schemes.some(s => s === 'OAUTH2' || s === 'OAUTH1')) return 'oauth'
    if (schemes.some(s => s === 'API_KEY' || s === 'BEARER_TOKEN')) return 'api_key'
    if (schemes.some(s => s === 'NO_AUTH')) return 'no_auth'
    return 'unknown'
  }

  private guessManagedAuthSupport(t: any): boolean {
    // Fallback heuristic: assume managed auth supported for OAuth and no_auth.
    // Composio's docs say managed_auth_supported is a metadata field — when present, trust it.
    const at = this.detectAuthType(t)
    return at === 'oauth' || at === 'no_auth'
  }

  private normalizeStatus(s: string): ConnectionStatus {
    const norm = (s ?? '').toUpperCase()
    if (norm === 'ACTIVE') return 'active'
    if (norm === 'EXPIRED') return 'expired'
    if (norm === 'REVOKED' || norm === 'DELETED') return 'revoked'
    if (norm === 'PENDING' || norm === 'INITIATED') return 'pending'
    if (norm === 'FAILED' || norm === 'ERROR') return 'failed'
    return 'pending'
  }
}
```

- [ ] **Step 3: Run + commit**

```bash
bun test src/daemon/connectors/composioClient.test.ts
git add src/daemon/connectors/composioClient.ts src/daemon/connectors/composioClient.test.ts
git commit -m "feat(connectors): ComposioClient wrapper — uses link() not deprecated initiate()"
```

Expected: 6/6 pass.

---

## Task 2: ConnectionStore (SQLite)

**Files:**
- Create: `src/daemon/connectors/connectionStore.ts`
- Create: `src/daemon/connectors/connectionStore.test.ts`

Persists `Connection` records. Single-account-per-toolkit constraint enforced via UNIQUE index.

- [ ] **Step 1: Test (TDD, 6 tests)**

```typescript
// src/daemon/connectors/connectionStore.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { ConnectionStore } from './connectionStore'

describe('ConnectionStore', () => {
  let db: Database
  let store: ConnectionStore

  beforeEach(() => {
    db = new Database(':memory:')
    store = new ConnectionStore(db)
  })

  it('creates and retrieves a connection', () => {
    store.upsert({
      user_id: 'local', toolkit_slug: 'slack', connection_id: 'c_abc',
      auth_config_id: 'ac_slack', status: 'active', created_at: 1000,
    })
    const got = store.getByToolkit('local', 'slack')
    expect(got?.connection_id).toBe('c_abc')
    expect(got?.status).toBe('active')
  })

  it('upsert replaces existing connection for same (user, toolkit)', () => {
    store.upsert({ user_id: 'local', toolkit_slug: 'slack', connection_id: 'c_old', auth_config_id: 'ac', status: 'expired', created_at: 100 })
    store.upsert({ user_id: 'local', toolkit_slug: 'slack', connection_id: 'c_new', auth_config_id: 'ac', status: 'active', created_at: 200 })
    expect(store.listByUser('local').length).toBe(1)
    expect(store.getByToolkit('local', 'slack')?.connection_id).toBe('c_new')
  })

  it('listByUser returns only that user', () => {
    store.upsert({ user_id: 'a', toolkit_slug: 'slack', connection_id: 'c1', auth_config_id: 'ac', status: 'active', created_at: 1 })
    store.upsert({ user_id: 'b', toolkit_slug: 'gmail', connection_id: 'c2', auth_config_id: 'ac', status: 'active', created_at: 2 })
    expect(store.listByUser('a').map(c => c.toolkit_slug)).toEqual(['slack'])
    expect(store.listByUser('b').map(c => c.toolkit_slug)).toEqual(['gmail'])
  })

  it('markStatus updates only the status + timestamp', () => {
    store.upsert({ user_id: 'local', toolkit_slug: 'slack', connection_id: 'c', auth_config_id: 'ac', status: 'active', created_at: 1 })
    store.markStatus('local', 'slack', 'expired')
    const got = store.getByToolkit('local', 'slack')!
    expect(got.status).toBe('expired')
    expect(got.expired_at).toBeGreaterThan(0)
  })

  it('remove deletes the row', () => {
    store.upsert({ user_id: 'local', toolkit_slug: 'slack', connection_id: 'c', auth_config_id: 'ac', status: 'active', created_at: 1 })
    store.remove('local', 'slack')
    expect(store.getByToolkit('local', 'slack')).toBeNull()
  })

  it('listActive returns only status=active', () => {
    store.upsert({ user_id: 'local', toolkit_slug: 'slack', connection_id: 'c1', auth_config_id: 'ac', status: 'active', created_at: 1 })
    store.upsert({ user_id: 'local', toolkit_slug: 'gmail', connection_id: 'c2', auth_config_id: 'ac', status: 'expired', created_at: 2 })
    expect(store.listActive('local').map(c => c.toolkit_slug)).toEqual(['slack'])
  })
})
```

- [ ] **Step 2: Implementation**

```typescript
// src/daemon/connectors/connectionStore.ts
import type { Database } from 'bun:sqlite'
import type { Connection, ConnectionStatus, ToolkitSlug } from './types'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS composio_connections (
  user_id TEXT NOT NULL,
  toolkit_slug TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  auth_config_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_polled_at INTEGER,
  expired_at INTEGER,
  PRIMARY KEY (user_id, toolkit_slug)
);
CREATE INDEX IF NOT EXISTS idx_composio_conn_status ON composio_connections(status);
`

export class ConnectionStore {
  constructor(private db: Database) { db.exec(SCHEMA) }

  upsert(c: Connection): void {
    this.db.run(
      `INSERT INTO composio_connections (user_id, toolkit_slug, connection_id, auth_config_id, status, created_at, last_polled_at, expired_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, toolkit_slug) DO UPDATE SET
         connection_id = excluded.connection_id,
         auth_config_id = excluded.auth_config_id,
         status = excluded.status,
         created_at = excluded.created_at,
         last_polled_at = excluded.last_polled_at,
         expired_at = excluded.expired_at`,
      [c.user_id, c.toolkit_slug, c.connection_id, c.auth_config_id, c.status, c.created_at,
       c.last_polled_at ?? null, c.expired_at ?? null],
    )
  }

  getByToolkit(userId: string, toolkitSlug: ToolkitSlug): Connection | null {
    const row = this.db.query(
      `SELECT * FROM composio_connections WHERE user_id = ? AND toolkit_slug = ?`,
    ).get(userId, toolkitSlug) as any
    return row ? this.rowToConnection(row) : null
  }

  listByUser(userId: string): Connection[] {
    const rows = this.db.query(
      `SELECT * FROM composio_connections WHERE user_id = ? ORDER BY toolkit_slug`,
    ).all(userId) as any[]
    return rows.map(r => this.rowToConnection(r))
  }

  listActive(userId: string): Connection[] {
    return this.listByUser(userId).filter(c => c.status === 'active')
  }

  markStatus(userId: string, toolkitSlug: ToolkitSlug, status: ConnectionStatus): void {
    const now = Date.now()
    const expiredAt = status === 'expired' || status === 'revoked' ? now : null
    this.db.run(
      `UPDATE composio_connections
       SET status = ?, last_polled_at = ?, expired_at = COALESCE(?, expired_at)
       WHERE user_id = ? AND toolkit_slug = ?`,
      [status, now, expiredAt, userId, toolkitSlug],
    )
  }

  remove(userId: string, toolkitSlug: ToolkitSlug): void {
    this.db.run(`DELETE FROM composio_connections WHERE user_id = ? AND toolkit_slug = ?`, [userId, toolkitSlug])
  }

  private rowToConnection(r: any): Connection {
    return {
      user_id: r.user_id, toolkit_slug: r.toolkit_slug, connection_id: r.connection_id,
      auth_config_id: r.auth_config_id, status: r.status as ConnectionStatus,
      created_at: r.created_at, last_polled_at: r.last_polled_at ?? undefined,
      expired_at: r.expired_at ?? undefined,
    }
  }
}
```

- [ ] **Step 3: Run + commit**

```bash
bun test src/daemon/connectors/connectionStore.test.ts
git add src/daemon/connectors/connectionStore.ts src/daemon/connectors/connectionStore.test.ts
git commit -m "feat(connectors): ConnectionStore — SQLite persistence with single-account-per-toolkit constraint"
```

Expected: 6/6 pass.

---

## Task 3: ConnectionFlow (browser + localhost callback)

**Files:**
- Create: `src/daemon/connectors/connectionFlow.ts`
- Create: `src/daemon/connectors/connectionFlow.test.ts`

Orchestrates: (a) compute Composio auth config id for the toolkit, (b) call `linkConnection` with a localhost callback URL, (c) open browser via existing `BrowserOpener`, (d) await callback via existing `OAuthCallbackHandler`, (e) confirm connection became active via `listConnectedAccounts`, (f) persist via `ConnectionStore`.

- [ ] **Step 1: Test (8 tests)**

```typescript
// src/daemon/connectors/connectionFlow.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { ConnectionFlow } from './connectionFlow'
import { ConnectionStore } from './connectionStore'

function makeDeps(overrides: any = {}) {
  const db = new Database(':memory:')
  return {
    composio: {
      getOrCreateAuthConfig: async (slug: string) => `ac_${slug}`,
      linkConnection: async (args: any) => ({
        connection_id: 'c_abc',
        redirect_url: 'https://composio.dev/auth/slack/...',
        status: 'pending',
        // Raw return — has waitForConnection() that ConnectionFlow uses
        _raw: { waitForConnection: async (_ms: number) => ({ id: 'c_abc', status: 'ACTIVE' }) },
      }),
      listConnectedAccounts: async (args: any) => [{ id: 'c_abc', toolkit_slug: args.toolkit ?? 'slack', status: 'active', auth_config_id: 'ac_slack' }],
    },
    browserOpener: { open: async (url: string) => { /* noop */ } },
    oauthCallbackHandler: {
      listen: async (opts: any) => ({
        port: 12345, callbackUrl: 'http://localhost:12345/composio-cb',
        capturePromise: Promise.resolve({ callback_path: '/composio-cb', query_params: { status: 'success' }, raw_url: '', captured_at: Date.now() }),
      }),
    },
    connectionStore: new ConnectionStore(db),
    ...overrides,
  }
}

describe('ConnectionFlow', () => {
  it('connects a Slack-like OAuth toolkit end-to-end', async () => {
    const deps = makeDeps()
    const flow = new ConnectionFlow(deps as any)
    const result = await flow.connect({ userId: 'local', toolkitSlug: 'slack' })
    expect(result.status).toBe('success')
    expect(result.connection_id).toBe('c_abc')
    expect(deps.connectionStore.getByToolkit('local', 'slack')?.status).toBe('active')
  })

  it('opens the browser to redirect_url returned by composio.linkConnection', async () => {
    const opens: string[] = []
    const deps = makeDeps({
      browserOpener: { open: async (url: string) => { opens.push(url) } },
    })
    const flow = new ConnectionFlow(deps as any)
    await flow.connect({ userId: 'local', toolkitSlug: 'slack' })
    expect(opens[0]).toMatch(/composio\.dev/)
  })

  it('passes localhost callback URL when calling linkConnection', async () => {
    const linkCalls: any[] = []
    const deps = makeDeps({
      composio: {
        ...makeDeps().composio,
        linkConnection: async (args: any) => { linkCalls.push(args); return { connection_id: 'c', redirect_url: '/x', status: 'pending' } },
      },
    })
    const flow = new ConnectionFlow(deps as any)
    await flow.connect({ userId: 'local', toolkitSlug: 'slack' })
    expect(linkCalls[0].callbackUrl).toMatch(/^http:\/\/localhost:\d+\/composio-cb/)
  })

  it('skips browser for api_key/no_auth toolkits', async () => {
    const opens: string[] = []
    const deps = makeDeps({
      browserOpener: { open: async (url: string) => { opens.push(url) } },
      composio: {
        ...makeDeps().composio,
        linkConnection: async () => ({ connection_id: 'c_api', status: 'active' }),   // no redirect_url
      },
    })
    const flow = new ConnectionFlow(deps as any)
    const result = await flow.connect({ userId: 'local', toolkitSlug: 'openai' })
    expect(result.status).toBe('success')
    expect(opens.length).toBe(0)
  })

  it('returns failed if waitForConnection rejects', async () => {
    const deps = makeDeps({
      composio: {
        ...makeDeps().composio,
        linkConnection: async () => ({
          connection_id: 'c', redirect_url: 'https://...', status: 'pending',
          _raw: { waitForConnection: async () => { throw new Error('TIMEOUT') } },
        }),
      },
    })
    const flow = new ConnectionFlow(deps as any)
    const result = await flow.connect({ userId: 'local', toolkitSlug: 'slack' })
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/TIMEOUT|active within 30s/)
  })

  it('returns failed if waitForConnection settles in a non-ACTIVE status', async () => {
    const deps = makeDeps({
      composio: {
        ...makeDeps().composio,
        linkConnection: async () => ({
          connection_id: 'c', redirect_url: 'https://...', status: 'pending',
          _raw: { waitForConnection: async () => ({ id: 'c', status: 'FAILED' }) },
        }),
      },
    })
    const flow = new ConnectionFlow(deps as any)
    const result = await flow.connect({ userId: 'local', toolkitSlug: 'slack' })
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/non-active|FAILED/i)
  })

  it('times out gracefully if OAuthCallbackHandler timeout fires', async () => {
    const deps = makeDeps({
      oauthCallbackHandler: {
        listen: async () => ({
          port: 0, callbackUrl: 'http://localhost:0/composio-cb',
          capturePromise: Promise.reject(new Error('OAuthCallbackHandler: timeout after 300s waiting for callback')),
        }),
      },
    })
    const flow = new ConnectionFlow(deps as any)
    const result = await flow.connect({ userId: 'local', toolkitSlug: 'slack' })
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/timeout/i)
  })

  it('does not insert a stale row into ConnectionStore on failure', async () => {
    const deps = makeDeps({
      composio: {
        ...makeDeps().composio,
        linkConnection: async () => ({
          connection_id: 'c', redirect_url: 'https://...', status: 'pending',
          _raw: { waitForConnection: async () => { throw new Error('TIMEOUT') } },
        }),
      },
    })
    const flow = new ConnectionFlow(deps as any)
    await flow.connect({ userId: 'local', toolkitSlug: 'slack' })
    expect(deps.connectionStore.getByToolkit('local', 'slack')).toBeNull()
  })

  it('records duration_ms', async () => {
    const flow = new ConnectionFlow(makeDeps() as any)
    const result = await flow.connect({ userId: 'local', toolkitSlug: 'slack' })
    expect(result.duration_ms).toBeGreaterThanOrEqual(0)
  })
})
```

- [ ] **Step 2: Implementation**

```typescript
// src/daemon/connectors/connectionFlow.ts
// Orchestrates a single OAuth/API-key connection flow against Composio,
// reusing the existing OAuthCallbackHandler (C.2.5) for the localhost callback.

import type { ComposioClient } from './composioClient'
import type { ConnectionStore } from './connectionStore'
import type { ConnectFlowResult, ToolkitSlug } from './types'

export interface BrowserOpener { open(url: string): Promise<void> }
export interface OAuthCallbackHandler {
  listen(opts: { path: string; timeout_sec: number }): Promise<{
    port: number
    callbackUrl: string
    capturePromise: Promise<{ callback_path: string; query_params: Record<string, string>; raw_url: string; captured_at: number }>
  }>
}

export type ConnectionFlowDeps = {
  composio: Pick<ComposioClient,
    'getOrCreateAuthConfig' | 'linkConnection' | 'listConnectedAccounts'>
  browserOpener: BrowserOpener
  oauthCallbackHandler: OAuthCallbackHandler
  connectionStore: ConnectionStore
}

export class ConnectionFlow {
  constructor(private deps: ConnectionFlowDeps) {}

  async connect(opts: { userId: string; toolkitSlug: ToolkitSlug }): Promise<ConnectFlowResult> {
    const startedAt = Date.now()
    try {
      // 1. Resolve auth config (idempotent — looks up existing managed config or creates one)
      const authConfigId = await this.deps.composio.getOrCreateAuthConfig(opts.toolkitSlug)

      // 2. Pre-arm the localhost callback BEFORE calling Composio so we know the URL
      const cb = await this.deps.oauthCallbackHandler.listen({ path: '/composio-cb', timeout_sec: 300 })

      // 3. Initiate the link
      const linkResult = await this.deps.composio.linkConnection({
        userId: opts.userId,
        authConfigId,
        callbackUrl: cb.callbackUrl,
      })

      // 4. If a redirect URL came back (OAuth flow), open the browser and await the callback
      if (linkResult.redirect_url) {
        await this.deps.browserOpener.open(linkResult.redirect_url)
        await cb.capturePromise   // resolves on redirect, rejects on timeout
      }
      // For API-key / no-auth toolkits, linkResult.status is already 'active' — no browser needed

      // 5. Confirm via the SDK's built-in waitForConnection() — replaces manual polling
      //    of listConnectedAccounts. waitForConnection() handles backoff internally
      //    and resolves when status flips to ACTIVE (or rejects on timeout).
      let confirmedStatus = 'ACTIVE'
      let connectionId = linkResult.connection_id
      let authConfigId = authConfigId   // sourced from earlier in this function
      try {
        const confirmed = await linkResult._raw.waitForConnection(30_000)
        confirmedStatus = (confirmed?.status ?? 'ACTIVE').toUpperCase()
        connectionId = confirmed?.id ?? confirmed?.connection_id ?? linkResult.connection_id
      } catch (err) {
        return {
          status: 'failed',
          toolkit_slug: opts.toolkitSlug,
          duration_ms: Date.now() - startedAt,
          error: `connection did not become active within 30s: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
      if (confirmedStatus !== 'ACTIVE') {
        return {
          status: 'failed',
          toolkit_slug: opts.toolkitSlug,
          duration_ms: Date.now() - startedAt,
          error: `connection settled in non-active status: ${confirmedStatus}`,
        }
      }

      // 6. Persist
      this.deps.connectionStore.upsert({
        user_id: opts.userId,
        toolkit_slug: opts.toolkitSlug,
        connection_id: connectionId,
        auth_config_id: authConfigId,
        status: 'active',
        created_at: Date.now(),
      })

      return {
        status: 'success',
        toolkit_slug: opts.toolkitSlug,
        connection_id: connectionId,
        duration_ms: Date.now() - startedAt,
      }
    } catch (err) {
      return {
        status: 'failed',
        toolkit_slug: opts.toolkitSlug,
        duration_ms: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }
}
```

- [ ] **Step 3: Run + commit**

```bash
bun test src/daemon/connectors/connectionFlow.test.ts
git add src/daemon/connectors/connectionFlow.ts src/daemon/connectors/connectionFlow.test.ts
git commit -m "feat(connectors): ConnectionFlow — orchestrates browser + localhost callback + ConnectionStore"
```

Expected: 8/8 pass.

---

## Task 4: HttpMcpClient (HTTP/SSE transport)

**Files:**
- Create: `src/daemon/mcp/httpMcpClient.ts`
- Create: `src/daemon/mcp/httpMcpClient.test.ts`

The existing `McpClient` in `src/daemon/mcp/mcpClient.ts` speaks stdio (subprocess + StdioClientTransport). Composio's MCP server is HTTP-based. This task adds a parallel `HttpMcpClient` that implements the same interface using `@modelcontextprotocol/sdk`'s `StreamableHTTPClientTransport` (default) or `SSEClientTransport` (fallback if Composio's MCP only speaks legacy SSE).

### ⚠️ MANDATORY pre-implementation verification step

Composio's MCP transport (Streamable HTTP vs SSE) is NOT 100% confirmed from docs alone. Before writing `HttpMcpClient`:

```bash
# 1. Get a live session URL by running:
bun --eval '
  import { Composio } from "@composio/core";
  const c = new Composio({ apiKey: process.env.COMPOSIO_API_KEY });
  const s = await c.create("test-user", { toolkits: ["hackernews"], workbench: { enable: false }, manageConnections: true });
  console.log({ url: s.mcp.url, headers: s.mcp.headers });
'

# 2. Test with MCP Inspector:
npx @modelcontextprotocol/inspector
# In the Inspector UI: paste session.mcp.url + headers, try connecting with both
# "Streamable HTTP" and "SSE" transport options, see which one succeeds.
```

Document which transport works. If Streamable HTTP works, use `StreamableHTTPClientTransport`. If only SSE works, use `SSEClientTransport`. Either way, the rest of `HttpMcpClient` is identical — they share the same `Client` interface from `@modelcontextprotocol/sdk/client/index.js`.

**Do not skip this verification step.** Picking the wrong transport class causes a 400 Bad Request on first `connect()` with a cryptic error message — debugging that retroactively is much more painful than 5 minutes with the Inspector.

- [ ] **Step 1: Pre-read existing `mcpClient.ts`** — match the interface exactly. Whatever shape `McpClient` exposes (`listTools()`, `callTool()`, `connect()`, `disconnect()`, etc.), `HttpMcpClient` must match.

- [ ] **Step 2: Test (5 tests)**

```typescript
// src/daemon/mcp/httpMcpClient.test.ts
import { describe, it, expect } from 'bun:test'
import { HttpMcpClient } from './httpMcpClient'

describe('HttpMcpClient', () => {
  it('constructs with url + headers', () => {
    const client = new HttpMcpClient({
      url: 'https://mcp.composio.dev/v1/session/abc',
      headers: { 'x-api-key': 'test', 'x-session-id': 'sess_1' },
    })
    expect(client.url).toBe('https://mcp.composio.dev/v1/session/abc')
  })

  it('connect() opens the transport', async () => {
    // Inject a fake transport that records connect/disconnect calls
    // Test that client.connect() drives it.
  })

  it('listTools() returns tools from server', async () => {
    // Mock transport that returns {tools: [{name: 'slack_send', inputSchema: {...}}]}
    // Assert listTools returns matching array
  })

  it('callTool() forwards to transport.request("tools/call", ...)', async () => {
    // Mock and assert
  })

  it('disconnect() closes the transport', async () => {
    // Mock and verify
  })
})
```

Specific implementation details for the implementer to figure out by reading `@modelcontextprotocol/sdk` source:

- Use `StreamableHTTPClientTransport` from `@modelcontextprotocol/sdk/client/streamableHttp.js` for Composio (their MCP uses Streamable HTTP per 2025-03-26 spec)
- If Composio's MCP requires legacy SSE, use `SSEClientTransport` from `@modelcontextprotocol/sdk/client/sse.js`
- Use the same `Client` class from `@modelcontextprotocol/sdk/client/index.js` that the existing `mcpClient.ts` uses

- [ ] **Step 3: Implementation**

```typescript
// src/daemon/mcp/httpMcpClient.ts
// HTTP/SSE transport variant of McpClient. Used for hosted MCP servers
// like Composio that expose the MCP protocol over Streamable HTTP.

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

  constructor(opts: HttpMcpClientOptions) {
    this.url = opts.url
    this.headers = opts.headers ?? {}
  }

  async connect(): Promise<void> {
    if (this.client) return
    this.client = new Client(
      { name: 'kairos-daemon', version: '0.3.5' },
      { capabilities: {} },
    )
    this.transport = new StreamableHTTPClientTransport(new URL(this.url), {
      requestInit: { headers: this.headers },
    })
    await this.client.connect(this.transport)
  }

  async listTools(): Promise<McpTool[]> {
    if (!this.client) throw new Error('HttpMcpClient: not connected')
    const result = await this.client.listTools()
    return (result.tools ?? []).map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as any,
    }))
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.client) throw new Error('HttpMcpClient: not connected')
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

  updateHeaders(newHeaders: Record<string, string>): void {
    // For session URL refresh — caller should typically disconnect + reconnect for a new URL
    this.headers = newHeaders
  }
}
```

- [ ] **Step 4: Run + commit**

```bash
bun test src/daemon/mcp/httpMcpClient.test.ts
git add src/daemon/mcp/httpMcpClient.ts src/daemon/mcp/httpMcpClient.test.ts
git commit -m "feat(mcp): HttpMcpClient — Streamable HTTP transport for hosted MCP servers"
```

Expected: 5/5 pass.

---

## Task 5: Extend McpHost to dispatch on transport type

**Files:**
- Modify: `src/daemon/mcp/mcpHost.ts`
- Modify: `src/daemon/mcp/types.ts` (extend `McpServerConfig` if needed)

`McpHost` currently constructs `McpClient` (stdio) for every server. Branch on `config.transport`: instantiate `HttpMcpClient` when `transport === 'http' | 'sse'`, otherwise `McpClient`.

- [ ] **Step 1: Read existing `mcpHost.ts`**. Find the `start(serverConfig)` or `startServer(...)` method. Find the line where `McpClient` is constructed.

- [ ] **Step 2: Extend `types.ts`**

```typescript
// src/daemon/mcp/types.ts (extend existing McpServerConfig)
export type McpServerConfig = {
  id: string
  enabled: boolean
  transport: 'stdio' | 'http' | 'sse'   // 'http' = Streamable HTTP (2025-03-26 spec)
  // stdio-only fields
  command?: string
  args?: string[]
  env?: Record<string, string>
  auth_keychain?: { service: string; account: string; env_var: string }
  // http/sse-only fields
  url?: string                          // full URL incl. path
  headers?: Record<string, string>      // sent on every request
  headers_keychain?: Array<{ service: string; account: string; header_name: string }>  // populate headers from keychain
  // common
  tier_policy: { default: 'GREEN' | 'YELLOW' | 'ORANGE' | 'RED' }
}
```

- [ ] **Step 3: Branch in `McpHost`**

Locate the spot in `mcpHost.ts` where servers are started. Replace the direct `new McpClient(...)` construction with:

```typescript
import { HttpMcpClient } from './httpMcpClient'
import { McpClient } from './mcpClient'

private async createClient(config: McpServerConfig): Promise<McpClient | HttpMcpClient> {
  if (config.transport === 'http' || config.transport === 'sse') {
    const headers = await this.resolveHeaders(config)
    return new HttpMcpClient({ url: config.url!, headers })
  }
  // existing stdio path
  return new McpClient(/* existing args */)
}

private async resolveHeaders(config: McpServerConfig): Promise<Record<string, string>> {
  const headers = { ...(config.headers ?? {}) }
  for (const kc of config.headers_keychain ?? []) {
    const value = await this.keychain.get(kc.service, kc.account)
    if (value) headers[kc.header_name] = value
  }
  return headers
}
```

- [ ] **Step 4: Update existing tests** that touch McpServerConfig to satisfy the new optional fields (`transport: 'stdio'` is the default).

- [ ] **Step 5: Run + commit**

```bash
bun test src/daemon/mcp/
git add src/daemon/mcp/mcpHost.ts src/daemon/mcp/types.ts
git commit -m "feat(mcp): McpHost branches on transport — stdio | http | sse"
```

Expected: existing MCP tests still pass + the McpHost can now drive HttpMcpClient.

---

## Task 6: ComposioSessionManager

**Files:**
- Create: `src/daemon/connectors/composioSessionManager.ts`
- Create: `src/daemon/connectors/composioSessionManager.test.ts`

Owns the ToolRouter session lifecycle. On daemon boot, creates (or resumes) a session via `composio.create(userId, { toolkits, manageConnections: true })`. Exposes `getMcpUrl()` and `getMcpHeaders()` for `McpHost` to consume. Updates the session when the user connects a new toolkit (`session.update(...)`).

- [ ] **Step 1: Test (5 tests)**

```typescript
// src/daemon/connectors/composioSessionManager.test.ts
import { describe, it, expect } from 'bun:test'
import { ComposioSessionManager } from './composioSessionManager'

function makeFakeSdk(behavior: any = {}) {
  return {
    create: async (userId: string, opts: any) => {
      behavior.lastCreateOpts = opts   // tests assert workbench/manageConnections settings here
      return {
        session_id: behavior.session_id ?? 'sess_xyz',
        mcp: { url: behavior.mcp_url ?? 'https://backend.composio.dev/tool_router/' + (behavior.session_id ?? 'sess_xyz'),
               headers: behavior.mcp_headers ?? { 'x-api-key': 'k' } },
        update: async (newOpts: any) => { behavior.updated = newOpts },
        // Note: NO toolkits.add mock — Composio's SDK has no such method. Only update() exists.
      }
    },
    use: async (sessionId: string) => ({
      session_id: sessionId,
      mcp: { url: `https://backend.composio.dev/tool_router/${sessionId}`, headers: { 'x-api-key': 'k' } },
    }),
  }
}

describe('ComposioSessionManager', () => {
  it('creates a new session on first init when no cached session_id', async () => {
    const sdk = makeFakeSdk()
    const m = new ComposioSessionManager({ sdk, userId: 'local', toolkits: ['slack'] })
    await m.init()
    expect(m.getMcpUrl()).toMatch(/sess_xyz/)
  })

  it('resumes an existing session if session_id is provided', async () => {
    const sdk = makeFakeSdk()
    const m = new ComposioSessionManager({ sdk, userId: 'local', toolkits: ['slack'], cachedSessionId: 'sess_resumed' })
    await m.init()
    expect(m.getMcpUrl()).toMatch(/sess_resumed/)
  })

  it('addToolkit triggers session.update', async () => {
    const sdk = makeFakeSdk()
    const m = new ComposioSessionManager({ sdk, userId: 'local', toolkits: ['slack'] })
    await m.init()
    await m.addToolkit('gmail')
    // Session should now know about gmail
    expect(m.getToolkits()).toContain('gmail')
  })

  it('getMcpUrl + getMcpHeaders before init throws', () => {
    const m = new ComposioSessionManager({ sdk: makeFakeSdk(), userId: 'local', toolkits: [] })
    expect(() => m.getMcpUrl()).toThrow(/init/)
  })

  it('getSessionId returns the current session_id', async () => {
    const m = new ComposioSessionManager({ sdk: makeFakeSdk(), userId: 'local', toolkits: ['slack'] })
    await m.init()
    expect(m.getSessionId()).toBe('sess_xyz')
  })

  it('always passes workbench.enable: false to composio.create() (KAIROS does not want the sandbox tools)', async () => {
    const behavior: any = {}
    const sdk = makeFakeSdk(behavior)
    const m = new ComposioSessionManager({ sdk, userId: 'local', toolkits: ['slack'] })
    await m.init()
    expect(behavior.lastCreateOpts.workbench).toEqual({ enable: false })
  })

  it('passes manageConnections: true by default (enables in-chat auth)', async () => {
    const behavior: any = {}
    const sdk = makeFakeSdk(behavior)
    const m = new ComposioSessionManager({ sdk, userId: 'local', toolkits: ['slack'] })
    await m.init()
    expect(behavior.lastCreateOpts.manageConnections).toBe(true)
  })

  it('addToolkit uses session.update (NOT a non-existent session.toolkits.add)', async () => {
    const behavior: any = {}
    const sdk = makeFakeSdk(behavior)
    const m = new ComposioSessionManager({ sdk, userId: 'local', toolkits: ['slack'] })
    await m.init()
    await m.addToolkit('gmail')
    expect(behavior.updated).toEqual({ toolkits: ['slack', 'gmail'] })
  })
})
```

- [ ] **Step 2: Implementation**

```typescript
// src/daemon/connectors/composioSessionManager.ts
// Lifecycle for a Composio ToolRouter session.
//
// On daemon boot: either resume cached session (via composio.use(session_id))
// or create a fresh one with the currently-connected toolkits.
//
// When user connects a new toolkit, call addToolkit() to update the live session.
// The McpHost queries getMcpUrl/getMcpHeaders to wire the HttpMcpClient.

import type { ToolkitSlug } from './types'

export type ComposioSessionManagerOptions = {
  sdk: any                       // @composio/core instance
  userId: string
  toolkits: ToolkitSlug[]        // initial set
  cachedSessionId?: string       // resume from disk if present
  manageConnections?: boolean    // default true
}

export class ComposioSessionManager {
  private session: any = null
  private currentToolkits: Set<ToolkitSlug>

  constructor(private opts: ComposioSessionManagerOptions) {
    this.currentToolkits = new Set(opts.toolkits)
  }

  async init(): Promise<void> {
    if (this.opts.cachedSessionId) {
      try {
        this.session = await this.opts.sdk.use(this.opts.cachedSessionId)
        // Trust the cached session — toolkits set was already configured when it was created
        return
      } catch {
        // resume failed (session might have expired) — fall through to fresh create
      }
    }
    this.session = await this.opts.sdk.create(this.opts.userId, {
      toolkits: [...this.currentToolkits],
      // CRITICAL: keep manageConnections: true so Composio's in-chat auth meta-tool stays active.
      // When the agent calls a tool for an unconnected toolkit, Composio returns a Connect URL
      // instead of an error — the agent surfaces it in chat, user clicks, connection completes.
      // This is one of two parallel auth paths (the other is our explicit ConnectionFlow).
      manageConnections: this.opts.manageConnections ?? true,
      // CRITICAL: disable workbench. Default-on spawns a Python sandbox and exposes
      // COMPOSIO_REMOTE_WORKBENCH + COMPOSIO_REMOTE_BASH_TOOL — tools KAIROS doesn't want
      // in its catalog (eats context tokens + gives the agent unwanted shell access).
      workbench: { enable: false },
    })
  }

  getSessionId(): string {
    this.assertInited()
    return this.session.session_id
  }

  getMcpUrl(): string {
    this.assertInited()
    return this.session.mcp.url
  }

  getMcpHeaders(): Record<string, string> {
    this.assertInited()
    return this.session.mcp.headers
  }

  getToolkits(): ToolkitSlug[] {
    return [...this.currentToolkits]
  }

  async addToolkit(slug: ToolkitSlug): Promise<void> {
    this.assertInited()
    if (this.currentToolkits.has(slug)) return
    this.currentToolkits.add(slug)
    // Composio's SDK API: ONLY session.update({ toolkits: [...] }) exists.
    // Note: session.toolkits() is a read-only query (no .add() method) — do not call it.
    // session.update() replaces the toolkit list, so we always pass the FULL desired set.
    if (typeof this.session.update === 'function') {
      await this.session.update({ toolkits: [...this.currentToolkits] })
    } else {
      // Last-resort fall back: re-create session with the new toolkit set
      this.session = await this.opts.sdk.create(this.opts.userId, {
        toolkits: [...this.currentToolkits],
        manageConnections: this.opts.manageConnections ?? true,
        workbench: { enable: false },
      })
    }
  }

  async removeToolkit(slug: ToolkitSlug): Promise<void> {
    this.assertInited()
    if (!this.currentToolkits.has(slug)) return
    this.currentToolkits.delete(slug)
    if (typeof this.session.update === 'function') {
      await this.session.update({ toolkits: [...this.currentToolkits] })
    } else {
      this.session = await this.opts.sdk.create(this.opts.userId, {
        toolkits: [...this.currentToolkits],
        manageConnections: this.opts.manageConnections ?? true,
        workbench: { enable: false },
      })
    }
  }

  private assertInited(): void {
    if (!this.session) throw new Error('ComposioSessionManager: must call init() before use')
  }
}
```

- [ ] **Step 3: Run + commit**

```bash
bun test src/daemon/connectors/composioSessionManager.test.ts
git add src/daemon/connectors/composioSessionManager.ts src/daemon/connectors/composioSessionManager.test.ts
git commit -m "feat(connectors): ComposioSessionManager — ToolRouter session lifecycle + MCP URL provider"
```

Expected: 5/5 pass.

---

## Task 7: TokenExpiryPoller

**Files:**
- Create: `src/daemon/connectors/tokenExpiryPoller.ts`
- Create: `src/daemon/connectors/tokenExpiryPoller.test.ts`

Background loop that calls `composio.listConnectedAccounts({ userId })` every N minutes. Diffs against `ConnectionStore` — if a connection was previously active but is now missing/expired, update the store and emit an "expired" event for the agency layer (eventually surfaced via inbox notification by Phase F UI).

- [ ] **Step 1: Test (4 tests)**

```typescript
// src/daemon/connectors/tokenExpiryPoller.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { ConnectionStore } from './connectionStore'
import { TokenExpiryPoller } from './tokenExpiryPoller'

describe('TokenExpiryPoller', () => {
  let db: Database
  let store: ConnectionStore

  beforeEach(() => {
    db = new Database(':memory:')
    store = new ConnectionStore(db)
  })

  it('detects an active connection has dropped (now missing in remote)', async () => {
    store.upsert({ user_id: 'local', toolkit_slug: 'slack', connection_id: 'c1', auth_config_id: 'ac', status: 'active', created_at: 1 })
    const events: any[] = []
    const poller = new TokenExpiryPoller({
      composio: { listConnectedAccounts: async () => [] },   // Composio reports nothing active
      connectionStore: store,
      onConnectionExpired: (c) => events.push(c),
      userId: 'local',
      intervalMs: 1000,
    })
    await poller.runOnce()
    expect(events.length).toBe(1)
    expect(events[0].toolkit_slug).toBe('slack')
    expect(store.getByToolkit('local', 'slack')?.status).toBe('expired')
  })

  it('does NOT mark expired when remote reports active', async () => {
    store.upsert({ user_id: 'local', toolkit_slug: 'slack', connection_id: 'c1', auth_config_id: 'ac', status: 'active', created_at: 1 })
    const events: any[] = []
    const poller = new TokenExpiryPoller({
      composio: { listConnectedAccounts: async () => [{ id: 'c1', toolkit_slug: 'slack', status: 'active', auth_config_id: 'ac' }] },
      connectionStore: store,
      onConnectionExpired: (c) => events.push(c),
      userId: 'local',
      intervalMs: 1000,
    })
    await poller.runOnce()
    expect(events.length).toBe(0)
    expect(store.getByToolkit('local', 'slack')?.status).toBe('active')
  })

  it('updates last_polled_at timestamps even for still-active connections', async () => {
    store.upsert({ user_id: 'local', toolkit_slug: 'slack', connection_id: 'c1', auth_config_id: 'ac', status: 'active', created_at: 1, last_polled_at: 1 })
    const poller = new TokenExpiryPoller({
      composio: { listConnectedAccounts: async () => [{ id: 'c1', toolkit_slug: 'slack', status: 'active', auth_config_id: 'ac' }] },
      connectionStore: store,
      onConnectionExpired: () => {},
      userId: 'local',
      intervalMs: 1000,
    })
    await poller.runOnce()
    const after = store.getByToolkit('local', 'slack')!
    expect(after.last_polled_at).toBeGreaterThan(1)
  })

  it('start() + stop() can be called multiple times safely', async () => {
    const poller = new TokenExpiryPoller({
      composio: { listConnectedAccounts: async () => [] },
      connectionStore: store, onConnectionExpired: () => {},
      userId: 'local', intervalMs: 1_000_000,   // never auto-fires during test
    })
    poller.start()
    poller.start()
    poller.stop()
    poller.stop()
  })
})
```

- [ ] **Step 2: Implementation**

```typescript
// src/daemon/connectors/tokenExpiryPoller.ts
import type { ConnectionStore } from './connectionStore'
import type { Connection } from './types'

type ListedAccount = { id: string; toolkit_slug: string; status: string; auth_config_id: string }

export type TokenExpiryPollerDeps = {
  composio: { listConnectedAccounts(opts: { userId: string; statuses?: string[] }): Promise<ListedAccount[]> }
  connectionStore: ConnectionStore
  onConnectionExpired: (c: Connection) => void
  userId: string
  intervalMs?: number   // default 5 minutes
}

export class TokenExpiryPoller {
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false

  constructor(private deps: TokenExpiryPollerDeps) {}

  async runOnce(): Promise<void> {
    const remote = await this.deps.composio.listConnectedAccounts({ userId: this.deps.userId })
    const remoteById = new Map(remote.map(r => [r.id, r]))
    const local = this.deps.connectionStore.listByUser(this.deps.userId)
    const now = Date.now()
    for (const lc of local) {
      const r = remoteById.get(lc.connection_id)
      if (!r) {
        if (lc.status === 'active') {
          this.deps.connectionStore.markStatus(this.deps.userId, lc.toolkit_slug, 'expired')
          this.deps.onConnectionExpired({ ...lc, status: 'expired', expired_at: now })
        }
        continue
      }
      const normalized = (r.status ?? '').toUpperCase()
      if (normalized === 'ACTIVE') {
        this.deps.connectionStore.markStatus(this.deps.userId, lc.toolkit_slug, 'active')
      } else if (normalized === 'EXPIRED' || normalized === 'REVOKED') {
        if (lc.status === 'active') {
          this.deps.connectionStore.markStatus(this.deps.userId, lc.toolkit_slug, normalized === 'REVOKED' ? 'revoked' : 'expired')
          this.deps.onConnectionExpired({ ...lc, status: normalized.toLowerCase() as any, expired_at: now })
        }
      }
    }
  }

  start(): void {
    if (this.running) return
    this.running = true
    const interval = this.deps.intervalMs ?? 5 * 60 * 1000
    // Fire one immediately on start, then on the interval
    this.runOnce().catch(() => { /* swallow — daemon shouldn't crash on polling error */ })
    this.timer = setInterval(() => {
      this.runOnce().catch(() => {})
    }, interval)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.running = false
  }
}
```

- [ ] **Step 3: Run + commit**

```bash
bun test src/daemon/connectors/tokenExpiryPoller.test.ts
git add src/daemon/connectors/tokenExpiryPoller.ts src/daemon/connectors/tokenExpiryPoller.test.ts
git commit -m "feat(connectors): TokenExpiryPoller — polls Composio every 5 min, marks expired connections"
```

Expected: 4/4 pass.

---

## Task 8: ConnectServiceIntent

**Files:**
- Create: `src/daemon/connectors/connectServiceIntent.ts`
- Create: `src/daemon/connectors/connectServiceIntent.test.ts`

GREEN-tier agency intent: `connect_service` with arg `{ toolkit_slug }`. Handler calls `ConnectionFlow.connect()`, then triggers `ComposioSessionManager.addToolkit()` so the session knows about the new connection. Returns `ConnectFlowResult`.

- [ ] **Step 1: Test (4 tests, mirrors C.2.5 setupIntent pattern)**

```typescript
import { describe, it, expect } from 'bun:test'
import { createConnectServiceIntent } from './connectServiceIntent'

describe('connectServiceIntent', () => {
  it('has expected metadata (id=connect_service, tier=GREEN)', () => {
    const intent = createConnectServiceIntent({
      connectionFlow: { connect: async () => ({ status: 'success', toolkit_slug: 'slack', duration_ms: 100, connection_id: 'c' }) },
      sessionManager: { addToolkit: async () => {} },
    } as any)
    expect(intent.id).toBe('connect_service')
    expect(intent.tier).toBe('GREEN')
  })

  it('runs the full pipeline on success', async () => {
    const calls: any[] = []
    const intent = createConnectServiceIntent({
      connectionFlow: { connect: async (args: any) => { calls.push({ stage: 'connect', args }); return { status: 'success', toolkit_slug: args.toolkitSlug, duration_ms: 1, connection_id: 'c' } } },
      sessionManager: { addToolkit: async (slug: string) => { calls.push({ stage: 'addToolkit', slug }) } },
    } as any)
    const result = await intent.handler({ toolkit_slug: 'slack' })
    expect(result.status).toBe('success')
    expect(calls[0].stage).toBe('connect')
    expect(calls[1].stage).toBe('addToolkit')
  })

  it('throws when toolkit_slug is missing', async () => {
    const intent = createConnectServiceIntent({
      connectionFlow: { connect: async () => { throw new Error('should not be called') } },
      sessionManager: { addToolkit: async () => {} },
    } as any)
    await expect(intent.handler({} as any)).rejects.toThrow(/toolkit_slug/i)
  })

  it('does NOT call session.addToolkit when connection failed', async () => {
    const calls: any[] = []
    const intent = createConnectServiceIntent({
      connectionFlow: { connect: async () => ({ status: 'failed', toolkit_slug: 'slack', duration_ms: 1, error: 'oops' }) },
      sessionManager: { addToolkit: async (slug: string) => { calls.push(slug) } },
    } as any)
    const result = await intent.handler({ toolkit_slug: 'slack' })
    expect(result.status).toBe('failed')
    expect(calls.length).toBe(0)
  })
})
```

- [ ] **Step 2: Implementation**

```typescript
// src/daemon/connectors/connectServiceIntent.ts
import type { ConnectionFlow } from './connectionFlow'
import type { ComposioSessionManager } from './composioSessionManager'
import type { ConnectFlowResult, ToolkitSlug } from './types'

export type ConnectServiceIntentDeps = {
  connectionFlow: Pick<ConnectionFlow, 'connect'>
  sessionManager: Pick<ComposioSessionManager, 'addToolkit'>
  userId?: string   // defaults to 'local' for single-user daemon
}

export function createConnectServiceIntent(deps: ConnectServiceIntentDeps) {
  return {
    id: 'connect_service',
    tier: 'GREEN' as const,
    description: 'Connect a new third-party service (Slack, Gmail, GitHub, etc.) to KAIROS via Composio managed OAuth.',
    handler: async (args: { toolkit_slug: ToolkitSlug }): Promise<ConnectFlowResult> => {
      if (!args.toolkit_slug || typeof args.toolkit_slug !== 'string') {
        throw new Error('connect_service: toolkit_slug is required and must be a non-empty string')
      }
      const result = await deps.connectionFlow.connect({
        userId: deps.userId ?? 'local',
        toolkitSlug: args.toolkit_slug,
      })
      if (result.status === 'success') {
        await deps.sessionManager.addToolkit(args.toolkit_slug)
      }
      return result
    },
  }
}
```

- [ ] **Step 3: Run + commit**

```bash
bun test src/daemon/connectors/connectServiceIntent.test.ts
git add src/daemon/connectors/connectServiceIntent.ts src/daemon/connectors/connectServiceIntent.test.ts
git commit -m "feat(connectors): connect_service intent (GREEN tier) — wires ConnectionFlow + SessionManager"
```

Expected: 4/4 pass.

---

## Task 9: DisconnectServiceIntent

**Files:**
- Create: `src/daemon/connectors/disconnectServiceIntent.ts`
- Create: `src/daemon/connectors/disconnectServiceIntent.test.ts`

GREEN-tier intent: `disconnect_service` with arg `{ toolkit_slug }`. Looks up the connection in `ConnectionStore`, calls `composio.deleteConnection(connection_id)`, removes from local store, calls `sessionManager.removeToolkit()`.

- [ ] Same shape as Task 8. 3-4 tests covering: happy path, missing toolkit_slug, no active connection, partial failure (Composio delete succeeds but local store delete fails — should still cleanly degrade).
- [ ] Commit: `feat(connectors): disconnect_service intent — removes connection from Composio + local store`

Expected: 3-4 tests pass.

---

## Task 10: Daemon wire-up

**Files:**
- Modify: `src/daemon/types.ts` (add `composio?: ComposioConfig`)
- Modify: `src/daemon/config.ts` (env vars + defaults)
- Modify: `src/daemon/index.ts` (instantiate Composio subsystem)

- [ ] **Step 1: Read existing boot sequence in `index.ts`.** Find where `McpHost`, `IntentRegistry`, `Keychain`, `BrowserOpener`, `OAuthCallbackHandler` (from C.2.5 onboarding subsystem) are instantiated.

- [ ] **Step 2: Add the wiring** (after MCP + onboarding subsystems are up):

```typescript
import { ComposioClient } from './connectors/composioClient'
import { ConnectionStore } from './connectors/connectionStore'
import { ConnectionFlow } from './connectors/connectionFlow'
import { ComposioSessionManager } from './connectors/composioSessionManager'
import { TokenExpiryPoller } from './connectors/tokenExpiryPoller'
import { createConnectServiceIntent } from './connectors/connectServiceIntent'
import { createDisconnectServiceIntent } from './connectors/disconnectServiceIntent'

if (config.composio?.enabled !== false) {
  // Model A: API key comes from KAIROS Cloud config (production) or env var (dev/beta).
  // NEVER from local Keychain — Composio is a Cloud-managed shared resource, not user-owned.
  const apiKey = process.env.COMPOSIO_API_KEY ?? config.composio?.api_key
  if (!apiKey) {
    log.warn('[composio] no COMPOSIO_API_KEY set, skipping Composio subsystem. Set the env var to enable connectors.')
  } else {
    const composioClient = new ComposioClient({ apiKey })
    const connectionStore = new ConnectionStore(db)

    // Initial toolkits = already-active connections
    const userId = 'local'
    const activeConnections = connectionStore.listActive(userId)
    const initialToolkits = activeConnections.map(c => c.toolkit_slug)

    const sessionManager = new ComposioSessionManager({
      sdk: composioClient.sdk,
      userId,
      toolkits: initialToolkits,
      cachedSessionId: config.composio?.session_id,
      // EXPLICITLY enable manageConnections — even though it's the default, being explicit
      // documents the intent. This keeps Composio's COMPOSIO_MANAGE_CONNECTIONS meta-tool
      // available to the LLM agent, which is what enables in-chat auth (Path B in the
      // "Two coexisting connection paths" section).
      manageConnections: true,
    })
    await sessionManager.init()

    // Register Composio as an MCP server in McpHost — McpHost will use HttpMcpClient
    // because transport === 'http'.
    await mcpHost.addServer({
      id: 'composio',
      enabled: true,
      transport: 'http',
      url: sessionManager.getMcpUrl(),
      headers: sessionManager.getMcpHeaders(),
      tier_policy: { default: 'YELLOW' },   // most Composio tools are YELLOW-tier (write actions on user accounts)
    })

    // Connection flow uses the OAuth callback handler from C.2.5 onboarding subsystem
    const connectionFlow = new ConnectionFlow({
      composio: composioClient,
      browserOpener: onboarding.browserOpener,
      oauthCallbackHandler: onboarding.oauthCallbackHandler,
      connectionStore,
    })

    // Register intents
    intentRegistry.register(createConnectServiceIntent({ connectionFlow, sessionManager, userId }))
    intentRegistry.register(createDisconnectServiceIntent({ composio: composioClient, sessionManager, connectionStore, userId }))

    // Start expiry polling
    const expiryPoller = new TokenExpiryPoller({
      composio: composioClient,
      connectionStore,
      onConnectionExpired: (c) => {
        log.warn(`[composio] connection expired: ${c.toolkit_slug} — needs reconnect`)
        // Phase F UI will surface this via the inbox; for now just log
      },
      userId,
      intervalMs: config.composio?.poll_interval_ms ?? 5 * 60 * 1000,
    })
    expiryPoller.start()
  }
}
```

- [ ] **Step 3: Type-check + full test suite**

```bash
bunx tsc --noEmit
bun test
```

Expect: no new failures.

- [ ] **Step 4: Commit**

```bash
git add src/daemon/index.ts src/daemon/types.ts src/daemon/config.ts
git commit -m "feat(connectors): wire C.2.7 — Composio subsystem in daemon boot"
```

---

## Task 11: Smoke test — Connect a no-auth Composio toolkit

**Files:**
- Create: `scripts/smoke-composio.ts`

End-to-end smoke test that does NOT require user OAuth interaction. Uses one of Composio's no-auth toolkits (e.g., `weather`, `hackernews`, `time`, or similar — check `composio.toolkits.get({ auth_type: 'no_auth' })`).

Flow:
1. Boot a minimal Composio subsystem (ComposioClient + SessionManager + McpHost with HttpMcpClient)
2. List toolkits to confirm SDK works
3. Connect a no-auth toolkit via ConnectionFlow (should complete in <2s with no browser)
4. Wait for McpHost to register the new server
5. Call one tool via the MCP path
6. Assert tool returned a non-error result
7. Disconnect the toolkit
8. Confirm McpHost no longer has it

- [ ] Print results, commit, **DO NOT YET tag**.

---

## Task 12: Validation gate — Full end-to-end with a real user-auth toolkit

**Files:**
- Create: `scripts/validate-phase-c2-7.ts`

The validation gate. Two modes (same pattern as C.2.5/C.2.6 validation):

**Mode 1 — Scripted/Simulated:** Drive a connection flow against Composio's managed OAuth using a programmatically-controlled browser substitute that auto-approves. Or, if Composio doesn't expose a test mode, fall back to a no-auth toolkit (e.g., HackerNews / weather) and assert the full pipeline succeeds without user interaction.

**Mode 2 — User-interactive (skippable via `--no-interactive`):** Same as Mode 1 but for a real OAuth toolkit (Slack or Notion). User generates token by clicking Allow in their browser. Asserts end-to-end: connection becomes active, MCP server registers tools, a smoke tool call succeeds, expiry poller picks up the connection on next tick.

**Assertions:**
- ConnectionFlow.connect returns status=success
- ConnectionStore has the new row with status=active
- McpHost.listAllTools() includes at least one `composio::*` tool
- The smoke tool call returns `ok: true`
- TokenExpiryPoller.runOnce() does NOT downgrade the connection
- Disconnect cleanly removes both the local store row and the Composio remote connection

**Output:**
```
=== KAIROS C.2.7 Validation ===
Started: <ISO>

[Mode 1] No-auth toolkit (hackernews)...
  ✓ ConnectionFlow returned success in 1.2s
  ✓ McpHost registered 4 hackernews tools
  ✓ Tool call hackernews::get_user_info returned ok=true
  ✓ TokenExpiryPoller left connection active
  ✓ Disconnect removed connection from local store + Composio

[Mode 2 — user-interactive] Skip via --no-interactive (or run with consent)
  ...

=== Gate verdict: PASS ✓ ===
```

- [ ] Run, append CHANGELOG entry for `v0.3.5-phase-c2-7`, commit, tag.

---

## Virality amendments — folded in based on Composio feature brainstorm (2026-05-27)

Three small additions punch above their weight for "people want to share this" moments. All folded into existing tasks:

### V1 — Two system-prompt directives (30 min, enables Hooks 2 + 3)

When KAIROS's agency layer invokes a Composio-backed agent (any LLM call that should be able to use Composio tools), the system prompt MUST include these two sentences:

```
When you are unsure which tool to use for a task, call COMPOSIO_SEARCH_TOOLS
with a description of what you need before concluding you cannot help.

When a user's request touches multiple apps or services, use
COMPOSIO_MULTI_EXECUTE_TOOL to chain the required actions in a single
request rather than executing them one at a time.
```

**Where to wire**: in the agency layer's system-prompt builder (find via `grep -rn "system_blocks" src/daemon/agency/`). These directives go in the persona/standing-orders block (cache_hint: 'long' — cached). Folded into **Task 10 (daemon wire-up)**.

### V2 — `postConnectionAnnouncement()` in ConnectionFlow (~2h, makes connection moment viral)

After `waitForConnection()` resolves with ACTIVE status in **Task 3 (ConnectionFlow.connect)**, call a new private method `postConnectionAnnouncement(toolkit_slug)` that:

1. Calls `composio.toolkits.get(toolkit_slug)` to fetch the toolkit's tool list
2. Picks 3 representative tools (prefer common-verb ones: `send`, `create`, `list`, `search`)
3. Builds a voice-friendly announcement: `"<Toolkit> connected. I can now <verb1>, <verb2>, and <verb3>."`
4. Hands it off to the daemon's voice/inbox surface (whatever Phase E + F provide)
5. Optionally suggests a first action ("Want me to show you what's waiting on your review?")

This is the difference between "Slack connected ✓" (status update) and "Slack connected. I can now send messages, list channels, and search threads. Want me to check who's online?" (introduction).

### V3 — `DestructiveToolGuard` in McpHost (~2h, builds trust + shareability)

In **Task 5 (McpHost transport branching)**, also extend the tool-invocation path with a destructive-action guard. Before invoking ANY tool whose `qualified_id` matches `/delete|remove|archive|trash|purge|drop/i`:

1. Build a human-readable description of what's about to happen (from tool name + args — e.g., "delete 12 Linear issues matching 'old'").
2. Emit a "DESTRUCTIVE_CONFIRMATION_NEEDED" agency event with a 30-second timeout.
3. Phase E voice surface speaks the confirmation prompt and listens for "yes" / "no" response.
4. If "yes" within 30s → execute. If "no" or timeout → abort the tool call with a cancellation result.

This works WITHOUT depending on Composio surfacing the `destructiveHint` tag — pattern-match on tool names ourselves. Hooks in as a `McpHost.beforeInvokeTool` callback (add this hook in Task 5).

The viral moment: KAIROS asks before deleting things, every time. Users SHARE this because it's the opposite of the "AI deleted my prod database" horror stories.

---

## Out of scope — features intentionally NOT in v1

**Custom Toolkits / Custom Tools API** — Looks like the "enterprise superpower" feature but is a trap for C.2.7:
- Custom tools are NOT yet supported in the MCP path (Composio docs say "coming soon" as of 2026-05). Using them requires switching from `session.mcp.url` to `session.tools()` native mode — a full architectural rework of the ToolRouter pattern we're built on.
- The viral use case it seems to unlock ("KAIROS connects to your internal CRM") is better served by `COMPOSIO_SEARCH_TOOLS` discovering tools within Composio's 500+ catalog.
- Real target users (enterprises with internal tools) are NOT Phase E's viral audience.

Defer until Composio ships MCP support for custom toolkits AND KAIROS has a Phase F config surface where non-devs can describe their APIs.

**Workbench file processing** — Phase F+ feature. Needs a separate session config (different `workbench: { enable: true }` session) + careful prompt-level restriction to prevent `COMPOSIO_REMOTE_BASH_TOOL` misuse. Not worth the security complexity in v1.

**Files mount** — Same. Defer to a phase where there's a clear KAIROS use case that needs sandboxed file ops.

---

## Task count + LOC summary (post-Model-A simplification)

| # | Task | LOC |
|---|---|---|
| 0 | Deps + types | 100 |
| 1 | ComposioClient | 200 |
| 2 | ConnectionStore | 150 |
| 3 | ConnectionFlow + postConnectionAnnouncement (V2) | 250 |
| 4 | HttpMcpClient | 200 |
| 5 | McpHost transport branching + DestructiveToolGuard (V3) | 200 |
| 6 | ComposioSessionManager | 200 |
| 7 | TokenExpiryPoller | 150 |
| 8 | connect_service intent | 100 |
| 9 | disconnect_service intent | 100 |
| 10 | Daemon wire-up + V1 system prompt directives | 150 |
| 11 | Smoke test (scripts/smoke-composio.ts) | 200 |
| 12 | Validation gate (scripts/validate-phase-c2-7.ts) | 300 |
| | **Total** | **~2,300 LOC + ~700 LOC tests = ~3,000 LOC** |

Virality amendments add ~300 LOC (+~10%) but unlock 3 demo-able moments: dynamic tool discovery, multi-app voice chaining, rich connection announcements, and destructive-action confirmations.

---

## Self-review checklist

- [ ] **No deprecated APIs:** Code uses `connectedAccounts.link()`, NOT `initiate()`. Code uses ToolRouter session pattern, NOT direct OAuth URL construction.
- [ ] **Managed auth only:** No code path requires KAIROS-team-registered OAuth credentials. All toolkit configs use `type: 'use_composio_managed_auth'`.
- [ ] **Localhost callback reused:** No new OAuth handler — `OAuthCallbackHandler` from C.2.5 is the single source of truth for capturing redirects.
- [ ] **Single account per toolkit:** `ConnectionStore` uses `PRIMARY KEY (user_id, toolkit_slug)` to enforce this at the schema level.
- [ ] **No Cloud dependency:** Daemon works fully standalone. Expiry detection is polling-based.
- [ ] **MCP host extended cleanly:** Existing `mcpClient.ts` (stdio) unchanged. `HttpMcpClient` is parallel, not replacement. McpHost branches on `config.transport`.
- [ ] **Cost monitoring hook:** While not implemented as a feature in this phase, `executeTool` calls flow through Composio's API and are billed per-call. CacheStats (C.2.6) could be extended later to track them.

---

## Risks flagged

1. **Composio's SDK API may differ slightly from research-extracted shape.** The implementer should verify each method signature against `@composio/core` source in `node_modules` after install. The wrapping pattern in `ComposioClient` is designed to absorb minor signature changes without rippling.

2. **`session.update()` behavior for adding toolkits incrementally.** Some SDK versions may require a full re-create rather than incremental update. The `ComposioSessionManager.addToolkit()` method has a fallback to recreation. Verify in practice.

3. **MCP transport — Streamable HTTP vs SSE.** Composio's MCP server may use either depending on the spec version it implements. The `HttpMcpClient` currently uses `StreamableHTTPClientTransport`. If Composio's server speaks SSE only, swap to `SSEClientTransport`. Both are exported from `@modelcontextprotocol/sdk/client/`.

4. **Composio May 2026 security incident.** Pending their Zero Trust KMS rollout, users' connected tokens are stored in Composio's standard infrastructure. KAIROS should display a transparent note to users about this when they first connect a service. Phase F UI will own this messaging.

5. **Polling cost at scale.** TokenExpiryPoller fires `listConnectedAccounts` every 5 min per user. At 10K users that's ~2M list-API calls/month. **Important distinction:** these are management API calls, NOT tool-call billing — they count against Composio's per-org rate limit (e.g., 20K req/10min on Starter tier), NOT against the 2M tool-call quota of Production. The risk is hitting the rate limit ceiling, not the billing ceiling. Mitigation: at scale, KAIROS Cloud could aggregate poll requests across users into a single batched call (e.g., poll the whole org's connections, then fan out updates to individual daemons).

6. **`ToolkitInfo.managed_auth_supported` detection.** The current implementation guesses based on auth scheme. If Composio's API exposes an explicit field for this, the implementer should switch to using it.

---

## Future phase: C.2.8 — Proactive Remote Monitoring + Cloud Relay (deferred)

When KAIROS Cloud exists, add the remote event monitoring layer. Sketch of scope:

**Cloud-side (the missing infrastructure):**
- WebSocket server (e.g., Cloudflare Durable Objects) that daemons connect to
- Per-user auth (long-lived token issued at signup, stored in daemon Keychain `com.kairos.cloud / token`)
- `composio.triggers.subscribe()` listener on Cloud (one Pusher connection for the whole project)
- Per-user event routing — incoming event's `userId` matched against connected daemons
- Offline event queueing (~24h retention) for daemons that disconnect

**Daemon-side:**
- WebSocket client to KAIROS Cloud
- TriggerSubscriber that receives routed events
- MonitoringRuleStore (SQLite): `(rule_id, trigger_id, user_id, filter_fn, action_intent_id)`
- TriggerRouter: incoming event → matches rules → applies filters → invokes notify_user agency intent
- New voice intents: `create_monitoring_rule`, `list_monitoring_rules`, `delete_monitoring_rule`
- Reconciliation on daemon restart: query Cloud for active rules, sync local store

**Estimated size:** ~1,500-2,000 LOC (~10-12 tasks) + the Cloud relay setup (~200-300 LOC, separate deployment). Cloud hosting cost: ~$10-30/mo at 1K-10K users on Cloudflare Workers.

**Critical Composio constraint** to remember: Gmail triggers are POLLED (~15-min cadence). Sub-15-minute Gmail awareness requires direct Google Pub/Sub integration, NOT Composio. Other toolkits (Slack, GitHub, Linear, Notion, Calendar) are real-time via webhooks.

**Use case validation gate for C.2.8:**
- "Tell me when Mark Cuban emails" — works within 15 min latency
- "Notify when someone @mentions me in Slack" — real-time
- "Alert when a PR is opened on kairos-sandbox" — real-time
- "Notify when a Linear issue is assigned to me" — real-time

---

## Execution Handoff

Plan saved to `docs/superpowers/plans/2026-05-27-phase-c2-7-composio-connectors.md`.

**Recommended execution:** Subagent-driven development, same pattern as C.2.5 + C.2.6. ~2-3 sessions of 60-90 min each at the C.2.5/C.2.6 cadence.

After C.2.7 ships (`v0.3.5-phase-c2-7`), the reactive connector layer is complete (500+ integrations callable on user request). Next options:
- **C.2.8 — Proactive Remote Monitoring** (deferred per Path 3 decision; ships when Cloud exists)
- **C.3 — Magentic-One orchestrator + smolagents CodeAgent + AWM + Persona-Awareness** (existing roadmap next phase)
- **Phase D / E / F** per existing roadmap

Going to C.3 first means the agency layer becomes much smarter BEFORE proactive remote monitoring lands — when C.2.8 finally adds "tell me when X happens", the agent reasoning about whether to interrupt the user (Earned Interrupt + Persona-Awareness) is already production-grade.
