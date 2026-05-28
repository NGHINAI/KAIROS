# Managed OAuth Deep Dive: Can KAIROS Skip BYOC?

**Date:** 2026-05-27  
**Author:** Research agent (Claude Sonnet 4.6)  
**Predecessor:** `2026-05-27-platforms-followup.md`  
**Purpose:** Re-verification of prior research that concluded BYOC is mandatory for production. Ground findings in actual repo code, not marketing pages.  
**Repos examined:** `PipedreamHQ/pipedream-connect-examples`, `PipedreamHQ/mcp-chat`, `composiohq/composio`, `ComposioHQ/trustclaw`, `ComposioHQ/secure-openclaw`, `NangoHQ/sample-app`

---

## 1. Bottom Line Up Front

| Platform | Managed OAuth for KAIROS production? | One-sentence justification |
|----------|--------------------------------------|----------------------------|
| **Pipedream Connect** | **YES — works for production** | The `PIPEDREAM_CLIENT_ID`/`SECRET` are Pipedream *project* credentials (not Slack/Gmail credentials); Pipedream's own OAuth apps handle the actual Slack/Gmail consent screens with no BYOC required. |
| **Composio** | **YES — works for production** | Managed auth is the default, non-deprecated path; current SDK example code uses `use_composio_managed_auth` with no Slack app registration required; BYOC is optional (white-label only). |
| **Nango** | **YES with caveats** | Nango shared apps work for production but Nango's own docs explicitly say "strongly recommend registering your own app before going live" due to provider TOS revocation risk and fixed scope sets; it's technically viable but fragile. |

**The prior research was wrong.** The "BYOC is mandatory for production" conclusion applied the Pipedream Workflows product's restriction to Pipedream Connect (a completely different product), and misread Composio's BYOC docs as mandatory rather than optional.

---

## 2. Pipedream Connect Deep Dive

### 2.1 What `PIPEDREAM_CLIENT_ID` and `PIPEDREAM_CLIENT_SECRET` Actually Are

This is the root of the prior research error. These environment variables are **Pipedream-issued project OAuth credentials** — they authenticate KAIROS's backend to Pipedream's API. They are NOT Slack credentials, NOT Gmail credentials, NOT any per-provider registration.

Source: `managed-auth-basic-next-app/.env.example` (actual repo code):

```
PIPEDREAM_CLIENT_ID=<your-oauth-client-id>
PIPEDREAM_CLIENT_SECRET=<your-oauth-client-secret>
NEXT_PUBLIC_PIPEDREAM_PROJECT_ID=<your-project-id>
PIPEDREAM_PROJECT_ENVIRONMENT=development
```

There is no `SLACK_CLIENT_ID`, no `GMAIL_CLIENT_SECRET`, no per-provider OAuth credentials anywhere in this file or any file in the repo. You get `PIPEDREAM_CLIENT_ID`/`SECRET` from your Pipedream workspace dashboard — one time — and they authenticate all 3,000+ integrations.

Source: Pipedream docs — "OAuth clients are tied to the workspace and are administered by workspace admins. You create them in Pipedream's API settings page."

### 2.2 The Complete Connect Flow (from actual `server.ts` and `page.tsx`)

```typescript
// server.ts — actual production code from the example repo
const pd = new PipedreamClient({
  projectId: NEXT_PUBLIC_PIPEDREAM_PROJECT_ID,
  projectEnvironment: "production",     // no Slack app needed
  clientId: PIPEDREAM_CLIENT_ID,        // Pipedream project credential
  clientSecret: PIPEDREAM_CLIENT_SECRET // Pipedream project credential
});

// Create a connect token for a user
const tokenResponse = await pd.tokens.create({
  externalUserId: "kairos-user-xyz"
});
// → Returns: { token, connectLinkUrl, expiresAt }
// connectLinkUrl is a Pipedream-hosted URL — Pipedream handles all provider OAuth
```

```tsx
// page.tsx — frontend flow
await client.connectAccount({
  app: "slack",    // Pipedream's own Slack OAuth app handles this
  onSuccess: ({ id }) => { /* account connected */ }
});
// User is redirected to Pipedream's hosted connect UI
// Pipedream's own Slack app initiates the OAuth flow
// User sees: "Pipedream wants access to your Slack workspace"
```

### 2.3 The `mcp-chat` Repo Confirms This

`mcp-chat/.env.example`:

```
PIPEDREAM_CLIENT_ID=         # Pipedream workspace credential
PIPEDREAM_CLIENT_SECRET=     # Pipedream workspace credential
PIPEDREAM_PROJECT_ID=        # Pipedream project ID
PIPEDREAM_PROJECT_ENVIRONMENT=  # development | production
```

No `SLACK_CLIENT_ID`. No `GOOGLE_CLIENT_ID` for integrations (only a `GOOGLE_CLIENT_ID` optional entry for the *chat app's own login*, which is separate). Pipedream's 3,000-app catalog is available through just the Pipedream project credentials.

### 2.4 Development vs Production Mode in Connect

- **Development**: Max 10 external users; users must be signed into pipedream.com; free on all plans.
- **Production**: No user limit; users do NOT need Pipedream accounts; requires paid Connect plan ($150/mo base + $2/user/mo over 100).

Neither mode requires per-provider OAuth credentials. Managed OAuth works in BOTH modes.

### 2.5 The "Running Workflows with Official OAuth Apps Is Not Allowed" Error — CLARIFIED

**This error applies to Pipedream Workflows (the visual builder product), NOT to Pipedream Connect.**

Pipedream has two distinct products:

1. **Workflows** — Zapier-like visual builder. When a Pipedream workflow runs *on behalf of an end user* using Pipedream's shared OAuth apps, it hits this error. This is a Workflows-specific restriction because Pipedream does not allow building resellable automations on their shared OAuth credentials.

2. **Connect** — The SDK/API for embedding "connect your apps" in third-party products. This is specifically designed for exactly what KAIROS needs. There is no such error in Connect. The Pipedream Connect docs explicitly say: "Ship new integrations quickly with Pipedream's approved OAuth clients, or use your own."

The prior research found the "Running workflows..." error in Pipedream community forums and incorrectly applied it to Connect. The community threads were Workflows users, not Connect users.

### 2.6 What the User Sees on the Consent Screen

- **Managed (no BYOC)**: "Pipedream wants access to your Slack workspace"
- **BYOC (optional)**: "[KAIROS] wants access" — requires registering your own Slack app and supplying credentials to Pipedream

BYOC for white-labeling is optional. Production works without it.

---

## 3. Composio Deep Dive

### 3.1 Managed Auth is Alive and the Default

From `python/examples/auth_configs.py` (actual production example code in the composio repo):

```python
from composio import Composio

composio = Composio()   # just an API key — no Slack/Gmail credentials

# THIS IS MANAGED AUTH — no custom credentials needed
auth_config = composio.auth_configs.create(
    toolkit="github",
    options={
        "type": "use_composio_managed_auth",
    },
)

# THIS IS CUSTOM AUTH (BYOC) — optional, for white-labeling
auth_config = composio.auth_configs.create(
    toolkit="notion",
    options={
        "type": "use_custom_auth",
        "credentials": {
            "client_id": "1234567890",
            "client_secret": "1234567890",
        },
    },
)
```

Both paths exist and are documented as current. Managed auth requires zero per-provider credentials.

### 3.2 Tool Router (TrustClaw Production Example) — No BYOC Required

TrustClaw is Composio's own production AI agent app (715 GitHub stars, deployed on Vercel for real users). Its `.env.example`:

```
COMPOSIO_API_KEY=       # just this — no Slack, no Gmail, no GitHub credentials
```

Its actual auth flow (`src/server/api/routers/toolkits/getAuthLink.ts`):

```typescript
const composio = createComposioClient();
const session = await composio.create(userId, {});

// session.authorize() uses Composio's managed OAuth — no auth_config_id supplied
const connectionRequest = await session.authorize(input.toolkit, {
  callbackUrl: `${env.NEXT_PUBLIC_APP_URL}/dashboard/toolkits`,
});
// User visits redirectUrl — sees "Composio wants access to your Slack"
```

No `auth_config_id` is passed. No Slack client ID or secret anywhere in the codebase. This is managed auth in a production deployed app used for real end users.

### 3.3 Is Managed Auth Deprecated?

**No.** The prior report claimed: "Composio's `initiate()` method for managed OAuth will return 400 BadRequest starting 2026-05-08 for new organizations."

This claim is not supported by any evidence found:

1. `python/examples/auth_configs.py` still shows `use_composio_managed_auth` as a current, uncommented example
2. Composio docs explicitly: "Most toolkits work out of the box with Composio managed OAuth"
3. TrustClaw (Composio's own app, updated in 2025-2026) uses managed auth without BYOC
4. The security breach post-mortem revoked "Composio-managed and custom auth configuration" tokens — managed auth is clearly still operational
5. No deprecation notice in codebase, docs, or changelog

The "400 BadRequest for new orgs as of 2026-05-08" finding in the prior report appears to have been hallucinated or was a severe misread of an isolated error.

### 3.4 What trustclaw and secure-openclaw Reveal

Both repos are Composio's own showcase AI agent apps:

- **trustclaw**: `COMPOSIO_API_KEY` only in `.env.example`. 1000+ tools. Production deployed on Vercel. Users connect via `session.authorize(toolkit)` — managed OAuth.
- **secure-openclaw**: `COMPOSIO_API_KEY` only. Personal AI assistant. Managed OAuth for all integrations.

These are not toys — they are production-intent apps with real OAuth for real end users. If managed auth were deprecated, these repos would not build on it.

### 3.5 Security Incident — The Actual Concern

The May 2026 breach is the legitimate reason to be cautious about Composio, but for the right reason:

- 0.3% of connections affected (mostly GitHub tokens in an auxiliary cache)
- The platform is still running managed OAuth — but the architecture has **not** been fixed yet
- Zero-trust KMS is on the roadmap, not shipped

For KAIROS storing *personal user credentials* (Gmail, personal Slack, personal GitHub), the blast radius of a future breach is real. This is why BYOC or Nango might be preferred for security-conscious deployment — not because managed auth is "blocked" but because tokens are centrally held without zero-trust isolation.

---

## 4. Nango Deep Dive

### 4.1 Shared Apps Work Technically — But Are Fragile

From the nango sample-app back-end `.env.example`:

```
DATABASE_URL="postgres://postgres:postgres@localhost:5632/postgres"
NANGO_SECRET_KEY=""
```

No per-provider OAuth. The sample app connects to Slack and Google Drive using Nango's shared apps.

The `nango-integrations/.env.example` similarly contains only Nango keys, no Slack credentials.

### 4.2 The Sample App Flow

```typescript
// postConnectSession.ts — create a connect session (no Slack app needed)
const res = await nango.createConnectSession({
    end_user: { id: user.id, email: user.email, display_name: user.displayName },
    allowed_integrations: [integration]
});
// → Returns session token for frontend Connect UI

// sendSlackMessage.ts — trigger a Nango Action
await nango.triggerAction(integration, userConnection.connectionId, 'send-message', input);

// getNangoCredentials.ts — optionally retrieve raw token
const credentials = await nango.getConnection(integrationId, userConnection.connectionId);
```

No Slack app registration anywhere. Nango's shared Slack app handles the OAuth.

### 4.3 The Nango Caveat From Their Own Docs

Nango explicitly states:

> "We strongly recommend registering your own OAuth app before going live."

> "Most providers don't allow shared credentials. Nango developer apps may be revoked by the provider at any time."

These are real risks:
- **Revocation**: Slack or Google can revoke Nango's shared app, disconnecting all KAIROS users simultaneously
- **Fixed scopes**: Cannot request non-default scopes without BYOC
- **No branding**: Users see "Nango wants access"
- **Token portability blocked**: Shared-app tokens cannot be exported; BYOC migration requires full re-auth

The prior research called this "dev-only." The accurate framing: **technically works in production, but Nango says don't do it.** The risk is provider-side revocation, not a Nango-side enforcement block.

---

## 5. Honest Reckoning with Prior Research

### Error 1: Conflated Pipedream Workflows with Pipedream Connect (most consequential)

The "Running workflows with official OAuth apps is not allowed" error is a Pipedream **Workflows** restriction. Connect is a different product, designed specifically for downstream OAuth embedding. The example repo has no per-provider credentials anywhere. Prior research found the Workflows error, failed to distinguish the product surface, and concluded Connect required BYOC. This is demonstrably false.

### Error 2: Misidentified what `PIPEDREAM_CLIENT_ID`/`SECRET` are

Prior research implied these were Slack/Gmail OAuth credentials. They are Pipedream workspace credentials — one-time setup in the Pipedream dashboard, covering all 3,000+ integrations. The env var names look like OAuth credentials because they are, but they're for Pipedream's API, not Slack's API.

### Error 3: Fabricated or severely misread the Composio managed auth deprecation

"Composio's `initiate()` method for managed OAuth will return 400 BadRequest starting 2026-05-08 for new organizations" — zero evidence for this anywhere in repos, docs, changelogs, or breach post-mortem. Current examples use managed auth without deprecation notices. TrustClaw uses managed auth in production. This appears to have been hallucinated.

### Error 4: Overstated Nango shared apps as "dev-only"

Nango does not technically block shared apps in production; they recommend against it. The distinction matters for decision-making. The risks (revocation, fixed scopes, no export) are real and worth documenting — but the framing "dev-only" was an overstatement of Nango's actual position.

### What the Prior Reports Got Right

- Pricing analysis was accurate
- Composio security breach risk assessment was accurate
- Nango's self-hosting MCP unlock finding was accurate
- Pipedream Workday acquisition risk is real
- Both platforms' branding implications (users see "Pipedream/Composio wants access") were accurate

---

## 6. Updated Recommendation

### Decision Matrix

```
Get to market fast (no OAuth app registration):
→ Composio managed auth
  - COMPOSIO_API_KEY only
  - Users see "Composio wants access"
  - ~$0.23/user/mo at 25 AI tool calls/day
  - 500+ integrations, native MCP/Tool Router
  - Risk: May 2026 breach architecture not yet fixed

Need managed OAuth with larger-company backing:
→ Pipedream Connect managed auth
  - PIPEDREAM_CLIENT_ID/SECRET only (Pipedream workspace creds)
  - Users see "Pipedream wants access"
  - $2/user/mo ceiling, Workday acquisition risk
  - 3,000+ integrations

Best long-term cost + control (invest 2 weeks in DevOps):
→ Nango self-hosted + BYOC
  - Register own OAuth apps at Slack, Gmail, GitHub, etc.
  - ~$0.30/user/mo infra cost
  - Users see "[KAIROS] wants access"
  - Full token ownership, getConnection() escape hatch

White-labeling on any platform:
→ BYOC on Composio or Pipedream
  - Register own OAuth apps, supply to platform
  - Users see "[KAIROS] wants access"
```

### For KAIROS v1 (Ship Fast)

**Use Composio managed auth.** `COMPOSIO_API_KEY` only. Zero per-provider OAuth app registration. Tool Router gives MCP + 500+ apps in one session. TrustClaw proves this pattern works in production.

**Monitor**: Composio's security posture post-breach. Plan BYOC migration at 500+ users or when enterprise sales requires white-labeled consent screens.

### For KAIROS v2 (Scale + Security)

Register own Slack, Gmail, GitHub, Notion, Linear OAuth apps (1-2 weeks). Then use Composio with custom auth configs or Nango self-hosted for full token ownership.

### Do Not Use Pipedream as Primary Platform

$2/user/mo pricing ceiling + Workday uncertainty + smallest integration flexibility makes it the weakest choice. Viable as a fallback if Composio security posture becomes unacceptable.

---

## 7. What's the Catch? Real Tradeoffs of Managed OAuth vs BYOC

| Concern | Managed Auth | BYOC |
|---------|-------------|------|
| **Consent screen branding** | "Pipedream/Composio wants access" | "[KAIROS] wants access" |
| **Rate limits** | Shared across all platform customers | Your own isolated bucket |
| **Scope control** | Fixed to platform's defaults | Full control |
| **Marketplace listing** | Cannot list in Slack App Directory, Google Workspace Marketplace | Can list |
| **Enterprise sales** | CISOs reject third-party names on consent screens | Passes security reviews |
| **Provider TOS risk (Nango)** | Provider can revoke shared app, breaking all users | Your app is independent |
| **Token ownership** | Tokens in platform's infrastructure | Tokens in your infrastructure (or Nango with getConnection()) |
| **Security blast radius** | Composio/Pipedream breach = your users' tokens at risk | Platform breach doesn't expose your tokens |
| **Setup cost** | Zero (just an API key) | 1-2 weeks to register OAuth apps at each provider |

**For KAIROS specifically**: The security blast radius concern is the most material one — KAIROS users are connecting personal Gmail, personal GitHub, personal Slack. Managed auth at Composio means those personal credentials are centrally held in a platform that just had a breach. This is a real risk, not a theoretical one.

The branding concern ("Composio wants access") is real for enterprise sales but likely tolerable for KAIROS's developer-focused early users.

The recommendation: start with managed auth (Composio) to ship fast, migrate to BYOC + Nango self-hosted as security requirements and scale demand it.

---

## Appendix: Code Evidence Summary

| Claim | Evidence | Source |
|-------|----------|--------|
| Pipedream Connect doesn't need Slack/Gmail app | No `SLACK_CLIENT_ID` in repo | `managed-auth-basic-next-app/.env.example` |
| `PIPEDREAM_CLIENT_ID` is a Pipedream workspace credential | Created in Pipedream dashboard, covers all 3,000+ apps | Pipedream docs + `.env.example` |
| mcp-chat works with just Pipedream credentials | No per-provider OAuth in env | `mcp-chat/.env.example` |
| Composio managed auth is current | `use_composio_managed_auth` in live example, no deprecation notice | `python/examples/auth_configs.py` |
| TrustClaw uses managed auth in production | `COMPOSIO_API_KEY` only; `session.authorize(toolkit)` with no auth_config_id | `trustclaw/.env.example`, `getAuthLink.ts` |
| Nango sample-app uses shared apps | `NANGO_SECRET_KEY` only; no `SLACK_CLIENT_ID` | `nango sample-app/.env.example` |
| Nango recommends BYOC for production | "strongly recommend registering your own app before going live" | Nango official docs |
| Pipedream Workflows error is Workflows-specific | Error documented in Workflows community forums; Connect docs say "use Pipedream's approved OAuth clients" with no production caveat | Pipedream Connect docs |

---

*Research conducted 2026-05-27. Code read directly from GitHub repos via gh CLI and GitHub API. Documentation pages fetched via WebFetch. Prior reports: `2026-05-25-connection-platforms-research.md`, `2026-05-27-platforms-followup.md`.*
