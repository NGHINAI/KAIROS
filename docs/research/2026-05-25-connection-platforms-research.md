# Connection Platform Research: Pipedream vs Composio vs Nango

**Date:** 2026-05-25  
**Author:** Research agent (Claude Sonnet 4.6)  
**Purpose:** Evaluate three OAuth/integration platforms for KAIROS hosted user accounts  
**KAIROS constraint:** ~$10/user/mo revenue, ~$3 LLM cost, ~$5 remaining for all infra + profit; connector platform must cost ≤$2/user/mo  

---

## Table of Contents

1. [Pipedream](#1-pipedream)
2. [Composio](#2-composio)
3. [Nango](#3-nango)
4. [Cross-Platform Comparison Matrix](#4-cross-platform-comparison-matrix)
5. [KAIROS-Specific Recommendation](#5-kairos-specific-recommendation)
6. [Build vs Buy Analysis](#6-build-vs-buy-analysis)
7. [Action Items](#7-action-items)

---

## 1. Pipedream

### 1.1 Identity + Positioning

| Field | Detail |
|-------|--------|
| Company | Pipedream (now a Workday product) |
| HQ | San Francisco, CA (founded 2018) |
| Funding | Raised ~$20M total; acquired by Workday November 19, 2025 (deal closed ~January 31, 2026) |
| Employees | ~50 pre-acquisition |
| Positioning | Developer-first workflow automation platform; pivoted in 2024-2025 to "AI agent connectivity" with Pipedream Connect |

**Recent product evolution:** Between 2024 and 2025, Pipedream heavily invested in **Pipedream Connect** — a product that lets SaaS developers embed "connect your apps" OAuth widgets directly in their own product, with Pipedream managing the entire auth stack. The MCP server launched in 2025 to expose 3,000+ apps as tools to AI agents.

**Workday acquisition impact:** Closed January 2026. Workday's declared intent is to use Pipedream's connector catalog (3,000+ apps) to bridge Workday's 75M+ enterprise user base with third-party systems for AI agent workflows. The product will remain available to existing customers during transition, but the roadmap will prioritize Workday's enterprise AI agent use case rather than the startup-embedded-OAuth use case. `mcp.pipedream.com` now redirects to a Workday announcement page — the standalone hosted MCP endpoint is effectively sunset or absorbed. **This is material risk for KAIROS.**

---

### 1.2 Integration Coverage

- **Count:** 3,000+ apps, 10,000+ prebuilt tools (actions/triggers)
- **Top KAIROS-relevant services covered:** Slack, Gmail/Google Workspace, Notion, GitHub, Linear, HubSpot, Salesforce, Jira, Airtable, Discord, Zoom, Stripe, Twilio, Dropbox, Google Drive, Trello, Asana, Microsoft Teams, Zendesk, Intercom
- **Coverage quality:** The breadth is unmatched — no other platform comes close to 3,000 apps. Actions go well beyond basic auth; many include full CRUD operations. However, these are Pipedream's own pre-built component definitions, not raw API passthrough — the quality depends on when a given connector was last updated.

---

### 1.3 MCP Support

- **Yes** — Pipedream had an active hosted MCP server at `mcp.pipedream.com` that exposed its full 3,000-app catalog with managed OAuth per user.
- **Post-acquisition status:** As of May 2026, `mcp.pipedream.com` displays a Workday acquisition announcement. The endpoint appears absorbed into Workday's platform.
- **Recommendation:** Treat Pipedream MCP as **unavailable for new KAIROS builds** until Workday publishes a new public roadmap. The architectural capability existed and was impressive; the product availability is uncertain.

---

### 1.4 Connection UX — Step by Step (Connecting a KAIROS User's Slack)

**Who registers the OAuth app at Slack?**  
Pipedream. They maintain their own Slack OAuth app. You can optionally supply your own OAuth credentials (custom app) for production white-labeling, but by default Pipedream's app is used.

**Step-by-step flow:**

```
1. KAIROS backend calls Pipedream Connect SDK:
   const session = await pd.connect.createToken({
     externalUserId: "kairos-user-xyz",
     app: "slack"
   });
   // Returns a short-lived auth URL

2. KAIROS UI redirects user to: pd.pipedream.com/auth/connect?token=...
   (or embeds the Pipedream Connect iframe widget)

3. User sees consent screen:
   - Default: "Pipedream wants access to your Slack workspace"
   - With custom OAuth app: "[YOUR APP] wants access..." (requires KAIROS to register own Slack app)

4. User clicks "Allow" in Slack's consent screen.

5. Slack redirects back to Pipedream's redirect URI (Pipedream-controlled).

6. Pipedream exchanges auth code for access + refresh tokens.

7. Pipedream stores tokens encrypted in their cloud database,
   associated with (external_user_id="kairos-user-xyz", app="slack").

8. KAIROS receives a callback or polls for account confirmation.

9. KAIROS later calls Slack on behalf of user:
   const resp = await pd.proxy.post({
     externalUserId: "kairos-user-xyz",
     accountId: "apn_abc123",
     url: "https://slack.com/api/chat.postMessage",
     body: { text: "hello", channel: "C..." }
   });
   // Pipedream injects Bearer token, makes the call, returns response.
   // KAIROS never sees the raw token.

10. On user disconnect: KAIROS calls pd.connect.deleteAccount(accountId).
    Pipedream revokes the token at Slack and deletes from storage.
```

**Total user-visible clicks:** ~3 (click "Connect Slack" → click "Allow" in Slack consent → see success screen)  
**Where token lives:** Pipedream's database only  
**Does KAIROS ever hold the token?** No — all calls go via proxy  
**White-label?** Only if you BYOC (Bring Your Own OAuth Credentials) — you register the Slack app yourself, supply Client ID/Secret to Pipedream

---

### 1.5 Pricing Model

| Tier | Price | Includes |
|------|-------|----------|
| Free | $0/mo | Dev mode only; max 10 external users; users must be logged into Pipedream |
| Connect | $150/mo | Production mode; 100 external users included; 10,000 credits/mo |
| Additional users | $2/user/mo | Each unique user beyond first 100 |
| Additional credits | Overage billed at end of cycle | 1 credit = 30s compute at 256MB |

**KAIROS scale calculation (1,000 users × 5 connections × 500 API calls/day):**

- Base: $150/mo (first 100 users)  
- Additional 900 users × $2 = $1,800/mo  
- **Total base: $1,950/mo just for user authentication**  
- Per-user equivalent: **$1.95/user/mo** (barely under the $2 threshold — but this is just auth, not including compute credits for proxied calls)
- 500 calls/day × 30 users using active workflows = significant credit burn on top
- **Verdict at 1,000 users: ~$1.95-$2.50/user/mo** — right at KAIROS's hard limit before acquisition risk is factored in

**Note:** If Workday changes pricing post-acquisition (enterprise-only tiers, minimum spend, etc.), this breaks immediately. Also: the community thread confirms no volume discount was publicly listed — custom pricing for scale requires a sales call.

---

### 1.6 Self-Hosting

- **Not available.** Pipedream is a fully proprietary hosted service.  
- License: Proprietary (closed source)  
- There is no self-hosted option, no open-source components, no Docker image.
- **Acquisition makes this permanent** — Workday will not open-source the platform.

---

### 1.7 SDK / API Surface

```typescript
// Initialize
const pd = new PipedreamClient({
  projectEnvironment: "production",
  projectId: "proj_xxx",
  clientId: "client_xxx",
  clientSecret: "secret_xxx"
});

// Get token (KAIROS doesn't call this — use proxy instead)
// No direct getToken() — all access via proxy

// Proxy call
const resp = await pd.proxy.post({
  externalUserId: "kairos-user-xyz",
  accountId: "apn_abc123",
  url: "https://slack.com/api/chat.postMessage",
  body: { text: "hello", channel: "C..." }
});

// MCP (pre-acquisition — now uncertain)
// mcp.pipedream.com/app/slack  →  SSE endpoint with 30s timeout
```

**SDKs:** TypeScript, Python  
**Webhook support:** Yes, for trigger events (not specifically for token refresh events)  
**Token refresh callback:** Not documented as a first-class webhook — handled silently by Pipedream

---

### 1.8 Trust + Security Model

| Dimension | Detail |
|-----------|--------|
| Token storage | Pipedream's cloud DB, encrypted at rest |
| Compliance | SOC 2 Type II, HIPAA, GDPR |
| Token revocation | `deleteAccount()` call; Pipedream revokes at upstream |
| Platform downtime risk | High — no fallback; you are 100% dependent on Pipedream infrastructure |
| Vendor lock-in | **Severe** — no token export, no self-hosting, acquisition by enterprise vendor |

**Post-acquisition lock-in note:** Tokens are stored exclusively in Pipedream/Workday infrastructure. If Workday changes terms, shuts down the indie product, or moves to enterprise-only pricing, KAIROS has no migration path without asking all 1,000+ users to re-authorize via a new platform. This is the single largest risk.

---

### 1.9 Recent Fundraising + Stability

- Total raised: ~$20M (pre-acquisition)
- Acquired by Workday (NASDAQ: WDAY, ~$60B market cap) November 2025, closed January 2026
- 5,000+ customers at acquisition
- **Stability verdict:** The company is stable in the sense that Workday won't go bankrupt. However, the *product direction* is now determined by a $60B enterprise HR software company. Developer-friendly pricing and consumer-app focus are at significant risk.

---

## 2. Composio

### 2.1 Identity + Positioning

| Field | Detail |
|-------|--------|
| Company | Composio, Inc. |
| HQ | San Francisco, CA (founded 2023) |
| Funding | $29M total; Series A: $25M led by Lightspeed Venture Partners (July 2025) |
| Valuation | ~$120M post-Series A |
| Employees | ~40-60 (estimated from Series A scale) |
| Positioning | "AI agent tool platform" — positioned as the integration layer specifically for AI agents and LLMs, not general automation |

**Recent product evolution:** Launched in 2023 as a Python/TypeScript SDK for giving LLMs tools. In 2024-2025, pivoted heavily toward MCP — becoming one of the first platforms to expose integrations as hosted MCP servers. Added "Tool Router" for per-user scoped MCP URLs. Series A (July 2025) specifically cited "building AI skills that improve over time" as the thesis — the product is increasingly an AI execution platform, not just OAuth infrastructure.

---

### 2.2 Integration Coverage

- **Count:** 500-1,000+ toolkits (sources vary; 500 is confirmed, OpenClaw plugin GitHub claims 1,000+)
- **Top KAIROS-relevant services covered:** Slack, Gmail, Notion, GitHub, Linear, Jira, HubSpot, Salesforce, Google Drive, Trello, Asana, Discord, Airtable, Stripe, Zoom, Microsoft Teams, Dropbox, Bitbucket, Sentry — all confirmed
- **Coverage quality:** Strong for the top 100 apps. Tools include meaningful action primitives (not just auth) — e.g., for Slack: `send_message`, `list_channels`, `get_thread`, etc. "Premium tools" exist (higher call cost) for some providers.
- **Premium tier warning:** Some integrations (not fully disclosed which) are classified as "premium" tools and cost approximately 3x the credit rate of standard tools.

---

### 2.3 MCP Support

- **Yes — native, hosted.** This is Composio's primary differentiator.
- **Hosted MCP URL format:** `https://backend.composio.dev/v3/mcp/{SERVER_ID}?user_id={USER_ID}`
- **Authentication:** `x-api-key: YOUR_COMPOSIO_API_KEY` header
- **Per-user scoping:** Each MCP request includes a `user_id` parameter; Composio looks up that user's stored credentials and injects them per tool call
- **Self-hosted MCP:** No — the MCP server is hosted-only
- **MCP Auth standard (2025 spec):** Composio's Tool Router implements per-session scoped URLs, aligning with OAuth 2.1 MCP spec from March 2025

**This is the cleanest MCP story of the three platforms** as of May 2026.

---

### 2.4 Connection UX — Step by Step (Connecting a KAIROS User's Slack)

**Who registers the OAuth app at Slack?**
- **Prototype/dev:** Composio's managed Slack app (user sees "Composio wants access")
- **Production (recommended):** KAIROS registers its own Slack OAuth app; supplies Client ID + Secret to Composio as a "custom auth config." User sees "[KAIROS] wants access."

**Step-by-step flow (production custom auth):**

```
SETUP (one-time per integration):
1. KAIROS team registers Slack OAuth app at api.slack.com
   → Receives CLIENT_ID and CLIENT_SECRET
2. KAIROS calls Composio API:
   POST /auth_configs
   { "toolkit": "slack", "client_id": "...", "client_secret": "..." }
   → Returns auth_config_id: "ac_abc123"

PER-USER CONNECTION:
3. KAIROS backend calls Composio:
   POST /connected_accounts/link
   { "user_id": "kairos-user-xyz", "auth_config_id": "ac_abc123" }
   → Returns redirect_url: "https://slack.com/oauth/v2/authorize?client_id=...&state=..."

4. KAIROS redirects user to redirect_url.

5. User sees Slack consent screen branded as "[KAIROS] wants access to..."
   Clicks "Allow."

6. Slack redirects to Composio's redirect URI (Composio-controlled).

7. Composio exchanges auth code for access + refresh tokens.
   Tokens stored encrypted in Composio's database, keyed to "kairos-user-xyz".

8. KAIROS receives callback (webhook) confirming connection.

AGENT MAKING API CALLS:
9. Composio MCP server called by KAIROS AI agent:
   URL: https://backend.composio.dev/v3/mcp/{SERVER_ID}?user_id=kairos-user-xyz
   Headers: x-api-key: COMPOSIO_KEY
   
   Agent calls tool: slack_send_message({ channel: "C...", text: "hello" })
   
   Composio looks up kairos-user-xyz's Slack token,
   calls Slack API directly,
   returns result to agent.
   KAIROS/agent never sees the raw token.

USER DISCONNECT:
10. KAIROS calls: DELETE /connected_accounts/{connection_id}
    Composio revokes token at Slack, deletes from storage.
```

**Total user-visible clicks:** ~3 (click "Connect Slack" → consent screen → success)  
**Where token lives:** Composio's database only  
**Does KAIROS ever hold the token?** No  
**White-label?** Yes — with custom auth config (KAIROS registers its own Slack app)

---

### 2.5 Pricing Model

| Tier | Price | Includes |
|------|-------|----------|
| Free | $0/mo | 20K tool calls/mo; community support |
| Starter ("Ridiculously Cheap") | $29/mo | 200K tool calls/mo; email support |
| Production ("Serious Business") | $229/mo | 2M tool calls/mo; Slack support (1K+ users) |
| Enterprise | Custom | Custom volume; VPC/on-prem; SOC 2 dedicated; SLA |

**Overage pricing:**
- Starter: $0.299 per 1,000 additional tool calls
- Production: $0.249 per 1,000 additional tool calls
- Premium tools: ~3x the rate of standard calls

**Key structural fact: Composio charges per tool call, NOT per connected user.** This is potentially very favorable for KAIROS.

**KAIROS scale calculation (1,000 users × 5 connections × 500 API calls/day):**

- 500 calls/day × 1,000 users = 500,000 calls/day = 15,000,000 calls/month
- Production tier: $229/mo = 2M included calls
- Overage: 13,000,000 × $0.249/1,000 = **$3,237/mo in overage**
- **Total: ~$3,466/mo = $3.47/user/mo** — **exceeds KAIROS's $2/user limit**

**But** — this assumes all 500 daily API calls hit Composio. KAIROS's daemon doesn't send all calls through Composio; only the tool-calling layer does. Realistic tool-call volume might be 10-50 calls/day per active user (agent actions, not monitoring/reads).

**Revised estimate at 25 calls/day/user:**
- 25 × 1,000 × 30 = 750,000 calls/mo
- Production tier covers 2M → under threshold
- Cost: **$229/mo = $0.23/user/mo** — **extremely favorable**

**Verdict:** Composio's pricing model is KAIROS-friendly **if** the per-call volume stays manageable. At 500+ AI-initiated calls/day/user (heavy agent mode), costs balloon. At 25-100 calls/day/user (realistic for KAIROS co-worker model), it's extremely cheap.

---

### 2.6 Self-Hosting

- **No official self-hosted option.** The GitHub issue (#291, July 2024) requesting on-prem deployment was closed without resolution.
- Composio mentions "VPC/on-premises deployment" in Enterprise tier marketing, but this appears to be a Composio-managed deployment within your cloud, not a self-hosted open-source deployment.
- License: Proprietary (the SDK/connectors on GitHub are Apache 2.0, but the platform runtime is closed)
- **No Docker image for running Composio yourself.**

---

### 2.7 SDK / API Surface

```python
# Python SDK
from composio import Composio
composio = Composio(api_key="COMPOSIO_KEY")

# Create connection link for a user
session = composio.connected_accounts.link(
    user_id="kairos-user-xyz",
    auth_config_id="ac_slack_xxx"
)
# → Returns redirect_url for user to visit

# MCP server URL generation
instance = composio.mcp.generate(
    user_id="kairos-user-xyz",
    mcp_config_id="mcp_server_id"
)
# → Returns: "https://backend.composio.dev/v3/mcp/SERVER_ID?user_id=kairos-user-xyz"

# Direct tool call (without MCP)
result = composio.tools.execute(
    tool_name="SLACK_SENDS_A_MESSAGE",
    params={"channel": "C...", "text": "hello"},
    user_id="kairos-user-xyz"
)
```

**SDKs:** Python, TypeScript/JavaScript  
**Webhooks:** Yes — for connection events, tool call results  
**Token refresh:** Automatic, silent; Composio handles refresh internally  
**getToken() equivalent:** Not exposed — by design, tokens are never returned to the caller

---

### 2.8 Trust + Security Model

| Dimension | Detail |
|-----------|--------|
| Token storage | Composio's cloud DB, encrypted at rest |
| Compliance | SOC 2 Type 2, ISO 27001 |
| Token revocation | DELETE `/connected_accounts/{id}` |
| Platform downtime | If Composio is down, all agent tool calls fail |
| Vendor lock-in | High — no token export, no self-hosting |

**CRITICAL: May 2026 Security Incident**

Composio disclosed a security breach in May 2026 (current month). An attacker gained arbitrary code execution via an internal agentic infrastructure monitoring tool, then pivoted to an auxiliary token cache:

- ~5,241 API keys were in the cache during the breach window
- 5,001 GitHub OAuth tokens potentially compromised
- 12 Gmail tokens potentially compromised
- ~26 other services with 1-5 tokens each
- ~0.3% of active connections affected (mostly internal test accounts)

**What this means for KAIROS:** This incident revealed that Composio's internal infrastructure did not fully isolate the token store from operational tooling. The attackers used LLM-generated exploit patterns to escalate privileges. Composio's post-incident response included mandatory API key rotation and plans for zero-trust token architecture — implying the architecture pre-incident was not zero-trust.

For a platform like KAIROS where users are connecting personal Slack/Gmail accounts, this is material. A breach at Composio directly compromises KAIROS users' personal accounts.

---

### 2.9 Recent Fundraising + Stability

- **Total raised:** $29M (Seed: $4M ~2023; Series A: $25M, July 2025, Lightspeed lead)
- **Valuation:** ~$120M post-Series A
- **Notable investors:** Lightspeed, Elevation Capital, Guillermo Rauch (Vercel), Dharmesh Shah (HubSpot CTO)
- **Growth signals:** 100K+ developers, Series A secured at strong terms from tier-1 VC
- **Stability concern:** Very early-stage startup ($120M valuation, ~40-60 employees). Series A runway is typically 24-36 months. The May 2026 security incident could impact enterprise sales momentum. Ongoing viability depends on execution — not guaranteed.

---

## 3. Nango

### 3.1 Identity + Positioning

| Field | Detail |
|-------|--------|
| Company | Nango, Inc. (NangoHQ) |
| HQ | San Francisco, CA (founded 2022) |
| Funding | $7.5M seed led by Gradient (announced April 1, 2026); total ~$11M including prior $3.5M |
| Investors | Gradient (Google), Horizon, Y Combinator, Akshay Kothari (Notion), John Kim (Sendbird) |
| Employees | ~13-20 (pre-raise), growing post-April 2026 raise |
| Positioning | "OAuth and unified APIs as infrastructure" — explicitly developer infrastructure, not agent platform |

**Recent product evolution:** Nango started as a pure OAuth token manager. In 2024-2025, evolved into a full integration platform with sync, proxy, and scripted actions. In 2026, pivoted positioning toward "AI agent integrations" — adding MCP server, AI coding agent skill for building connectors, and rebranding marketing around agentic use cases. The April 2026 $7.5M raise (despite already being cashflow positive with "several million ARR") signals deliberate acceleration into the AI agent opportunity.

**Key strategic fact:** Nango was cashflow positive before raising the April 2026 round. This is unusual and suggests genuine product-market fit without burn-dependent growth.

---

### 3.2 Integration Coverage

- **Count:** 800+ APIs (as of early 2026; up from 700+ in 2025)
- **Top KAIROS-relevant services covered:** Slack, Gmail/Google, Notion, GitHub, Linear, HubSpot, Salesforce, Jira, Airtable, Discord, Stripe, Twilio, Zoom, Microsoft Teams, Dropbox, Google Drive, Trello, Asana, Zendesk, Intercom — all confirmed
- **Coverage quality:** Nango provides **open-source connector templates** — the auth configuration and action skeletons are on GitHub (MIT license for the integrations themselves, ELv2 for the platform). This is fundamentally different from Pipedream/Composio: you can read, fork, and customize the connector logic. The platform also has an AI coding agent skill so Claude Code can generate new connectors against the Nango runtime.

---

### 3.3 MCP Support

- **Yes — built-in hosted MCP server**
- **Hosted MCP URL:** `https://api.nango.dev/mcp`
- **Required headers per request:**
  - `Authorization: Bearer <NANGO-SECRET-KEY>`
  - `connection-id: <CONNECTION-ID>` (user's connection reference, stored by KAIROS)
  - `provider-config-key: <INTEGRATION-ID>`
- **Self-hosted MCP:** Available in free self-hosted tier? **No** — free self-hosted is auth + proxy only. MCP server requires paid plan (Starter+).
- **Roadmap:** MCP is a first-class feature, not an afterthought. Nango also supports the "MCP Auth" standard emerging in 2026.
- **Nango MCP latency:** Claims <100ms overhead added to tool calls; auto-scales on traffic surges.

---

### 3.4 Connection UX — Step by Step (Connecting a KAIROS User's Slack)

**Who registers the OAuth app at Slack?**
- **By default:** Nango uses Nango's managed Slack OAuth credentials (user sees "Nango wants access")  
- **White-label (all plans):** KAIROS registers its own Slack app; supplies credentials to Nango. User sees "[KAIROS] wants access."  
- **Key differentiator:** Nango's white-label is available on all paid plans, not just enterprise — Composio and Pipedream can both do BYOC but Nango makes it the standard recommended path from the start.

**Step-by-step flow (white-label production):**

```
SETUP (one-time per integration):
1. KAIROS team registers Slack OAuth app at api.slack.com
   → Receives CLIENT_ID and CLIENT_SECRET
   → Sets redirect URI to: https://api.nango.dev/oauth/callback

2. KAIROS registers integration in Nango dashboard:
   Integration ID: "slack"
   Client ID: xxx, Client Secret: xxx
   Scopes: chat:write,channels:read,...

PER-USER CONNECTION:
3. KAIROS backend creates a Connect Session:
   POST https://api.nango.dev/connect/sessions
   { end_user: { id: "kairos-user-xyz" } }
   → Returns: { token: "session_token_xxx", connect_link: "https://..." }

4. KAIROS frontend calls:
   nango.openConnectUI({ sessionToken: "session_token_xxx" })
   → Opens Nango's pre-built Connect UI component (white-labeled)

   OR (custom UI): KAIROS redirects user to the connect_link URL.

5. User sees: "[KAIROS] wants access to your Slack workspace"
   (User sees KAIROS branding because we registered the Slack app)
   Clicks "Allow."

6. Slack redirects to: https://api.nango.dev/oauth/callback?code=...&state=...
   Nango handles the exchange.

7. Nango stores access + refresh tokens in its database,
   keyed to connection-id: "nango-generated-uuid-xxx"
   (KAIROS stores this connection-id for the user in its own DB)

8. KAIROS receives webhook: POST /kairos/nango-webhook
   { event: "auth.created", connection_id: "nango-generated-uuid-xxx" }

KAIROS MAKING API CALLS:
Option A — Proxy (real-time):
9a. const response = await nango.get({
      endpoint: "/api/conversations.list",
      providerConfigKey: "slack",
      connectionId: "nango-generated-uuid-xxx"
    });
    // Nango injects Bearer token, makes call, returns response.
    // KAIROS never sees raw token.

Option B — Retrieve token (KAIROS makes own HTTP calls):
9b. const connection = await nango.getConnection("slack", "nango-generated-uuid-xxx");
    // connection.credentials.access_token is returned
    // KAIROS can cache for up to 5 minutes
    // IMPORTANT: This does expose the token to KAIROS server code

Option C — MCP (agent-facing):
9c. AI agent calls Nango MCP server:
    URL: https://api.nango.dev/mcp
    Headers:
      Authorization: Bearer NANGO_SECRET
      connection-id: nango-generated-uuid-xxx
      provider-config-key: slack
    
    Tool: slack_send_message({ channel: "C...", text: "hello" })

USER DISCONNECT:
10. DELETE https://api.nango.dev/connections/{connection_id}
    → Nango revokes token at Slack, deletes stored credentials
    → KAIROS removes connection_id from its user record
```

**Total user-visible clicks:** ~3  
**Where token lives:** Nango's database; optionally retrievable by KAIROS server  
**Does KAIROS ever hold the token?** Optional — `getConnection()` can return it. The proxy and MCP paths keep tokens inside Nango.  
**White-label?** Yes — standard feature on all paid plans  
**Nango's differentiator here:** The `getConnection()` escape hatch. If Nango ever goes down or changes terms, KAIROS can retrieve all tokens (with user consent baked into the original OAuth grant) and migrate to direct storage. No other platform offers this.

---

### 3.5 Pricing Model

| Tier | Price | Connections | Proxy Requests | Function Compute | Notes |
|------|-------|-------------|----------------|------------------|-------|
| Free (Cloud) | $0/mo | 10 | 100k/mo | 10 hrs | Auth + Proxy only; no MCP |
| Starter | From $50/mo | 20 included | 200k/mo | 20 hrs | +$1/connection over 20 |
| Growth | From $500/mo | 100 included | 1M/mo | 100 hrs | +$1/connection over 100 |
| Enterprise | Custom | Custom | Custom | Custom | Self-hosted option; HIPAA |

**Usage-based overages (across all paid tiers):**
- Connections: $1/connection/mo beyond tier allotment
- Proxy requests: $0.0001 per request beyond allotment
- Function runs: $0.0001 per execution beyond allotment
- Function compute: $0.0000002 per millisecond beyond allotment

**KAIROS scale calculation (1,000 users × 5 connections = 5,000 connections):**

- Growth tier: $500/mo includes 100 connections
- Additional 4,900 connections × $1 = $4,900/mo
- **Total connections cost: $5,400/mo = $5.40/user/mo** — **WAY over KAIROS's $2 limit**

**This is the fundamental problem with Nango for KAIROS at hosted scale.**

**Revised calculation with proxy calls:**
- 500 calls/day × 1,000 users × 30 days = 15M calls/mo
- 15M proxy requests × $0.0001 = $1,500/mo in proxy costs
- Plus connection costs: $5,400/mo
- **Total at full scale: ~$6,900/mo** — absolutely unsustainable

**BUT — self-hosted Nango changes this math completely:**
- Self-hosted (free tier): Auth + Proxy only, up to 1,000 connections FREE
- Self-hosted (Enterprise plan required for MCP, Functions, etc.)
- Enterprise self-hosted: Fixed annual license fee + fraction of cloud usage fees
- **The self-hosted path is the only way Nango works for KAIROS at scale**

**Estimated self-hosted cost at 1,000 users:**
- Infrastructure: ~$200-400/mo (Postgres, Redis, ElasticSearch, compute — ~5 services × 1 CPU/2GB RAM each + DB)
- Enterprise license: Not publicly disclosed (requires sales call)
- Conservative estimate: **$0.20-$0.60/user/mo for infrastructure** if enterprise license is reasonable

**Verdict:** Nango Cloud pricing breaks KAIROS economics at $1/connection/mo. Self-hosted Nango is potentially the most cost-efficient path but requires enterprise license negotiation and DevOps investment.

---

### 3.6 Self-Hosting

- **Yes — this is Nango's core differentiator**
- **License:** Elastic License 2.0 (ELv2)
  - Allows: Use within your own product/SaaS
  - Prohibits: Offering Nango itself as a managed service to others
  - For KAIROS's use case (embedding in your own product), ELv2 is permissive
  - **ELv2 is NOT OSI-approved open source** — it is "source available"
- **Infrastructure required:**
  - 5 Node services (Server, Persist, Runner, Jobs, Orchestrator) — 1 CPU/2GB RAM each
  - Postgres: 2 CPU, 8GB RAM, 128GB storage
  - Redis: 128MB
  - ElasticSearch: 2 vCPU, 1GB RAM, 30GB storage
  - S3-compatible object storage: <500MB
  - Total: ~10-12 vCPUs, ~20GB RAM minimum for 1M+ executions/day
- **Deployment:** Helm charts (Kubernetes) or custom ECS; updates on 2-month cadence
- **Feature gaps (free self-hosted vs Enterprise self-hosted vs Cloud):**

| Feature | Free Self-Hosted | Enterprise Self-Hosted | Nango Cloud |
|---------|-----------------|----------------------|-------------|
| Auth (OAuth) | Yes | Yes | Yes |
| API Proxy | Yes | Yes | Yes |
| MCP Server | **No** | Yes | Yes (paid) |
| Syncs/Functions | **No** | Yes | Yes (paid) |
| Webhooks | **No** | Yes | Yes (paid) |
| Auth branding | **No** | Yes | Yes (paid) |
| RBAC | **No** | Yes | Yes (paid) |
| SAML SSO | **No** | Yes | Yes (paid) |
| Support SLA | None | Yes | Yes (paid) |

**Key gap:** The free self-hosted tier gives Auth + Proxy only. For KAIROS to get MCP server capability in a self-hosted setup, an Enterprise license is mandatory. Price is not published — sales call required.

---

### 3.7 SDK / API Surface

```typescript
// TypeScript Node SDK
import { Nango } from '@nangohq/node';

const nango = new Nango({ secretKey: process.env.NANGO_SECRET_KEY });

// Get token (for KAIROS to make direct calls — optional)
const connection = await nango.getConnection('slack', 'connection-id-xyz');
const accessToken = connection.credentials.access_token;
// Note: tokens expire; don't cache >5 minutes; set forceRefresh: true if needed

// Proxy call (KAIROS never holds token)
const response = await nango.get({
  endpoint: '/api/conversations.list',
  providerConfigKey: 'slack',
  connectionId: 'connection-id-xyz'
});

// MCP (pass connection context to agent)
// Headers: Authorization + connection-id + provider-config-key
// URL: https://api.nango.dev/mcp
```

**SDKs:** TypeScript/Node (primary), Python (limited)  
**Webhooks:** Yes — for auth.created, auth.revoked, sync.completed, error events  
**Token refresh webhook:** Yes — `auth.token_refresh_error` event for broken connections  
**KAIROS token migration escape hatch:** `getConnection()` can return raw tokens if needed for migration

---

### 3.8 Trust + Security Model

| Dimension | Detail |
|-----------|--------|
| Token storage | Nango's cloud DB, encrypted at rest with AES-256; SOC 2 Type II, HIPAA, GDPR |
| Compliance | SOC 2 Type II, HIPAA (add-on), GDPR |
| Token revocation | DELETE `/connections/{id}` — Nango revokes upstream, deletes locally |
| Platform downtime | If Nango Cloud is down, proxied calls fail; but KAIROS can use `getConnection()` as fallback to direct calls |
| Vendor lock-in | **Low-to-moderate** — `getConnection()` returns raw tokens; self-hosting is possible; no token hostage situation |

**Critical trust differentiator:** Nango's `getConnection()` API is an explicit anti-lock-in feature. KAIROS can retrieve all user tokens at any time and migrate to direct storage or another platform without re-authorization. No other platform offers this.

**Security incident history:** No disclosed breaches as of May 2026 (compared to Composio's May 2026 incident).

---

### 3.9 Recent Fundraising + Stability

- **April 1, 2026:** $7.5M seed led by Gradient (Google Ventures spinout), Y Combinator, Horizon
- **Notable investors:** Akshay Kothari (Notion CPO), John Kim (Sendbird CEO)
- **Pre-raise ARR:** "Several million" — company was cashflow positive
- **Customer count:** 10,000+ engineering teams (many likely free/open-source users)
- **Notable customers:** Replit, Mercor, Ramp
- **Infrastructure scale:** Billions of API requests/month

**Stability verdict:** Very small company (13-20 employees) but cashflow positive before raising — this is a strong signal. Gradient (Google) and YC backing suggests strategic interest from major players. The risk is the size of the team; if 2-3 key engineers leave, it could impact reliability. However, the self-hosting option means KAIROS is not 100% dependent on Nango's uptime.

---

## 4. Cross-Platform Comparison Matrix

| Dimension | Pipedream | Composio | Nango |
|-----------|-----------|----------|-------|
| **Apps/integrations** | 3,000+ apps | 500-1,000+ toolkits | 800+ APIs |
| **MCP support** | Yes (absorbed into Workday, status uncertain) | Yes — native, hosted, best-in-class | Yes — built-in hosted + self-hosted (Enterprise) |
| **Self-hosting** | No | No (Enterprise VPC only, not open) | Yes — free (auth+proxy) or Enterprise (full) |
| **License** | Proprietary | Proprietary (SDK: Apache 2.0) | Elastic License 2.0 (source-available) |
| **White-label OAuth** | Yes (BYOC, any plan) | Yes (BYOC, recommended for production) | Yes (BYOC, standard on all paid plans) |
| **Token storage** | Pipedream only | Composio only | Nango (token retrieval available) |
| **getToken() API** | Not exposed | Not exposed | Yes — `getConnection()` returns raw token |
| **Proxy API** | Yes | Yes (via tool calls) | Yes |
| **Per-user pricing** | $2/user/mo (100 included at $150) | None — per tool call | $1/connection/mo ($50 base + 20 included) |
| **KAIROS cost @ 1K users / 5 connections** | ~$1,950/mo ($1.95/user) | ~$229/mo at 25 calls/day/user ($0.23/user) | ~$5,400/mo cloud ($5.40/user); self-hosted TBD |
| **Acquisition/stability risk** | HIGH — Workday enterprise pivot | MEDIUM — Series A startup, security incident | LOW-MEDIUM — cashflow positive, small team |
| **Security incidents** | None disclosed | May 2026 breach (5,241 tokens cached) | None disclosed |
| **SOC 2 Type II** | Yes | Yes | Yes |
| **HIPAA** | Yes | Enterprise only | Yes (add-on) |
| **Build new connectors** | Limited (closed tooling) | Limited (closed tooling) | Yes — open-source templates, AI-buildable |
| **SDK quality** | TypeScript + Python | TypeScript + Python | TypeScript (primary), Python (limited) |
| **Vendor lock-in risk** | SEVERE (acquired, no token export) | HIGH (no token export, no self-host) | LOW (token export + self-host available) |
| **OSS/AGPL alignment** | None | None | ELv2 (source-available, not OSI) |
| **Founded** | 2018 | 2023 | 2022 |
| **Total funding** | ~$20M (acquired) | $29M | ~$11M |
| **Employee count** | ~50 (absorbed into Workday) | ~40-60 | ~13-20 (growing) |

---

## 5. KAIROS-Specific Recommendation

### Primary Recommendation: Nango Self-Hosted (Enterprise License)

**Why:**

1. **Economics at scale.** Nango Cloud's $1/connection/mo pricing is prohibitive ($5.40/user/mo at 5 connections). But Nango self-hosted removes the per-connection cost. Your cost becomes infrastructure (~$200-400/mo for 1,000 users) plus an Enterprise license fee. Even if the Enterprise license costs $2,000-$5,000/year, the per-user cost comes to under $0.50/user/mo — well within budget.

2. **No vendor lock-in.** `getConnection()` returns raw tokens. If Nango folds, changes terms, or the self-hosted path becomes untenable, KAIROS can migrate to direct token storage without forcing all users to re-authorize. This is the only platform offering this.

3. **ELv2 and KAIROS's AGPL codebase.** ELv2 is not AGPL-compatible (it's not OSI-approved open source), but it permits use within your own product. Since KAIROS is building a product (not reselling Nango as a service), ELv2 is legally fine. The AGPL codebase for KAIROS remains clean — you're using Nango as a dependency, not embedding it as a user-facing feature.

4. **MCP available on Enterprise self-hosted.** The AI agent use case is served.

5. **No security breach history.** Composio had a May 2026 incident; Pipedream is absorbed into Workday with uncertain security posture going forward.

6. **cashflow-positive small team** with strategic backing (Google's Gradient, YC, Notion CPO) — better survival odds than a burn-heavy Series A startup.

**Risks with this choice:**
- Enterprise license price is opaque (requires sales call) — could be $1,000/mo+ annually
- Small team (13-20) — bus factor risk
- Self-hosting adds DevOps burden (Postgres, Redis, ElasticSearch, 5 Node services)
- Free self-hosted misses MCP — must negotiate Enterprise license to unlock it
- ELv2 is not true open source; Nango could change terms

---

### Secondary Fallback: Composio (Hosted, Custom Auth Config)

**When to use as fallback:**
- If Nango Enterprise licensing proves too expensive or burdensome
- If DevOps capacity is insufficient to maintain self-hosted infrastructure
- For KAIROS's first 500 users while negotiating Nango Enterprise deal
- For the "BYO mode" tier of KAIROS where users bring their own accounts with lower volume

**Why Composio over Pipedream as fallback:**
- Per-tool-call pricing vs per-user: at realistic KAIROS usage (25-100 agent actions/day), Composio is ~$0.23-$0.50/user/mo — far cheaper than Pipedream
- Native MCP story is the cleanest of the three
- Series A funding with strong investors (Lightspeed) provides more runway than Pipedream (enterprise-pivoted acquiree)
- BYOC (bring your own OAuth credentials) is well-documented and production-ready

**Composio caveats:**
- May 2026 security incident is concerning for storing personal account tokens (Gmail, GitHub)
- No self-hosting escape hatch — if Composio folds, all users must re-authorize
- No token export/retrieval API — zero migration path without re-auth

---

### Hybrid Strategy

**Recommended architecture:**

```
Tier 1: Nango Self-Hosted (Enterprise)
  → Store all OAuth tokens in self-hosted Nango
  → Use Nango proxy/MCP for all agent tool calls
  → Register KAIROS's own OAuth apps at Slack, Gmail, etc. (BYOC)
  
Tier 2: Composio Hosted (Starter/Production plan)
  → Use ONLY for long-tail connectors (apps in Composio but not Nango's 800+)
  → Route tool calls for these specific integrations through Composio
  → Do NOT store primary tokens in Composio — use Nango for auth, call Composio as execution layer
  
Tier 3: DIY (for 3-5 critical high-volume integrations)
  → Slack, Gmail, GitHub: Register own OAuth apps, store tokens directly in KAIROS's encrypted Postgres
  → Build thin PKCE + TokenManager for these 3-5 apps
  → Gives full control, zero per-call cost, direct API access
```

This hybrid gives:
- Full ownership of critical paths (Slack/Gmail)
- Nango's broad 800+ API coverage for mid-tier integrations
- Composio's long tail for exotic connectors
- MCP via Nango (primary) and Composio (secondary)
- Total estimated cost: $400-800/mo infrastructure + Enterprise license vs $2,000-6,000/mo for full cloud solutions

---

## 6. Build vs Buy Analysis

### The DIY Option: Register Your Own OAuth Apps

**What it entails:**
- Register OAuth apps at each provider (Slack, Gmail, GitHub, Notion, Linear, etc.)
- Build PKCE flow for each (or use an OAuth library like `passport.js`, `oauth4webapi`)
- Build TokenManager: encrypted storage, refresh logic, expiry tracking
- Handle provider-specific quirks: Google's 7-day token expiry on unverified apps, Slack's token rotation, Microsoft's multi-tenant weirdness
- Build "Connect Account" UI: redirect, callback, success state

**Effort estimates:**

| Task | One-time work | Ongoing/year |
|------|--------------|-------------|
| Register OAuth apps (10 providers) | 2-3 days | ~1 day (app reviews, key rotation) |
| PKCE + callback flow (per provider) | 1-2 hours per provider | Minimal |
| TokenManager (Postgres-backed, encrypted) | 3-5 days | ~1 week/year (security patches, refresh bugs) |
| Token refresh + error handling | 2-3 days | ~2 weeks/year (provider spec changes) |
| App review (Slack `chat:write`, Gmail Send, etc.) | 1-2 weeks per sensitive scope | Ongoing (re-reviews on changes) |
| Rate limit handling | 2-3 days | ~1 week/year |
| Testing (end-to-end OAuth flows) | 3-5 days | ~2 days per major update |
| **Total initial investment** | **~6-8 weeks for 10 providers** | **~6-8 weeks/year maintenance** |

**Cost at scale:**
- Developer time: 6-8 weeks initial × $150-200/hr = $36,000-$64,000 one-time
- Annual maintenance: 6-8 weeks × $150-200/hr = $36,000-$64,000/year
- Infrastructure: ~$50-100/mo (just Postgres + Redis for token storage)
- Per-user cost at 1,000 users: **~$0.05-$0.10/user/mo** (essentially free except dev time)

**DIY advantages:**
- Zero per-user or per-call platform cost
- Full control over token security architecture
- No vendor lock-in
- Perfect AGPL alignment
- Can implement custom security (HSM, zero-knowledge, etc.)
- Tokens never leave your infrastructure

**DIY disadvantages:**
- App review friction: Getting `chat:write` approved for Slack takes weeks; Google's Gmail `Send` scope requires security assessment; Notion, Linear, GitHub are easier but still require manual app registration
- Ongoing maintenance: Every provider spec change is your problem
- Scale of connectors: Getting to 50+ providers takes 6+ months
- Long tail is genuinely hard: Provider quirks, token formats, scope changes, deprecations
- No MCP server out of the box — you'd need to build one

**Recommendation for DIY:** Only for the top 3-5 integrations (Slack, Gmail, GitHub, Notion, Google Calendar) where volume justifies the investment and you want maximum control. Use Nango (self-hosted) for everything else.

---

## 7. Action Items

Listed in priority order, assuming Nango self-hosted is the primary choice:

1. **[IMMEDIATE] Sales call with Nango** — Get Enterprise self-hosted pricing. The single biggest unknown is whether the annual license fee is $500, $5,000, or $50,000. This determines whether the entire recommendation holds.
   - Contact: https://nango.dev → "Get a demo" / enterprise sales
   - Key questions: (a) Annual license cost for self-hosted Enterprise, (b) feature list confirmation (MCP included?), (c) support terms, (d) token migration/export guarantees

2. **[1 WEEK] Spike: Nango self-hosted deployment** — Deploy Nango free tier (auth+proxy only) to a test environment. Validate that the 5-service infrastructure fits your existing cloud setup. Document effort required.
   - Resources: `nango.dev/docs/guides/platform/self-hosting`
   - Target: Validate Helm chart deploys cleanly on your existing Kubernetes or confirm ECS path

3. **[1 WEEK] Spike: Composio free tier** — Implement the full Slack connection flow with custom auth config on Composio's free tier. Measure actual tool call volume per active user day to validate the $0.23/user/mo estimate.

4. **[2 WEEKS] DIY Slack + Gmail OAuth** — Regardless of platform choice, register KAIROS's own OAuth apps at Slack and Gmail. These are the two highest-volume integrations; having your own app gives you rate limit isolation, faster review cycles, and the BYOC option for any platform. This is a prerequisite for white-label OAuth everywhere.

5. **[POST-NANGO-DEAL] Implement Nango self-hosted with BYOC** — Once Enterprise licensing is confirmed:
   - Deploy Nango Enterprise self-hosted
   - Configure KAIROS's Slack, Gmail, GitHub, Notion, Linear OAuth apps as integrations
   - Implement `openConnectUI()` flow in KAIROS frontend
   - Store `connection_id` per user in KAIROS's Postgres
   - Implement Nango webhook handler for auth events
   - Wire up Nango proxy for agent tool calls

6. **[ONGOING] Monitor Composio security posture** — If using Composio as a fallback for long-tail connectors, watch their security bulletins. The May 2026 incident should resolve with their zero-trust architecture rewrite. Revisit in Q3 2026.

7. **[SKIP for now] Pipedream** — Do not build new integration infrastructure on Pipedream. The Workday acquisition makes the product roadmap and pricing opaque. Revisit only if Workday publishes a clear developer-friendly standalone pricing page for Pipedream Connect post-acquisition.

---

## Appendix: Pricing Limitations Disclosure

The following information was **not publicly available** and would require a sales call to confirm:

- **Nango Enterprise self-hosted annual license cost** — Critical unknown. Research found it's "a fixed annual license + fraction of cloud usage-based fees" but no dollar amount was disclosed.
- **Composio Enterprise VPC pricing** — Custom quoted. No floor/ceiling found.
- **Pipedream post-acquisition pricing** — As of May 2026, unclear whether Workday will maintain the $150/mo + $2/user Connect plan, move to enterprise-minimum, or sunset the standalone product.
- **Composio premium tools list** — Which specific integrations are "premium" (3x cost) was not fully disclosed in public documentation. Requires testing or documentation review.
- **Nango Enterprise feature list confirmation** — The self-hosting docs suggest MCP requires Enterprise, but the exact feature boundary between Growth cloud and Enterprise self-hosted was not clearly delineated.

---

*Research conducted 2026-05-25. Pricing and product features change rapidly in this space — verify all figures with each vendor before making commitments.*
