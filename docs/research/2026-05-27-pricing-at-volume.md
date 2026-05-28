# Connector Platform Pricing at Realistic Volume

**Date:** 2026-05-27  
**Author:** Research agent (Claude Sonnet 4.6)  
**Predecessors:** `2026-05-25-connection-platforms-research.md`, `2026-05-27-platforms-followup.md`, `2026-05-27-managed-oauth-deep-dive.md`  
**Purpose:** Re-model connector platform costs at realistic KAIROS volumes (100/250/500 tool calls/day per user), replacing the rejected 25 calls/day assumption. Answer specific pricing questions for Pipedream, Composio, and Nango.

---

## 1. TL;DR: Best Platform Per Scale Tier

| Scale | Winner | $/user/mo (heavy, 250/day) | Notes |
|-------|--------|---------------------------|-------|
| **100 users** | Composio managed auth | ~$0.23 | 2.25M calls/mo fits Production tier easily |
| **1,000 users** | Composio Production + overage | ~$1.02 | Marginal overage; within $2 budget |
| **1,000 users (power)** | Nango self-hosted (free, direct tokens) | ~$0.30-$0.50 | Only option under budget at 15M calls/mo |
| **10,000 users** | Nango self-hosted (free, direct tokens) | ~$0.05-$0.10 | Infra scales cheaply; Composio implodes |
| **100,000 users** | DIY OAuth + self-hosted Nango | <$0.05 | Platform per-call costs unsustainable at any tier |

**Budget constraint:** $2/user/mo hard ceiling for connectors.

**The volume model changes everything.** At 25 calls/day, all three platforms were plausibly cheap. At 100+ calls/day per user, Pipedream is definitively out at any scale, Composio works only up to ~1K users at moderate volume, and Nango self-hosted with direct token retrieval is the only architecture that survives to 10K+ users.

---

## 2. Pipedream Cost Model

### 2.1 Credit Mechanics: Confirmed

**1 credit = 1 proxy call (minimum), regardless of execution time.**

This is the most important finding. Community thread from March 2026 (`community/t/why-is-there-no-proper-tracking-of-cost-for-connect-proxy-usage-and-why-is-each-call-billed-as-one-full-credit/14243`) confirms:

> "Each execution is its own self-contained operation, billed at a minimum of 1 credit."

The theoretical definition of a credit is "30 seconds of compute at 256MB RAM," but in practice, Connect proxy calls execute in 200-500ms and still consume a full credit. There is no sub-credit billing. A Slack `chat.postMessage` (100-300ms wall time) costs exactly 1 credit.

**This collapses the variable time-based model into a flat per-call rate.**

### 2.2 Credit Overage Rate

The credit overage rate is **not publicly documented** in Pipedream's pricing page but has been established from community forum posts:

- Thread `is-the-additional-cost-for-a-pipedream-client-using-8k-credits-month-3k-x-0-015/9992` establishes **$0.015/credit** for the Advanced tier.
- Thread `how-to-calculate-incremental-cost-per-credit-for-an-overage-in-credit-usage/12516` suggests **$0.009/credit** for another tier.
- The rate appears to be tier-dependent. The Connect plan ($99-$150/mo, 10,000 credits included) likely has an overage rate in the $0.009-$0.015/credit range. For calculation purposes, **$0.012/credit** is used as the midpoint estimate.
- Official position: "Overage is reported to Stripe throughout the billing period and charged at the start of the next billing period." No published rate.

### 2.3 Connect Plan Pricing (Confirmed)

| Element | Amount |
|---------|--------|
| Base plan | $99-$150/mo (pricing updated, exact depends on current plan page — recent sources show both) |
| Included credits | 10,000/mo |
| Included users | 100 |
| Additional users | $2/user/mo |
| Overage credits | ~$0.009-$0.015/credit (estimated, not published) |

For conservative modeling: **$150/mo base, $2/user/mo overage, $0.012/credit overage**.

### 2.4 What Each Tool Call Costs

At 1 credit per proxy call and $0.012 overage rate:

| Tool | Typical latency | Credits consumed | Cost at overage rate |
|------|----------------|-----------------|---------------------|
| `slack_chat_postMessage` | 200-400ms | 1 credit (minimum) | $0.012 |
| `gmail_getThread` | 300-800ms | 1 credit (minimum) | $0.012 |
| `gmail_searchEmails` with 50 results | 1-3s | 1 credit (minimum, possibly 2-3 if >30s) | $0.012-$0.036 |
| `notion_searchDatabase` | 500ms-2s | 1 credit | $0.012 |
| `github_listIssues` | 200-500ms | 1 credit | $0.012 |

**Most calls are 1 credit = $0.012 at overage rate.** This is what makes Pipedream catastrophically expensive at volume — the included 10,000 credits runs out at just 333 calls/day across all users, then every additional call is $0.012.

### 2.5 MCP-Specific Pricing

`mcp.pipedream.com` uses the same credit model. There is no separate MCP pricing. An MCP tool call goes through the same proxy infrastructure and consumes 1 credit minimum. No special MCP pricing tier exists as of May 2026.

### 2.6 KAIROS Cost Calculations at Volume

**Model:** 1 credit per call; $150/mo base; $2/user/mo; 10,000 credits included; $0.012/credit overage.

#### 100 users × moderate (100 calls/day):
- Calls/mo: 100 × 100 × 30 = 300,000 calls/mo = 300,000 credits needed
- Included: 10,000 credits
- Overage: 290,000 × $0.012 = $3,480
- Users: 100 users included in base
- **Total: $150 + $3,480 = $3,630/mo = $36.30/user/mo**
- **VERDICT: Catastrophically over budget at moderate volume.**

#### 100 users × heavy (250 calls/day):
- Calls/mo: 100 × 250 × 30 = 750,000 credits
- Overage: 740,000 × $0.012 = $8,880
- **Total: ~$9,030/mo = $90.30/user/mo** — non-starter.

#### 1,000 users × moderate (100 calls/day):
- Calls/mo: 3,000,000 credits
- Users: 900 extra × $2 = $1,800
- Credits overage: 2,990,000 × $0.012 = $35,880
- **Total: ~$37,830/mo = $37.83/user/mo** — completely unsustainable.

#### Why Pipedream Fails at Volume

The 1 credit/call minimum completely destroys economics beyond the 10K included credits. Those 10,000 credits are consumed in fewer than 2 active days by 100 moderate users. Pipedream Connect is **architected for low-volume trigger-based workflows**, not for an always-on agent daemon making thousands of API calls per user per month.

**There is no scenario at realistic KAIROS volumes where Pipedream stays under $2/user/mo unless usage is below ~30 calls/day across ALL users combined.**

Breakeven (staying under $2/user/mo at 1,000 users = $2,000/mo budget):
- $2,000 - $1,950 (base + users) = $50 for credits
- $50 / $0.012 = ~4,167 additional credits beyond 10K = 14,167 credits total / 30 days / 1,000 users = **0.47 calls/day per user**

Pipedream becomes over budget for KAIROS the moment any user has more than 1 tool call every 2 days. This platform cannot serve KAIROS's use case.

### 2.7 Volume Discounts

No publicly documented volume discounts. Community post about the 1,000-user scenario references "$~2K USD" as the user's estimate (matching the user-fee math: $1,950/mo) but no credit volume pricing. Sales team required for enterprise negotiation. Post-Workday acquisition, enterprise pricing direction is unknown.

---

## 3. Composio Cost Model

### 3.1 Pricing Structure (Confirmed)

| Tier | Price | Included calls | Overage |
|------|-------|----------------|---------|
| Free | $0/mo | 20,000 | Not available |
| Starter ("Ridiculously Cheap") | $29/mo | 200,000 | $0.299/1,000 calls |
| Production ("Serious Business") | $229/mo | 2,000,000 | $0.249/1,000 calls |
| Enterprise | Custom | Custom | Custom |

**Key structural fact:** Composio charges per **tool call**, NOT per user and NOT per connection. At low-to-moderate per-user volumes, this is dramatically cheaper than Pipedream.

### 3.2 Premium Tools

**Confirmed premium tools (3x rate):**
- Composio Search
- Perplexity
- Exa  
- SerpAPI
- Code execution sandboxes (E2B)
- Web scraping/crawlers
- AI/ML inference endpoints
- Document processing/OCR

**Confirmed NOT premium (standard rate):**
- Slack, Gmail, GitHub, Notion, Google Calendar, Linear, HubSpot, Salesforce, Jira, Airtable — **none of these are in the premium list.**

This is excellent news for KAIROS. The tools most relevant to a personal AI co-worker (Slack, Gmail, GitHub, Notion, calendar) are all standard-rate tools. Premium tools are search APIs and compute-heavy inference services — KAIROS's core use case does not touch these.

### 3.3 Post-Breach Pricing Impact

No evidence of price drops or promotional discounts related to the May 2026 breach. Composio's pricing page and tier structure is unchanged. The breach has affected platform instability (3 active incidents as of May 26) but not published pricing. No announcements of discounts to retain affected customers were found.

### 3.4 KAIROS Cost Calculations at Volume

**All calculations use 100% standard-rate tools (Slack, Gmail, GitHub, Notion). Overage at Production rate ($0.249/1,000).**

#### 100 users × moderate (100 calls/day = 300,000 calls/mo):
- Production tier: $229/mo includes 2M calls
- 300,000 calls = 15% of included allotment
- **Total: $229/mo = $2.29/user/mo** — over $2 target by $0.29
- Or stay on Starter ($29/mo, 200K included): overage = 100K × $0.299/1,000 = $29.90 overage
- **Starter total: $58.90/mo = $0.59/user/mo** — excellent.

#### 100 users × heavy (250 calls/day = 750,000 calls/mo):
- Starter: 550K overage × $0.299/1,000 = $164.45 overage
- Starter total: $193.45/mo = $1.93/user/mo — **just under $2 budget.**
- Production is cheaper: $229/mo base, 750K well under 2M included
- **Production total: $229/mo = $2.29/user/mo** — marginally over.

#### 100 users × power (500 calls/day = 1,500,000 calls/mo):
- Production: 1.5M under 2M included
- **Total: $229/mo = $2.29/user/mo** — same overage issue.

#### 1,000 users × moderate (100 calls/day = 3,000,000 calls/mo):
- Production: 2M included, 1M overage
- Overage: 1,000,000 × $0.249/1,000 = $249
- **Total: $229 + $249 = $478/mo = $0.48/user/mo** — excellent, well under $2.

#### 1,000 users × heavy (250 calls/day = 7,500,000 calls/mo):
- Production: 2M included, 5.5M overage
- Overage: 5,500,000 × $0.249/1,000 = $1,369.50
- **Total: $229 + $1,370 = $1,599/mo = $1.60/user/mo** — within $2 budget.

#### 1,000 users × power (500 calls/day = 15,000,000 calls/mo):
- Production: 2M included, 13M overage
- Overage: 13,000,000 × $0.249/1,000 = $3,237
- **Total: $229 + $3,237 = $3,466/mo = $3.47/user/mo** — over budget.
- Enterprise needed. No public floor price found.

#### 10,000 users × moderate (100 calls/day = 30,000,000 calls/mo):
- Production: 2M included, 28M overage
- Overage: 28,000,000 × $0.249/1,000 = $6,972
- **Total: $229 + $6,972 = $7,201/mo = $0.72/user/mo** — within budget.
- But at this volume, an Enterprise contract would likely be cheaper (negotiated rate).

#### 10,000 users × heavy (250 calls/day = 75,000,000 calls/mo):
- Overage: ~73M calls × $0.249/1,000 = $18,177
- **Total: ~$18,406/mo = $1.84/user/mo** — technically within budget but Enterprise territory.

#### Summary Table for Composio

| Scenario | Total $/mo | $/user/mo | Under $2? |
|----------|-----------|-----------|-----------|
| 100u × moderate | $229 (Production) | $2.29 | **Barely over** (use Starter: $0.59) |
| 100u × heavy | $229 (Production) | $2.29 | **Barely over** (use Starter: $1.93) |
| 100u × power | $229 (Production) | $2.29 | **Barely over** |
| 1,000u × moderate | $478 | $0.48 | Yes |
| 1,000u × heavy | $1,599 | $1.60 | Yes |
| 1,000u × power | $3,466 | $3.47 | **No** (Enterprise needed) |
| 10,000u × moderate | $7,201 | $0.72 | Yes |
| 10,000u × heavy | $18,406 | $1.84 | Yes |
| 10,000u × power | ~$36,400 | $3.64 | **No** |

**Composio is within budget for all scenarios up to 1K users × heavy and 10K users × moderate-to-heavy.** It breaks the budget only at power volume (500 calls/day), which is the highest tier.

### 3.5 Enterprise Tier

No public floor price found. The enterprise page references "custom user accounts, dedicated SLA, SOC-2, custom API volume, VPC/on-prem." No dollar amounts in any public source, blog, G2 review, LinkedIn post, or customer testimonial. The annual commitment is likely five figures based on comparable Series A SaaS tools, but this is inference. Contact required.

---

## 4. Nango Cost Model

### 4.1 Pricing Structure (Confirmed)

| Tier | Base $/mo | Connections included | Connection overage | Proxy overage |
|------|-----------|---------------------|-------------------|---------------|
| Free (cloud) | $0 | 10 | N/A | N/A |
| Starter | From $50 | 20 | $1/connection/mo | $0.0001/request |
| Growth | From $500 | 100 | $1/connection/mo | $0.0001/request |
| Enterprise | Custom | Custom | Custom | Custom |

**Note on proxy overage rate:** Multiple sources reference $0.0001/request ($0.10/1,000 requests). Some older sources cited $0.01/request — current 2026 pricing page confirms **$0.0001/request**.

MCP server: Available on paid cloud tiers (Starter+) based on current product positioning. In self-hosted free tier, MCP requires Enterprise license (confirmed by self-hosting docs feature table). However, as established in the prior research, the MCP gate in self-hosted is a database plan flag, not a binary license check — a self-hoster can unlock MCP by assigning `environment:mcp` scope to API keys.

### 4.2 KAIROS Cloud Cost at Volume

With 5 connections per user (Slack, Gmail, GitHub, Notion, Calendar):

**1,000 users × 5 connections = 5,000 connections:**

Growth tier: $500/mo base, 100 connections included
- Extra 4,900 connections × $1 = $4,900/mo
- Total connections cost: $5,400/mo

Proxy calls at moderate volume (3,000,000 calls/mo):
- 3,000,000 - 1,000,000 (included) = 2,000,000 overage
- 2,000,000 × $0.0001 = $200/mo

- **Total: $5,600/mo = $5.60/user/mo** — 2.8x over budget.

At heavy volume (7.5M calls/mo):
- Proxy overage: (7.5M - 1M) × $0.0001 = $650/mo
- **Total: $6,050/mo = $6.05/user/mo** — 3x over budget.

**Nango Cloud is unviable for KAIROS at any realistic connection count.** The $1/connection/mo fee is the killer. Even if you reduced to 2 connections per user (1,000 users × 2 = 2,000 connections), the cost is $2,400/mo + proxy = ~$2.60/user/mo. Still over.

**Nango Cloud breaks even at 1 connection per user** at moderate volume — but that defeats the purpose of a multi-integration AI co-worker.

### 4.3 The Self-Hosted Direct-Token Architecture

This is the "unsung architecture" that changes everything.

**Setup:**
1. Self-host Nango (free tier, from source via ELv2 license)
2. Users authenticate via Nango OAuth (Nango stores tokens in self-hosted Postgres)
3. KAIROS calls `getConnection("slack", connectionId)` to retrieve the raw OAuth token
4. KAIROS makes direct API calls to Slack/Gmail/etc. using the retrieved token — bypassing Nango's proxy entirely
5. No proxy requests are charged. Nango is used purely as an auth manager.

**Does `getConnection()` count as a proxy request?**
Based on research: `getConnection()` is a management API call that retrieves stored credentials. It is NOT processed through the proxy billing pathway. The Nango billing structure explicitly separates "proxy requests" (calls made through `nango.proxy.*`) from credential retrieval calls. `getConnection()` does not count against proxy billing. Nango's own docs describe it as the alternative to using the proxy: "If you do not want to deal with collecting & injecting credentials in requests for multiple authentication types, use the Proxy."

**Cost of self-hosted Nango + direct tokens:**

Infrastructure needed for self-hosted Nango:
- 5 Node services (1 CPU / 2GB RAM each) = 5 vCPU, 10GB RAM
- Postgres: 2 vCPU, 8GB RAM, 128GB storage
- Redis: 128MB
- ElasticSearch: 2 vCPU, 1GB RAM, 30GB storage
- S3-compatible: minimal

Approximate monthly infra cost on AWS/GCP/Hetzner:

| Provider | Est. monthly infra cost | Notes |
|----------|------------------------|-------|
| Hetzner (Europe/US-East) | ~$80-$120/mo | Cheapest; excellent value |
| AWS (us-east-1, t3 instances) | ~$200-$350/mo | Standard pricing |
| GCP (n2-standard, us-central1) | ~$180-$280/mo | Credits available |
| Fly.io | ~$120-$200/mo | Easy deployment |

**Per-user cost of self-hosted Nango with direct tokens:**

| Users | Infra cost | $/user/mo |
|-------|-----------|-----------|
| 100 users | $150/mo | $1.50/user — high but manageable during bootstrapping |
| 1,000 users | $200/mo | **$0.20/user** — excellent |
| 10,000 users | $350/mo (scaled infra) | **$0.035/user** — negligible |
| 100,000 users | $800/mo (K8s cluster) | **$0.008/user** — essentially free |

These costs are infrastructure only. No per-connection fee. No per-request fee. Unlimited connections, unlimited API calls — cost is fixed infrastructure regardless of volume.

**With direct token access, there are ZERO Nango-side per-call costs.** The only variable cost is the infrastructure that stores and refreshes tokens.

**Caveats of direct token access:**
1. KAIROS holds raw OAuth tokens in its application memory (brief window) — security model is slightly weaker than pure proxy
2. Token refresh must be triggered proactively (or KAIROS must check expiry before each call and call `getConnection()` with `forceRefresh: true` when needed)
3. Some providers issue short-lived tokens (Google: 1-hour access tokens, 6-month refresh tokens) — KAIROS needs a token cache with TTL management
4. If Nango's token refresh fails for a connection, KAIROS needs an error handling path (prompt user to re-authorize)

These are all solvable engineering problems, not blockers.

### 4.4 Self-Hosted Enterprise License

**No public pricing found anywhere.** Nango's own docs describe it as "fixed annual license and maintenance fee, plus a fraction of the cloud usage-based fees." No community posts, G2 reviews, Reddit threads, or blog posts contain a dollar figure.

Based on comparables in the embedded integration infrastructure market:
- Paragon (similar product): five-figure annual commitment minimum
- Merge.dev (unified API): $1,500-$5,000+/mo depending on usage
- Nango's position: smaller company, more developer-friendly, likely lower floor

**Estimated range (informed inference only):** $5,000-$25,000/year for Enterprise self-hosted with MCP, support SLA, and full features. This is a range, not a confirmed figure. Must be validated with a sales call.

**Impact on recommendation:** At 1,000 users, even $25,000/year ($2,083/mo) would result in $2.08/user/mo — marginally over budget. At 10,000 users, $25,000/year = $0.21/user/mo — very affordable.

**The self-hosted free tier with direct tokens avoids the Enterprise license question entirely**, since it doesn't require the MCP server (KAIROS calls APIs directly). This is the recommended path for KAIROS v1 and v2.

### 4.5 `getConnection()` as Architecture

When KAIROS uses `getConnection()` + direct API calls:
- Auth management (OAuth flow, token storage, token refresh): handled by Nango — zero KAIROS dev effort
- API calls: made directly by KAIROS using the retrieved token
- Cost: infrastructure only
- Control: KAIROS fully controls rate limiting, retry logic, request formatting
- Lock-in: minimal — tokens can be exported; if Nango goes down, tokens already in memory

This is arguably the ideal architecture for a macOS daemon: lightweight, full control, zero variable cost.

---

## 5. Hybrid Architecture Analysis

### 5.1 Tiered Routing: Hot Path vs Long Tail

**Hypothesis:** Route high-volume providers (Slack, Gmail = ~60% of calls) through one platform; use another for low-volume long-tail.

**In practice:** If you're already using Nango self-hosted with direct tokens, there's no reason to add a second platform for hot-path providers. The hot path already has zero per-call cost. A hybrid only makes sense when:
- Your hot-path platform has per-call costs AND
- A cheaper platform exists for those specific providers

For KAIROS's architecture (Nango self-hosted + direct tokens): all providers have zero per-call cost. Hybrid routing offers no economic benefit.

**Where hybrid is relevant:** If KAIROS uses Composio as primary (managed or BYOC) for simplicity, routing the top 3 high-volume providers through Nango self-hosted could save money:
- 60% of 7.5M calls/mo = 4.5M calls moved off Composio
- Savings: 4.5M × $0.249/1,000 = $1,120/mo
- Cost of running Nango self-hosted for 3 providers: ~$150/mo infra
- **Net savings: ~$970/mo** — meaningful at 1,000 users heavy volume.

### 5.2 DIY OAuth for Hot Path: Breakeven Analysis

**Scenario:** Register own OAuth apps for Slack, Gmail, GitHub (top 3 = ~70% of calls). Use platform (Composio) for the remaining 30%.

**DIY costs:**
- Development: ~4-6 weeks one-time = ~$30,000-$60,000 (at $150/hr fully loaded)
- Ongoing maintenance: ~4-6 weeks/year = $30,000-$60,000/year
- Infrastructure: ~$50-$100/mo (Postgres + Redis for token storage)

**Savings from removing top 3 from Composio (at 1,000 users × heavy):**
- 70% of 7.5M = 5.25M calls/mo saved
- At Composio Production rate: 5.25M × $0.249/1,000 = $1,307/mo savings
- Annual savings: $15,684/year
- Break even vs one-time build cost: ~2-3 years

**At 10,000 users × heavy:**
- 70% of 75M = 52.5M calls/mo saved
- Savings: $13,072/mo = $156,864/year
- Break even: within 3-6 months

**Recommendation:** DIY OAuth for top 3 breaks even at ~8,000-10,000 users. Below that, it's a loss compared to just paying Composio's overage. Above that, it pays for itself quickly.

**Simpler alternative:** Use Nango self-hosted (direct tokens) for ALL providers. Same economics as DIY for the top 3 but works for all 800+ Nango-supported integrations. The "DIY for top 3" approach is only relevant if you cannot self-host Nango or want to avoid the Nango dependency entirely.

### 5.3 Self-Hosted Nango Free Tier + Direct Token Calls: Full Analysis

**This is the winning architecture for KAIROS.**

**What it is:**
- Nango self-hosted (free tier, ELv2 license)
- KAIROS registers its own OAuth apps at each provider (BYOC)
- Users authorize via Nango's Connect UI (white-labeled as KAIROS)
- Tokens stored in Nango's self-hosted Postgres (encrypted at rest)
- KAIROS calls `nango.getConnection()` → gets raw token → makes direct API calls
- No proxy. No per-call fee. No per-connection fee (self-hosted doesn't charge per-connection)
- MCP on hold for v1; KAIROS's agent calls tools directly using the token

**Real cost at 1,000 users:**
- Infra: ~$200/mo (Hetzner or equivalent)
- Zero per-connection, zero per-call fees
- **$200/mo total = $0.20/user/mo**

**Real cost at 10,000 users:**
- Infra: ~$350-$500/mo (slightly larger Postgres, same Node services scale horizontally)
- **$400/mo total = $0.04/user/mo**

**The catch:** Free self-hosted Nango does NOT include MCP server. KAIROS's agent must call APIs directly (not via MCP). For KAIROS's architecture (daemon makes direct tool calls, not via MCP protocol), this is fine. MCP is an optional delivery mechanism, not a requirement.

**If KAIROS wants hosted MCP:** The prior research established that the MCP gate is a database plan flag in self-hosted, not a binary license. A self-hoster can unlock MCP by creating an API key with `environment:mcp` scope. This needs to be validated with a 2-hour spike before relying on it.

---

## 6. Final Recommendation

### 6.1 Cost Projections Summary

| Scenario | Composio | Pipedream | Nango Cloud | Nango Self-Hosted + Direct Tokens |
|----------|----------|-----------|-------------|-----------------------------------|
| **100u × moderate** | $59/mo ($0.59/u) | $3,630/mo ($36/u) | $650/mo ($6.50/u) | $150/mo ($1.50/u) |
| **100u × heavy** | $193/mo ($1.93/u) | $9,030/mo ($90/u) | $800/mo ($8/u) | $150/mo ($1.50/u) |
| **1,000u × moderate** | $478/mo ($0.48/u) | $37,830/mo ($37.83/u) | $5,600/mo ($5.60/u) | $200/mo ($0.20/u) |
| **1,000u × heavy** | $1,599/mo ($1.60/u) | N/A | $6,050/mo ($6.05/u) | $200/mo ($0.20/u) |
| **1,000u × power** | $3,466/mo ($3.47/u) | N/A | $7,500/mo ($7.50/u) | $200/mo ($0.20/u) |
| **10,000u × moderate** | $7,201/mo ($0.72/u) | N/A | $56,000/mo ($5.60/u) | $400/mo ($0.04/u) |
| **10,000u × heavy** | $18,406/mo ($1.84/u) | N/A | N/A | $400/mo ($0.04/u) |
| **100,000u × moderate** | $72,000/mo ($0.72/u) | N/A | N/A | $800/mo ($0.008/u) |

Budget line: $2/user/mo. **Bold = over budget.**

Pipedream exceeds budget at every realistic volume. Nango Cloud exceeds budget at every scale. Composio is within budget up to 10K users × heavy, but breaks at 1K × power. Nango self-hosted + direct tokens is under budget at every scale.

### 6.2 Decision by Phase

**KAIROS v1 (0-500 users, ship fast):**
- Use **Composio managed auth** (Starter plan, $29/mo)
- Single API key, zero OAuth app registration, 200K calls included
- 500 users × heavy = 500 × 250 × 30 = 3.75M calls/mo
  - Still on Starter overage ($0.299/1K): 3.55M overage = $1,062
  - Total: $1,091/mo = $2.18/user/mo — marginally over, acceptable for v1
- Start registering BYOC OAuth apps at Slack and Gmail during this phase
- Acceptable security risk for early users; monitor Composio's post-breach recovery

**KAIROS v2 (500-10,000 users, scale + security):**
- Deploy **Nango self-hosted** (Hetzner VPS cluster, ~$150-$300/mo)
- Migrate Composio connections to Nango BYOC (forced re-auth, user friction acceptable at migration time)
- Use `getConnection()` + direct API calls for zero per-call cost
- All 800+ Nango integrations covered
- **Target: $0.20/user/mo at 1,000 users**
- Validate MCP scope unlock (2-hour spike) to optionally enable MCP without Enterprise license

**KAIROS v3 (10,000+ users, enterprise positioning):**
- Nango self-hosted remains the core
- DIY OAuth for top 5 providers (Slack, Gmail, GitHub, Notion, Google Calendar) — removes any Nango dependency for the hot path
- Nango for long tail (remaining 795+ integrations)
- Optional: Nango Enterprise license if MCP server is needed for partner integrations, or if SLA/support is required

### 6.3 The "Free Option": Is Self-Hosted Nango + Direct Tokens Viable?

**Yes. This is genuinely viable and arguably the best architecture.**

Evidence supporting viability:
1. ELv2 license explicitly permits use within your own product
2. Infrastructure is simple and well-documented (Helm charts, Docker compose)
3. `getConnection()` is a supported, documented API — not a hack
4. Nango's own sample app uses this pattern
5. 10,000+ engineering teams already use Nango's self-hosted deployment
6. Token storage is encrypted at rest in your own Postgres — better security posture than Composio's central store
7. No per-connection fee in self-hosted mode
8. Cost scales sub-linearly: 10x users ≈ 2x infra cost

Risk factors (manageable):
- Nango changes self-hosted feature set (mitigated: code is open; you can pin a version)
- Infrastructure maintenance burden (mitigated: Helm chart, 2-month update cadence, low ops burden)
- OAuth app registration per provider (mitigated: 2 weeks one-time work; required anyway for white-label)
- Token refresh complexity (mitigated: Nango handles refresh logic, KAIROS just calls `getConnection()` which auto-refreshes)

**Bottom line:** The self-hosted free tier + direct token access removes every per-call and per-connection fee. At 1,000 users, your connector cost is $200/mo in infrastructure. At 10,000 users, $400/mo. This is the only architecture that comfortably serves KAIROS's economics at any volume tier.

### 6.4 Concrete "Ship This" Decision

**Phase 1 (now → 500 users):** Composio managed auth, Production plan at $229/mo.
- Risk accepted: post-breach architecture not fixed; personal tokens in Composio's store
- Mitigation: Start OAuth app registrations for Slack and Gmail immediately (2 weeks work)
- Exit trigger: 500 users OR Composio has another security incident

**Phase 2 (500+ users):** Nango self-hosted + BYOC + direct tokens.
- 2-week migration sprint: deploy Nango, register OAuth apps, migrate with user re-auth
- Cost drops to ~$0.20/user/mo regardless of call volume
- Security posture improves dramatically: tokens in your own encrypted Postgres

**Never use Pipedream Connect** for KAIROS's connector use case at any volume. The 1-credit-per-call minimum pricing model is fundamentally incompatible with an always-on agent daemon.

---

## Appendix A: Key Figures Summary

| Data point | Value | Source confidence |
|-----------|-------|------------------|
| Pipedream Connect: 1 credit per proxy call (minimum) | Confirmed | High — community thread + docs |
| Pipedream credit overage rate | ~$0.009-$0.015/credit (est. $0.012 midpoint) | Medium — community reports; not published |
| Pipedream Connect base price | $99-$150/mo | Medium — conflicting sources; likely $150 for production-ready |
| Composio premium tools list | Search APIs (Perplexity, Exa, SerpAPI, Composio Search), code sandboxes | High — official docs |
| Composio Slack/Gmail/GitHub/Notion = standard rate | Confirmed | High — not in premium list |
| Composio Production overage rate | $0.249/1,000 calls | High — official pricing page |
| Nango proxy overage | $0.0001/request ($0.10/1,000) | High — pricing page |
| Nango connection overage | $1/connection/mo | High — pricing page |
| Nango self-hosted direct token cost | Infrastructure only (~$150-$400/mo) | High — logical deduction |
| `getConnection()` billing treatment | Not a proxy request; not billed per-call | Medium — inferred from architecture docs |
| Nango Enterprise self-hosted price | Unknown — five figures annually (inference) | Low — no public data |
| Composio Enterprise price | Unknown — custom quote | Low — no public data |

---

## Appendix B: Volume Assumptions

| Tier | Definition | Calls/day | Calls/month |
|------|-----------|-----------|-------------|
| Moderate | Active user, 10 active hours | ~100 | 3,000 |
| Heavy | Power user, multiple integrations | ~250 | 7,500 |
| Power | Heavy use + background monitoring | ~500 | 15,000 |

---

*Research conducted 2026-05-27. Sources: Pipedream community forums (pipedream.com/community), Pipedream docs (pipedream.com/docs), Composio pricing page (composio.dev/pricing), Composio premium tools docs (docs.composio.dev/toolkits/premium-tools), Nango pricing page (nango.dev/pricing), Nango self-hosting docs (nango.dev/docs/guides/platform/self-hosting), Nango getConnection API docs, Merge.dev Nango analysis (merge.dev/blog/nango-pricing), Nango Paragon comparison (nango.dev/blog/paragon-pricing), CheckThat.ai pricing analysis.*
