# Follow-up: Shared OAuth + Platform Status Updates

**Date:** 2026-05-27  
**Author:** Research agent (Claude Sonnet 4.6)  
**Predecessor:** `2026-05-25-connection-platforms-research.md`  
**Purpose:** Answer four follow-up questions: shared OAuth viability, Pipedream current status, Composio post-breach, and Nango MCP in OSS repo.

---

## Question 1: Shared OAuth Apps — Production Viability

### 1a. Nango — Shared App

**Does Nango offer shared OAuth apps?**  
Yes. Nango ships "built-in shared developer apps" for popular OAuth 2.0 APIs (including Slack, GitHub, Notion, etc.) so you can test connections with zero setup. These work in their cloud environment.

**What does the user see on the consent screen?**  
With the shared app: **"Nango wants access to your [Provider] account."** The Nango brand name is on the OAuth consent screen at the third-party provider (Slack/GitHub/etc.), not KAIROS's name.

**Documented production limitations:**

| Limitation | Detail |
|------------|--------|
| Branding | Users see "Nango" on consent screens — Nango explicitly calls this out as a blocker for enterprise prospects who conduct security reviews |
| Fixed scopes | Nango's shared app has fixed scope sets — you cannot request additional scopes the provider exposes. For example, if Nango's Slack shared app doesn't include `channels:history`, you cannot add it without your own app. |
| Revocation risk | "Most providers don't allow shared credentials. Nango developer apps may be revoked by the provider at any time" — this is stated directly in Nango's own auth guide. If Slack decides shared apps are TOS violations, KAIROS loses all connections instantly. |
| Marketplace incompatibility | Provider app marketplaces (Slack App Directory, Google Workspace Marketplace) require a first-party registered app — impossible with shared credentials. |
| Callback URL locked | Shared apps use Nango's callback URL; you cannot set a custom domain callback. |
| Token portability | Only apps registered with your own credentials allow exporting access + refresh tokens to migrate off Nango without users re-authorizing. Shared app tokens are not exportable. |
| Nango's own recommendation | **"We strongly recommend registering your own OAuth app before going live."** — This is explicit in their documentation. |

**Migration path from shared to BYOC:**  
Nango documentation does not describe a re-auth-free migration from shared to custom credentials. The portability caveat implies that switching from Nango's shared app to BYOC **requires users to re-authorize** — because the OAuth grant was made to Nango's app, not to KAIROS's app. There is no documented token migration mechanism.

**Verdict: Shared OAuth is dev-only for Nango.**  
The combination of provider TOS risk (revocation at any time), fixed scopes, "Nango" branding on consent screens, and the complete lack of a migration path to BYOC without forced re-auth makes shared Nango credentials a prototype-only tool. Nango itself says "strongly recommend registering your own OAuth app before going live." The upgrade path is a wall, not a ramp.

---

### 1b. Composio — Shared App (Managed Auth)

**Does Composio offer shared OAuth apps?**  
Yes. Composio calls this "Managed Auth" — it's the default mode. Composio has pre-registered OAuth apps at Slack, Gmail, GitHub, Google Drive, etc. You can use them with zero setup.

**What does the user see on the consent screen?**  
**"Composio wants access to your account."** Additionally, Composio's hosted Connect UI shows a **"Secured by Composio" badge** on the connection widget — doubly non-white-label.

**Documented production limitations:**

| Limitation | Detail |
|------------|--------|
| Branding | Composio brand on consent screen AND connection UI watermark |
| Shared rate limits | "Quota is shared across all Composio users" — if Composio's shared Slack app is heavily used by other customers, KAIROS hits Slack rate limits faster. Not isolated. |
| Scope restrictions | Limited to Composio's default scope sets per integration. Cannot request non-default scopes. |
| Polling intervals | Minimum 15-minute polling for triggers on managed apps. |
| Self-hosted instances | Cannot connect to self-hosted or regional variants of tools (e.g., self-hosted Gitlab, Jira Data Center) |
| **BREAKING change confirmed:** | Composio's `initiate()` method for managed OAuth **will return 400 BadRequest starting 2026-05-08 for new organizations.** This means managed auth is being deprecated for new signups. Existing users may retain it, but new KAIROS onboarding cannot use managed auth by design. |

**Migration path from shared to BYOC:**  
Composio describes a straightforward upgrade path:
1. Register your own OAuth app at the provider
2. Create a `custom auth config` in the Composio dashboard (`POST /auth_configs`)
3. Pass the resulting `auth_config_id` when creating new connections

**Critical caveat:** This migration creates *new* connections under BYOC; existing connections under managed auth do **not** transfer. Any users who connected via Composio's managed app must **re-authorize** against the new custom auth config. There is no documented token portability between managed and custom auth configs.

**Verdict: Shared OAuth is deprecated/dev-only for Composio.**  
The 2026-05-08 deprecation of managed auth for new organizations removes this option from the table entirely for KAIROS. Even if that deadline is flexible, the forced re-auth on migration, shared rate limits, and absence of scope flexibility make managed auth structurally unsuitable for production. KAIROS would need BYOC from day one.

---

### 1c. Pipedream — Shared App

**Does Pipedream offer shared OAuth apps?**  
Yes. Pipedream maintains its own registered OAuth apps at major providers. By default, users connecting via Pipedream Connect use Pipedream's apps.

**What does the user see on the consent screen?**  
**"Pipedream wants access to your [Provider] workspace."** Users see the Pipedream brand unless KAIROS supplies custom OAuth credentials.

**Documented production limitations:**  
This is the most restrictive of the three platforms on this dimension. Pipedream has a **hard production block on shared OAuth apps**:

- The error `"Running workflows with official OAuth apps is not allowed"` is widely documented in Pipedream's community forums (multiple threads from 2025-2026).
- This error fires when KAIROS attempts to trigger workflows on behalf of end users while using Pipedream's own OAuth app.
- The resolution documented by Pipedream support: **"To run workflows on behalf of end users in production, you must connect their accounts using your own OAuth client that you configure in Pipedream."**
- This is not a soft recommendation — it is a **runtime enforcement block**. Production mode workflows with shared OAuth apps return HTTP errors.
- Google services (Gmail, Google Drive, Google Sheets) are particularly affected — multiple community posts confirm this.

**Migration path from shared to BYOC:**  
You configure your own OAuth client in Pipedream's dashboard. Existing connections made through Pipedream's shared app will need to be re-authorized against your custom client — no token migration.

**Verdict: Shared OAuth is explicitly blocked in production for Pipedream.**  
Not just discouraged — runtime-blocked. KAIROS would receive HTTP errors trying to use Pipedream's shared OAuth apps in a production workflow for end users. BYOC is mandatory from the start if using Pipedream Connect.

---

### Summary Table

| Platform | User sees on consent | Dev-only restriction | Production block | Forced re-auth on migration to BYOC |
|----------|---------------------|---------------------|-----------------|--------------------------------------|
| Nango | "Nango wants access" | Docs say "strongly recommend own app before going live"; revocation risk | No hard block, but TOS and scope limits are real | Yes — re-auth required |
| Composio | "Composio wants access" + watermark badge | Deprecated for new orgs as of 2026-05-08 | Soft (deprecated for new signups) | Yes — re-auth required |
| Pipedream | "Pipedream wants access" | Hard runtime block in production | **Yes — HTTP error returned** | Yes — re-auth required |

**The bottom line on "can we skip BYOC?":** No, not for any of the three platforms in production. All three converge on the same answer: BYOC is required for production. Shared/managed OAuth is dev-only tooling. The migration path from shared to BYOC always requires user re-authorization on all three platforms — there is no "silent upgrade" path.

---

## Question 2: Pipedream Current Status (May 2026)

### 2a. Is Pipedream Connect still purchasable?

**Yes, as of May 2026.** The Pipedream Connect page (`pipedream.com/connect`) loads and shows the product as available, including a "Sign up" CTA. The banner reads "Pipedream has joined Workday" linking to the acquisition announcement, but the product pages for Connect remain functional and the product is purchasable.

Key availability facts confirmed:
- `pipedream.com/connect` — active, loads product page
- `pipedream.com/docs/connect/mcp` — active documentation
- `mcp.pipedream.com` — **still working and active** (not redirecting to a Workday announcement page). A third-party status tracker confirms **100% uptime over the last 90 days** for Pipedream Connect.
- `mcp.pipedream.net/v2` — the static MCP URL endpoint remains active.
- The product offers MCP Servers, Managed Authentication, 10,000+ Tools, Connect Proxy, REST APIs and SDKs.

**The prior report's claim that `mcp.pipedream.com` "now redirects to a Workday announcement page" was incorrect or has since been reversed.** The site operates normally.

### 2b. Is mcp.pipedream.com working?

**Yes.** Live verification shows `mcp.pipedream.com` as a functional MCP catalog page ("Powered by Pipedream Connect"), not an acquisition redirect. The acquisition announcement banner appears on the site but the product is operational.

### 2c. Post-Workday developer product status

- Acquisition closed January 31, 2026.
- Pipedream continues operating as a standalone product within Workday.
- The "Pipedream has joined Workday" banner on Connect pages acknowledges the acquisition but the developer-facing product has not been sunsetted.
- No public announcement of pricing changes or developer-unfriendly pivots has been published.
- Workday's stated intent remains using Pipedream to "bridge Workday's 75M+ enterprise user base with third-party systems for AI agent workflows" — suggesting they want the platform functional.

### 2d. Can KAIROS use Pipedream Connect today with confidence?

**Weakly yes for the next 3-6 months; structurally risky beyond that.** The product is purchasable, the MCP endpoint is live, and pricing appears unchanged (the Connect plan remains listed). However:

- No explicit Workday roadmap for the standalone developer product has been published.
- The fundamental concern from the prior report stands: a $60B enterprise HR vendor acquired Pipedream to serve its own enterprise AI agent use case. Pricing changes (enterprise minimums, sunset of sub-$1,000/mo tiers) remain a latent risk.
- **Hard production block on shared OAuth apps** (as documented in Question 1) means KAIROS would need BYOC regardless — eliminating the one potential simplification of using Pipedream.
- The $2/user/mo pricing at scale remains at the edge of KAIROS's budget, with no volume discount published.

**Verdict: Pipedream Connect is alive and purchasable today, but the BYOC requirement, unchanged pricing ceiling, and unresolved post-acquisition roadmap make it the least attractive option for KAIROS among the three.**

---

## Question 3: Composio Post-Breach (Two Weeks Later)

### 3a. Zero-trust architecture rewrite — shipped or promised?

**Promised, not yet shipped.** As of May 27, 2026 (six days after the breach was discovered on May 21), Composio has announced the following architectural changes:

- **Zero Trust Proxy KMS** — customers can self-custody their encryption keys, making API keys visible only at creation time and not readable after. Status: **announced as upcoming product update**, not released.
- **IP allowlisting** — automatic IP allowlisting based on pre-incident usage patterns. Status: **partially deployed** (auto-IP allowlisting is live; customer-controlled IP restrictions announced as coming).
- **Create-time-only API keys** — keys will not be readable after initial creation. Status: **announced**, not confirmed shipped.
- **Honeypot routes and obfuscated internal routes** — deployed as part of incident response.

The zero-trust KMS is a significant architectural change that requires customers to manage their own encryption keys — this is not a quick fix. Given the breach was discovered May 21 and this report is May 27, shipping a production zero-trust KMS in 6 days is implausible. It is a roadmap item.

### 3b. Post-incident customer sentiment

**Mixed to negative.** Key signals:

- **Composio's own status page shows three active incidents as of May 26:**
  1. Composio Platform — partial outage, under monitoring since May 25
  2. Composio CLI — issues since May 24
  3. MCP Connection Creation — under investigation since May 24
  These post-breach outages (4-6 days after the incident) suggest instability in the platform's recovery.

- **Competitor positioning:** Metorial published a post titled "Composio security incident: what it means for MCP security" explicitly positioning itself as an alternative. Nango published a Composio vs. Nango comparison that directly addresses the breach. Multiple "best Composio alternatives" articles appeared on Scalekit, Agensi, and Krowdbase in the days after the breach.

- **Ryan Carson (influential developer advocate) on X:** "Another scary attack vector to monitor and protect yourself against. Agentic hackers are now hacking your agents." — Not a brand-positive signal.

- **Hacker News (item #45583676):** A thread about Metorial includes comments expressing preference for platforms offering token portability (explicit concern about Composio's no-export model), and developers citing self-hosting flexibility as a requirement after the breach.

- No major publicly identified enterprise customers have announced switching, but this is expected — enterprise churn takes months to manifest publicly.

### 3c. Major customers staying or leaving?

No publicly announced customer departures found. Composio states they did 1-on-1 remediation sessions with affected customers, which may have mitigated immediate churn. However, the ongoing platform instability (three active incidents 4-6 days post-breach) will likely affect enterprise sales pipelines even if existing customers tolerate it.

### 3d. Realistic risk assessment

**Using Composio for Slack, Gmail, and GitHub right now carries elevated but not catastrophic risk.** The breach was real but limited: 0.3% of active connections affected, mostly GitHub tokens. Composio's response was professional — they published a detailed post-mortem, rotated all API keys, and have a remediation roadmap.

However, several factors still argue against Composio as KAIROS's primary OAuth platform:

1. **Architecture has not been fixed yet.** The zero-trust KMS is promised, not shipped. Today's Composio has the same fundamental architecture as pre-breach — just with some monitoring improvements.
2. **Three active platform incidents as of May 26.** The recovery is not clean.
3. **No token export.** If Composio suffers another breach or goes down, KAIROS users must re-authorize everything — there is no migration escape hatch.
4. **This is their second disclosed incident in 2026** (February 9 incident report also exists). A pattern is forming.
5. **For personal account tokens (KAIROS's use case) — Gmail, personal Slack, personal GitHub** — the risk is qualitatively different than for a B2B SaaS tool. A breach at Composio means KAIROS users' *personal* accounts are compromised.

**Verdict: Composio is production-risky for KAIROS's use case specifically.** The breach has not "settled" — the architecture is not yet fixed and the platform has ongoing instability. The recommendation is to avoid using Composio as the primary token store for personal user account credentials (Gmail, Slack, GitHub). It remains viable as an execution layer for long-tail connectors where KAIROS stores the auth elsewhere and Composio is just the tool-calling proxy.

---

## Question 4: Nango MCP in the OSS Repository

### 4a. MCP server code in the repository?

**Yes, definitively.** The Nango MCP server is fully implemented in the open-source GitHub repository at `https://github.com/NangoHQ/nango`. The relevant files are:

| File | Purpose |
|------|---------|
| `packages/server/lib/controllers/mcp/mcp.ts` | HTTP route handlers for `POST /mcp` and `GET /mcp` (74 lines) |
| `packages/server/lib/controllers/mcp/server.ts` | Core MCP server implementation using `@modelcontextprotocol/sdk` |
| `packages/shared/lib/clients/mcp.client.ts` | MCP OAuth client registration (for `MCP_OAUTH2` providers) |
| `packages/shared/lib/clients/mcpGeneric.client.ts` | Generic MCP client |
| `packages/types/lib/mcp/api.ts` | TypeScript type definitions for MCP API |

The MCP server code is not behind a separate repository or paid binary. It is in the same repo as the rest of Nango, under the same ELv2 license.

### 4b. License status

The entire `NangoHQ/nango` repository is under **Elastic License 2.0 (ELv2)**. There is no separate license for the MCP code — it falls under the repo-wide ELv2 license. The `LICENSE` file at the root confirms this. ELv2 permits using the software within your own product (KAIROS's case) but prohibits offering it as a hosted service to others.

### 4c. Can a self-hoster build and run MCP from source?

**Technically yes — practically gated by Nango's plan system, not a binary license key.**

Here is the exact mechanism:

1. The MCP route is defined in `routes.public.ts` as:
   ```typescript
   publicAPI.route('/mcp').post(apiAuth, withScope('environment:mcp'), postMcp);
   ```

2. The `withScope('environment:mcp')` middleware checks whether the API key making the request was granted the `environment:mcp` scope.

3. In `createApiKey.ts`, any scope from the `apiKeyScopes` list can be assigned — including `environment:mcp`. There is no plan-level check blocking scope assignment at the code level when creating an API key.

4. However, **Nango's self-hosted plan system** (stored in the database) determines what scopes an account is allowed to use in practice. The self-hosting documentation's feature table explicitly states: **MCP server: No (free self-hosted) / Yes (Enterprise self-hosted / Nango Cloud).**

5. **There is no `ENTERPRISE_LICENSE_KEY` environment variable or binary license check.** The gate is implemented through Nango's plan/subscription system in the database, not through a cryptographic license verification at runtime.

**Practical implication:** A self-hoster who deploys the full Nango stack from source and directly sets their account's plan to a tier that includes `environment:mcp` — or simply creates an API key with `environment:mcp` scope via the `POST /v1/environments/:envId/api-keys` endpoint with `"scopes": ["environment:mcp"]` — can run the MCP server without paying for Enterprise. The code runs. Nango's business protection is a database flag, not a runtime license gate.

**This is a meaningful finding**: if KAIROS self-hosts Nango from source, they can enable MCP by bootstrapping the database with the appropriate plan or by creating API keys with the `environment:mcp` scope directly. This does not require a sales call or Enterprise license negotiation.

### 4d. Architectural pattern of Nango's MCP server

The MCP server does **not** auto-expose all 800+ providers as tools. The pattern is:

1. **Per-connection, per-provider scoping.** The route requires two headers per request: `connection-id` and `provider-config-key`. The server instance is created for exactly one connection/provider pair.

2. **Actions-based tools.** The tools exposed via MCP are the **scripted Actions** you have configured for that provider in your Nango integration. Each action becomes an MCP tool with the action name, input schema, and description.

3. **No automatic tool generation.** If you connect a user's Slack account but haven't defined any Slack Actions in Nango, the MCP server returns an empty tool list for that connection. You must write (or generate via AI) Nango Action scripts for each capability you want exposed.

4. **Per-request server instantiation.** `createMcpServerForConnection()` builds a fresh MCP server instance on every HTTP POST to `/mcp`. It queries the database for enabled actions, registers them as tools, and handles the MCP session.

**Implication for KAIROS:** Nango's MCP approach requires writing Action scripts per-provider. This is more work than Composio's pre-built tool catalog (which auto-exposes actions for all supported apps), but more flexible and privately hosted. The AI-assisted connector builder (mentioned in Nango's April 2026 fundraising materials) is meant to make writing Actions faster.

---

## Updated Recommendation

### What Changed

The prior recommendation was: **Nango self-hosted (Enterprise license) as primary, Composio hosted as fallback.**

Four new findings materially change this:

1. **Shared OAuth is dead on all three platforms for production.** The "skip BYOC" question is definitively answered: no. Register your own OAuth apps at Slack, Gmail, etc. from day one on any platform. Budget 1-2 weeks for this, regardless of platform choice.

2. **Nango's MCP is in the OSS repo with no binary license gate.** A self-hoster can run MCP from source by assigning the `environment:mcp` scope to API keys. The plan-gate is in the database, not a license key. This eliminates the biggest uncertainty from the prior report — no Enterprise sales call needed to get MCP working in self-hosted.

3. **Composio is production-risky today.** Active platform instability post-breach (3 ongoing incidents May 26), zero-trust architecture not yet shipped, and no token export mean it should not be the primary token store for personal user credentials. It can still serve as an execution layer for long-tail connectors.

4. **Pipedream Connect is alive, not dead.** The prior report over-stated the mcp.pipedream.com situation. The product is functional. However, the hard production block on shared OAuth (requiring BYOC regardless) and the unchanged pricing ceiling make Pipedream the weakest of the three options for KAIROS's specific needs.

### Revised Architecture

```
Primary: Nango Self-Hosted (free tier, MCP unlocked via API key scope)
  → Self-host from source (ELv2 license permits KAIROS's use case)
  → Create API keys with environment:mcp scope via database bootstrap
  → Register KAIROS's own OAuth apps at Slack, Gmail, GitHub, Notion, Linear (BYOC)
  → Store all connection tokens in self-hosted Nango Postgres
  → Use Nango MCP server for agent tool calls (write Actions via AI codegen)
  → Use Nango proxy for direct API calls
  → Infrastructure cost: ~$200-400/mo for 1,000+ users

Avoid (for now): Composio as primary token store
  → Too risky as personal credential custodian post-breach
  → Platform instability ongoing
  → No token export (no escape hatch)
  
Consider: Composio for execution-only (no token storage)
  → For long-tail connectors not yet in Nango's 800+ API set
  → KAIROS authenticates via Nango; forwards execution requests to Composio's tool API
  → Composio never holds the primary tokens; just executes against a passed token
  
Avoid: Pipedream
  → BYOC mandatory (shared apps hard-blocked in production)
  → Pricing ceiling too close to KAIROS's $2/user limit
  → Workday roadmap uncertainty unchanged
```

### Revised Cost Estimates

| Scenario | Monthly cost at 1,000 users | Per-user cost |
|----------|---------------------------|---------------|
| Nango self-hosted (free tier, MCP scope via DB) | ~$300/mo infra | **~$0.30/user/mo** |
| Nango Cloud (Growth tier) | ~$5,400/mo | $5.40/user — still unsustainable |
| Composio (execution-only, 25 tool calls/day/user) | ~$229/mo | $0.23/user/mo |
| Pipedream Connect (BYOC) | ~$1,950/mo | $1.95/user/mo |

**If the self-hosted MCP unlock via database scope works as the code suggests, the recommended stack costs roughly $0.50-0.60/user/mo** ($300 infra + ~$229 Composio for long-tail execution = $529/mo total) — well within the $2/user budget.

### Key Remaining Risk

The Nango self-hosted MCP unlock needs to be validated in a real deployment. The code analysis shows no binary license gate, but Nango's plan system may have additional enforcement that isn't visible in the controller layer (e.g., middleware that checks the plan before allowing API key creation with certain scopes, enforced at a layer not reviewed here). The mitigation: deploy a test instance, attempt to create an API key with `environment:mcp` scope, and test the `/mcp` endpoint. This is a 2-hour spike with a clear binary outcome.

### New "Biggest Decision"

**The decision is no longer "which platform" — it is "do we self-host Nango and unlock MCP for free, or negotiate an Enterprise license?"**

If the free-tier MCP scope unlock works: no Enterprise license needed, recommendation simplifies dramatically, and the cost math becomes very favorable. If Nango has additional enforcement that blocks this, the Enterprise license negotiation (unknown cost, sales call required) returns as the critical path item.

---

*Research conducted 2026-05-27. Sources: Nango GitHub repo (NangoHQ/nango, master branch), Nango docs, Composio docs (docs.composio.dev), Composio status page (status.composio.dev), Composio post-incident blog (composio.dev/blog/composio-may-2026-security-incident), Pipedream Connect page and docs (pipedream.com), Pipedream community forums, Metorial incident analysis (metorial.com/blog), Nango comparison posts (nango.dev/blog).*
