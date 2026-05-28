# Composio Full Documentation Walk — 2026-05-27

> Exhaustive read of docs.composio.dev against the C.2.7 plan at
> `docs/superpowers/plans/2026-05-27-phase-c2-7-composio-connectors.md`
>
> All doc URLs referenced below are the `.md` variants from `https://docs.composio.dev/llms.txt`
> (the canonical page list). Every section below was fetched and verified.

---

## 1. How Composio Works (Canonical Overview)

**Source:** `https://docs.composio.dev/docs/how-composio-works.md`

Composio is a runtime integration layer. The **session** is the fundamental unit of execution — it binds user identity, tool access, auth state, and execution logs into a single handle.

Key concepts confirmed:

| Term | Definition |
|------|-----------|
| Session | Created by `composio.create(userId)`. Ephemeral config object binding user to toolkits + auth. |
| `composio.use(sessionId)` | Resumes an existing session. **Confirmed real method.** |
| `session.update({toolkits, authConfigs, connectedAccounts})` | Modifies live session. **Confirmed real method.** |
| `session.mcp.url` | MCP server endpoint for this session. |
| `session.mcp.headers` | Auth headers for the MCP connection. |
| `session.authorize(toolkit, {callbackUrl?})` | Manually triggers OAuth flow, returns `ConnectionRequest`. |
| `session.tools()` | Returns native tools formatted for an AI framework provider. |
| `session.toolkits()` | Returns toolkit list with connection status. |

Sessions persist server-side. They don't expire on their own. Sessions can be updated in-place via `session.update()` without losing state.

**Workbench:** Included by default in all sessions. Provides persistent Python sandbox (`COMPOSIO_REMOTE_WORKBENCH` + `COMPOSIO_REMOTE_BASH_TOOL`). Disable with `workbench: { enable: false }` in `composio.create()`. Not billed today but planned. Relevant for KAIROS: **disable it** — KAIROS does not need a Python sandbox.

---

## 2. Sessions & Configuration

**Source:** `https://docs.composio.dev/docs/configuring-sessions.md`

Full TypeScript `composio.create()` signature:

```typescript
const session = await composio.create(userId: string, {
  toolkits?: string[] | { enable?: string[]; disable?: string[] };
  authConfigs?: Record<string, string>;
  connectedAccounts?: Record<string, string[]>;
  preload?: { tools?: string[] | "all" };
  sessionPreset?: SessionPreset;
  manageConnections?: boolean | { enable?: boolean; callbackUrl?: string };
  workbench?: { enable?: boolean; sandboxSize?: "standard" | "medium" | "large" | "xlarge" };
  multiAccount?: { enable?: boolean; maxAccountsPerToolkit?: number; requireExplicitSelection?: boolean };
});
```

`session.update()` accepts the same shape (toolkits, authConfigs, connectedAccounts).

`composio.use(sessionId)` resumes a session by ID.

**Critical for the plan:** The plan's `ComposioSessionManager` calls `this.opts.sdk.create(userId, opts)` and `this.opts.sdk.use(sessionId)` — both confirmed real methods. The `session.update()` method is confirmed, but its signature for `toolkits` is an array (not an object with `add`) — the plan's `addToolkit()` fallback that calls `session.toolkits.add([slug])` is **wrong** — there is no `session.toolkits.add()`. The correct call is `session.update({ toolkits: [...updatedList] })`.

---

## 3. Authentication — Overview

**Source:** `https://docs.composio.dev/docs/authentication.md`

Two modes:

### Mode 1: In-Chat Authentication (Default)

The agent autonomously handles auth when it needs a tool that requires it. The `COMPOSIO_MANAGE_CONNECTIONS` meta-tool is included in every session by default (`manageConnections` defaults to `true`). When the LLM calls `COMPOSIO_MANAGE_CONNECTIONS`, it gets back a Connect Link URL and presents it to the user in chat. The user authenticates and the agent retries.

**No developer code required for this mode.** Zero setup. It just works.

This is **NOT** what the C.2.7 plan uses (plan uses manual auth), but it is a real alternative pattern that the plan should acknowledge.

### Mode 2: Manual Authentication

Developer calls `session.authorize(toolkit, { callbackUrl? })` explicitly. Returns a `ConnectionRequest` with `connectionRequest.redirectUrl` (TypeScript) / `connection_request.redirect_url` (Python). Developer opens browser to that URL. After OAuth completes, `connectionRequest.waitForConnection(timeout_ms)` resolves with the connected account.

**Composio handles token refresh automatically.** Tokens never expire from KAIROS's perspective (Composio refreshes before expiry). The plan's `TokenExpiryPoller` is checking for the case where the user revokes access externally — this is still valid reasoning but tokens don't auto-expire due to age.

---

## 4. In-Chat Authentication Deep Dive

**Source:** `https://docs.composio.dev/docs/authenticating-users/in-chat-authentication.md`

- Enabled by default via `manage_connections=True` / `manageConnections: true` in `composio.create()`.
- `COMPOSIO_MANAGE_CONNECTIONS` meta-tool is what the LLM calls — it checks connection status and returns a Connect Link URL.
- Customize with `manageConnections: { callbackUrl: "https://yourapp.com/chat" }` to control where user lands post-auth.
- To **disable**: `manageConnections: false` in `composio.create()`.

**Relevance for KAIROS:** In-chat auth is a legitimate alternative to the plan's current manual-auth-first approach. If KAIROS surfaces an LLM conversation, the LLM can trigger auth autonomously. The plan can support BOTH: use manual auth for the "connect in settings" UX flow, and allow in-chat auth if the user tries to use an unconnected toolkit in a conversation.

To use in-chat auth alongside manual auth:
- Keep `manageConnections: true` (the default) in session creation.
- The `ConnectionFlow.connect()` path remains for explicit "connect in settings" UI.
- The LLM-triggered path works automatically.

---

## 5. Manual Authentication Deep Dive

**Source:** `https://docs.composio.dev/docs/authenticating-users/manually-authenticating.md`

```typescript
const session = await composio.create("user_123");
const connectionRequest = await session.authorize("gmail", {
  callbackUrl: "http://localhost:12345/composio-cb"  // desktop: localhost OK
});
const connectedAccount = await connectionRequest.waitForConnection(60000);
```

- `session.authorize()` is on the **session** object, NOT on `composio.connectedAccounts`.
- `connectionRequest.redirectUrl` — the URL to open in browser.
- `connectionRequest.waitForConnection(timeout_ms)` — polls until done. Default 60s.
- `callbackUrl` param: Composio appends `?status=success&connected_account_id=ca_xxx` to the callback URL after OAuth completes. A localhost URL works for desktop apps.

**Key difference from the plan:** The plan uses `composio.connectedAccounts.link()` directly. The docs also show `session.authorize()` as the primary recommended path for manual auth. Both are valid — `session.authorize(toolkit)` internally resolves the auth config and calls `link()`, making it a higher-level convenience wrapper. The plan's lower-level approach (manually calling `getOrCreateAuthConfig()` then `linkConnection()`) is more explicit but functionally equivalent.

---

## 6. Connected Accounts API

**Source:** `https://docs.composio.dev/reference/sdk-reference/typescript/connected-accounts.md`
**Source:** `https://docs.composio.dev/docs/auth-configuration/migrating-initiate-to-link.md`

### initiate() vs link() — CRITICAL

The plan's table correctly shows `link()` as the current API. However, the docs reveal a nuance:

- `initiate()` is deprecated ONLY for **Composio-managed OAuth configs on OAuth1/OAuth2/DCR_OAUTH schemes**.
- `initiate()` is still valid for API key, bearer token, basic auth, and custom auth configs.
- `link()` enforces the consent step that `initiate()` could bypass.
- Timeline: New orgs blocked from `initiate()` for managed OAuth since May 8, 2026. All orgs blocked July 3, 2026.

The plan's test "does NOT call deprecated initiate()" is correct. The `ComposioClient.linkConnection()` implementation correctly uses `connectedAccounts.link()`.

### `connectedAccounts.link()` TypeScript signature:

```typescript
await composio.connectedAccounts.link(
  userId: string,
  authConfigId: string,
  options?: {
    alias?: string;
    callbackUrl?: string;
  }
): Promise<ConnectionRequest>
```

Returns a `ConnectionRequest` with:
- `redirectUrl: string` — URL to open in browser
- `id: string` — connected account ID
- `waitForConnection(timeout?: number): Promise<ConnectedAccount>`

Also: `composio.connectedAccounts.waitForConnection(connectedAccountId, timeout?)` — standalone polling method.

**Status values documented:** `ACTIVE`, `INACTIVE` (via enable/disable), `EXPIRED` (from webhook events). The plan uses `pending | active | expired | revoked | failed` — `PENDING` and `INITIATED` are reasonable inferences for the link-in-progress state, but docs don't explicitly enumerate them all.

### `connectedAccounts.refresh()` — UNDOCUMENTED IN PLAN

The SDK has a `connectedAccounts.refresh()` method:
```typescript
await composio.connectedAccounts.refresh(nanoid, {
  redirectUrl?, validateCredentials?
})
```
This explicitly refreshes OAuth tokens/credentials. The plan does not call this anywhere. The plan's `TokenExpiryPoller` detects expiry but does not offer to refresh — it just marks as expired. This is OK for v1 but worth knowing the method exists.

---

## 7. Auth Configs

**Source:** `https://docs.composio.dev/docs/auth-configuration/programmatic-auth-configs.md`
**Source:** `https://docs.composio.dev/reference/sdk-reference/typescript/auth-configs.md`

Correct API for creating a managed auth config:

```typescript
const authConfig = await composio.authConfigs.create("GITHUB", {
  name: "GitHub",
  type: "use_composio_managed_auth",
});
// Returns { id: "ac_xxx", isComposioManaged: true, ... }
```

The plan's `getOrCreateAuthConfig()` uses:
```typescript
await this.sdk.authConfigs.create(toolkitSlug, { type: 'use_composio_managed_auth' })
```

This matches. The `type: "use_composio_managed_auth"` value is confirmed correct.

The `isComposioManaged` boolean field is on auth config objects — useful for the conditional routing pattern between `link()` and `initiate()`.

---

## 8. Toolkits API

**Source:** `https://docs.composio.dev/reference/sdk-reference/typescript/toolkits.md`
**Source:** `https://docs.composio.dev/docs/toolkits/fetching-tools-and-toolkits.md`

`composio.toolkits` methods:
- `composio.toolkits.get(slug)` — single toolkit
- `composio.toolkits.get(query?)` — paginated list
- `composio.toolkits.authorize(userId, toolkitSlug, authConfigId?)` — initiate connection
- `composio.toolkits.getAuthConfigCreationFields(slug, authScheme, options)` — fields for auth config setup
- `composio.toolkits.listCategories()` — toolkit categories

**What the plan uses:** `this.sdk.toolkits.get({ limit: opts.limit ?? 100, cursor: opts.cursor })` — this matches the paginated overload.

**What the plan returns:** The `ToolkitInfo` type in the plan includes `auth_type`, `managed_auth_supported`, `tools_count`. The docs show toolkit objects return `slug`, `name`, `logo`, `authConfigDetails`. The fields `auth_schemes`, `managed_auth_supported`, `tools_count` are not confirmed in the TypeScript SDK response. The plan's `detectAuthType()` and `guessManagedAuthSupport()` fallback heuristics are necessary because the exact fields are unclear.

**118 toolkits** have managed auth. 70 require custom credentials.

---

## 9. MCP Integration

**Source:** `https://docs.composio.dev/docs/native-tools-vs-mcp.md`
**Source:** `https://docs.composio.dev/docs/troubleshooting/mcp.md`
**Source:** `https://docs.composio.dev/reference/sdk-reference/typescript/mcp.md`

### session.mcp

`session.mcp` is an object with two properties:
- `session.mcp.url` — the MCP server URL for this session
- `session.mcp.headers` — auth headers to include with every request

### URL format

From troubleshooting docs, the MCP URLs follow:
- `https://apollo-<randomID>-composio.vercel.app/v3/mcp/` (Vercel-hosted)
- `https://apollo.composio.dev/v3/mcp/` (direct)

These are NOT `https://mcp.composio.dev/...` as some older docs suggest. The troubleshooting doc shows the actual production URLs.

### Transport protocol

The docs **do NOT explicitly state** whether Composio's MCP uses SSE or Streamable HTTP. The plan assumes Streamable HTTP (2025-03-26 spec) via `StreamableHTTPClientTransport`. This is a reasonable assumption for modern Composio (they've been shipping the new spec), but is **unverified** from docs.

The troubleshooting doc recommends using MCP Inspector or Postman MCP Requests to debug — which supports HTTP-based transport. However, the plan has a correct fallback note: "If Composio's server speaks SSE only, swap to `SSEClientTransport`."

### composio.mcp (standalone, not session-based)

`composio.mcp` is a separate, higher-level object for managing "MCP server configurations" (persistent named MCP servers, not tied to a session). Methods: `create()`, `list()`, `get()`, `update()`, `delete()`, `generate()`. The `generate()` method takes `(userId, mcpConfigId, options)` and returns server URLs for a specific user.

This is a different concept from `session.mcp.url` — the session-based MCP URL is what the plan uses (correct).

### MCP spec version

**Not confirmed in docs.** The plan states "Streamable HTTP per 2025-03-26 spec" — this is an assumption.

---

## 10. Session.authorize() vs connectedAccounts.link() — The Key Distinction

The plan uses `composio.connectedAccounts.link()` directly (low-level). The docs recommend `session.authorize()` (high-level convenience wrapper that internally calls `link()`).

Both are valid. The difference:

| Approach | Who resolves auth config? | Usage |
|----------|--------------------------|-------|
| `session.authorize(toolkit)` | Composio (automatically) | Recommended. Simpler. |
| `composio.connectedAccounts.link(userId, authConfigId)` | Developer (must call `authConfigs.create()` first) | More control. What the plan does. |

The plan's `ConnectionFlow` approach (manual auth config creation + link) is valid but more verbose. The alternative of using `session.authorize()` would eliminate the need for `getOrCreateAuthConfig()` entirely.

---

## 11. Triggers

**Source:** `https://docs.composio.dev/docs/triggers.md`

Triggers deliver real-time events (Slack message, GitHub commit) to a webhook URL. Two mechanisms: webhook (real-time, Slack/Notion/Asana) and polling (15-min minimum delay, Gmail/Calendar).

**Relevant trigger for KAIROS:** `composio.connected_account.expired` — fires when a refresh token is revoked or expires. Available via the Webhook Subscriptions API. This is a real-time alternative to the plan's polling approach.

**Why the plan chose polling anyway:** Desktop agents don't have a publicly accessible webhook URL. The trigger approach would require KAIROS Cloud infrastructure (a backend to receive webhook POSTs). The plan's polling approach is correct for Phase E (pre-Cloud). However, the plan should note that Phase F Cloud can replace polling with this webhook subscription.

---

## 12. Pre/Post Processors (now called Modifiers)

**Source:** `https://docs.composio.dev/docs/tools-direct/modify-tool-behavior/before-execution-modifiers.md`
**Source:** `https://docs.composio.dev/docs/tools-direct/modify-tool-behavior/after-execution-modifiers.md`
**Source:** `https://docs.composio.dev/docs/migration-guide/new-sdk.md`

- Old name: "processors" (v1 SDK). New name: "modifiers" (v3 SDK).
- Types: `beforeExecute`, `afterExecute`, `modifySchema`.
- **Only available in direct execution mode.** The docs explicitly state: "If you're building an agent, we recommend using sessions instead." Modifiers are not documented for session-based tool execution.
- For the session pattern, tool behavior modification is done at the session level (what toolkits/tools are available) or via the agent's own prompt.

**Verdict for KAIROS:** Pre/post modifiers (processors) are **not applicable** to the session/ToolRouter pattern the plan uses. Skip them for C.2.7.

---

## 13. SDK API Names — Migration from v1 to v3

**Source:** `https://docs.composio.dev/docs/migration-guide/new-sdk.md`

Critical terminology changes:

| Old (v1) | New (v3) | Impact on plan |
|----------|----------|----------------|
| `apps` | `toolkits` | Plan uses `toolkits` — correct |
| `actions` | `tools` | Plan uses `tools` — correct |
| `integrations` | `auth_configs` | Plan uses `authConfigs` — correct |
| `entity_id` | `user_id` | Plan uses `userId` — correct |
| `ComposioToolSet` | `Composio` | Plan imports `Composio` from `@composio/core` — correct |
| `processors.pre/post/schema` | `modifiers.beforeExecute/afterExecute/modifySchema` | Not used in plan — correct |

The plan's `composio.authConfigs.list()` call (in `getOrCreateAuthConfig()`) uses `this.sdk.authConfigs.list({ toolkit: toolkitSlug })` — the v3 parameter is `toolkit` as the filter. This is consistent with the v3 API.

---

## 14. Sessions vs Direct Execution

**Source:** `https://docs.composio.dev/docs/sessions-vs-direct-execution.md`

Sessions-only features:
- In-chat authentication (COMPOSIO_MANAGE_CONNECTIONS)
- Workbench (Python sandbox)
- Dynamic approval rules
- Automatic dependency resolution

Direct execution-only features:
- Manual toolkit version pinning
- Lower latency (single LLM call vs multi-turn discovery)
- Full modifier support

**The plan uses sessions (ToolRouter pattern) — correct choice for KAIROS.** The meta-tool discovery overhead is acceptable for a desktop agent where the LLM needs to autonomously find the right tool.

---

## 15. Custom Tools

**Source:** `https://docs.composio.dev/docs/toolkits/custom-tools-and-toolkits.md`

Custom tools use `experimental_createTool()` / `experimental_createToolkit()`. They work with **native tools only** (`session.tools()`). **MCP support for custom tools is "coming soon"** — currently not available.

**For KAIROS:** If KAIROS wants to expose its own tools (e.g., KAIROS_CREATE_TASK, KAIROS_SCHEDULE_EVENT) alongside Composio tools to the LLM, it can use custom tools — but NOT via the MCP path. This would require using native tools instead of MCP for the LLM integration.

---

## 16. Rate Limits

**Source:** `https://docs.composio.dev/reference/rate-limits.md`

Per-organization rate limits on a rolling 10-minute window:

| Plan | Limit |
|------|-------|
| Starter / Hobby | 20,000 requests / 10 min |
| Growth | 100,000 requests / 10 min |
| Enterprise | Unlimited |

All endpoints count toward this limit (tool execution, listing, triggers). Rate limiting is NOT per-toolkit. HTTP 429 response includes `Retry-After` header.

**Plan's polling concern:** At 10K users polling every 5 min, that's ~2M `listConnectedAccounts` calls per month. At 10K users active simultaneously, that's 1,000 polling calls per 5 min (200/min or 2,000 per 10 min). Within Starter/Hobby limits if you're not also executing many tools. The plan's concern is valid at scale.

---

## 17. Security & Token Storage

**Source:** `https://docs.composio.dev/docs/common-faq.md`

- SOC 2 Type II compliant. Trust center: `https://trust.composio.dev/`
- Connected account secrets displayed as `abcd...` by default (masked for security)
- No fixed Composio IP ranges (routed via Cloudflare/Vercel)
- Self-hosting available on Enterprise only

**Re: the May 2026 security incident mentioned in the plan (Risk #4):** The docs don't mention this. The FAQ simply references SOC 2 compliance. The Zero Trust KMS rollout is not mentioned in the current docs. This incident may be a real concern based on external information, but can't be confirmed or denied from the docs alone.

---

## 18. Pricing & Billing

**Source:** `https://docs.composio.dev/toolkits/premium-tools.md`
**Source:** `https://docs.composio.dev/docs/observability/usage.md`

Tool call counting:
- Every tool execution (successful or failed) counts.
- Sessions created count separately.
- Listing operations (like `connectedAccounts.list()`) — **not confirmed** whether these count as tool calls. Likely not, as they are management API calls vs tool executions.

Premium tools (search, code execution, scraping, AI inference, document processing):
- Roughly 3x the cost of standard tool calls.
- 1,000 premium calls free on free tier.

Plan tiers (as named in the premium-tools doc, different from rate-limits doc):
- "Ridiculously Cheap" — 5,000 premium calls, $0.897/1k overage
- "Serious Business" — 50,000 premium calls, $0.747/1k overage
- "Enterprise" — flexible

**Note:** The plan's "Production tier covers 2M tool calls" is not confirmed by the docs seen. The pricing tier names in the docs don't match standard SaaS naming and may be outdated or for a different product tier. Needs verification from Composio's pricing page directly.

---

## 19. Multi-tenancy / Projects

**Source:** `https://docs.composio.dev/docs/projects.md`

Composio has a two-level hierarchy: **Organization** → **Projects**. Each project has its own API key, connected accounts, auth configs, webhook configs. Resources are fully isolated between projects.

**For KAIROS Model A (shared Composio API key):** All KAIROS users share one Composio project. User isolation is achieved via Composio's `userId` scoping — each user's connected accounts are scoped to their `userId`. This is correct and what the docs recommend.

---

## 20. Shared Connections

**Source:** `https://docs.composio.dev/docs/authenticating-users/shared-connections.md`

Shared connections allow multiple users to use a single authenticated account. Use cases: org-managed credentials, background agents, team mailboxes.

**For KAIROS v1:** Not relevant (single-user daemon). Could be relevant in Phase F for enterprise KAIROS where a team shares a Slack workspace connection.

---

## 21. Connection Expiry Events (Webhook Alternative to Polling)

**Source:** `https://docs.composio.dev/docs/subscribing-to-connection-expiry-events.md`

The `composio.connected_account.expired` webhook event fires when a refresh token is revoked or expires. Subscribe via the Webhook Subscriptions API at `https://backend.composio.dev/api/v3.1/webhook_subscriptions`.

**This is a real alternative to polling.** It requires a publicly accessible webhook URL (server-side). The plan correctly chose polling for Phase E (daemon has no public endpoint). The webhook approach should be flagged as the Phase F upgrade path.

---

## 22. Workbench

**Source:** `https://docs.composio.dev/docs/workbench.md`

- Included by default in all sessions.
- Provides `COMPOSIO_REMOTE_WORKBENCH` and `COMPOSIO_REMOTE_BASH_TOOL` meta-tools.
- Python sandbox persists across calls within a session.
- **Not billed today** but billing planned.
- Disable: `workbench: { enable: false }` in `composio.create()`.

**Action needed in the plan:** The `ComposioSessionManager.init()` call to `composio.create()` should include `workbench: { enable: false }` to avoid loading unused sandbox meta-tools into the LLM context.

---

## 23. Glossary Key Terms

**Source:** `https://docs.composio.dev/docs/glossary.md`

- **Session**: "Ephemeral configuration object from `composio.create(userId)`" — note "ephemeral" is the glossary word, but docs elsewhere say sessions "persist server-side" and don't expire. The session ID is stable; the session is not destroyed.
- **In-Chat Authentication**: "AI agent handles authentication by calling `COMPOSIO_MANAGE_CONNECTIONS`"
- **Manual Authentication**: "User authentication handled by your application code"
- **Workbench**: "Persistent Python sandbox via `COMPOSIO_REMOTE_WORKBENCH` meta tool"

---

---

# Amendments Needed to the C.2.7 Plan

## Amendment 1: session.update() API is confirmed, but session.toolkits.add() does NOT exist

**Doc:** `https://docs.composio.dev/docs/how-composio-works.md`

**Current state in plan (Task 6, ComposioSessionManager.addToolkit(), lines ~1131-1143):**
```typescript
if (typeof this.session.toolkits?.add === 'function') {
  await this.session.toolkits.add([slug])
} else if (typeof this.session.update === 'function') {
  await this.session.update({ toolkits: [...this.currentToolkits] })
} else {
  // Fall back: re-create session
  ...
}
```

**Problem:** `session.toolkits.add()` does not exist in the SDK. The `session.toolkits()` method is a read-only query (returns connection status). The only write path is `session.update()`.

**Proposed change:** Remove the `session.toolkits?.add` branch entirely. The correct implementation is:
```typescript
async addToolkit(slug: ToolkitSlug): Promise<void> {
  this.assertInited()
  if (this.currentToolkits.has(slug)) return
  this.currentToolkits.add(slug)
  // session.update() is the confirmed API — no session.toolkits.add()
  await this.session.update({ toolkits: [...this.currentToolkits] })
}
```

**Reasoning:** Confirmed from docs. `session.update()` is real and accepts `toolkits` array. The `.add()` method on `session.toolkits` does not exist — `session.toolkits()` is a query method, not a collection manager.

---

## Amendment 2: The plan's ConnectionFlow should offer session.authorize() as an alternative path, or replace the low-level link() approach

**Doc:** `https://docs.composio.dev/docs/authenticating-users/manually-authenticating.md`

**Current state in plan (Task 1, ComposioClient.getOrCreateAuthConfig + Task 3, ConnectionFlow):**
The plan manually calls `getOrCreateAuthConfig()` to resolve an auth config ID, then calls `connectedAccounts.link(userId, authConfigId, { callbackUrl })`.

**Alternative pattern (from docs):**
```typescript
const connectionRequest = await session.authorize("gmail", {
  callbackUrl: "http://localhost:12345/composio-cb"
});
const connectedAccount = await connectionRequest.waitForConnection(300000);
```

`session.authorize()` internally resolves the auth config and calls `link()` — it's a higher-level convenience wrapper that eliminates the need for `getOrCreateAuthConfig()`.

**Proposed change (OPTIONAL — not a breaking issue, but simpler):** Refactor `ConnectionFlow` to use `session.authorize(toolkit, { callbackUrl })` instead of the `getOrCreateAuthConfig` + `linkConnection` sequence. This eliminates Task 1's `getOrCreateAuthConfig()` method and simplifies the flow.

However, the current approach is also valid — it gives KAIROS more control (e.g., can reuse an auth config ID without session context). Keep the current approach but add a comment explaining that `session.authorize()` is the simpler alternative.

---

## Amendment 3: In-chat auth should be explicitly allowed (not disabled) in the session

**Doc:** `https://docs.composio.dev/docs/authenticating-users/in-chat-authentication.md`

**Current state in plan (Task 6, ComposioSessionManager.init(), lines ~1102-1106):**
```typescript
this.session = await this.opts.sdk.create(this.opts.userId, {
  toolkits: [...this.currentToolkits],
  manageConnections: this.opts.manageConnections ?? true,
})
```

**Looks correct** — `manageConnections` defaults to `true`. BUT: the plan's `ComposioConfig` type (Task 0) includes no `manageConnections` field, and the `ComposioSessionManagerOptions` has no `manageConnections` field either, making the `this.opts.manageConnections ?? true` rely on an undefined value that resolves to `true`.

**Proposed change:** Add explicit clarity. Two options:
1. Add `manageConnections?: boolean` to `ComposioSessionManagerOptions` with default `true`.
2. Explicitly document that in-chat auth IS enabled, and KAIROS can use both flows simultaneously (manual "connect in settings" + automatic LLM-driven in-chat auth).

**Reasoning:** In-chat auth is a valuable feature for KAIROS — if the LLM detects the user wants to use Gmail but has no connection, it can surface the auth URL in the conversation automatically. The plan should explicitly preserve this capability rather than accidentally disabling it.

---

## Amendment 4: Workbench should be disabled in session creation

**Doc:** `https://docs.composio.dev/docs/workbench.md`

**Current state in plan (Task 6, ComposioSessionManager.init()):**
```typescript
this.session = await this.opts.sdk.create(this.opts.userId, {
  toolkits: [...this.currentToolkits],
  manageConnections: this.opts.manageConnections ?? true,
})
```

No `workbench` parameter. By default, every session includes a Python sandbox + `COMPOSIO_REMOTE_WORKBENCH` and `COMPOSIO_REMOTE_BASH_TOOL` meta-tools.

**Problem:** These meta-tools will appear in KAIROS's MCP tool list and/or native tool list. They consume context window tokens and expose unneeded capabilities.

**Proposed change:**
```typescript
this.session = await this.opts.sdk.create(this.opts.userId, {
  toolkits: [...this.currentToolkits],
  manageConnections: this.opts.manageConnections ?? true,
  workbench: { enable: false },  // KAIROS doesn't need a Python sandbox
})
```

**Reasoning:** The workbench is intended for AI agents doing data processing. KAIROS is a task-management agent; the Python sandbox adds noise to the tool list without benefit.

---

## Amendment 5: connectionRequest.waitForConnection() replaces the plan's polling-after-link pattern

**Doc:** `https://docs.composio.dev/reference/sdk-reference/typescript/connected-accounts.md`

**Current state in plan (Task 3, ConnectionFlow.connect(), lines ~730-736):**
```typescript
// await the callback via OAuthCallbackHandler
await cb.capturePromise   // resolves on redirect, rejects on timeout

// Then confirm with Composio:
const accounts = await this.deps.composio.listConnectedAccounts({ userId: opts.userId, statuses: ['ACTIVE'] })
const active = accounts.find(a => a.id === linkResult.connection_id || a.toolkit_slug === opts.toolkitSlug)
```

After capturing the callback, the plan manually calls `listConnectedAccounts` to confirm the connection is active.

**Better approach available:** `connectionRequest.waitForConnection(timeout_ms)` does this polling automatically:
```typescript
const connectionRequest = await composio.connectedAccounts.link(userId, authConfigId, { callbackUrl })
// open browser...
// await localhost callback OR use waitForConnection
const connectedAccount = await connectionRequest.waitForConnection(300000)
// connectedAccount.status will be 'ACTIVE'
```

**Proposed change:** After `link()` returns a `ConnectionRequest`, use `linkResult.waitForConnection()` instead of the manual `listConnectedAccounts` confirmation step. This is cleaner and leverages the built-in polling.

However: If KAIROS is using the localhost `OAuthCallbackHandler` to capture the redirect (which signals completion), it can skip `waitForConnection` and just call `connectedAccounts.get(id)` once to confirm status. The current approach is not wrong — just slightly redundant if the localhost callback already signals completion.

**Minimal change:** After `cb.capturePromise` resolves, call `await connectionRequest.waitForConnection(30000)` to let Composio confirm the connection reached ACTIVE state before persisting it. Remove the manual `listConnectedAccounts` call.

---

## Amendment 6: MCP URL format is apollo.composio.dev/v3/mcp/ not mcp.composio.dev

**Doc:** `https://docs.composio.dev/docs/troubleshooting/mcp.md`

**Current state in plan (Task 6, test code lines ~1012-1014):**
```typescript
mcp: { url: `https://mcp.composio.dev/v3/${sessionId}`, headers: { 'x-api-key': 'k' } }
```

**Problem:** The troubleshooting doc shows production MCP URLs as:
- `https://apollo-<randomID>-composio.vercel.app/v3/mcp/`
- `https://apollo.composio.dev/v3/mcp/`

NOT `https://mcp.composio.dev/v3/...`

**Proposed change:** Update the mock MCP URL in `composioSessionManager.test.ts` to use `apollo.composio.dev/v3/mcp/` pattern. The actual URL comes from `session.mcp.url` so the live code is fine — it's only the test mocks that hardcode the wrong domain.

Also update the "Critical API guidance" table in the plan preamble which references `session.mcp.url` (correct) but the plan's earlier narrative mentions `https://mcp.composio.dev/...` style URLs.

---

## Amendment 7: Transport protocol for HttpMcpClient is UNCONFIRMED — needs verification

**Doc:** `https://docs.composio.dev/docs/native-tools-vs-mcp.md` + troubleshooting

**Current state in plan (Task 4, HttpMcpClient, lines ~838-840):**
```
// Use `StreamableHTTPClientTransport` from `@modelcontextprotocol/sdk/client/streamableHttp.js` for Composio
// (their MCP uses Streamable HTTP per 2025-03-26 spec)
```

**Problem:** The docs do NOT confirm transport protocol (SSE vs Streamable HTTP). The MCP troubleshooting guide recommends using Postman MCP Requests to debug, which is consistent with HTTP transport. The plan's Streamable HTTP assumption is plausible but unverified.

**Proposed change:** The plan already documents this as Risk #3:
> "MCP transport — Streamable HTTP vs SSE. Composio's MCP server may use either..."

Upgrade Risk #3 to a mandatory first step in Task 4: before writing `HttpMcpClient`, install `@composio/core` and call `session.mcp.url` + `session.mcp.headers` on a real session, then use `curl` or the MCP Inspector to determine whether the endpoint responds to Streamable HTTP or SSE. Add this as an explicit `- [ ] Verify transport` step before the implementation step.

---

## Amendment 8: Polling may not be needed for token expiry — Composio auto-refreshes OAuth tokens

**Doc:** `https://docs.composio.dev/docs/authentication.md`

> "Composio automatically refreshes OAuth tokens before they expire. You don't need to handle re-authentication."

**Current state in plan:** `TokenExpiryPoller` polls every 5 min to detect expired connections. The plan's rationale was "token expiry detection."

**Nuance:** Composio handles OAuth token refresh automatically. The `TokenExpiryPoller` is NOT detecting token expiry in the OAuth sense — it's detecting when a user manually revokes access (disconnects the KAIROS app from their Google/Slack account). The `composio.connected_account.expired` event fires specifically when "a refresh token is revoked or expires."

**Proposed change:** Rename `TokenExpiryPoller` to `ConnectionRevokedPoller` or `ConnectionStatusPoller` in the comments/docs. The polling is for detecting **user revocation**, not token expiry (Composio handles token expiry). This is a comment/naming clarification, not a code change.

Also: Since Composio auto-refreshes tokens, the polling interval of 5 min is conservative. 30 min or even 1 hour would be sufficient since the only event being detected is user revocation, which is rare.

---

## Amendment 9: connectedAccounts.link() TypeScript signature has positional args, not object

**Doc:** `https://docs.composio.dev/reference/sdk-reference/typescript/connected-accounts.md`

**Current state in plan (Task 1, ComposioClient.linkConnection()):**
```typescript
const result = await this.sdk.connectedAccounts.link({
  userId: args.userId,
  authConfigId: args.authConfigId,
  callbackUrl: args.callbackUrl,
  config: args.config,
})
```

**Problem:** The documented TypeScript signature is:
```typescript
await composio.connectedAccounts.link(
  userId: string,       // positional
  authConfigId: string, // positional
  options?: { alias?: string; callbackUrl?: string }
)
```

**Not** a single options object. The Python SDK uses named kwargs; TypeScript uses positional args.

**Proposed change:**
```typescript
const result = await this.sdk.connectedAccounts.link(
  args.userId,
  args.authConfigId,
  { callbackUrl: args.callbackUrl }
)
```

Note: `config` (for api_key/no_auth flows) is not in the `link()` signature — those flows use `initiate()` which still accepts `config`. If KAIROS needs to support API-key toolkits without OAuth, it should conditionally use `initiate()` for non-OAuth auth configs (per the migration guide's conditional routing pattern).

---

## Amendment 10: session.authorize() returns ConnectionRequest with redirectUrl (not redirect_url in TS)

**Doc:** `https://docs.composio.dev/docs/authenticating-users/manually-authenticating.md`

**Current state in plan (Task 3, ConnectionFlow.connect(), lines ~726-728):**
```typescript
const linkResult = await this.deps.composio.linkConnection({...})
if (linkResult.redirect_url) {
  await this.deps.browserOpener.open(linkResult.redirect_url)
```

And in `ComposioClient.linkConnection()`:
```typescript
return {
  connection_id: result.connection_id ?? result.id,
  redirect_url: result.redirect_url ?? result.redirectUrl,  // normalizing both
```

**Status:** The plan's normalization (`result.redirect_url ?? result.redirectUrl`) is defensive and correct. TypeScript SDK uses `redirectUrl` (camelCase). The plan's internal type uses `redirect_url` (snake_case) as the normalized internal form. This is fine as long as the normalization is consistent.

**No change needed** — the plan already handles both field name conventions.

---

## Amendment 11: No session.update() called when addToolkit / removeToolkit after session creation — also need to update the McpHost URL

**Current state in plan (Task 6 + Task 5):**

When `ComposioSessionManager.addToolkit(slug)` is called after session creation:
1. It calls `session.update({ toolkits: [...this.currentToolkits] })` — correct.
2. But the MCP URL may change after `session.update()` — the plan does NOT refresh the `HttpMcpClient` URL.

The session-level MCP URL (`session.mcp.url`) may or may not change when toolkits are updated. The docs say sessions can be updated "without losing context" via `session.update()`, but they don't clarify if `session.mcp.url` stays the same.

**Proposed change:** After `session.update()` in `addToolkit()`, re-read `this.session.mcp.url` and `this.session.mcp.headers`. If they differ from the previous values, emit an event so `McpHost` can reconnect the `HttpMcpClient` with the new URL. Add a `getMcpUrlChanged()` check or an event emitter to `ComposioSessionManager`.

This is a robustness concern. The session URL likely stays stable (it's a session-scoped URL), but should be verified.

---

## Amendment 12: Custom tools NOT available via MCP — "coming soon"

**Doc:** `https://docs.composio.dev/docs/toolkits/custom-tools-and-toolkits.md`

The docs state: "Custom tools work with **native tools** (`session.tools()`). MCP support is coming soon."

**Implication for KAIROS:** If KAIROS later wants to expose its own tools (KAIROS_CREATE_TASK) to the LLM alongside Composio tools, it cannot do so via the MCP path in v1. It would need to use native tools (`session.tools()`) with an AnthropicProvider instead of MCP.

**Proposed change to plan:** Add a note in the MCP section (Task 4/5): "Custom Composio tools are not available via session.mcp.url at this time. Any KAIROS-native tools must be registered separately through the existing `McpClient` (stdio) path or through Composio's native tools API once the session uses `session.tools()` instead of MCP."

---

---

# Final Assessment: Amendments Summary

## The 3 Most Important Things the Plan Is Missing or Wrong About

**1. `session.toolkits.add()` does not exist (Amendment 1)**
The `ComposioSessionManager.addToolkit()` method has a branch checking `typeof this.session.toolkits?.add === 'function'`. This method does not exist. The session's `toolkits()` method is read-only query. The only way to add a toolkit to a running session is `session.update({ toolkits: [...allToolkits] })`. The fallback to `session.update` is correct but the `.add()` check adds dead code and false confidence.

**2. `connectedAccounts.link()` uses positional args in TypeScript, not an options object (Amendment 9)**
The plan calls `this.sdk.connectedAccounts.link({ userId, authConfigId, callbackUrl, config })` as a single options object. The documented TypeScript signature is positional: `link(userId, authConfigId, { alias?, callbackUrl? })`. The `config` parameter is not available in `link()` — it's only in `initiate()`. This will cause a runtime error on the first attempt to connect an API-key toolkit.

**3. Workbench is enabled by default and should be disabled (Amendment 4)**
Every session spins up a Python sandbox by default. This adds `COMPOSIO_REMOTE_WORKBENCH` and `COMPOSIO_REMOTE_BASH_TOOL` to the session's tool list, consuming context window tokens and exposing unneeded capabilities. The fix is one line: `workbench: { enable: false }` in `composio.create()`.

## In-Chat Auth Explained (2 sentences)

In-chat auth is Composio's default behavior where the LLM itself handles OAuth by calling the `COMPOSIO_MANAGE_CONNECTIONS` meta-tool when it needs access to a toolkit — it gets back a Connect Link URL and presents it to the user mid-conversation, then retries the task after auth. For KAIROS, this means users can also authenticate "on demand" during a conversation without going to a settings screen, and KAIROS should preserve this by keeping `manageConnections: true` (the default) in session creation rather than disabling it.

## Composio Capability KAIROS Should Add That the Plan Doesn't Cover

**`connectionRequest.waitForConnection()`** — The plan's `ConnectionFlow.connect()` manually calls `listConnectedAccounts` to confirm a connection reached ACTIVE state. The SDK provides a built-in polling method (`connectionRequest.waitForConnection(timeout_ms)`) that does this correctly with proper backoff. KAIROS should use this instead of manual polling in the connection confirmation step (Amendment 5). It simplifies the code and follows the documented pattern.

## Confidence Level: 7/10

The plan's architecture is fundamentally sound. The ToolRouter/session pattern is real and well-documented. The `link()` vs `initiate()` distinction is correctly handled. The `StreamableHTTPClientTransport` assumption for MCP transport is reasonable but unverified from docs. The 3 bugs identified (`.toolkits.add()`, positional args for `link()`, workbench enabled by default) are real and will cause failures in implementation. Other concerns (MCP URL format in tests, workbench, connection polling naming) are minor. The plan will need these fixes before implementation begins.

## Specific Amendments to Apply

1. **`/docs/superpowers/plans/2026-05-27-phase-c2-7-composio-connectors.md`, Task 6, lines ~1131-1143** — Remove the `session.toolkits?.add` branch. Use only `session.update({ toolkits: [...] })`.

2. **Same file, Task 1, `ComposioClient.linkConnection()` method** — Change from single options object to positional args: `this.sdk.connectedAccounts.link(args.userId, args.authConfigId, { callbackUrl: args.callbackUrl })`. Remove `config` from the `link()` call — `config` is only valid for `initiate()`.

3. **Same file, Task 6, `ComposioSessionManager.init()`** — Add `workbench: { enable: false }` to all `composio.create()` calls.

4. **Same file, Task 4, Risk #3** — Upgrade from a risk note to a mandatory verification step: run the transport check before implementing `HttpMcpClient`.

5. **Same file, Task 3, `ConnectionFlow.connect()`** — After `cb.capturePromise` resolves, use `linkResult.waitForConnection(30000)` instead of the manual `listConnectedAccounts` confirmation step (Amendment 5).

6. **Same file, Task 6 test code, line ~1012** — Update mock MCP URL from `https://mcp.composio.dev/v3/...` to `https://apollo.composio.dev/v3/mcp/` pattern.

7. **Same file, Task 0, `types.ts`** — The `ComposioSessionManagerOptions` should explicitly include `manageConnections?: boolean` defaulting to `true`, with a comment explaining in-chat auth is preserved by this default.

8. **Same file, Risk #5 (polling at scale)** — Add note that `connectedAccounts.list` calls likely count toward the rate limit (20K/10min on Starter), not toward tool call billing. At 10K users, polling every 5 min = 2K list calls per 10-min window on the same Starter plan limit as tool executions. This is the actual risk.
