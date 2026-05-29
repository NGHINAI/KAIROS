# Phase D — Composio Triggers (Real-Time Event Subscription)

**Status:** design approved 2026-05-29
**Author:** Nirmal Ghinaiya
**Scope:** wire Composio's real-time trigger subscription into KAIROS's perception bus so STANDING_ORDERS v2 rules can fire on incoming external events (new emails, GitHub PRs, Slack DMs, calendar invites). Production-grade reliability patterns: persistent event log, idempotency, reconciliation, refcounted trigger instances, server-side filtering hints. Tag `v0.5.0`.

---

## 1. Goals

| Capability | Implementation |
|---|---|
| Daemon receives real-time events from connected services | Composio's `triggers.subscribe()` Pusher channel; events normalized → perception bus |
| User authors "notify me when X" via existing speech path | OrdersAuthor extends to new `incoming_event` state selector — zero new intent handlers |
| Filter grammar already exists, scales to any new toolkit | C.4.1 ConditionEvaluator `if`/`unless` predicates run on `payload.*` — works for any JSON event shape Composio adds |
| Server-side filtering where supported (drops 99% noise at source) | `config:` field in DSL → passed to `triggers.create(triggerConfig)` for GitHub repo, Slack channel, etc. |
| Production reliability at 1000+ users × 500k events/day | Persistent SQLite event log + idempotency keys + reconciliation + refcounted instances + backpressure |
| Auto-OAuth when service not connected | ConnectGuard surfaces inbox prompt + native notification + opens Composio OAuth URL |
| Backward compatible with C.1–C.4 | New event source, same evaluator, same dispatcher, same restraint pipeline. Persona shifts, dry-run gates, cooldowns all apply automatically |

## 2. Non-goals

- **Real-time Gmail.** Composio's hosted Gmail OAuth polls every ~15 min. Sub-second Gmail requires BYOAuth + Google Pub/Sub (own Google OAuth app + verification + Pub/Sub topic infrastructure). Accepted as a known limitation for Phase D. Other toolkits (Slack, GitHub, Linear, Notion, Calendar) are real-time via webhook ingestion.
- **Webhook receiver path.** Requires KAIROS Cloud (Phase F).
- **Voice surface for ConnectGuard prompts.** Phase E adds voice. Phase D uses inbox + native notifications.
- **Cross-user trigger sharing.** Phase F enterprise.
- **DLQ inspection UI.** HUD (Phase F).

## 3. Architecture

```
                         ┌─────────────────────────────────────┐
   Composio Pusher ────► │ TriggerListener (NEW)               │
   (private-{proj}_      │  - composio.triggers.subscribe()    │
    triggers channel)    │  - reconnect with exponential backoff│
                         │  - 30s heartbeat health check       │
                         │  - surface "monitoring degraded" alert│
                         └────────────────┬────────────────────┘
                                          │ raw event
                                          ▼
                         ┌─────────────────────────────────────┐
                         │ TriggerEventLog (NEW)               │
                         │  SQLite — composio_trigger_events   │
                         │  UNIQUE(toolkit, event_id) idempotent│
                         │  status: received → processed/failed │
                         └────────────────┬────────────────────┘
                                          │ normalized envelope
                                          ▼
                         ┌─────────────────────────────────────┐
                         │ TriggerNormalizer (NEW)             │
                         │  Maps any Composio payload to:      │
                         │  { trigger_slug, toolkit, payload,  │
                         │    raw, received_at, event_id,      │
                         │    connected_account_id, user_id }  │
                         └────────────────┬────────────────────┘
                                          │ bus.publish('incoming_event', envelope)
                                          ▼
                         ┌─────────────────────────────────────┐
                         │ Perception Bus (EXISTING)           │
                         │  kind = 'incoming_event'            │
                         └────────────────┬────────────────────┘
                                          │
                                          ▼
                         ┌─────────────────────────────────────┐
                         │ ReactiveEvaluator (EXTEND, +50 LOC) │
                         │  matchesSelector() handles new      │
                         │  StateSelector.incoming_event       │
                         │  if/unless run against payload      │
                         └────────────────┬────────────────────┘
                                          │ fire (gated by cooldown, dry-run, persona)
                                          ▼
                         ┌─────────────────────────────────────┐
                         │ ActionDispatcher (EXISTING)         │
                         │  routes to intent / skill / composio │
                         └─────────────────────────────────────┘

   ─── Lifecycle support modules ─────────────────────────────────────

   ┌─────────────────────────────────────┐  ┌─────────────────────────────────────┐
   │ TriggerInstanceManager (NEW)        │  │ TriggerSchemaCache (NEW)            │
   │  - refcount: many rules → 1 instance │  │  - composio.triggers.get_type(slug) │
   │  - reconcile w/ listActive() at boot │  │    cached at boot                   │
   │  - delete instance on refcount → 0  │  │  - used by OrdersAuthor for compile │
   │  - create from rule.config (server- │  │  - used by Listener for payload     │
   │    side hints)                      │  │    schema validation                │
   └─────────────────────────────────────┘  │  - 24h refresh + on-miss             │
                                            └─────────────────────────────────────┘

   ┌─────────────────────────────────────┐  ┌─────────────────────────────────────┐
   │ ConnectGuard (NEW)                  │  │ TriggerMetrics (NEW)                │
   │  - check ConnectionStore (C.2.7)    │  │  - counts: received, matched, fired │
   │    when rule with incoming_event    │  │  - latencies (p50/p99)              │
   │    is materialized                  │  │  - per-rule + per-toolkit           │
   │  - if not connected:                │  │  - SQLite trigger_metrics table     │
   │    1. inbox prompt + native notif   │  │  - daemon HTTP /metrics endpoint    │
   │    2. open Composio OAuth URL       │  │  - read by future HUD               │
   │    3. on callback: activate rule    │  └─────────────────────────────────────┘
   │  - 5-min timeout → rule moves to    │
   │    'pending_connection' state       │
   └─────────────────────────────────────┘
```

## 4. DSL extension — `incoming_event` state selector

The only NEW user-visible change to the v2 DSL. Everything else reuses existing types.

```yaml
## mark-cuban-email
---
schema_version: 1
when:
  state:
    incoming_event:
      trigger: GMAIL_NEW_GMAIL_MESSAGE
      # Optional: triggerConfig hints applied server-side at instance creation.
      # Trigger-specific; validated against TriggerSchemaCache schema.
      # Gmail: {} (no server-side filter available)
      # GitHub: { owner: "user", repo: "myproject" } drops events from other repos
      # Slack:  { channel: "C0XXXXX" } drops events from other channels
      config:
        # empty for Gmail
if:
  - "payload.from.includes('mark.cuban')"
  - "payload.subject != 'unsubscribe'"
do:
  - action: notify
    args:
      message: "Mark emailed: ${payload.subject}"
cooldown: 30s
state: dry_run
created_by: voice
created_at: 2026-05-29T10:00:00Z
---
You said: "notify me when Mark Cuban emails me"
```

**Schema addition to `StateSelector` (TypeScript-normative):**

```typescript
type StateSelector =
  // ... existing clipboard, focus_app, calendar, file_events, browser_tabs, pattern
  | {
      incoming_event: {
        trigger: string                  // Composio trigger slug, e.g. 'GMAIL_NEW_GMAIL_MESSAGE'
        config?: Record<string, unknown> // optional triggerConfig hints (server-side filter)
      }
    }
```

**Validation rules added to `OrdersParser`:**
1. `trigger` must match `^[A-Z][A-Z0-9_]+$` (Composio convention)
2. `config` shape validated against `TriggerSchemaCache.getType(trigger).config` schema at parse time. Invalid → rule logged + skipped (lenient v1 behavior preserved)

## 5. Per-component design

### 5a. TriggerListener

**File:** `src/daemon/connectors/triggers/listener.ts`

Singleton, started at daemon boot. Subscribes once to Composio's Pusher channel with no client-side filters (we want ALL events through the funnel for the local SQLite log + perception bus to handle).

```typescript
export class TriggerListener {
  constructor(deps: {
    composio: ComposioClient
    eventLog: TriggerEventLog
    normalizer: TriggerNormalizer
    perceptionBus: EventBus
    metrics: TriggerMetrics
    onHealthChange?: (health: 'healthy' | 'degraded' | 'offline') => void
  })

  async start(): Promise<void>     // calls composio.triggers.subscribe; starts heartbeat
  async stop(): Promise<void>      // unsubscribes; clears heartbeat
  getHealth(): 'healthy' | 'degraded' | 'offline'
}
```

**Receive path (per event):**
1. Hash event for idempotency key: `event_id = payload.id ?? sha256(json(payload)).slice(0, 16)`
2. `eventLog.record({ trigger_slug, toolkit, event_id, raw: payload, received_at: now() })` — UNIQUE constraint silently drops duplicates
3. If new (not duplicate), `normalizer.normalize(payload) → envelope`
4. `perceptionBus.publish({ kind: 'incoming_event', payload: envelope })`
5. After ReactiveEvaluator returns: `eventLog.markProcessed(event_id)`
6. `metrics.recordReceived(toolkit, latency_ms)`

**Heartbeat (every 30s):**
- Verify Pusher connection state via `pusher.connection.state === 'connected'`
- If state is `unavailable` or `failed`: emit `onHealthChange('degraded')`, surface inbox prompt "Monitoring degraded — Composio connection unstable", continue reconnect attempts
- 5 consecutive failures (~2.5 min) → `onHealthChange('offline')`, surface native notification

**Reconnect strategy:**
- pusher-js handles its own auto-reconnect with built-in exponential backoff
- We wrap to log telemetry and emit health changes
- If unresponsive >5 min, listener tears down + recreates the subscription (full re-handshake)

### 5b. TriggerEventLog

**File:** `src/daemon/connectors/triggers/eventLog.ts`

```sql
CREATE TABLE IF NOT EXISTS composio_trigger_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  toolkit TEXT NOT NULL,
  trigger_slug TEXT NOT NULL,
  event_id TEXT NOT NULL,
  connected_account_id TEXT,
  user_id TEXT,
  raw_payload TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  processed_at INTEGER,
  failed_at INTEGER,
  last_error TEXT,
  status TEXT NOT NULL DEFAULT 'received',  -- received | processed | failed
  UNIQUE(toolkit, event_id)
);
CREATE INDEX IF NOT EXISTS idx_trigger_events_status ON composio_trigger_events(status, received_at);
```

API:
```typescript
class TriggerEventLog {
  /** Returns true if newly inserted; false if duplicate (idempotent). */
  record(envelope: NormalizedEvent): boolean
  markProcessed(toolkit: string, event_id: string): void
  markFailed(toolkit: string, event_id: string, error: string): void
  listUnprocessed(limit: number): Array<NormalizedEvent>   // boot-time replay
  prune(olderThan: number): number                          // delete processed rows > 7 days old
}
```

**Boot-time replay:** on daemon boot, `listUnprocessed(100)` is drained through the perception bus — handles crash recovery. Rows older than 7 days are pruned daily.

### 5c. TriggerNormalizer

**File:** `src/daemon/connectors/triggers/normalizer.ts`

Pure function that maps the variable Composio payload shapes to the canonical envelope.

```typescript
type NormalizedEvent = {
  trigger_slug: string                       // 'GMAIL_NEW_GMAIL_MESSAGE'
  toolkit: string                            // 'gmail'
  payload: Record<string, unknown>           // the inner data the user filters on
  raw: Record<string, unknown>               // original full Composio payload (for debug)
  received_at: number                        // ms epoch
  event_id: string                           // idempotency key
  connected_account_id?: string
  user_id?: string
}
```

Composio's payload wraps the actual event data in different ways per trigger type. Normalizer reads the schema from `TriggerSchemaCache` to find the right path. Falls back to raw payload if schema is missing.

### 5d. TriggerInstanceManager

**File:** `src/daemon/connectors/triggers/instanceManager.ts`

Refcounting: many rules may share one Composio trigger instance.

```sql
CREATE TABLE IF NOT EXISTS trigger_instances (
  trigger_id TEXT PRIMARY KEY,           -- Composio 'ti_xxx'
  trigger_slug TEXT NOT NULL,
  connected_account_id TEXT NOT NULL,
  config_hash TEXT NOT NULL,             -- sha256 of triggerConfig used to create
  created_at INTEGER NOT NULL,
  rule_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS rule_trigger_links (
  rule_slug TEXT NOT NULL,
  trigger_id TEXT NOT NULL,
  PRIMARY KEY (rule_slug, trigger_id),
  FOREIGN KEY (trigger_id) REFERENCES trigger_instances(trigger_id) ON DELETE CASCADE
);
```

API:
```typescript
class TriggerInstanceManager {
  /** Acquire (create-or-reuse) instance for a rule. Returns trigger_id. */
  async acquireForRule(rule_slug: string, trigger_slug: string, config: Record<string, unknown>): Promise<string>
  /** Release: decrements refcount; deletes Composio instance if 0. */
  async releaseForRule(rule_slug: string, trigger_id: string): Promise<void>
  /** Reconcile local store against Composio's listActive(). Runs at boot. */
  async reconcile(): Promise<{ orphaned_local: string[]; orphaned_remote: string[]; recreated: string[] }>
}
```

**Reconciliation logic:**
1. `local = SELECT trigger_id FROM trigger_instances`
2. `remote = await composio.triggers.listActive()`
3. `orphaned_local = local - remote` → delete from SQLite; affected rules → `pending_connection` state
4. `orphaned_remote = remote - local` → DELETE from Composio (unused remote instances)
5. For rules referencing missing trigger_id: try `acquireForRule()` to recreate

### 5e. TriggerSchemaCache

**File:** `src/daemon/connectors/triggers/schemaCache.ts`

Caches `composio.triggers.get_type(slug)` results for: (1) DSL config validation, (2) OrdersAuthor's compile-time schema lookup, (3) TriggerNormalizer payload field paths.

```typescript
class TriggerSchemaCache {
  async initialize(): Promise<void>   // bulk-load all types for connected toolkits
  getType(slug: string): TriggerType | null
  async refresh(): Promise<void>      // daily timer
}

type TriggerType = {
  slug: string
  toolkit: string
  config_schema: JsonSchema         // for DSL config: validation
  payload_schema: JsonSchema        // for normalizer path lookup
  description: string               // for OrdersAuthor LLM prompt
}
```

24h refresh. On-miss refresh rate-limited (same pattern as ComposioToolResolver from C.4.2).

### 5f. ConnectGuard

**File:** `src/daemon/connectors/triggers/connectGuard.ts`

When a new `incoming_event` rule is materialized, ensures the underlying toolkit is connected before activating.

```typescript
class ConnectGuard {
  constructor(deps: {
    connectionStore: ConnectionStore       // C.2.7 existing
    connectionFlow: ConnectionFlow         // C.2.7 existing
    inbox: InboxSurface                    // existing
    nativeNotifier: NativeNotifier         // existing
    onConnectionComplete: (toolkit: string) => void
  })

  /** Returns 'ready' if connected, otherwise initiates connect prompt. */
  async ensureConnected(toolkit: string, rule_slug: string): Promise<'ready' | 'pending' | 'timeout'>
}
```

**Flow:**
1. Check `connectionStore.listActive('local')` for the toolkit
2. If connected → return `'ready'`
3. If not:
   - `inbox.add({ kind: 'connect_required', title: 'Connect ${toolkit}', body: 'KAIROS needs ${toolkit} to monitor for rule ${rule_slug}. Click to connect.' })`
   - `nativeNotifier.notify('KAIROS needs ${toolkit} access — open inbox to connect')`
   - `connectionFlow.link(toolkit)` → returns OAuth URL → opens via `open` system command (macOS)
   - Wait up to 5 min for callback (via existing tokenExpiryPoller / connectionFlow callback)
   - On success → `onConnectionComplete(toolkit)` → ReactiveEvaluator notified → rule moves `pending_connection → active`
   - On timeout → rule stays `pending_connection`; user can retry from inbox

### 5g. TriggerMetrics

**File:** `src/daemon/connectors/triggers/metrics.ts`

```sql
CREATE TABLE IF NOT EXISTS trigger_metrics (
  toolkit TEXT NOT NULL,
  rule_slug TEXT,
  metric TEXT NOT NULL,         -- 'received' | 'matched' | 'fired' | 'failed' | 'latency_ms'
  value INTEGER NOT NULL,
  bucket_start INTEGER NOT NULL,  -- 1-minute bucket
  PRIMARY KEY (toolkit, rule_slug, metric, bucket_start)
);
```

API:
```typescript
class TriggerMetrics {
  record(toolkit: string, rule_slug: string | null, metric: string, value: number): void
  query(opts: { from: number; to: number; metric?: string; toolkit?: string }): MetricsRow[]
  /** P50/P99 over a time window for a specific metric. */
  percentiles(metric: string, opts: { from: number; to: number; toolkit?: string }): { p50: number; p99: number }
}
```

Exposed via the existing daemon HTTP server: `GET /metrics/triggers?from=...&to=...` returns JSON. Future Phase F HUD reads this.

### 5h. ReactiveEvaluator extension

**Modify:** `src/daemon/orders/v2/reactiveEvaluator.ts`

Add to `matchesSelector()`:

```typescript
if ('incoming_event' in sel && kind === 'incoming_event') {
  const ie = sel.incoming_event
  const env = payload as NormalizedEvent
  if (ie.trigger !== env.trigger_slug) return false
  // config matching is purely server-side; if event reached us, the trigger
  // is the right one. if/unless predicates handle further filtering.
  return true
}
```

The `if`/`unless` predicates run against `payload.X` paths automatically — `payload` in the predicate context is `NormalizedEvent.payload` (the inner data the user cares about). C.4.1's `maybeFire()` machinery handles cooldown + dry-run + dispatch.

### 5i. OrdersAuthor extension

**Modify:** `src/daemon/orders/v2/author.ts`

Updates to the system prompt:
- Tell the LLM about the `incoming_event` selector type
- Inject the catalog of available trigger slugs for connected toolkits from `TriggerSchemaCache`
- Examples of how to express common patterns ("notify me when X emails me" → `GMAIL_NEW_GMAIL_MESSAGE` + `payload.from.includes(X)`)

New dep: `schemaCache?: TriggerSchemaCache`. When present, OrdersAuthor enriches the LLM prompt with available triggers + their payload schemas.

**Connection check:** after compiling, if the rule uses `incoming_event` AND the toolkit isn't in `connectionStore.listActive()`, OrdersAuthor sets `rule.state = 'pending_connection'` and triggers `ConnectGuard.ensureConnected()` asynchronously. User sees "Rule created, awaiting ${toolkit} connection."

## 6. Storage — five new tables

(All defined inline above.)

- `composio_trigger_events` — idempotent event log
- `trigger_instances` — Composio trigger instance bookkeeping
- `rule_trigger_links` — rule → instance refcounting
- `trigger_metrics` — observability
- New rule lifecycle state: `'pending_connection'` added to existing `LifecycleState` union

## 7. Daemon wire-up

In `src/daemon/index.ts`, after the existing Composio block (C.2.7):

```typescript
// ──────────────────────────────────────────────────────────────────────
// Phase D — Composio Triggers subsystem
// ──────────────────────────────────────────────────────────────────────
if (composioClient && config.composio?.triggers_enabled !== false) {
  try {
    const schemaCache = new TriggerSchemaCache({ composio: composioClient })
    await schemaCache.initialize().catch(err => log(`[triggers] schema init: ${err}`, 'warn'))

    const eventLog = new TriggerEventLog(db)
    const normalizer = new TriggerNormalizer({ schemaCache })
    const metrics = new TriggerMetrics(db)

    const instanceManager = new TriggerInstanceManager({ db, composio: composioClient })
    await instanceManager.reconcile().catch(err => log(`[triggers] reconcile: ${err}`, 'warn'))

    const connectGuard = new ConnectGuard({
      connectionStore, connectionFlow, inbox,
      nativeNotifier: notifier,
      onConnectionComplete: (toolkit) => { /* notify ReactiveEvaluator */ },
    })

    const listener = new TriggerListener({
      composio: composioClient, eventLog, normalizer,
      perceptionBus: bus, metrics,
      onHealthChange: (health) => log(`[triggers] health=${health}`),
    })
    await listener.start()

    // Wire schemaCache into OrdersAuthor (if it exists)
    if ((globalThis as any).__kairosOrdersAuthor) {
      (globalThis as any).__kairosOrdersAuthor.schemaCache = schemaCache
      ;(globalThis as any).__kairosOrdersAuthor.instanceManager = instanceManager
      ;(globalThis as any).__kairosOrdersAuthor.connectGuard = connectGuard
    }

    // Boot replay of unprocessed events
    const unprocessed = eventLog.listUnprocessed(100)
    for (const env of unprocessed) bus.publish('incoming_event', env)
    if (unprocessed.length > 0) log(`[triggers] replayed ${unprocessed.length} events at boot`)

    ;(globalThis as any).__kairosTriggerListener = listener
    ;(globalThis as any).__kairosTriggerEventLog = eventLog
    log(`[triggers] subsystem ready`)
  } catch (err) {
    log(`[triggers] subsystem failed to start: ${err}`, 'warn')
  }
}
```

Shutdown wires `listener.stop()`.

## 8. Test strategy

**Per-component unit tests (~56 tests):**

| Component | Tests |
|---|---|
| TriggerListener | 8 (subscribe success, reconnect, heartbeat detects degraded, event flow happy path, idempotent re-delivery, health change callbacks, stop unsubscribes, metrics emission) |
| TriggerEventLog | 8 (record unique, record duplicate dropped, markProcessed, markFailed, listUnprocessed ordering, prune deletes old processed, status transitions, persistence across reopen) |
| TriggerNormalizer | 6 (Gmail payload mapping, GitHub payload mapping, Slack payload mapping, missing schema fallback, event_id derivation, idempotent normalization) |
| TriggerInstanceManager | 10 (acquireForRule new instance, acquireForRule reuses existing, refcount increment, releaseForRule deletes when 0, releaseForRule keeps when >0, reconcile finds orphans, reconcile recreates missing, config hash consistency, ON DELETE CASCADE cleans links, persistence) |
| TriggerSchemaCache | 6 (initialize bulk load, getType hit, getType miss → null, refresh updates, on-miss refresh rate-limited, persistence to disk cache) |
| ConnectGuard | 6 (already connected → ready, not connected → pending, callback success → activate, timeout → pending_connection, inbox prompt content, native notif content) |
| TriggerMetrics | 4 (record + query, percentiles, bucketing, HTTP endpoint format) |
| ReactiveEvaluator extension | 4 (incoming_event matches selector, trigger_slug mismatch ignored, if/unless on payload, dry-run path) |
| OrdersAuthor extension | 4 (LLM prompt includes available triggers, compile produces incoming_event rule, missing toolkit triggers ConnectGuard, schema validation rejects invalid config) |

**Integration tests (~6):** Pusher → Log → Normalizer → Evaluator end-to-end with fakes; reconcile-on-boot drains unprocessed events; ConnectGuard flow for "not connected" rule.

**Phase D validation gate** (`scripts/validate-phase-d.ts`, ~20 assertions):

| Scenario | Assertions |
|---|---|
| Boot subsystem with fakes | 2 |
| User speaks 3 different rules (Slack, GitHub, Gmail) | 3 (one per toolkit) |
| Pusher delivers events, rules fire | 3 (one per matching event) |
| Idempotent re-delivery suppressed | 2 |
| Dry-run gate respected | 2 |
| Cooldown respected | 2 |
| ConnectGuard for unconnected toolkit | 2 |
| Refcount: share trigger across rules | 1 |
| Reconcile-on-boot detects orphan | 1 |
| Health check: simulated Pusher disconnect | 1 |
| Shutdown: no leaked timers | 1 |

**Regression:** all 11 existing gates + full `bun test` must pass.

## 9. Risks + mitigations

1. **Pusher under Bun runtime quirks** — `pusher-js` is browser/Node oriented. Phase D Task 0 includes a spike test verifying Pusher works under Bun. If broken, fall back to raw WebSocket against Composio's documented Pusher URL.
2. **Composio API rate limits on boot** — `listActive() + get_type() × N` could be heavy. Mitigation: TriggerSchemaCache only loads types for currently-active rules' triggers; expansion happens lazily.
3. **Event explosion from broken filter** — typo in `payload.x` matches everything → 500 events/min. Mitigation: per-rule cooldown (C.4.1) + dry-run gate (C.4.1) + automatic suspension after 100 fires in 5 min.
4. **Server-side `triggerConfig` schema drift** — Composio could change required fields. Mitigation: schemaCache refreshes daily; OrdersAuthor validates at compile time; affected rules → `suspended` + surfaced.
5. **OAuth callback fails or times out** — user closes browser. Mitigation: ConnectGuard 5-min timeout, rule moves to `pending_connection`, retry button in inbox.
6. **Daemon offline during high-value event** — Pusher does not queue. Mitigation: documented limitation; Phase F adds webhook + Cloud relay for at-least-once delivery.

## 10. Out of scope (deferred to later phases)

- BYOAuth + Google Pub/Sub for real-time Gmail (separate phase)
- Webhook receiver for at-least-once delivery (Phase F)
- Voice surface for ConnectGuard prompts (Phase E)
- Trigger sharing across users (Phase F enterprise)
- DLQ inspection UI (Phase F HUD)
- Custom Composio toolkits (Phase F)

## 11. Tagging plan

After Phase D gate verdicts PASS + regression sweep clean:

1. Append `CHANGELOG.md` with `v0.5.0` entry summarizing the trigger subsystem
2. Commit: `release: Phase D complete — Composio real-time triggers`
3. Tag: `v0.5.0`

---

End of design.
