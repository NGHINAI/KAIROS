# Phase E.2 — Self-Healing Composio Integration

**Status:** Design only. **DO NOT IMPLEMENT YET** — blocked on Phase E.1 (voice).
**Estimated effort:** ~3 weeks of focused work post-voice.
**Ships as:** v0.7.0 (after Phase E.1 voice ships as v0.6.x).

---

## 1. Problem statement

Phase D (v0.5.x) shipped the proactive loop: Composio trigger → KAIROS reactive → outbound action. Live-verified end-to-end against Google Calendar and Linear. But three real production gaps surfaced:

### Gap 1 — Per-toolkit config scoping
Every Composio trigger has its own scoping concept and KAIROS has no way to fill it in:

| Toolkit | Required config |
|---|---|
| Linear | `team_id` |
| Slack | `channel_id` |
| GitHub | `owner` + `repo` |
| Notion | `database_id` or `page_id` |
| Asana | `project_id` |
| Trello | `board_id` |
| Jira | `project_key` |
| HubSpot | `pipeline_id` or `list_id` |
| Salesforce | `record_id` |
| ... | ... |

We empirically hit this on the Linear test — `LINEAR_ISSUE_CREATED_TRIGGER` requires `team_id`. KAIROS had no way to know or fetch it. Required manual intervention (looking up team via SDK call).

### Gap 2 — Execution failures without recovery
When `composio_tool` action dispatch fails (catalog drift, schema change, attachment required), the rule silently fails. No retry, no recovery. Examples:
- LLM-authored rule uses tool name that doesn't exist (`gmail.send` vs `send_email`)
- Composio renames `send_email` → `send_message` (catalog drift)
- Tool requires file attachment but rule doesn't stage one
- Required arg added in newer schema version

### Gap 3 — Hardcoded fragility
Every gap above currently requires KAIROS code changes when new toolkits appear, schemas drift, or Composio renames things. **KAIROS should self-heal.**

## 2. Vision — three tiers, two flows, one architecture

### Two flows
- **AUTHORING** — when an LLM-authored rule needs config fields filled (which Linear team? which Slack channel?)
- **EXECUTION** — when a `composio_tool` action fails to dispatch (wrong tool name, missing arg, etc.)

### Three tiers (apply to both flows)
```
┌──────────────────────────────────────────────────────────────────────┐
│  TIER 1 — DiscoveryRegistry (deterministic, instant)                 │
│  ─────────────────────────────────────────────────                   │
│  Hardcoded map: {toolkit}.{configField} → discovery method.          │
│  Covers ~50-100 toolkits seeded at v0.7.0 launch.                    │
│  Auto-fills via cached single-shot tool call (e.g. LIST_TEAMS).      │
│  Single result → silent auto-fill. Multiple → Tier 2.                │
│  ~200ms-1s, $0 LLM cost. Handles 80%+ of real cases.                 │
└──────────────────────────────────────────────────────────────────────┘
                                  ↓
┌──────────────────────────────────────────────────────────────────────┐
│  TIER 2 — PickerStrategy (user-mediated, voice-first)                │
│  ─────────────────────────────────────────────────                   │
│  Multiple discovery options. Surface to user.                        │
│  Primary: voice ("Which Linear team — Ajgaoscw, Marketing,           │
│  or Engineering?") with conversational confirm.                      │
│  Fallback: inbox prompt + native notification + Discord DM           │
│  (PickerStrategy chain, ordered by user prefs).                      │
│  ~5s-2min depending on user response. Decision cached.               │
└──────────────────────────────────────────────────────────────────────┘
                                  ↓
┌──────────────────────────────────────────────────────────────────────┐
│  TIER 3 — Agentic MCP fallback (LLM-mediated, generalized)           │
│  ─────────────────────────────────────────────────                   │
│  Tier 1+2 don't apply (registry doesn't know toolkit, or execution   │
│  failed). Spawn a specialized subagent:                              │
│   - Composio MCP session for that toolkit                            │
│   - LLM agent loop with MCP tools attached                           │
│   - Voice updates while running ("Hang on, finding right tool...")   │
│  Non-blocking — main daemon serves other rules in parallel.          │
│  ~5-60s. Reliable for any toolkit.                                   │
└──────────────────────────────────────────────────────────────────────┘
```

## 3. Voice-first UX

**The picker and progress are voice-driven by default.** Visual surfaces are fallbacks for things you need to LOOK at (e.g. a long list of channel names).

**Example flows:**

*Authoring (Tier 1+2):*
```
USER  (voice): "Ping me when a Linear issue gets created"
KAIROS (voice): "Sure — I see one Linear team called Ajgaoscw. Watching it now."
[rule activated silently — auto-discovery happened in background]
```

*Authoring (Tier 2 picker):*
```
USER  (voice): "Notify me on Slack messages"
KAIROS (voice): "Which channel — #general, #design, or #standup?"
USER  (voice): "design"
KAIROS (voice): "Watching #design for new messages."
```

*Execution (Tier 3 background):*
```
[Linear issue arrives → rule fires → composio_tool action: gmail.send_email]
[Direct execute fails because LLM-authored rule used 'send_message' instead]

KAIROS (voice, ambient): "I'm working on that Gmail summary — give me 10 seconds."
[main daemon stays responsive]
[Tier 3 subagent: spawns, connects to Composio Gmail MCP, finds GMAIL_SEND_EMAIL
 with the right args, executes via MCP, returns]
KAIROS (voice): "Sent."
```

## 4. Subagent deployment (openclaw-inspired)

Per the user-cited reference at https://github.com/openclaw/openclaw, the right pattern is **scoped subagents with per-agent tool allowlists**. Each subagent is specialized for a task with limited access.

### KAIROS subagent types (v0.7)

```typescript
type SubagentKind =
  | 'config_discovery_solver'   // Tier 3 for authoring
  | 'execution_recovery_solver' // Tier 3 for action dispatch
  | 'discovery_registry_extender' // self-learning: adds new toolkits to registry
```

Each spawned with:
- **Scope:** specific toolkit (`gmail`, `linear`, etc.) — never general
- **Tool allowlist:** ONLY that toolkit's Composio MCP tools + a tiny meta-tool kit (return result, log, ask user)
- **Timeout:** no hard cap but progress required every 30s, else escalate
- **Reporting channel:** voice for updates, inbox for "needs human"

### Non-blocking pattern

```
[main daemon]
    └── ReactiveEvaluator handles event
        └── ActionDispatcher.composio_tool
            ├── Tier 1 try → fails
            └── spawn Tier-3 subagent in background  ────→ [subagent]
                  ↓                                            │
              return promise to dispatcher                     │
                  ↓                                            │
              dispatcher returns to ReactiveEvaluator          │
                  ↓                                            │
              main loop continues, serves other rules          │
                                                               │
              [eventually]                                     │
                  ↓ ←──── subagent returns result ─────────────┘
              rule fires final status: success/fail/asked-user
              voice update: "Sent." or "I need to ask you something."
```

**This mirrors Claude Code's Agent tool pattern** — fire-and-forget background work with notification on completion.

## 5. Component breakdown

### New files

```
src/daemon/connectors/composio/selfhealing/
├── discoveryRegistry.ts           # Tier 1 registry (hardcoded + extensible)
├── discoveryRegistry.seed.ts      # Initial seed: 50-100 toolkit entries
├── configInferenceEngine.ts       # Reads schema, identifies missing fields,
│                                  # orchestrates Tier 1/2/3 fill
├── discoveryCache.ts              # SQLite-backed persistence of discovered configs
├── pickerStrategy.ts              # Interface
├── voicePickerStrategy.ts         # Primary (depends on Phase E.1 voice)
├── inboxPickerStrategy.ts         # Fallback
├── nativeNotifPickerStrategy.ts   # Fallback
├── compositePickerStrategy.ts     # Chain orchestrator
├── subagentTypes.ts               # Type definitions
├── subagentSpawner.ts             # Generic subagent lifecycle manager
├── configSolverSubagent.ts        # Tier 3 for authoring
├── executionSolverSubagent.ts     # Tier 3 for action dispatch
├── mcpToolFilter.ts               # Builds scoped tool allowlist per toolkit
└── voiceProgressReporter.ts       # Streams subagent progress as voice updates
```

### Modified files

```
src/daemon/connectors/composio/composioClient.ts
  └── Adds executeToolWithFallback(args, fallbackEnabled = true)
      that wraps Tier 1 execute in try/catch and escalates to Tier 3 spawner

src/daemon/connectors/triggers/instanceManager.ts
  └── acquireForRule() now calls ConfigInferenceEngine to fill missing fields
      before triggers.create()

src/daemon/orders/v2/actionDispatcher.ts
  └── composio_tool branch uses executeToolWithFallback

src/daemon/orders/v2/author.ts
  └── After rule construction, hands triggerConfig to ConfigInferenceEngine
      for required-field fill
```

### Database schema additions

```sql
-- Persisted discoveries (so we don't ask again)
CREATE TABLE discovered_configs (
  toolkit TEXT NOT NULL,
  field TEXT NOT NULL,
  value TEXT NOT NULL,
  label TEXT,                    -- human label (e.g. "Ajgaoscw")
  discovered_at INTEGER NOT NULL,
  discovered_via TEXT NOT NULL,  -- 'registry' | 'picker' | 'mcp_fallback'
  rule_count INTEGER DEFAULT 0,  -- how many rules use this discovery
  PRIMARY KEY (toolkit, field, value)
);

-- Subagent execution log (observability)
CREATE TABLE subagent_runs (
  id TEXT PRIMARY KEY,           -- UUID
  kind TEXT NOT NULL,            -- subagent type
  toolkit TEXT NOT NULL,
  spawned_at INTEGER NOT NULL,
  completed_at INTEGER,
  status TEXT NOT NULL,          -- 'running' | 'success' | 'failed' | 'asked_human'
  tier_invoked_from INTEGER,     -- 1, 2, or 3 (recursive escalation tracking)
  result_summary TEXT,
  llm_tokens INTEGER,
  llm_cost_cents INTEGER,
  duration_ms INTEGER
);
```

## 6. Discovery registry seed (Tier 1 — initial coverage)

The registry maps `{toolkit}.{configField}` → discovery descriptor. Seeding ~50-100 toolkits at v0.7.0 launch covers the long tail.

### Registry entry shape

```typescript
type DiscoveryEntry = {
  toolkit: string                       // 'linear'
  field: string                         // 'team_id'
  listTool: string                      // 'LINEAR_LIST_LINEAR_TEAMS'
  resultPath: string                    // 'data.teams' — JSONPath to array
  idField: string                       // 'id'
  labelField: string                    // 'name' — for picker UI / voice
  filterArgs?: Record<string, unknown>  // optional, e.g. { active: true }
  multiSelectAllowed?: boolean          // for "watch all channels" patterns
}
```

### Initial seed (50+ entries)

```typescript
// Productivity
'linear.team_id': { listTool: 'LINEAR_LIST_LINEAR_TEAMS', resultPath: 'data.teams', idField: 'id', labelField: 'name' },
'notion.database_id': { listTool: 'NOTION_SEARCH_NOTION_PAGE', filterArgs: { filter: { value: 'database', property: 'object' } }, resultPath: 'data.results', idField: 'id', labelField: 'title' },
'asana.project_id': { listTool: 'ASANA_LIST_PROJECTS', resultPath: 'data.data', idField: 'gid', labelField: 'name' },
'trello.board_id': { listTool: 'TRELLO_LIST_BOARDS', resultPath: 'data', idField: 'id', labelField: 'name' },
'clickup.team_id': { listTool: 'CLICKUP_LIST_TEAMS', resultPath: 'data.teams', idField: 'id', labelField: 'name' },
'jira.project_key': { listTool: 'JIRA_LIST_PROJECTS', resultPath: 'data.values', idField: 'key', labelField: 'name' },
'monday.workspace_id': { listTool: 'MONDAY_LIST_WORKSPACES', resultPath: 'data.workspaces', idField: 'id', labelField: 'name' },
'airtable.base_id': { listTool: 'AIRTABLE_LIST_BASES', resultPath: 'data.bases', idField: 'id', labelField: 'name' },
'todoist.project_id': { listTool: 'TODOIST_LIST_PROJECTS', resultPath: 'data', idField: 'id', labelField: 'name' },
'basecamp.project_id': { listTool: 'BASECAMP_LIST_PROJECTS', resultPath: 'data', idField: 'id', labelField: 'name' },

// Communication
'slack.channel_id': { listTool: 'SLACK_LIST_CHANNELS', resultPath: 'data.channels', idField: 'id', labelField: 'name' },
'discord.channel_id': { listTool: 'DISCORD_LIST_CHANNELS', resultPath: 'data', idField: 'id', labelField: 'name' },
'discord.guild_id': { listTool: 'DISCORD_LIST_GUILDS', resultPath: 'data', idField: 'id', labelField: 'name' },
'microsoft_teams.team_id': { listTool: 'MICROSOFT_TEAMS_LIST_TEAMS', resultPath: 'data.value', idField: 'id', labelField: 'displayName' },
'microsoft_teams.channel_id': { listTool: 'MICROSOFT_TEAMS_LIST_CHANNELS', resultPath: 'data.value', idField: 'id', labelField: 'displayName' },
'google_chat.space_id': { listTool: 'GOOGLE_CHAT_LIST_SPACES', resultPath: 'data.spaces', idField: 'name', labelField: 'displayName' },
'telegram.chat_id': { listTool: 'TELEGRAM_LIST_CHATS', /* ... */ },
'mattermost.team_id': { /* ... */ },
'mattermost.channel_id': { /* ... */ },
'rocketchat.channel_id': { /* ... */ },
'zoom.user_id': { listTool: 'ZOOM_LIST_USERS', /* ... */ },

// CRM
'hubspot.pipeline_id': { listTool: 'HUBSPOT_LIST_PIPELINES', resultPath: 'data.results', idField: 'id', labelField: 'label' },
'hubspot.list_id': { listTool: 'HUBSPOT_LIST_LISTS', /* ... */ },
'salesforce.record_id': { listTool: 'SALESFORCE_LIST_RECORDS', /* ... */ },
'pipedrive.pipeline_id': { listTool: 'PIPEDRIVE_LIST_PIPELINES', /* ... */ },
'zoho_crm.module_id': { listTool: 'ZOHO_CRM_LIST_MODULES', /* ... */ },
'attio.list_id': { listTool: 'ATTIO_LIST_LISTS', /* ... */ },

// Code/DevOps
'github.repo': { listTool: 'GITHUB_LIST_REPOS_FOR_AUTHENTICATED_USER', resultPath: 'data', idField: 'full_name', labelField: 'full_name' },
'gitlab.project_id': { listTool: 'GITLAB_LIST_PROJECTS', resultPath: 'data', idField: 'id', labelField: 'path_with_namespace' },
'bitbucket.repo_slug': { listTool: 'BITBUCKET_LIST_REPOS', /* ... */ },
'circleci.project_slug': { listTool: 'CIRCLECI_LIST_PROJECTS', /* ... */ },

// File storage
'google_drive.folder_id': { listTool: 'GOOGLEDRIVE_LIST_FILES', filterArgs: { q: "mimeType='application/vnd.google-apps.folder'" }, resultPath: 'data.files', idField: 'id', labelField: 'name' },
'dropbox.folder_path': { listTool: 'DROPBOX_LIST_FOLDER', /* ... */ },
'box.folder_id': { listTool: 'BOX_LIST_FOLDERS', /* ... */ },
'onedrive.folder_id': { listTool: 'ONEDRIVE_LIST_FOLDERS', /* ... */ },

// Calendar/Email
'googlecalendar.calendar_id': { listTool: 'GOOGLECALENDAR_LIST_CALENDARS', resultPath: 'data.items', idField: 'id', labelField: 'summary' },
'outlook.calendar_id': { listTool: 'OUTLOOK_LIST_CALENDARS', /* ... */ },
'gmail.label_id': { listTool: 'GMAIL_LIST_LABELS', resultPath: 'data.labels', idField: 'id', labelField: 'name' },
'calendly.event_type_uuid': { listTool: 'CALENDLY_LIST_EVENT_TYPES', /* ... */ },

// Analytics/Monitoring
'mixpanel.project_id': { listTool: 'MIXPANEL_LIST_PROJECTS', /* ... */ },
'segment.workspace_id': { /* ... */ },
'amplitude.org_id': { /* ... */ },
'datadog.org_id': { /* ... */ },
'sentry.org_slug': { /* ... */ },
'pagerduty.service_id': { listTool: 'PAGERDUTY_LIST_SERVICES', /* ... */ },

// Email/marketing
'sendgrid.sender_id': { /* ... */ },
'mailchimp.list_id': { listTool: 'MAILCHIMP_LIST_LISTS', /* ... */ },
'klaviyo.list_id': { /* ... */ },

// Payment
'stripe.account_id': { listTool: 'STRIPE_LIST_ACCOUNTS', /* ... */ },
'paypal.account_id': { /* ... */ },

// Forms/surveys
'typeform.form_id': { listTool: 'TYPEFORM_LIST_FORMS', resultPath: 'data.items', idField: 'id', labelField: 'title' },
'google_forms.form_id': { /* ... */ },
'jotform.form_id': { /* ... */ },

// ... and so on, with research at implementation time
```

**Total: ~50-100 entries** covering the bulk of B2B SaaS scoping needs. Long tail handled by Tier 3.

### Registry format on disk

JSON file at `~/.kairos/composio-discovery-registry.json` (overridable). Loaded into memory at boot. User can extend manually without code changes. KAIROS Self-Modification (Phase H?) can extend programmatically.

## 7. ConfigInferenceEngine — the orchestrator

```typescript
interface ConfigInferenceEngine {
  /**
   * Fill missing required fields in a triggerConfig.
   * Returns enriched config, or throws if user denies / Tier 3 fails.
   */
  fillTriggerConfig(opts: {
    toolkit: string
    triggerSlug: string
    proposedConfig: Record<string, unknown>
    schema: any  // from TriggerSchemaCache
    rule_slug: string
    intent: string  // for voice/UI: "watching Linear for new issues"
  }): Promise<FillResult>
}

type FillResult = {
  config: Record<string, unknown>
  discoveries: Array<{
    field: string
    value: string
    label: string
    via: 'registry-cache' | 'registry-fresh' | 'picker' | 'mcp-fallback'
    latency_ms: number
  }>
  status: 'ready' | 'pending_user' | 'pending_subagent' | 'failed'
}
```

**Algorithm:**
```
for each required field in schema not present in proposedConfig:
  // T1.1 cache check
  cached = discoveryCache.get(toolkit, field)
  if cached and cached.value still valid: use cached, continue

  // T1.2 registry
  entry = discoveryRegistry.get(toolkit, field)
  if entry:
    results = await composio.executeTool(entry.listTool, ...)
    options = extractOptions(results, entry)
    if options.length == 1:
      fill, cache, continue                       // T1 done
    if options.length > 1:
      choice = await pickerStrategy.pick(...)     // T2
      fill, cache, continue
    if options.length == 0:
      escalate to T3                              // T3

  // T3 — no registry entry or T1/T2 didn't yield
  result = await subagentSpawner.spawn('config_discovery_solver', { toolkit, field, intent })
  if result.ok: fill, cache, mark via='mcp-fallback', continue
  else: raise FillFailed(field)
```

## 8. ExecutionSolver — Tier 3 for action dispatch

```typescript
interface ExecutionSolver {
  /**
   * Recover from a failed composio_tool dispatch by spawning a subagent
   * with the toolkit's MCP server.
   */
  solveAction(opts: {
    toolkit: string
    originalArgs: Record<string, unknown>
    originalIntent: string  // from rule.description
    error: string           // why direct execute failed
    rule_slug: string
  }): Promise<ExecutionResult>
}
```

**Subagent prompt (templated):**
```
You are a focused Composio execution recovery agent for the {toolkit} toolkit.

A standing-order rule tried to do this:
  Intent: "{originalIntent}"
  Attempted args: {originalArgs}

The direct execution failed with:
  {error}

Use the Composio MCP tools available to you to complete the original intent.
Common reasons for direct failure: wrong tool name, missing required arg,
attachment needs staging via files.upload first, schema drift.

Constraints:
- Do not invent data. If you need information (e.g. attachment file path),
  use the report_need_human tool.
- Try at most 3 different approaches before reporting failure.
- Voice updates: call voice_say('Working on it...') every 15s of work.

Return: success with result OR failure with reason.
```

## 9. SubagentSpawner — non-blocking lifecycle

```typescript
class SubagentSpawner {
  /** Spawn a subagent and return immediately with a tracking handle. */
  spawn(kind: SubagentKind, params: any): SubagentHandle

  /** Get current state of a spawned subagent. */
  status(handle: SubagentHandle): SubagentStatus

  /** Cancel (e.g. if user countermands). */
  cancel(handle: SubagentHandle): Promise<void>
}

type SubagentHandle = {
  id: string
  startedAt: number
  result: Promise<SubagentResult>
}
```

**Implementation:** Worker thread or detached async task. Main daemon's event loop is NOT blocked.

**Voice integration:** `VoiceProgressReporter` subscribes to subagent lifecycle events:
- spawned → "Working on that..."
- progress (every 15s) → silent unless user asks
- needs_human → "I need to ask you about X"
- completed → "Done." or "I couldn't do that — {reason}"

## 10. Failure modes & observability

### Failure scenarios

| Failure | Detection | Recovery |
|---|---|---|
| Registry tool slug deprecated by Composio | T1 errors → T3 takes over | Self-modification phase: subagent reports back, updates registry |
| User abandons picker | Pollers timeout after N min | Rule saved `state: 'pending_connection'` (same as connect flow) |
| Subagent loops forever | 30s no-progress watchdog | Forced terminate, escalate to inbox |
| Composio API down | Connection error on first call | Retry with backoff, escalate to inbox after 3 attempts |
| User revokes OAuth mid-execution | 401 from Composio | Cancel subagent, surface re-auth prompt via voice |
| MCP server returns nonsense | LLM cycles fruitlessly | Watchdog terminate, mark `failed` |

### Observability

- `subagent_runs` table: complete history, queryable for cost/latency analysis
- `kairos_status` MCP tool extended with subagent state
- `kairos_debug` MCP tool gains `inspect_subagent <id>` action
- Voice debrief on request: "How many MCP fallbacks today?" → "Three. All on Notion. The notion.database_id registry entry might be wrong."

## 11. Self-modification loop (longer term)

Once subagents have run for a few weeks:
- Top-N failures in registry are visible
- KAIROS spawns `discovery_registry_extender` subagent during idle time
- Subagent reads failed runs, finds patterns, proposes registry additions
- Proposed additions surface to user for approval (voice or inbox)
- Approved → registry updated
- Cycle continues — KAIROS gets better with use

**This is the Hermes Dreaming pattern (C.3.1) applied to Composio integration.**

## 12. Implementation phases

### Phase E.1 — Voice (precondition for E.2)
Out of scope here. See separate Phase E spec.

### Phase E.2.1 — Foundation (after voice ships)
- DiscoveryRegistry (interface + seed file with 20 toolkits)
- DiscoveryCache (SQLite)
- ConfigInferenceEngine (Tier 1 only)
- Integration with `TriggerInstanceManager.acquireForRule`
- Tests + live verify with Linear, Slack, GitHub, Notion

### Phase E.2.2 — User-mediated layer
- PickerStrategy interface
- VoicePickerStrategy (depends on E.1)
- InboxPickerStrategy + NativeNotifPickerStrategy (fallback chain)
- CompositePickerStrategy
- Live verify with multi-team account

### Phase E.2.3 — Tier 3 MCP fallback
- SubagentSpawner generic infra
- ConfigSolverSubagent
- ExecutionSolverSubagent
- ActionDispatcher wiring
- Voice progress reporting

### Phase E.2.4 — Registry expansion
- Seed registry to 50-100 toolkits
- Verify each entry against Composio's current catalog
- Smoke tests per toolkit

### Phase E.2.5 — Self-modification loop (optional, defer to Phase H)
- DiscoveryRegistryExtender subagent
- Dreaming-time registry updates
- User approval flow for proposed additions

## 13. Open questions to revisit at implementation time

1. **MCP session lifecycle.** Does Composio's MCP session persist across multiple tool calls within one subagent run, or do we create per-call? Affects latency.
2. **Voice while user is talking.** If a Tier 3 subagent finishes mid-conversation, does it interrupt? Probably should buffer to "I just finished X" after current turn.
3. **Cost budgeting.** What's the per-user-per-day LLM cost cap before throttling Tier 3?
4. **Registry seed validation.** Each registry entry needs verification against actual Composio API. We could either smoke-test all entries at boot OR validate-on-first-use. Latter is faster but defers errors.
5. **Picker fatigue.** If user has 50 Slack channels, voice listing all is awful. Need smart filtering ("the ones you're @mentioned in?" or LLM-summarized subsets).
6. **Subagent tool allowlist granularity.** Per-toolkit allowlist via Composio MCP `toolkits: [slug]` filter, or finer-grained?
7. **Multi-config inference.** If a rule needs BOTH `team_id` AND `member_id`, does the picker present them sequentially or together?

## 14. Success criteria (when Phase E.2 ships)

- Linear, Slack, GitHub, Notion, Asana, Jira, Trello, HubSpot all work end-to-end via voice with zero manual config lookup
- Registry covers top-50 toolkits
- MCP fallback handles top-100 toolkit long tail
- 95th percentile rule activation latency < 5s (Tier 1+2)
- 95th percentile Tier 3 rule activation latency < 60s
- Self-modification proposes ≥1 registry improvement per week of use
- No daemon-blocking subagent runs (main loop stays responsive)
- Voice is the primary surface; visual fallback < 5% of interactions

---

## Appendix A — Real-world example walkthrough

**User:** *"Notify me when someone creates a Linear issue."*

```
[T+0ms]    OrdersAuthor LLM generates rule:
           when: incoming_event { trigger: LINEAR_ISSUE_CREATED_TRIGGER }
           do:   notify { message: "New Linear issue: ${payload.title}" }
           (no triggerConfig — LLM didn't know team_id)

[T+50ms]   ConfigInferenceEngine reads schema, sees team_id required.
           T1.1: cache miss for linear.team_id.
           T1.2: registry has linear.team_id → calls LINEAR_LIST_LINEAR_TEAMS.

[T+450ms]  Result: 1 team ("Ajgaoscw"). Auto-fill triggerConfig.
           Cache: linear.team_id = 83c4c7bf-... (label: "Ajgaoscw").

[T+500ms]  TriggerInstanceManager.acquireForRule → triggers.create succeeds.
           Voice: "Watching Linear team Ajgaoscw for new issues."

Total: ~500ms. No user interaction.
```

**User (different account, multiple teams):** *"Notify me when someone creates a Linear issue."*

```
[T+0ms]    LLM generates rule (no config).
[T+50ms]   T1.2 registry call: LINEAR_LIST_LINEAR_TEAMS.
[T+450ms]  3 teams returned: Engineering, Marketing, Sales.
[T+500ms]  T2 picker: voice = "Which team — Engineering, Marketing, or Sales?"
[T+8s]     User: "Engineering."
[T+8.1s]   Auto-fill, cache, activate.
           Voice: "Watching Engineering team for new issues."

Total: ~8s.
```

**User (obscure toolkit not in registry):** *"Tell me when a Tana node is created."*

```
[T+0ms]    LLM generates rule using TANA_NODE_CREATED.
[T+50ms]   ConfigInferenceEngine: schema requires workspace_id.
           T1.2: registry has no tana.workspace_id entry.
[T+100ms]  Escalate to T3: spawn config_discovery_solver subagent.
           Voice (ambient): "Hang on, getting the Tana setup right..."
[T+5s]     Subagent: Composio MCP for Tana. Finds TANA_LIST_WORKSPACES.
           One workspace found.
[T+12s]    Returns workspace_id. ConfigInferenceEngine caches.
           Bonus: subagent proposes DiscoveryRegistry entry for review.
           Voice: "Watching Tana workspace for new nodes. (I learned a new
           toolkit — Tana's now in my regular flow.)"

Total: ~12s. KAIROS self-improved.
```

---

## Appendix B — Inspiration & references

- **OpenClaw** (https://github.com/openclaw/openclaw): multi-agent config with per-agent tool allowlists. The `llm-task` plugin pattern (extensions/llm-task) is the architectural model for KAIROS subagents.
- **Claude Code's Agent tool**: fire-and-forget subagent spawning with notification on completion. Same pattern for KAIROS's subagent lifecycle.
- **Composio's `triggers.subscribe`** SDK source: how Composio internally normalizes events (v0.5.1 work). Tier 3 builds on the same MCP plumbing.
- **Hermes Dreaming (KAIROS C.3.1)**: idle-time self-improvement loop. Self-modification of the discovery registry is the natural extension.

## Appendix C — Scope NOT in Phase E.2

Explicit non-goals to avoid scope creep:
- Real-time webhook receiver for KAIROS Cloud (Phase F)
- Tool execution caching / memoization for cost reduction
- Cross-toolkit composition (e.g. "if X then Y in different toolkit")
- Visual canvas for picker UX (voice-first by design)
- Multi-tenant subagent isolation
- Recurring registry refresh from Composio's catalog API
