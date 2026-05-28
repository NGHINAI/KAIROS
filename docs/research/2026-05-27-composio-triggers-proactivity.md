# Composio Triggers — Proactive Monitoring Research
> 2026-05-27  
> Scope: KAIROS proactive monitoring architecture — answers Q1–Q7 from the research brief.  
> All SDK findings verified against source code in `composiohq/composio` and live documentation.

---

## 1. Composio Triggers — Overview

Composio Triggers is a pub-sub system that delivers real-time (or near-real-time) events from external services to subscribing applications. It is architecturally separate from Composio's tool-calling system, though it shares the same connected account model.

### Core terminology

| Term | Definition |
|------|-----------|
| **Trigger Type** | A template: defines what event to monitor (`GITHUB_COMMIT_EVENT`) and what `triggerConfig` fields it requires. |
| **Trigger Instance** | A live, scoped deployment of a trigger type bound to one user's connected account. Has a unique `ti_xxx` ID. Can be enabled, disabled, or deleted. |
| **Webhook Subscription** | A project-level registration of an outbound URL where Composio POSTs trigger events. One subscription URL per project. |
| **Pusher Subscription** | SDK-side WebSocket channel for receiving trigger events without a public URL. Used for local/daemon apps. |

### Two delivery channels (completely separate)

1. **Webhook delivery** — Composio POSTs `composio.trigger.message` events to your registered HTTPS URL. Production-grade. Requires a publicly accessible endpoint. Supports HMAC-SHA256 signature verification.

2. **Pusher delivery (`triggers.subscribe()`)** — SDK opens a Pusher (pusher.com) WebSocket channel. No public URL required. Works on localhost. Client-side filtering only. Intended for development but works for production daemons too.

### Two trigger mechanisms (how Composio ingests events from upstream)

| Mechanism | How it works | Latency | Examples |
|-----------|-------------|---------|---------|
| **Webhook** | Provider pushes to Composio's ingress URL in real-time | Near-instant | Slack, GitHub, Asana, Notion, Outlook |
| **Polling** | Composio polls provider on schedule | 15-min minimum for managed auth | Gmail, Google Calendar |

These are independent of the delivery channel above. A Gmail trigger ingested via polling can still be delivered to KAIROS via Pusher subscription.

---

## 2. Per-Toolkit Trigger Catalog

Trigger type counts and delivery mechanisms confirmed from docs. Exact slugs from SDK examples and source code.

### Gmail — 2 triggers (polling ingestion)

| Trigger slug | Description | Delivery mechanism (ingestion) | Polling interval |
|-------------|-------------|-------------------------------|-----------------|
| `GMAIL_NEW_GMAIL_MESSAGE` | New email arrives in inbox | Polling | ~15 min (managed auth) |
| (second trigger — slug unconfirmed) | Possibly `GMAIL_EMAIL_LABELED` | Polling | ~15 min |

**CRITICAL for KAIROS:** Gmail triggers are polling-based. Composio polls Gmail every 15 minutes at minimum under managed auth. This means "notify me when I get an email from Mark Cuban" has up to 15-minute latency. Confirmed by docs: "Gmail triggers poll roughly every minute by default. If you need lower latency, consider using webhooks or Google Pub/Sub integrations." — this appears to be a contradiction in the docs (one place says 15 min minimum, another says ~1 min). The truth likely depends on plan tier. For Composio-managed OAuth apps, 15 min appears to be the floor. Real-time Gmail requires custom OAuth app + Google Pub/Sub.

**`triggerConfig` for `GMAIL_NEW_GMAIL_MESSAGE`:** The SDK example shows `triggerConfig: {}` (empty), suggesting Gmail trigger fires on ALL new emails, no server-side filtering by sender/subject/label. KAIROS must filter locally.

### Slack — 8 triggers (webhook ingestion, real-time)

| Toolkit | Trigger type | Description |
|---------|-------------|-------------|
| Slack | `SLACK_NEW_MESSAGE` (inferred) | New message in any channel |
| Slackbot | App mentions trigger | Message mentioning the bot |
| Slackbot | DM trigger | Direct messages |
| Slackbot | Slash command trigger | Slash commands |

Exact slugs not fully confirmed from docs (Slack docs truncated). But: Slack uses **webhook delivery** (provider pushes to Composio), so events are near-real-time. Delivery from Composio to KAIROS then adds Pusher latency (near-zero).

**triggerConfig filtering:** Not confirmed from docs whether Slack triggers accept `channel_id` or similar config fields. The `SLACK_NEW_MESSAGE` type likely requires `channel_id` or workspace-level. **Assumed client-side filtering** for mention matching.

### GitHub — 20 triggers (webhook ingestion, real-time)

| Trigger slug (confirmed) | Description |
|--------------------------|-------------|
| `GITHUB_COMMIT_EVENT` | Commit pushed to repo |
| Others (18 more) | Issues, PRs, reviews, releases, etc. |

**`triggerConfig` for `GITHUB_COMMIT_EVENT` (CONFIRMED from SDK source):**
```typescript
triggerConfig: {
  repo: "composio",
  owner: "composiohq",
}
```
Server-side filtering by repo and owner is confirmed. This is genuinely server-side — Composio only creates a trigger instance for that specific repo, so KAIROS only gets events for the repos it subscribes to.

**For "new issue from outside contributor":** Would need a trigger like `GITHUB_ISSUE_OPENED` or `GITHUB_ISSUES_EVENT`. One of the 20 triggers covers this. Client-side filter on `payload.user.type !== 'Bot'` and cross-referencing contributor vs. collaborator list would be needed.

### Google Calendar — 7 triggers (mechanism unclear, likely polling)

Exact slugs not confirmed. Likely includes `GOOGLECALENDAR_NEW_EVENT`, `GOOGLECALENDAR_EVENT_UPDATED`, etc. Based on the "watch" mechanism Google Calendar uses, could be webhook-based if configured with a Composio-managed push channel.

### Notion — 13 triggers (listed as "poll type" but webhook delivery)

| Trigger slug (confirmed) | Description |
|--------------------------|-------------|
| `NOTION_ALL_PAGE_EVENTS_TRIGGER` | Any page created or updated workspace-wide |

Notion uses a webhook verification flow (Composio sends an ingress URL; Notion sends a token that must be pasted back). Under managed credentials, "the webhook ingress endpoint is already provisioned — just create the trigger."

### Linear — 3 triggers (webhook, real-time)

| Trigger slug (confirmed) | Description | `triggerConfig` |
|--------------------------|-------------|-----------------|
| `LINEAR_COMMENT_EVENT_TRIGGER` | Comment received | `team_id` (required) |
| `LINEAR_ISSUE_CREATED_TRIGGER` | New issue created | `team_id` (required) |
| `LINEAR_ISSUE_UPDATED_TRIGGER` | Issue updated | `team_id` (required) |

Linear triggers have **confirmed server-side filtering by `team_id`**. KAIROS can scope triggers to specific teams.

### Trigger coverage summary

| Toolkit | Trigger count | Ingestion mechanism | Real-time? | Server-side filter |
|---------|--------------|---------------------|------------|-------------------|
| Gmail | 2 | Polling | No (≥15 min) | None confirmed |
| Slack | 8 | Webhook | Yes | Unknown |
| GitHub | 20 | Webhook | Yes | repo + owner confirmed |
| Google Calendar | 7 | Likely polling | No | Unknown |
| Notion | 13 | Webhook | Yes | Unknown |
| Linear | 3 | Webhook | Yes | team_id confirmed |

---

## 3. Delivery Mechanism Analysis for KAIROS Local Daemon

### Option A — Pusher subscription (`triggers.subscribe()`) ← CANONICAL FOR LOCAL DAEMONS

**How it works (source-verified):**

```typescript
// 1. KAIROS daemon calls:
await composio.triggers.subscribe(
  (data: IncomingTriggerPayload) => {
    // called for every matching trigger event
    console.log(data.triggerSlug, data.payload);
  },
  {
    // Client-side filters (all optional):
    toolkits: ['gmail', 'github'],        // filter by toolkit
    triggerSlug: ['GMAIL_NEW_GMAIL_MESSAGE'],  // filter by trigger type
    userId: 'user-123',                   // filter by user ID
    connectedAccountId: 'ca_xxx',         // filter by specific account
    triggerId: 'ti_xxx',                  // filter by specific trigger instance
  }
);
```

**Under the hood (source-verified from `Pusher.ts` + `Triggers.ts`):**
1. SDK calls `GET /api/v3/internal/sdk/realtime/credentials` → gets `pusherKey`, `pusherCluster`, `projectId`.
2. SDK instantiates `pusher-js` client with those credentials.
3. SDK subscribes to channel `private-{projectId}_triggers`.
4. Channel auth uses `POST /api/v3/internal/sdk/realtime/auth` with the `x-api-key` header.
5. Events arrive as `trigger_to_client` events on the channel, with chunking support for large payloads.
6. SDK applies client-side filters (`toolkits`, `triggerSlug`, `userId`, etc.) before invoking callback.

**Pusher connection lifecycle:**
- Pusher-js handles reconnection automatically on disconnect (built into the library).
- The channel is `private-{projectId}_triggers` — project-scoped, not user-scoped. ALL users' trigger events arrive on this one channel; filtering happens in the callback.
- Auto-reconnect behavior: Pusher-js has a default reconnect with exponential backoff. After laptop sleep/wake, it reconnects within seconds.

**What happens when daemon is offline:**
Pusher events are NOT queued for offline clients. If KAIROS's daemon is offline (laptop closed, app not running), trigger events that fire during that window are **lost**. Pusher is not a persistent message queue. Events are delivered to connected subscribers only.

**Cost for Pusher option:**
- The Pusher WebSocket connection itself is free to KAIROS (Composio's managed Pusher account; KAIROS does not pay Pusher separately).
- Trigger API calls (`create`, `delete`, `enable`, `disable`, `listActive`) count toward the Composio API rate limit.
- Trigger events themselves (payloads arriving over Pusher) do **not** appear to count as "tool calls" for billing purposes. No documentation explicitly bills per-event. The pricing page bills "tool calls" (executions), not trigger deliveries.

**Verdict: Option A is the canonical pattern for local daemons.** The official examples (`ts/examples/triggers/src/subscribe.ts`) show this pattern. No public URL required. Pusher handles reconnects.

---

### Option B — Polling

**API surface:**
```typescript
const active = await composio.triggers.listActive({
  connectedAccountIds: ['ca_xxx'],
  triggerIds: ['ti_xxx'],
});
```

`listActive` returns trigger instances (configurations), NOT events. There is no "list events since cursor X" endpoint in the public SDK. Polling for events is not a supported pattern — Composio does not expose an event log with cursor pagination for triggers.

**Verdict: Option B does not exist as a meaningful alternative.** You can poll trigger *instances* (to check if they're still active), but you cannot poll for missed *events*. Events are delivery-only via Pusher or webhook.

---

### Option C — Composio-hosted webhook + KAIROS Cloud relay

**How it works:**
```bash
# Register webhook once per project:
curl -X POST https://backend.composio.dev/api/v3.1/webhook_subscriptions \
  -H "X-API-KEY: $COMPOSIO_API_KEY" \
  -d '{"webhook_url": "https://kairos.cloud/webhooks/composio", "enabled_events": ["composio.trigger.message"]}'
# Response includes a webhook_secret for HMAC verification.
```

Composio POSTs to `kairos.cloud/webhooks/composio`. KAIROS Cloud verifies HMAC, looks up which user the trigger belongs to (via `metadata.user_id`), and pushes to that user's daemon via whatever Cloud→daemon channel exists in Phase F.

**Security:** HMAC-SHA256, signing string: `{webhook-id}.{webhook-timestamp}.{payload}`, signature in `webhook-signature` header as `v1,{base64sig}`. Replay protection via 300-second timestamp tolerance.

**Offline behavior:** Unlike Pusher, webhook delivery can be retried by Composio on failure (docs mention checking trigger logs for "delivery attempts and errors"). However, delivery guarantees are not documented as "at-least-once" — Composio does not publish a retry SLA.

**Verdict: Option C is the Phase F architecture.** Requires KAIROS Cloud to exist. Once Cloud exists, this is strictly better than Pusher for reliability: Cloud can persist events when daemon is offline and deliver them when it reconnects.

---

### Option D — Server-Sent Events / gRPC

Not offered by Composio. The only streaming mechanism is Pusher (WebSocket).

---

### Recommendation for current phase (pre-Cloud)

Use **Option A (Pusher subscription)**. It works today with zero infrastructure. The `pusher-js` library handles reconnection. The daemon subscribes at startup and receives all trigger events for all users sharing the KAIROS Composio project (single API key model).

**The key limitation to document:** Events are lost if the daemon is offline. For Phase E (single-user local daemon, laptop always on when user is present), this is acceptable. For Phase F Cloud (multi-user, 24/7 availability), migrate to Option C.

---

## 4. Filtering Capabilities

### Server-side filtering (at Trigger Instance level)

When KAIROS creates a trigger instance, the `triggerConfig` object configures what events the trigger fires on. This IS server-side: Composio only sends events matching the config.

| Toolkit | Confirmed server-side filter fields |
|---------|-------------------------------------|
| GitHub | `repo`, `owner` — only events from that specific repo |
| Linear | `team_id` — only events from that team |
| Gmail | None confirmed — fires on all emails |
| Slack | Unknown — possibly `channel_id` |
| Google Calendar | Unknown |
| Notion | Unknown |

**For "email from Mark Cuban":** Gmail trigger fires on ALL new emails. KAIROS receives all and filters locally by `payload.from` matching known Cuban addresses (fuzzy match in the callback function). This means KAIROS's daemon receives every email the user gets, not just Cuban's.

**Bandwidth/privacy implication:** For a user receiving 200 emails/day, KAIROS gets 200 Pusher events/day from Gmail polling. Each event's payload includes email metadata (sender, subject, snippet). The email body may or may not be included depending on what Gmail's API returns. This is a privacy consideration: all email metadata flows through Composio's infrastructure.

### Client-side filtering (in `triggers.subscribe()` callback)

The SDK's `shouldSendTriggerAfterFilters()` method applies these filters client-side, after events are already delivered:

```typescript
{
  toolkits: string[],           // filter by toolkit slug (e.g., ['gmail'])
  triggerSlug: string[],        // filter by trigger type slug
  userId: string,               // filter by user ID
  connectedAccountId: string,   // filter by connected account
  triggerId: string,            // filter by specific trigger instance
  triggerData: string,          // filter by arbitrary trigger data field (undocumented)
}
```

These filters run in the callback after the event arrives over Pusher. They do NOT reduce the number of events delivered to the daemon — they only determine whether the KAIROS callback is invoked.

**For KAIROS:** Content-based filtering (e.g., "only emails from Cuban") must be done in the callback function itself, not in the `filters` parameter of `subscribe()`. The `triggerData` filter field is documented but its semantics are unclear.

---

## 5. Pricing + Scale

### Confirmed pricing (as of 2026-05-27)

| Tier | Monthly cost | Tool calls included | Overage |
|------|-------------|--------------------|---------| 
| Free | $0 | 20K | — |
| Ridiculously Cheap | $29 | 200K | $0.299/1K |
| Serious Business | $229 | 2M | $0.249/1K |
| Enterprise | Custom | Custom | Custom |

### Are trigger events billed as tool calls?

**Not confirmed from documentation.** The billing page bills "tool calls" (executions). Trigger event delivery (Pusher) does not appear to count as a tool call — it is an inbound event, not an outbound execution. However, trigger management API calls (create, delete, enable, disable, listActive) DO count toward the rate limit.

**Working assumption:** Trigger event delivery = free. Trigger management = counts toward API rate limit (20K–100K req/10min window).

### Scale calculation for KAIROS at 1,000 users

**Trigger management calls at startup (one-time per user):**
- `triggers.create()` per toolkit per user — ~5 per user = 5,000 calls total (one-time)
- `triggers.listActive()` on boot — ~1 per user = 1,000 calls on cold start

**Ongoing rate:**
- `triggers.listActive()` health checks — if KAIROS polls hourly: 1,000 calls/hr = 167 calls/10min. Well within rate limits.
- No ongoing trigger management API calls needed once subscriptions are created.

**Pusher subscription:** One persistent WebSocket connection per KAIROS Cloud instance (not per user). All 1,000 users' events arrive on one channel. Composio's Pusher account is shared infrastructure — Composio bears the Pusher cost, not KAIROS.

**Event volume (rough estimate for 1,000 users):**
- Gmail: 1,000 users × 50 emails/day ÷ 24 = ~2,100 events/hr arriving over Pusher
- Slack: 1,000 users × 100 messages/day ÷ 24 = ~4,200 events/hr
- GitHub: varies widely, likely 500–2,000 events/day
- Total: ~200–300 events/minute at 1K users

This is well within Pusher's throughput capabilities. Composio's infrastructure handles the upstream ingestion.

**Tool call billing for triggers at scale:**
- Creating 5 triggers per user for 1,000 users = 5,000 tool calls one-time
- On the Serious Business tier (2M included), this is negligible (0.25% of quota)
- Monthly ongoing management: essentially zero if KAIROS doesn't constantly re-create triggers

**Bottom line:** At 1,000 users, the Composio Serious Business tier ($229/mo) has sufficient capacity for triggers. The trigger management calls are negligible compared to actual tool executions. Trigger event delivery (Pusher) appears to be free.

---

## 6. Multi-User Dynamic Subscription Management

### Per-user trigger instances

Trigger instances are scoped per connected account, which is scoped per user ID. KAIROS can programmatically create triggers for each user:

```typescript
// When user A says "notify me when I get email from Mark Cuban":
const { triggerId } = await composio.triggers.create(
  'user-A-kairos-id',          // userId (KAIROS's internal user ID)
  'GMAIL_NEW_GMAIL_MESSAGE',
  {
    connectedAccountId: 'ca_user_A_gmail',  // User A's Gmail connected account
    triggerConfig: {},                       // No server-side filter for Gmail
  }
);
// Store triggerId → 'ti_xxx' in KAIROS's database alongside the rule
// "filter: from contains 'mark.cuban' OR 'mcuban'"
```

When the trigger fires, the event includes `metadata.connectedAccount.userId` (= `'user-A-kairos-id'`), so KAIROS Cloud can route the event to the correct user's daemon.

### Dynamic add/remove

```typescript
// User changes their mind:
await composio.triggers.disable('ti_xxx');    // pause without losing config
await composio.triggers.enable('ti_xxx');     // resume
await composio.triggers.delete('ti_xxx');     // permanent removal
```

These are real SDK methods confirmed from source. KAIROS can call these programmatically when users change their monitoring rules.

### Multi-user on shared API key (Model A)

All users share one Composio project (one API key). Trigger instances are user-scoped via the `userId` parameter in `triggers.create()`. The Pusher channel (`private-{projectId}_triggers`) delivers ALL users' events to a single subscription on the KAIROS Cloud side. KAIROS Cloud routes by `metadata.connectedAccount.userId`.

**Design implication for the plan:** KAIROS Cloud needs one `triggers.subscribe()` instance (one Pusher connection), not one per user. The routing fan-out from that single subscription to individual users happens in KAIROS's own code.

### Listing all triggers for a user

```typescript
const userTriggers = await composio.triggers.listActive({
  connectedAccountIds: ['ca_user_A_gmail', 'ca_user_A_slack'],
});
```

This lets KAIROS audit what monitoring rules are currently active for a user.

---

## 7. Reliability + Offline Behavior

### Delivery model

**Pusher (Option A):**
- At-most-once delivery. Events are NOT queued for offline subscribers.
- If KAIROS daemon is offline when an event fires, the event is lost permanently.
- Pusher-js auto-reconnects on disconnect (exponential backoff). After laptop wake, reconnection is fast (seconds).
- No ordering guarantees are documented. Events from different users/toolkits may arrive out of order.
- Composio does not publish a delivery SLA for Pusher.

**Webhook (Option C):**
- Composio's dashboard shows "trigger logs" with "delivery attempts and errors" — suggesting retries exist, but no explicit guarantee count or SLA is published.
- More reliable than Pusher for offline scenarios since Cloud endpoint is always up.

**Polling mechanism latency (ingestion side):**
- Gmail: ≥15 minutes latency from email arrival to Composio detecting it.
- Webhook-based triggers (Slack, GitHub, Linear, Notion): near-instant ingestion (<1 second typically).

### FIFO ordering

Not guaranteed. Pusher channel delivers events as they arrive. Multiple concurrent triggers from different sources may arrive in any order.

### For KAIROS trust model

The offline-loss problem with Pusher means: if the user says "notify me when I get email from Mark Cuban" and closes their laptop, they will NOT be notified of emails that arrived during that time when they reopen the laptop. This is a known limitation of Option A and should be clearly communicated to users in Phase E ("monitoring is active when KAIROS is running").

---

## 8. Voice-First Auth UX

### The problem

Composio's default in-chat auth returns a URL string which an agent surfaces as a clickable link in chat. KAIROS has no chat UI — voice only + hotkey. The LLM cannot speak "click here: https://connect.composio.dev/link/ln_abc123" and have that work.

### What Composio provides

- `session.authorize(toolkit, { callbackUrl })` returns `connectionRequest.redirectUrl` — a string URL.
- `connectionRequest.waitForConnection(timeout_ms)` — SDK polls until the connection reaches ACTIVE status.
- No `openBrowser()` SDK helper exists. Composio does not open browsers programmatically.
- Localhost callback URLs are supported (confirmed from prior research: "A localhost URL works for desktop apps").

### The ConnectIntent Voice Flow KAIROS needs to build

Composio gives KAIROS a URL. KAIROS is responsible for:

```
1. Agent decides it needs a toolkit (e.g., Gmail) that isn't connected.
2. Earned Interrupt check — is user in deep focus/meeting? (C.1.5 rules)
   - If hard block: queue the connection request for when user is interruptible.
   - If soft block: brief audio cue, user can dismiss.
3. Agent speaks: "I need access to your Gmail to do this. 
                  I'll open your browser now — click Allow when you're ready."
4. KAIROS calls `session.authorize('gmail', { callbackUrl: 'http://localhost:{port}/composio-cb' })`
5. KAIROS opens browser to `connectionRequest.redirectUrl` via `open(url)` (Node.js `open` package or `shell.openExternal` in Electron).
6. KAIROS calls `connectionRequest.waitForConnection(300_000)` on a background promise.
   - OR: KAIROS uses the OAuthCallbackHandler (C.2.5) to capture the localhost redirect,
     then calls `waitForConnection(30_000)` to confirm ACTIVE status.
7. On success: Agent speaks "Gmail connected. Let me do what you asked."
8. On timeout (user didn't click Allow in 5 min): Agent speaks "Looks like you skipped the browser — I'll ask again when you need it."
```

### What changes vs in-chat auth pattern

| Aspect | In-chat auth (web app) | KAIROS voice flow |
|--------|----------------------|-------------------|
| Auth prompt delivery | Agent writes URL in chat | Agent speaks prompt, no URL shown |
| Browser opening | User clicks link in chat | KAIROS opens browser programmatically |
| User confirmation | Click on URL | Browser opens automatically |
| Earned Interrupt check | N/A (user is already in chat) | Required — check C.1.5 rules first |
| Timeout behavior | Connect Link expires quietly | Agent speaks failure message after timeout |
| Waiting for completion | `waitForConnection()` same | `waitForConnection()` same |
| Callback capture | Server redirect | Localhost `OAuthCallbackHandler` (C.2.5) |

### Practical note on `open` package

```typescript
import open from 'open';

// Opens the default browser to the Composio auth URL:
await open(connectionRequest.redirectUrl);
```

The `open` npm package works on macOS, Windows, Linux. It calls the OS default browser. No Electron dependency. This is what KAIROS should use in the ConnectIntent voice flow.

### In-chat auth still relevant for Phase F

In Phase F (web dashboard exists), Composio's `COMPOSIO_MANAGE_CONNECTIONS` meta-tool in the session will work in a chat UI. Keep `manageConnections: true` in session creation for this reason. The voice flow and in-chat auth are complementary, not alternatives.

---

## 9. Recommended Architecture for KAIROS Proactive Layer

### Phase E (current — local daemon, pre-Cloud)

```
User: "Notify me if I get an email from Mark Cuban."

KAIROS Intent Handler (new: MonitoringIntentHandler):
  1. Parse intent → monitoring rule = { toolkit: 'gmail', trigger: 'GMAIL_NEW_GMAIL_MESSAGE', filter: { from_contains: ['mark.cuban', 'mcuban'] } }
  2. Check if Gmail is connected → ConnectionStore
     - If not: trigger ConnectIntent Voice Flow (Section 8)
  3. Create trigger instance:
     const { triggerId } = await composio.triggers.create(userId, 'GMAIL_NEW_GMAIL_MESSAGE', {
       connectedAccountId: 'ca_user_gmail',
       triggerConfig: {},  // Gmail has no server-side filter
     });
  4. Persist rule in KAIROS's local SQLite:
     { rule_id, trigger_id: triggerId, filter_fn: 'from_contains', filter_value: ['mark.cuban', 'mcuban'], notification_type: 'voice', user_id }
  5. Speak: "Got it. I'll let you know when Mark Cuban emails you."

KAIROS Trigger Listener (singleton, started at daemon boot):
  composio.triggers.subscribe(
    (event: IncomingTriggerPayload) => {
      TriggerRouter.route(event);  // routes by user_id + toolkit + triggerSlug
    }
  );

TriggerRouter.route(event):
  1. Look up stored rules matching { user_id: event.metadata.connectedAccount.userId, triggerSlug: event.triggerSlug }
  2. For each matching rule: evaluate filter_fn against event.payload
     - Gmail: event.payload.from?.toLowerCase().includes('mark.cuban')
  3. If filter passes: ProactiveNotifier.notify(rule, event)
     - Earned Interrupt check (C.1.5)
     - If allowed: speak notification ("Mark Cuban just emailed you — subject: {subject}")
     - If blocked: queue for next available window
```

### Phase F (Cloud exists — multi-user, 24/7)

```
Replace Pusher subscription with webhook delivery:
  - KAIROS Cloud registers webhook: POST /api/v3.1/webhook_subscriptions
    { webhook_url: "https://api.kairos.app/composio/events", enabled_events: ["composio.trigger.message"] }
  - Cloud receives POSTs, verifies HMAC, persists events in queue
  - Cloud pushes to user's daemon via existing Cloud→daemon channel
  - Daemon receives events even when it was offline (replay on reconnect)

Trigger instance management moves to Cloud:
  - User says "notify me when..." → voice → KAIROS Cloud creates trigger via Composio API
  - Cloud owns trigger_id → rule mapping in Postgres (not local SQLite)
  - Daemon has read-only view for notification display
```

### New modules needed in C.2.x

| Module | Location | Purpose |
|--------|----------|---------|
| `TriggerListener` | `src/daemon/connectors/triggerListener.ts` | Singleton Pusher subscription; calls `composio.triggers.subscribe()` at daemon boot |
| `TriggerStore` | `src/daemon/connectors/triggerStore.ts` | SQLite table: `monitoring_rules` (rule_id, trigger_id, filter config, notification config) |
| `TriggerRouter` | `src/daemon/connectors/triggerRouter.ts` | Routes inbound events to matching rules, applies filter functions |
| `MonitoringIntentHandler` | `src/daemon/intents/monitoringIntent.ts` | Handles "notify me when X" voice commands; creates trigger instances |
| `ConnectIntentVoiceFlow` | `src/daemon/connectors/connectIntentVoiceFlow.ts` | Earned Interrupt check → speak prompt → open browser → await callback |
| (Phase F) `TriggerWebhookReceiver` | `src/cloud/webhooks/composioReceiver.ts` | HMAC verification + event persistence + push to daemon |

### Key design decisions

**Decision 1: Filter granularity.** Gmail has no server-side filter, so KAIROS gets ALL emails. For a user with 500 emails/day, this is 500 Pusher events/day. Fine for a single user; at 1,000 users receiving 500 emails each = 500K events/day = ~350 events/minute. Pusher handles this. KAIROS's in-process filter is synchronous and cheap (string matching).

**Decision 2: Trigger instance lifetime.** Create trigger instances when user sets up a monitoring rule; disable (not delete) when user pauses the rule; delete when user permanently removes it. Use `triggers.listActive()` at daemon boot to reconcile with what's in local SQLite (detect triggers deleted by other means).

**Decision 3: Offline loss acknowledgment.** Phase E accepts missed events when daemon is offline. The UX should be: "I'm watching for emails from Mark Cuban while KAIROS is running." Not: "I'll always notify you, even if your laptop is off."

**Decision 4: Gmail latency disclosure.** Gmail triggers have ≥15 minute latency. For time-sensitive notifications ("my flight confirmation"), this may be unacceptable. Plan should note: Gmail real-time would require Google Pub/Sub integration (outside Composio), which is out of scope for Phase E.

---

## 10. Open Questions for the User

1. **Gmail latency is ≥15 minutes — acceptable?** For "email from Mark Cuban," a 15-minute delay may be fine (it's not urgent). But for "my flight confirmation arrived," this is a real problem. The plan should either: (a) accept this limitation and document it, or (b) note that real-time Gmail requires a separate Phase F Google Pub/Sub integration path. Which?

2. **Email privacy model.** Gmail trigger delivers email metadata (sender, subject, snippet, possibly body) to Composio's infrastructure, then to KAIROS. User must consent to this when connecting Gmail. Should KAIROS add an explicit privacy disclosure in the ConnectIntentVoiceFlow for Gmail specifically? ("Connecting Gmail means Composio will see your email metadata to check for notifications.")

3. **Trigger instance persistence across restarts.** Trigger instances (on Composio's side) persist even when the daemon restarts. If KAIROS creates a `GITHUB_COMMIT_EVENT` trigger for user A's repo, it stays active even if KAIROS is reinstalled. The `TriggerListener` needs to reconcile `TriggerStore` (local) vs `triggers.listActive()` (Composio remote) at boot — cleaning up orphaned instances. Is this reconciliation logic needed for Phase E, or is it a Phase F concern?

4. **Scale of monitoring rules.** How many monitoring rules per user should KAIROS support? Each rule = one trigger instance on Composio. If users create 20+ rules, that's 20+ trigger instances per user × 1,000 users = 20,000 active trigger instances. Is there a Composio limit on active trigger instances? Docs don't mention one, but worth confirming.

5. **"Mark Cuban" fuzzy matching.** Cuban's email could be `mark@cyberdust.com`, `mcuban@dallasmavs.com`, or various other addresses. How should KAIROS handle intent parsing for this? Options: (a) exact string match on what user says, (b) KAIROS LLM attempts to resolve common names to known email addresses, (c) user specifies email address explicitly. This is UX/intent parsing scope, not Composio scope — but needs answering before MonitoringIntentHandler is built.

6. **Webhook for Phase F — one webhook subscription or per-user?** Composio's webhook subscriptions are project-level. One webhook URL receives all users' events. KAIROS Cloud needs to handle fan-out. Confirm this is the right architecture before Cloud is built. Are there user-specific webhook URLs available in Composio? (Docs suggest not — it's project-level.)

7. **Pusher plan coverage.** Composio provides the Pusher channel as part of their service. At high volume (1,000+ users, hundreds of events/minute), is Composio's Pusher allocation sufficient, or does KAIROS need Enterprise tier to get guaranteed throughput? Composio doesn't publish Pusher capacity limits. Worth asking their support.

---

## Appendix: Confirmed SDK methods for trigger subsystem

All from `ts/packages/core/src/models/Triggers.ts` (source-verified 2026-05-27):

```typescript
// Create trigger instance
composio.triggers.create(userId: string, slug: string, body?: {
  connectedAccountId?: string;
  triggerConfig?: Record<string, unknown>;
}): Promise<{ triggerId: string }>

// Subscribe (Pusher WebSocket, no public URL needed)
composio.triggers.subscribe(
  fn: (data: IncomingTriggerPayload) => void,
  filters?: {
    toolkits?: string[];
    triggerId?: string;
    connectedAccountId?: string;
    triggerSlug?: string[];
    userId?: string;
    triggerData?: string;
  }
): Promise<void>

// Management
composio.triggers.enable(triggerId: string): Promise<{ status: 'success' }>
composio.triggers.disable(triggerId: string): Promise<{ status: 'success' }>
composio.triggers.delete(triggerId: string): Promise<{ triggerId: string }>

// Discovery
composio.triggers.listTypes(query?: { toolkits?: string[]; limit?: number; cursor?: string }): Promise<TriggersTypeListResponse>
composio.triggers.getType(slug: string): Promise<TriggersTypeRetrieveResponse>

// List active instances (for reconciliation)
composio.triggers.listActive(query?: {
  connectedAccountIds?: string[];
  triggerIds?: string[];
  triggerNames?: string[];
  authConfigIds?: string[];
  showDisabled?: boolean;
  limit?: number;
  cursor?: string;
}): Promise<TriggerInstanceListActiveResponse>

// Unsubscribe from Pusher
composio.triggers.unsubscribe(): Promise<void>

// Webhook verification (for Option C / Phase F)
composio.triggers.verifyWebhook(params: {
  payload: string;
  signature: string;  // 'webhook-signature' header — format: "v1,base64sig"
  secret: string;     // from webhook subscription response
  id: string;         // 'webhook-id' header
  timestamp: string;  // 'webhook-timestamp' header
  tolerance?: number; // default 300 seconds
}): Promise<{ version: WebhookVersion; payload: IncomingTriggerPayload; rawPayload: WebhookPayload }>
```

```typescript
// IncomingTriggerPayload structure:
{
  id: string;           // trigger instance ID
  uuid: string;
  triggerSlug: string;  // e.g., 'GMAIL_NEW_GMAIL_MESSAGE'
  toolkitSlug: string;  // e.g., 'gmail'
  userId: string;       // KAIROS user ID (scopes event to correct user)
  payload: Record<string, unknown>;          // trigger-specific data
  originalPayload: Record<string, unknown>;
  metadata: {
    triggerSlug: string;
    toolkitSlug: string;
    triggerConfig: Record<string, unknown>;  // config used when creating the instance
    connectedAccount: {
      id: string;         // Composio connected account ID
      userId: string;     // KAIROS user ID (same as top-level userId)
      authConfigId: string;
      status: 'ACTIVE' | 'INACTIVE';
    };
  };
}
```
