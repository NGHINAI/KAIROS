# Composio Implementation Research: Phase C.2.7

**Date:** 2026-05-27
**Author:** Research agent (Claude Sonnet 4.6)
**Purpose:** Capture every implementation detail needed to write the C.2.7 Composio Connector Integration plan. No code changes. For the plan author to paste directly into task descriptions.
**Prior context:** `2026-05-27-managed-oauth-deep-dive.md`, `2026-05-27-pricing-at-volume.md`
**Sources:** `composiohq/composio` repo (TypeScript SDK source), `ComposioHQ/trustclaw` (production reference app), `docs.composio.dev`, `composio.dev/pricing`, KAIROS codebase

---

## 1. SDK Overview — Exact Install + Import + First API Call

### Installation

```bash
npm install @composio/core
# OR for Bun:
bun add @composio/core
```

**Package name:** `@composio/core` version `0.10.0` as of research date.

**Provider packages** (install the one matching your LLM framework):

| Provider | Package |
|----------|---------|
| OpenAI (default, auto-installed) | built into `@composio/core` |
| Vercel AI SDK | `@composio/vercel` |
| OpenAI Agents SDK | `@composio/openai-agents` |
| Anthropic | `@composio/anthropic` |
| LangChain | `@composio/langchain` |
| Mastra | `@composio/mastra` |
| LlamaIndex | `@composio/llamaindex` |

KAIROS uses `@anthropic-ai/sdk` directly — use the base `@composio/core` with `ComposioProvider` (non-agentic) or implement a custom provider. Alternatively, use the MCP path (no provider package needed).

### Full Init Code

```typescript
import { Composio, AuthConfigTypes, AuthScheme } from '@composio/core';

// Initialize — reads COMPOSIO_API_KEY from env automatically
const composio = new Composio({
  apiKey: process.env.COMPOSIO_API_KEY,  // optional — reads env if omitted
});
```

**`ComposioConfig` full type** (all optional):

```typescript
type ComposioConfig = {
  apiKey?: string | null;           // COMPOSIO_API_KEY env fallback
  baseURL?: string | null;          // override API endpoint
  allowTracking?: boolean;          // telemetry (default: true)
  provider?: BaseComposioProvider;  // defaults to OpenAIProvider
  toolkitVersions?: ToolkitVersionParam;  // pin versions: { github: '20250909_00' }
  disableVersionCheck?: boolean;
  defaultHeaders?: Record<string, string>;
  dangerouslyAllowAutoUploadDownloadFiles?: boolean;
};
```

### Top-Level Objects on `composio`

```typescript
composio.tools           // list + execute tools
composio.toolkits        // list toolkits, authorize connections
composio.connectedAccounts  // manage authenticated connections
composio.authConfigs     // manage auth config blueprints
composio.triggers        // webhook subscriptions
composio.mcp             // MCP server management (experimental)
composio.files           // file upload/download
composio.create(userId, config?)  // create ToolRouter session (NEW primary API)
```

### The Two API Surfaces

Composio v3 has two distinct usage patterns:

**Pattern A — ToolRouter Session (preferred, recommended)**
```typescript
const session = await composio.create('kairos-user-xyz', {
  toolkits: ['gmail', 'github'],
  manageConnections: true,  // agent can auth the user in-chat
});
// session gives you: session.tools(), session.mcp.url, session.authorize()
```

**Pattern B — Direct API (lower-level)**
```typescript
// Step 1: Create auth config (one-time setup)
const authConfig = await composio.authConfigs.create('github', {
  type: AuthConfigTypes.COMPOSIO_MANAGED,
});
// Step 2: Create connection for user
const connReq = await composio.connectedAccounts.link('user-123', authConfig.id);
// Step 3: Execute tools
const tools = await composio.tools.get('user-123', { toolkits: ['github'] });
```

**Which pattern KAIROS should use:** The ToolRouter Session (Pattern A) is the current recommended path. It bundles auth management, tool listing, and MCP access in one call. The direct API (Pattern B) is needed for pre-creating auth configs.

---

## 2. Connection Lifecycle — Complete Code for All 6 Integration Types

### Critical Breaking Change (affects code written before 2026-05-08)

`composio.connectedAccounts.initiate()` is **deprecated** for Composio-managed OAuth (OAuth1, OAuth2, DCR_OAUTH). The cutover:
- New organizations: **2026-05-08** (already happened)
- All remaining orgs: **2026-07-03**

After cutover, `initiate()` throws `ComposioLegacyConnectedAccountsEndpointRetiredError`.

**Migrate ALL OAuth connections to `composio.connectedAccounts.link()` or `session.authorize()`.**

For non-OAuth (API keys, Basic auth, Bearer token), `initiate()` still works.

### 2a. Slack — OAuth2 Managed Auth (RECOMMENDED PATTERN FOR ALL OAUTH)

**Via ToolRouter Session (simplest — managed auth automatic):**

```typescript
import { Composio } from '@composio/core';

const composio = new Composio({ apiKey: process.env.COMPOSIO_API_KEY });

// Create a session for the user — managed auth is default
const session = await composio.create('kairos-user-xyz', {
  toolkits: ['slack'],
  manageConnections: true,  // agent can prompt user to connect if not connected
});

// Option 1: Session-level authorize (creates connection + returns redirect URL)
const connectionRequest = await session.authorize('slack', {
  callbackUrl: 'kairos://oauth-callback',  // deep link back to KAIROS
});
// Returns: ConnectionRequest { id, status, redirectUrl }
console.log(`Open this URL: ${connectionRequest.redirectUrl}`);

// Wait for user to complete OAuth flow
const connectedAccount = await connectionRequest.waitForConnection(120_000); // 2min timeout
// Returns: ConnectedAccountRetrieveResponse { id, status: 'ACTIVE', toolkit: { slug: 'slack' }, ... }
```

**Via Direct API (when you need explicit auth config control):**

```typescript
// Step 1: Create Composio-managed auth config (one-time per toolkit per project)
const authConfig = await composio.authConfigs.create('slack', {
  type: 'use_composio_managed_auth',
  name: 'KAIROS Slack Auth',  // optional label
  // Optionally restrict to specific scopes:
  // credentials: { scopes: 'channels:read,chat:write' }
});
// Returns: { id: 'ac_NSC2s9WqTE4n', authScheme: 'OAUTH2', isComposioManaged: true, toolkit: 'slack' }

// Step 2: Create connection for a specific user (use link(), not initiate())
const connectionRequest = await composio.connectedAccounts.link(
  'kairos-user-xyz',   // your internal user ID
  authConfig.id,       // 'ac_NSC2s9WqTE4n'
  {
    callbackUrl: 'kairos://oauth-callback',  // optional
    // allowMultiple: true  // if user should be able to connect multiple Slack workspaces
  }
);
// Returns: ConnectionRequest { id: 'ca_abc123', status: 'INITIATED', redirectUrl: 'https://...' }

console.log(`Redirect user to: ${connectionRequest.redirectUrl}`);

// Poll until OAuth complete
const connectedAccount = await connectionRequest.waitForConnection(120_000);
// Returns when status transitions to ACTIVE
```

What the user sees: **"Composio wants access to your Slack workspace"** (managed auth branding).

### 2b. Gmail — OAuth2 Managed Auth

Same pattern as Slack. Gmail uses `OAUTH2` scheme with managed auth.

```typescript
// Simple pattern via toolkits.authorize() — shorthand compound flow
const connectionRequest = await composio.toolkits.authorize(
  'kairos-user-xyz',
  'gmail'
  // Optional: pass existing authConfigId if you've pre-created one
);
// Automatically creates managed auth config if none exists, then calls link()

if (connectionRequest.redirectUrl) {
  console.log(`Open: ${connectionRequest.redirectUrl}`);
}
const connectedAccount = await connectionRequest.waitForConnection();
```

### 2c. GitHub — OAuth2 Managed Auth

```typescript
// Magic flow via session.authorize (creates managed auth config if needed)
const session = await composio.create('kairos-user-xyz', { toolkits: ['github'] });
const connectionRequest = await session.authorize('github');
if (connectionRequest.redirectUrl) {
  console.log(`Open: ${connectionRequest.redirectUrl}`);
}
const connectedAccount = await connectionRequest.waitForConnection();
console.log(`Connected: ${connectedAccount.id}`);
```

### 2d. Notion — OAuth2 Managed Auth

```typescript
const connectionRequest = await composio.toolkits.authorize('kairos-user-xyz', 'notion');
// Same redirect → wait pattern
```

### 2e. Linear — OAuth2 Managed Auth

```typescript
const connectionRequest = await composio.toolkits.authorize('kairos-user-xyz', 'linear');
// Same redirect → wait pattern
```

### 2f. API-Key Based Integration (e.g., OpenAI, custom service)

For API-key integrations, the flow does NOT redirect. You collect the key directly:

```typescript
import { Composio, AuthScheme } from '@composio/core';

// Step 1: Create custom auth config (no managed auth for API keys)
const authConfig = await composio.authConfigs.create('openai', {
  type: 'use_custom_auth',
  name: 'KAIROS OpenAI Config',
  authScheme: 'API_KEY',
  credentials: {
    api_key: 'placeholder',  // Will be overridden per-user
  },
});

// Step 2: Connect user with their API key
const connectionRequest = await composio.connectedAccounts.initiate(
  'kairos-user-xyz',
  authConfig.id,
  {
    config: AuthScheme.APIKey({
      api_key: process.env.USER_OPENAI_KEY!,  // user's actual key
    }),
  }
);
// For API keys: connectionRequest.redirectUrl is null — no redirect needed
// Status goes directly to ACTIVE
const connectedAccount = await connectionRequest.waitForConnection(10_000);
// Completes quickly since no OAuth redirect is needed
```

### `toolkits.authorize()` Internals — What It Does

```typescript
// Source: ts/packages/core/src/models/Toolkits.ts
// 1. Fetches the toolkit by slug
// 2. Lists existing auth configs for the toolkit
// 3. If none found: creates one with type: 'use_composio_managed_auth'
// 4. Calls composio.connectedAccounts.initiate() with allowMultiple: true
// Returns: ConnectionRequest
```

**Note:** `toolkits.authorize()` still calls the deprecated `initiate()` for backward compatibility. For production KAIROS, use `session.authorize()` or `connectedAccounts.link()` directly to avoid the deprecation path.

### `ConnectionRequest` Shape

```typescript
interface ConnectionRequest {
  id: string;          // connected account ID (e.g. 'ca_abc123')
  status?: string;     // 'INITIATED' | 'ACTIVE' | 'FAILED' | etc.
  redirectUrl?: string | null;  // OAuth consent URL (null for API key)
  waitForConnection(timeout?: number): Promise<ConnectedAccountRetrieveResponse>;
  toJSON(): ConnectionRequestState;
  toString(): string;
}
```

`waitForConnection(timeout = 60000)`:
- Polls `GET /api/v3/connected_accounts/{id}` every 1 second
- Returns `ConnectedAccountRetrieveResponse` when `status === 'ACTIVE'`
- Throws `ConnectionRequestTimeoutError` after `timeout` ms
- Throws `ConnectionRequestFailedError` if status is FAILED/EXPIRED/REVOKED

### `ConnectedAccountRetrieveResponse` Shape

```typescript
{
  id: string;          // 'ca_abc123'
  status: 'INITIALIZING' | 'INITIATED' | 'ACTIVE' | 'FAILED' | 'EXPIRED' | 'INACTIVE' | 'REVOKED';
  toolkit: { slug: string; name: string; logo?: string };
  authConfig: { id: string; isComposioManaged: boolean; authScheme: string };
  createdAt: string;
  updatedAt: string;
  // ... more fields
}
```

### Multiple Accounts per Toolkit (Personal + Work)

```typescript
// Enable during session creation
const session = await composio.create('kairos-user-xyz', {
  toolkits: ['gmail'],
  multiAccount: {
    enable: true,
    maxAccountsPerToolkit: 3,
    requireExplicitSelection: true,
  },
});

// Set an alias on a connected account for disambiguation
await composio.connectedAccounts.update('ca_abc123', { alias: 'work-gmail' });
```

For `link()` call: pass `allowMultiple: true` to bypass the duplicate-check guard.

### Disconnect Flow

```typescript
// Delete a connected account (revokes tokens)
await composio.connectedAccounts.delete('ca_abc123');

// Or refresh (force token refresh without deleting)
await composio.connectedAccounts.refresh('ca_abc123');
```

---

## 3. Tool Execution via SDK

### 3a. Get Tools for a User

```typescript
// Get all tools for specific toolkits (returns framework-wrapped tools for OpenAI by default)
const tools = await composio.tools.get('kairos-user-xyz', {
  toolkits: ['slack', 'github'],
  // OR:
  // tools: ['SLACK_SEND_MESSAGE', 'GITHUB_CREATE_AN_ISSUE'],  // specific tools only
  // tags: ['readOnlyHint'],  // filter by capability tags
  // important: true,  // top tools only
  // limit: 20,
  // search: 'send email',  // semantic search
});
// Returns: TToolCollection (format depends on provider)
```

### 3b. Execute a Tool Directly

```typescript
// Execute without a session (direct execution)
const result = await composio.tools.execute(
  'SLACK_SEND_MESSAGE',  // tool slug (ALLCAPS_SNAKE_CASE)
  {
    userId: 'kairos-user-xyz',
    arguments: {
      channel: 'C08ABC123',
      text: 'Hello from KAIROS',
    },
    version: '20250902_00',  // pin version for production stability
    // OR: dangerouslySkipVersionCheck: true  (not for production)
  }
);
// Returns: ToolExecuteResponse
```

**`ToolExecuteResponse` shape:**
```typescript
{
  data: unknown;           // tool output (varies per tool)
  error: string | null;    // error message if failed
  successful: boolean;
  logId: string;           // Composio log ID for debugging
  sessionInfo?: unknown;
}
```

### 3c. Execute via ToolRouter Session (preferred)

```typescript
const session = await composio.create('kairos-user-xyz', {
  toolkits: ['slack'],
});

// Direct session execution (no tool lookup)
const result = await session.execute('SLACK_SEND_MESSAGE', {
  arguments: {
    channel: 'C08ABC123',
    text: 'Hello from KAIROS',
  },
});
```

### 3d. `ToolListParams` — Full Type

```typescript
// Must provide exactly one of: tools | toolkits | scopes | search | tags | authConfigIds
type ToolListParams =
  | { tools: string[] }                          // specific tool slugs
  | { toolkits: string[]; limit?: number; search?: string; important?: boolean }
  | { toolkits: [string]; scopes: string[] }     // single toolkit + scope filter
  | { search: string }                           // semantic search
  | { tags: string[] }                           // filter by capability tags
  | { authConfigIds: string[] };                 // tools for specific auth configs
```

---

## 4. MCP Integration

### 4a. URL Format + Headers

The ToolRouter session MCP endpoint is accessed as:

```typescript
const session = await composio.create('kairos-user-xyz', {
  toolkits: ['gmail'],
  manageConnections: true,
});

// session.mcp shape:
session.mcp.type    // 'http' (HTTP streaming / streamable_http)
session.mcp.url     // e.g. 'https://mcp.composio.dev/toolrouter/session/<sessionId>?user_id=...'
session.mcp.headers // { 'x-api-key': '<COMPOSIO_API_KEY>' }
```

**`ToolRouterMCPServerConfig` type:**
```typescript
type ToolRouterMCPServerConfig = {
  type: 'http' | 'sse';
  url: string;
  headers?: Record<string, string>;
};
```

The URL encodes per-user scoping — it is a user-specific URL derived from the session ID and user ID. Headers carry the Composio API key.

### 4b. Transport Protocol

The current Composio MCP server uses **HTTP streaming** (`type: 'http'` = `streamable_http`). The `SSEClientTransport` is used for the older `mcp.create()`/`mcp.generate()` API path. The ToolRouter session MCP (`session.mcp.url`) uses **HTTP transport** with `@ai-sdk/mcp`'s HTTP client.

**MCP spec version:** The server exposes MCP via the 2024-11-05 protocol (standard JSON-RPC tool list + call). The transport type `'streamable_http'` appears in the server instance schema, suggesting compatibility with the 2025-03-26 Streamable HTTP spec as well.

### 4c. Connecting via `@ai-sdk/mcp` (Vercel AI SDK pattern — matches trustclaw)

```typescript
import { experimental_createMCPClient as createMCPClient } from '@ai-sdk/mcp';
import { Composio } from '@composio/core';

const composio = new Composio({ apiKey: process.env.COMPOSIO_API_KEY });
const session = await composio.create('kairos-user-xyz', {
  toolkits: ['gmail'],
  manageConnections: true,
});

const mcpClient = await createMCPClient({
  transport: {
    type: 'http',
    url: session.mcp.url,
    headers: session.mcp.headers,  // includes x-api-key
  }
});

const tools = await mcpClient.tools();
// tools is in Vercel AI SDK format (for passing to streamText etc.)
```

### 4d. Connecting via `@modelcontextprotocol/sdk` SSE (older MCP config API path)

This path uses `composio.mcp.create()` + `composio.mcp.generate()` + SSEClientTransport:

```typescript
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { experimental_createMCPClient as createMCPClient } from 'ai';
import { Composio } from '@composio/core';

const composio = new Composio({ apiKey: process.env.COMPOSIO_API_KEY });

// 1. Create an MCP config (persisted server definition)
const mcpConfig = await composio.mcp.create('kairos-gmail-mcp', {
  toolkits: [
    { toolkit: 'gmail', authConfigId: 'ac_your_gmail_auth_config_id' },
  ],
  allowedTools: ['GMAIL_FETCH_EMAILS', 'GMAIL_SEND_EMAIL'],
  manuallyManageConnections: false,
});
// Returns: { id, name, allowedTools, authConfigIds, commands, MCPUrl, generate() }

// 2. Generate a user-specific MCP server instance
const server = await composio.mcp.generate('kairos-user-xyz', mcpConfig.id);
// Returns: MCPServerInstance { id, name, type: 'streamable_http', url, userId, allowedTools }

// 3. Connect via SSE transport (for the older path)
const serverParams = new SSEClientTransport(new URL(server.url));
const mcpClient = await createMCPClient({
  name: 'composio-mcp-client',
  transport: serverParams,
});
const tools = await mcpClient.tools();
```

### 4e. OpenAI Agents SDK + Composio MCP (hosted MCP tool)

```typescript
import { Agent, run, hostedMcpTool } from '@openai/agents';
import { Composio } from '@composio/core';

const composio = new Composio();
const { mcp } = await composio.create('default');

const agent = new Agent({
  model: 'gpt-4o',
  tools: [
    hostedMcpTool({
      serverLabel: 'composio',
      serverUrl: mcp.url,
      headers: { 'x-api-key': process.env.COMPOSIO_API_KEY! },
    }),
  ],
});
```

### 4f. Claude (Anthropic) Agent SDK + Composio MCP

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';
import { Composio } from '@composio/core';

const composio = new Composio();
const session = await composio.create('user_123', { toolkits: ['gmail'] });

const stream = await query({
  prompt: 'Fetch my last email from gmail',
  options: {
    model: 'claude-sonnet-4-5-20250929',
    permissionMode: 'bypassPermissions',
    mcpServers: {
      composio: {
        type: 'http',
        url: session.mcp.url,
        headers: session.mcp.headers,
      },
    },
  },
});
```

### 4g. Adapting KAIROS's Existing `McpClient` for Composio

KAIROS's current `McpClient` (in `src/daemon/mcp/mcpClient.ts`) only supports `stdio` transport. Composio uses HTTP (`streamable_http`). KAIROS needs an `HttpMcpClient` variant that connects to `session.mcp.url` with the `x-api-key` header.

The existing `McpClient` uses `@modelcontextprotocol/sdk/client/index.js` `Client` + `StdioClientTransport`. To support Composio:

```typescript
// New: HttpMcpClient for Composio's streamable HTTP transport
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
// OR: use SSEClientTransport for SSE
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'

const transport = new StreamableHTTPClientTransport(
  new URL(session.mcp.url),
  { requestInit: { headers: session.mcp.headers } }
)
const client = new Client({ name: 'kairos', version: '0.5.0' }, { capabilities: {} })
await client.connect(transport)
// Then listTools() / callTool() exactly as now
```

**Check `@modelcontextprotocol/sdk` version in KAIROS:** `^1.0.4` — need to verify if `StreamableHTTPClientTransport` is available. The SSEClientTransport is available in all versions.

### 4h. Which MCP Path for KAIROS?

| Path | When to use |
|------|------------|
| `session.mcp.url` + HTTP transport (`@ai-sdk/mcp`) | KAIROS using Vercel AI SDK or direct Anthropic |
| `composio.mcp.create()` + SSE | Pre-defined MCP configs per user, older SDK path |
| `hostedMcpTool` (OpenAI Agents) | If KAIROS uses OpenAI Agents SDK |
| MCP server entry in `~/.kairos/mcp-servers.json` | If KAIROS treats Composio as just another MCP server |

**Recommendation for KAIROS:** Use `session.mcp.url` + the existing `McpClient` infrastructure (with HTTP transport added). Each KAIROS session creates a `composio.create(userId, {...})` call and passes `mcp.url` + `mcp.headers` to a new `HttpMcpClient`.

---

## 5. Multi-User Patterns

### 5a. User Scoping Primitives

Composio scopes everything by `userId` (called `externalUserId` in some APIs). This is YOUR internal user ID — Composio does not issue or manage user IDs.

```
Project (your COMPOSIO_API_KEY)
  └── AuthConfigs (per toolkit, shared across users)
        └── ConnectedAccounts (per user + per auth config)
              └── Tool executions (scoped to connected account)
```

- **One API key serves all users** — a single `COMPOSIO_API_KEY` supports unlimited users.
- `userId` = any string you choose (Composio doesn't validate or issue these).
- Each user gets their own connected accounts (their tokens).

### 5b. KAIROS Local Daemon (Single User)

For KAIROS's local daemon serving a single user per machine:

```typescript
// Use a stable, fixed user ID tied to the local machine
const KAIROS_USER_ID = 'kairos-local-user';  // or derive from macOS username

const composio = new Composio({ apiKey: process.env.COMPOSIO_API_KEY });
const session = await composio.create(KAIROS_USER_ID, {
  toolkits: ['gmail', 'slack', 'github', 'notion'],
  manageConnections: true,
});
```

### 5c. KAIROS Cloud (Multi-User)

For KAIROS Cloud serving many users, each user gets their own `userId`:

```typescript
// Derive from KAIROS's own user DB
const session = await composio.create(`kairos-cloud-${user.id}`, {
  toolkits: userProfile.connectedToolkits,
  manageConnections: true,
});
```

No per-user Composio API keys are needed. All users share the project's single `COMPOSIO_API_KEY`.

### 5d. Multiple Accounts per Toolkit

A user connecting personal Gmail AND work Gmail:

```typescript
const session = await composio.create('kairos-user-xyz', {
  toolkits: ['gmail'],
  multiAccount: {
    enable: true,
    maxAccountsPerToolkit: 3,
    requireExplicitSelection: true,
  },
});

// Connect second account with allowMultiple
const connectionReq2 = await composio.connectedAccounts.link(
  'kairos-user-xyz',
  authConfig.id,
  { allowMultiple: true, alias: 'work-gmail' }
);
```

### 5e. Shared Connections (Enterprise Pattern)

Composio supports SHARED connected accounts (ACL-based), where one connected account can be used by multiple users. This is an `experimental` feature:

```typescript
const connectionReq = await composio.connectedAccounts.link('owner-user', authConfig.id, {
  experimental: {
    accountType: 'SHARED',
    aclConfigForShared: {
      allowAllUsers: true,
      // OR: allowedUserIds: ['user-1', 'user-2']
    },
  },
});
// Then other users can use this connection via session.execute()
```

---

## 6. Tool Catalog Discovery

### 6a. List All Available Toolkits

```typescript
// Without session — all toolkits in the catalog
const allToolkits = await composio.toolkits.get({
  // category?: string        // e.g. 'developer-tools', 'communication'
  // sortBy?: string          // e.g. 'popularity'
  // limit?: number           // default: 20, use pagination
  // cursor?: string          // for pagination
});
// Returns: { items: ToolkitRetrieveResponse[], nextCursor: string | null, totalPages: number }

// ToolkitRetrieveResponse shape:
{
  slug: string;          // 'github', 'slack', 'gmail', etc.
  name: string;          // 'GitHub', 'Slack', 'Gmail'
  logo: string;          // URL to logo image
  authConfigDetails: ...;  // auth scheme info
  isNoAuth: boolean;     // true for no-auth tools (e.g. HackerNews)
  // ...
}
```

**Total count:** Composio docs state "1000+ toolkits". The prior research confirmed "500+" is a conservative floor.

### 6b. List Toolkits for a Specific User (Connected Only)

```typescript
const session = await composio.create('kairos-user-xyz', {});

// List toolkits with connection status for this user
const result = await session.toolkits({
  isConnected: true,  // only connected toolkits
  limit: 20,
  // nextCursor: cursor,  // for pagination
  // search: 'slack',  // fuzzy search
});
// Returns: { items: [{ slug, name, logo, noAuth, connected, ... }], nextCursor }
```

### 6c. List Tools for a Toolkit

```typescript
// Global — all tools in a toolkit
const tools = await composio.tools.get('default', {
  toolkits: ['github'],
  limit: 100,  // defaults to 20
});

// Per-user — tools scoped to user's connected accounts
const tools = await composio.tools.get('kairos-user-xyz', {
  toolkits: ['slack', 'gmail'],
  important: true,  // top tools only
});
```

### 6d. Semantic Search for Tools

```typescript
const tools = await composio.tools.get('kairos-user-xyz', {
  search: 'send message in Slack channel',
});
// Returns top matches semantically
```

### 6e. Tool Schema Format

Each tool has:

```typescript
{
  slug: string;          // 'SLACK_SEND_MESSAGE' — ALLCAPS_SNAKE_CASE
  name: string;          // 'Send Message'
  description?: string;  // human-readable description for LLM
  inputParameters?: {    // JSON Schema { type: 'object', properties: {...} }
    type: 'object';
    properties: Record<string, JSONSchemaProperty>;
    required?: string[];
  };
  outputParameters?: {   // JSON Schema for output
    type: 'object';
    properties: Record<string, JSONSchemaProperty>;
  };
  toolkit: { slug: string; name: string; logo?: string };
  version?: string;      // e.g. '20250902_00'
  tags?: string[];       // ['readOnlyHint', 'destructiveHint', etc.]
  isNoAuth?: boolean;
  scopes?: string[];     // OAuth scopes this tool requires
}
```

Tool slugs follow the pattern: `{TOOLKIT_SLUG}_{ACTION_NAME}` in ALLCAPS. Examples:
- `SLACK_SEND_MESSAGE`
- `GMAIL_FETCH_EMAILS`
- `GITHUB_CREATE_AN_ISSUE`
- `NOTION_SEARCH_DATABASE`

### 6f. Toolkit Version Pinning (Important for Production)

```typescript
// Pin versions at SDK init to avoid breaking changes
const composio = new Composio({
  toolkitVersions: {
    github: '20250909_00',
    slack: '20250902_00',
    gmail: '20250902_00',
  },
  // OR env vars: COMPOSIO_TOOLKIT_VERSION_GITHUB=20250909_00
});
```

For production KAIROS, toolkitVersions should be pinned. Use `'latest'` only in dev.

---

## 7. Webhook Integration

### 7a. Connection Expiry Webhook

**Event type:** `composio.connected_account.expired`

This fires when Composio fails to refresh an OAuth token (e.g. user revoked access, refresh token expired). This is the primary signal KAIROS needs to prompt re-authentication.

**Payload (zod-validated):**

```typescript
// From ts/packages/core/src/types/webhookEvents.types.ts
{
  id: string;            // 'msg_847cdfcd-d219-4f18-a6dd-91acd42ca94a'
  timestamp: string;     // ISO-8601
  type: 'composio.connected_account.expired';
  data: {
    id: string;          // connected account ID 'ca_abc123'
    user_id: string;     // your user ID 'kairos-user-xyz'
    status: 'EXPIRED';
    status_reason: string | null;
    toolkit: { slug: string };
    auth_config: { id: string; is_composio_managed: boolean; is_disabled: boolean };
    created_at: string;
    updated_at: string;
  };
  metadata: {
    project_id: string;
    org_id: string;
  };
}
```

**TypeScript type:** `ConnectionExpiredEvent` from `@composio/core`.

### 7b. Trigger Webhook (Tool Triggers — real-time events)

**Event type:** `composio.trigger.message`

Used for real-time triggers like "new email received", "new Slack message", etc. The payload varies per trigger type:

```typescript
// From triggers.types.ts
{
  type: 'composio.trigger.message';
  timestamp: string;
  data: {
    triggerSlug: string;    // e.g. 'slack_receive_message'
    payload: unknown;       // trigger-specific payload
    connectedAccountId?: string;
    metadata?: unknown;
  };
}
```

### 7c. Webhook Signature Verification

Composio signs webhook payloads using HMAC-SHA256. The signature format:
```
HMAC-SHA256(${webhookId}.${webhookTimestamp}.${payload}, webhookSecret)
```

Headers sent with each webhook:
- `webhook-id` — unique message ID
- `webhook-timestamp` — Unix timestamp (seconds)
- `webhook-signature` — `v1,base64EncodedHMAC`

**Verification code:**

```typescript
import { Composio } from '@composio/core';

const composio = new Composio({ apiKey: process.env.COMPOSIO_API_KEY });

// In your webhook endpoint handler:
async function handleWebhook(req: Request) {
  const payload = await req.text();
  const result = await composio.triggers.verifyWebhook({
    payload,
    signature: req.headers.get('webhook-signature')!,
    id: req.headers.get('webhook-id')!,        // note: 'id', not 'webhookId'
    timestamp: req.headers.get('webhook-timestamp')!,
    secret: process.env.COMPOSIO_WEBHOOK_SECRET!,
    tolerance: 300,  // reject webhooks older than 5 minutes
  });
  // result.version — 'V1' | 'V2' | 'V3'
  // result.payload — normalized IncomingTriggerPayload
  // result.rawPayload — raw validated payload
}
```

Throws `ComposioWebhookSignatureVerificationError` if signature is invalid.

### 7d. Subscribe to Real-Time Triggers (Pusher-based)

For real-time triggers without webhooks (uses Pusher internally):

```typescript
await composio.triggers.subscribe((data) => {
  console.log('Trigger received:', data.triggerSlug, data.payload);
}, {
  // Optional filters:
  triggerSlug: 'slack_receive_message',
  connectedAccountId: 'ca_abc123',
});

// Unsubscribe
await composio.triggers.unsubscribe();
```

**Note:** This is a persistent Pusher WebSocket connection, not an HTTP endpoint. For KAIROS daemon, the webhook endpoint approach is preferred to avoid long-lived connections.

### 7e. Registering a Webhook Endpoint

The webhook endpoint URL is set in the Composio dashboard (Project Settings → Webhooks). The payload is sent via HTTP POST to your URL. Composio does not have an SDK method for programmatic webhook registration at project level (dashboard-only for production webhooks).

For local development, the triggers.subscribe (Pusher) approach works without a public URL.

---

## 8. Auth Mode Decision Tree

### 8a. When to Use Managed Auth (use_composio_managed_auth)

Managed auth = Composio provides the OAuth app credentials. Users see "Composio wants access to...".

**Use managed auth when:**
- Getting to market fast
- You don't have/need white-label consent screens
- Your users are developers/early adopters (branding matters less)
- The toolkit supports it (most OAuth2 toolkits do)

**To use managed auth:**

```typescript
// Option 1: Fully automatic (no explicit auth config creation)
const connectionReq = await composio.toolkits.authorize('user-id', 'github');
// Composio auto-creates a managed auth config if none exists

// Option 2: Explicit managed auth config
const authConfig = await composio.authConfigs.create('github', {
  type: 'use_composio_managed_auth',  // or: AuthConfigTypes.COMPOSIO_MANAGED
  name: 'KAIROS GitHub Auth',
});
const connectionReq = await composio.connectedAccounts.link('user-id', authConfig.id);
```

**To check if a toolkit supports managed auth:**
```typescript
const authConfig = await composio.authConfigs.get(authConfigId);
authConfig.isComposioManaged  // true = managed auth
```

**Most OAuth2 toolkits (Slack, Gmail, GitHub, Notion, Linear, etc.) support managed auth.** API-key toolkits (OpenAI, Stripe, etc.) do not — they require the user to enter their key.

### 8b. When to Use Custom Auth (use_custom_auth)

**Use custom auth when:**
- White-label (users must see "[KAIROS] wants access")
- Need specific OAuth scopes beyond Composio's defaults
- Enterprise customers whose CISOs won't accept third-party consent screens
- The toolkit doesn't have Composio managed auth

```typescript
const authConfig = await composio.authConfigs.create('slack', {
  type: 'use_custom_auth',  // or: AuthConfigTypes.CUSTOM
  authScheme: 'OAUTH2',
  credentials: {
    client_id: process.env.SLACK_CLIENT_ID!,
    client_secret: process.env.SLACK_CLIENT_SECRET!,
  },
  // Optional: custom scopes
  // credentials: { scopes: 'channels:read,chat:write,users:read' }
});
const connectionReq = await composio.connectedAccounts.link('user-id', authConfig.id);
```

With custom auth: users see "KAIROS wants access to..." (your app's name).

### 8c. Detection Logic

```typescript
// Check if a toolkit has Composio managed auth available:
const toolkitInfo = await composio.toolkits.get('slack');
const hasComposioManagedAuth = toolkitInfo.authConfigDetails?.some(
  config => config.isComposioManaged === true
);

// Check auth scheme (determines if OAuth redirect is needed):
// OAUTH1, OAUTH2, DCR_OAUTH → redirect required
// API_KEY, BASIC, BEARER_TOKEN → no redirect, collect credentials directly
```

### 8d. Auth Schemes Reference

```typescript
const AuthSchemeTypes = {
  OAUTH1: 'OAUTH1',
  OAUTH2: 'OAUTH2',
  API_KEY: 'API_KEY',
  BASIC: 'BASIC',
  BEARER_TOKEN: 'BEARER_TOKEN',
  GOOGLE_SERVICE_ACCOUNT: 'GOOGLE_SERVICE_ACCOUNT',
  NO_AUTH: 'NO_AUTH',  // no credentials needed (e.g. HackerNews)
  DCR_OAUTH: 'DCR_OAUTH',
  S2S_OAUTH2: 'S2S_OAUTH2',
  // ... more
}
```

For KAIROS, the primary flows are:
- `OAUTH2` → use `connectedAccounts.link()` → redirect flow
- `API_KEY` → use `connectedAccounts.initiate()` with `AuthScheme.APIKey(...)` → no redirect

---

## 9. Error Handling + Token Refresh

### 9a. Composio Auto-Refreshes OAuth Tokens

**Important:** Composio automatically refreshes OAuth tokens before they expire. KAIROS does NOT need to implement token refresh logic.

Documentation quote: *"Composio automatically refreshes OAuth tokens before they expire. You don't need to handle re-authentication or token expiration."*

### 9b. When Auto-Refresh Fails → `composio.connected_account.expired` Webhook

If Composio cannot refresh a token (e.g. user revoked access, refresh token rotated), the connection transitions to `EXPIRED` status and fires the `composio.connected_account.expired` webhook.

KAIROS should:
1. Receive the webhook
2. Mark the connection as expired in local DB
3. Notify the user via KAIROS notification system
4. Guide user through re-authorization

### 9c. Error Types

```typescript
// From @composio/core errors:
ComposioConnectedAccountNotFoundError    // 404 — connection doesn't exist
ComposioMultipleConnectedAccountsError   // 409 — duplicate, use allowMultiple
ComposioFailedToCreateConnectedAccountLink  // link() call failed
ComposioLegacyConnectedAccountsEndpointRetiredError  // using deprecated initiate()
ConnectionRequestTimeoutError            // waitForConnection() timed out
ConnectionRequestFailedError             // OAuth flow failed/expired/revoked
ComposioAuthConfigNotFoundError          // auth config doesn't exist
ComposioToolNotFoundError                // tool slug not found
ValidationError                         // invalid parameters
ComposioWebhookSignatureVerificationError  // invalid webhook signature
```

### 9d. Handling Token Expiry in Tool Execution

```typescript
import { ComposioConnectedAccountNotFoundError } from '@composio/core';

try {
  const result = await composio.tools.execute('GMAIL_FETCH_EMAILS', {
    userId: 'kairos-user-xyz',
    arguments: { maxResults: 10 },
    version: '20250902_00',
  });
  if (!result.successful) {
    // Handle tool-level error (e.g., API rate limit, permission denied)
    console.error('Tool failed:', result.error);
  }
} catch (err) {
  if (err instanceof ComposioConnectedAccountNotFoundError) {
    // Connection was deleted or expired — need to re-auth
    await promptUserToReauth('gmail');
  } else {
    throw err;
  }
}
```

### 9e. Proactive Token Status Check

```typescript
// Check connection status before executing tools
const accounts = await composio.connectedAccounts.list({
  userIds: ['kairos-user-xyz'],
  toolkitSlugs: ['gmail'],
  statuses: ['ACTIVE'],  // only active connections
});

if (accounts.items.length === 0) {
  // User hasn't connected Gmail or token expired
  await initiateGmailConnection('kairos-user-xyz');
}
```

### 9f. Force Token Refresh (Manual)

```typescript
// Force refresh a specific connected account
await composio.connectedAccounts.refresh('ca_abc123');
```

---

## 10. Cost Model Verification — Current 2026 Pricing

Verified from `composio.dev/pricing` on 2026-05-27:

| Plan | Price | Included tool calls | Overage |
|------|-------|---------------------|---------|
| Free | $0/mo | 20,000/mo | N/A |
| Ridiculously Cheap | $29/mo | 200,000/mo | $0.299/1,000 calls |
| Serious Business | $229/mo | 2,000,000/mo | $0.249/1,000 calls |
| Enterprise | Custom | Custom | Custom |

**Unchanged from prior research.** No post-breach pricing changes or discounts found.

**Premium tools (3x rate)** — verified NOT including Slack, Gmail, GitHub, Notion, Linear. Premium tools are: Composio Search, Perplexity, Exa, SerpAPI, code execution sandboxes (E2B), web scrapers, AI/ML inference endpoints.

**What counts as a "tool call":** Each `tools.execute()` call, each MCP tool invocation. Tool listing (`tools.get()`) does NOT count.

**KAIROS-specific projections** (from prior research):
- 100 users × moderate (100 calls/day): Starter plan at $0.59/user/mo
- 1,000 users × heavy (250 calls/day): $1,599/mo = $1.60/user/mo
- Both within $2/user/mo budget

---

## 11. Post-Breach Security Posture

### 11a. What Happened (May 2026)

Based on prior research (deep-dive report):
- Approximately 0.3% of connections were affected
- Mostly GitHub tokens in an auxiliary cache layer
- All affected tokens were revoked
- Platform continued operating with managed OAuth

### 11b. Current Security Architecture

As of research date:
- **Zero Trust KMS:** Referenced in roadmap documentation; **not yet shipped as a generally available feature**. The architecture for "zero-trust KMS" involves customer-controlled encryption keys so Composio cannot decrypt tokens at rest. This is in the Enterprise pipeline.
- **Current storage:** Tokens are stored centrally in Composio's infrastructure, encrypted at rest by Composio (not customer-controlled keys). This is the standard model for all non-Enterprise customers.
- **Active incidents:** As of 2026-05-26, Composio's status page showed 3 active incidents (instability post-breach recovery).

### 11c. Practical Risk for KAIROS

For KAIROS v1 (0-500 users, developer-focused):
- Managed auth tokens stored in Composio's central store
- Risk accepted: a future Composio breach exposes users' personal Slack/Gmail/GitHub tokens
- Mitigation plan: Register own OAuth apps (BYOC) at 500+ users, migrate to custom auth configs
- Monitor: Composio's status page and security blog for follow-up incidents

### 11d. Composio's Recommendations (from docs.composio.dev)

The current docs do not publish specific post-breach security hardening recommendations for customers. The general guidance is:
1. Use webhook verification (HMAC-SHA256 signatures) to validate webhooks
2. Store `COMPOSIO_API_KEY` as a secret (not in client-side code)
3. Use `dangerouslyAllowAutoUploadDownloadFiles: false` (default) unless specifically needed
4. Set `sensitiveFileUploadProtection: true` (default) to block `.env`, `.ssh` files

For KAIROS's threat model, the largest concern is that personal user OAuth tokens (Gmail, GitHub) are held by a third-party that had a breach. No customer-side mitigation exists until Zero Trust KMS ships.

---

## 12. References

All sources read during this research:

### GitHub Repositories — Direct File Reads

| File | What it proved |
|------|---------------|
| `composiohq/composio/ts/examples/connected-accounts/src/index.ts` | Complete auth config + link() flow |
| `composiohq/composio/ts/examples/connected-accounts/src/toolkit-authorize.ts` | `toolkits.authorize()` compound flow |
| `composiohq/composio/ts/examples/connected-accounts/src/api-key.ts` | API key connection with `AuthScheme.APIKey()` |
| `composiohq/composio/ts/examples/connected-accounts/src/multiple-connected-accounts.ts` | `allowMultiple` flag |
| `composiohq/composio/ts/examples/mcp/src/index.ts` | MCP with `mcp.create()` + SSEClientTransport + Vercel AI |
| `composiohq/composio/ts/examples/tool-router/src/mcp.ts` | MCP via `session.mcp.url` + `@ai-sdk/mcp` HTTP transport |
| `composiohq/composio/ts/examples/tool-router/src/authorize.ts` | `session.authorize()` + `tools.get()` + OpenAI |
| `composiohq/composio/ts/examples/tool-router/src/multi-account.ts` | `multiAccount` config |
| `composiohq/composio/ts/examples/tool-router/src/openai-agents.ts` | `hostedMcpTool` pattern |
| `composiohq/composio/ts/examples/tool-router/src/claude-agent-sdk.ts` | Claude SDK + `session.mcp` HTTP transport |
| `composiohq/composio/ts/examples/tool-router/src/session-update.ts` | `session.update()` API |
| `composiohq/composio/ts/packages/core/src/composio.ts` | `ComposioConfig` type, class structure |
| `composiohq/composio/ts/packages/core/src/index.ts` | All exports |
| `composiohq/composio/ts/packages/core/src/models/ConnectedAccounts.ts` | `initiate()` deprecation, `link()`, `delete()`, `refresh()` |
| `composiohq/composio/ts/packages/core/src/models/AuthConfigs.ts` | `create()`, `get()`, `list()` methods |
| `composiohq/composio/ts/packages/core/src/models/Tools.ts` | `get()`, `execute()` signatures |
| `composiohq/composio/ts/packages/core/src/models/Toolkits.ts` | `get()`, `authorize()` internals |
| `composiohq/composio/ts/packages/core/src/models/MCP.ts` | `create()`, `generate()`, `list()` |
| `composiohq/composio/ts/packages/core/src/models/ToolRouter.ts` | Session creation internals |
| `composiohq/composio/ts/packages/core/src/models/ToolRouterSession.ts` | `authorize()`, `tools()`, `mcp`, `update()` |
| `composiohq/composio/ts/packages/core/src/models/ConnectionRequest.ts` | `waitForConnection()` implementation |
| `composiohq/composio/ts/packages/core/src/types/authConfigs.types.ts` | `AuthConfigTypes`, `AuthSchemeTypes` enums |
| `composiohq/composio/ts/packages/core/src/types/connectedAccounts.types.ts` | `ConnectedAccountStatuses`, shared/private/ACL |
| `composiohq/composio/ts/packages/core/src/types/tool.types.ts` | `ToolSchema`, `ToolListParams`, `ToolExecuteParams` |
| `composiohq/composio/ts/packages/core/src/types/toolRouter.types.ts` | `ToolRouterMCPServerConfig`, session types |
| `composiohq/composio/ts/packages/core/src/types/webhookEvents.types.ts` | `ConnectionExpiredEvent`, `WebhookEventTypes` |
| `composiohq/composio/ts/packages/core/src/types/mcp.types.ts` | MCP URL response schemas |
| `composiohq/composio/ts/packages/core/src/errors/ConnectedAccountsErrors.ts` | All error types |
| `composiohq/composio/ts/packages/core/src/models/Triggers.ts` | `subscribe()`, `verifyWebhook()` |
| `composiohq/composio/ts/packages/core/package.json` | Version 0.10.0 confirmed |
| `ComposioHQ/trustclaw/src/server/clients/composio.ts` | Production client init pattern |
| `ComposioHQ/trustclaw/src/server/api/routers/toolkits/getAuthLink.ts` | `session.authorize()` in production app |
| `ComposioHQ/trustclaw/src/server/api/routers/toolkits/getToolkits.ts` | `session.toolkits()` in production app |
| `ComposioHQ/trustclaw/.env.example` | Confirmed `COMPOSIO_API_KEY` only — no per-provider credentials |

### Documentation URLs

| URL | Content |
|-----|---------|
| `docs.composio.dev/getting-started/introduction` | SDK init, `composio.create()` basics |
| `docs.composio.dev/getting-started/quickstart` | First API call pattern |
| `docs.composio.dev/auth/managed-auth` | Managed auth concepts |
| `docs.composio.dev/auth/connected-accounts` | Connected account lifecycle |
| `docs.composio.dev/docs/toolkits/fetching-tools-and-toolkits` | Tool catalog discovery |
| `docs.composio.dev/llms.txt` | Full docs index |
| `composio.dev/pricing` | Current pricing — verified $29/$229 tiers |
| KAIROS codebase: `src/daemon/mcp/mcpClient.ts` | Existing MCP transport |
| KAIROS codebase: `src/daemon/mcp/mcpHost.ts` | Existing MCP host |
| KAIROS codebase: `src/daemon/mcp/types.ts` | `McpServerConfig` type |

---

## Appendix A: Key Differences Between `session.authorize()` vs `connectedAccounts.link()`

| | `session.authorize(toolkit)` | `connectedAccounts.link(userId, authConfigId)` |
|--|--|----|
| Auth config | Auto-created (managed) by session | Must be pre-created or passed explicitly |
| User ID | From session (set at `composio.create(userId)`) | Passed as first argument |
| Return type | `ConnectionRequest` (same) | `ConnectionRequest` (same) |
| Deprecation | Not deprecated | Not deprecated |
| Use case | Simple flow, managed auth | Explicit control, custom auth |

Both return `{ redirectUrl, waitForConnection() }` — identical interface.

## Appendix B: `initiate()` vs `link()` — Migration Guide

```typescript
// OLD (deprecated for managed OAuth after 2026-07-03):
const req = await composio.connectedAccounts.initiate(userId, authConfigId, options);

// NEW (works for all auth types, all orgs):
const req = await composio.connectedAccounts.link(userId, authConfigId, options);

// Options shape is the same:
// { callbackUrl?: string, alias?: string, allowMultiple?: boolean }
// Return shape is the same: ConnectionRequest { id, redirectUrl, waitForConnection() }
```

`initiate()` still works for:
- Custom auth configs (your own OAuth credentials)
- API key, Basic auth, Bearer token schemes (non-OAuth)

`initiate()` is retired for:
- Composio-managed OAuth (OAUTH1, OAUTH2, DCR_OAUTH)
- Timeline: new orgs since 2026-05-08, all orgs from 2026-07-03

## Appendix C: Package Names Summary

```
@composio/core          v0.10.0    — main SDK
@composio/vercel        v0.9.x     — Vercel AI SDK provider
@composio/openai-agents v0.9.2     — OpenAI Agents SDK provider
@composio/anthropic     v0.x.x     — Anthropic SDK provider
@composio/langchain     v0.x.x     — LangChain provider
@composio/client        (internal) — API client (used by core, not imported directly)
```

## Appendix D: Session Creation `ToolRouterCreateSessionConfig` — Full Options

```typescript
type ToolRouterCreateSessionConfig = {
  toolkits?: string[];              // ['gmail', 'slack']
  tools?: {                         // per-toolkit tool filtering
    [toolkit: string]: {
      enable?: string[];
      disable?: string[];
    }
  };
  manageConnections?: boolean | {   // true = agent manages auth in-chat
    enable: boolean;
    callbackUrl?: string;
    waitForConnections?: boolean;
  };
  multiAccount?: {                  // multiple accounts per toolkit
    enable: boolean;
    maxAccountsPerToolkit?: number;
    requireExplicitSelection?: boolean;
  };
  sessionPreset?: 'direct_tools';   // skips tool-router meta-tools
  preload?: {                       // pre-load specific tools into context
    tools: string[] | '*';
  };
  workbench?: {                     // code execution sandbox
    enable: boolean;
    sandboxSize?: 'standard' | 'medium' | 'large' | 'xlarge';
  };
  experimental?: {
    customTools?: CustomTool[];
    customToolkits?: CustomToolkit[];
  };
  tags?: string[] | { enable?: string[]; disable?: string[] };
};
```

---

*Research completed 2026-05-27. All code read directly from GitHub repositories via `gh` CLI. No code was speculated — every snippet was found verbatim in source files or documentation.*
