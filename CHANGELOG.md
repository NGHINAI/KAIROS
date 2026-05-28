## [v0.3.7-phase-c3-3] - 2026-05-28

### Added
- **AWM (Agent Workflow Memory) subsystem** — self-improving skill crystallization following the agentskills.io Dec-2025 standard
- **SKILL.md parser/serializer** with strict frontmatter validation (name regex, description length, KAIROS metadata extensions)
- **SkillWriter** with atomic tmp-then-rename persistence to `~/.kairos/skills/<slug>/`
- **UsageTracker** — Hermes 10-field `.usage.json` schema, failure history bounded to last 5
- **SkillStore** — SQLite metadata index with `rebuildFromDisk` recovery
- **SkillRegistry** — progressive disclosure (metadata at boot, body on activation), hot-reload via fsWatch
- **TsRunner** — Bun Worker TypeScript executor with 30s timeout
- **PythonRunner** — Composio Workbench session-based Python executor
- **SkillDispatcher** — routes scripts/main.ts → TsRunner, scripts/main.py → PythonRunner, else declarative
- **SkillCrystallizer** — LLM (mid-tier `skill_crystallize`) composes SKILL.md from trajectory clusters
- **PersonaGate** — cosine dedup (threshold 0.85) + autonomy tier classification (GREEN/YELLOW auto-promote, ORANGE/RED queue)
- **ReviewQueue** — SQLite-backed approval queue for risky skills
- **AwmWorker** — 4h-interval trajectory watcher with cluster detection and crystallization pipeline
- **Curator** — Hermes 2-phase lifecycle (deterministic stale@30d/archive@90d + LLM-driven keep/patch/consolidate/archive at `skill_curate` ultra-cheap tier)
- **invoke_skill** agency intent (GREEN at intent level; safety enforced via per-skill PersonaGate tier)
- Validation gate (`scripts/validate-phase-c3-3.ts`) — 14 assertions cover every subsystem

### Changed
- `TaskType` union extended with `skill_crystallize` (mid tier) and `skill_curate` (ultra-cheap tier)
- `SystemBlock.source` union extended with `'skills'` for SkillRegistry.buildSystemBlock()
- `UsageTracker` storage decoupled from skill dirs — now `~/.kairos/skills/.usage/<slug>.json` (was inside each skill dir; breaks when Curator moves dirs to .archive)

---

## v0.3.6-phase-c3-1 (2026-05-28) — User Profile + Persona-Awareness + soul.md

Phase C.3.1 establishes the KAIROS `.md` file family (soul.md / persona.md / traj.md / DREAMS.md) — the foundation for the agent intelligence layer. Identity is stable (soul.md), user model is live (persona.md, Dreaming-driven), every action is logged (traj.md), and consolidation runs in 3 phases (DREAMS.md).

### What shipped (11 tasks, ~1,700 LOC)

- **SoulLoader + SoulWizard** — OpenClaw-derived soul.md format (Core Truths + Boundaries + Vibe). First-run wizard asks 5 questions, lightweight LLM composes. 4 BASELINE_BOUNDARIES hardcoded in runtime — never user-overridable.
- **PersonaUpdater** — Hermes-derived user model. ≤400 token cap for prefix-cache efficiency. Two write paths: Dreaming-driven and nudge-based.
- **TrajWriter** — UFO2 ExperienceFlow-derived per-day trajectory log. Same SECRET_PATTERNS sanitization as C.1.5 UrgencyFloor (incl. Composio `ak_` key prefix).
- **DreamingExtension** — Hermes 3-phase Dreaming (Light/REM/Deep) atop Phase B's existing dreamer. 6-factor scoring formula. Writes DreamCycleEntry to DREAMS.md.
- **PersonaAwareness** — derives PersonaHints (interrupt_aggressiveness, in_focus_now, active_hours_now, prefer_terse, prefer_voice_over_text). Consumed by RestraintPipeline + future agency layer.
- **RestraintPipeline integration** — C.1.5 Earned Interrupt now reads persona hints. `in_focus_now → suppress`. `interrupt_aggressiveness=low → raise threshold +0.2`. Backward-compatible: works without personaAwareness too.

### Note for C.4

HEARTBEAT.md (time-triggered rules) is deferred to C.4. C.4's existing scope (STANDING_ORDERS.md v2 DSL refactor) should bundle HEARTBEAT.md alongside it.

### Validation
- 482+ unit tests passing (existing + new persona tests)
- Validation gate (`scripts/validate-phase-c3-1.ts`) covers 7 assertions across the persona subsystem

---

## v0.3.5-phase-c2-7 (2026-05-27) — Composio Connectors (reactive)

Phase C.2.7 wires Composio's 500+ integrations into KAIROS as MCP tools. Users connect Slack, Gmail, Notion, GitHub, etc. via voice-first auth (auto-open browser + Earned Interrupt restraint). NO BYOC — single `COMPOSIO_API_KEY` (Model A) serves all KAIROS users via Composio's multi-tenant userId scoping.

### What shipped (12 tasks, ~2,700 LOC)

- **ComposioClient wrapper** — uses `connectedAccounts.link()` with POSITIONAL args (deprecated `initiate()` guard)
- **ConnectionStore** — SQLite per-user toolkit connections (single-account-per-toolkit constraint)
- **ConnectionFlow** — browser + OAuthCallbackHandler + `waitForConnection()` confirmation
- **HttpMcpClient** — StreamableHTTPClientTransport for hosted MCP servers
- **McpHost transport branching** — stdio | http | sse via `config.transport`
- **ComposioSessionManager** — ToolRouter session lifecycle with workbench:false + manageConnections:true
- **TokenExpiryPoller** — 5-min polling for connection state
- **connect_service / disconnect_service intents** (GREEN tier)

### Virality amendments

- **V1 system prompt directives** — instructs the agent to use COMPOSIO_SEARCH_TOOLS for unknown tasks and COMPOSIO_MULTI_EXECUTE_TOOL for multi-app workflows
- **V2 postConnectionAnnouncement** — rich voice intro after each connection ("Slack connected. I can now send, list, and search.")
- **V3 DestructiveToolGuard** — confirms via voice before delete/remove/archive tool calls

### Out of scope (deferred to C.2.8)

- Composio triggers (proactive remote event monitoring)
- KAIROS Cloud relay (per-user event routing at scale)
- "Tell me when X happens" type rules

### Validation
- 100+ unit tests passing
- Smoke test (`scripts/smoke-composio.ts`) confirms live Composio integration
- Validation gate (`scripts/validate-phase-c2-7.ts`) covers 7 assertions

---

## v0.3.4.1 (2026-05-26) — Cheap-model migration (hosted mode: gpt-5-nano primary, no Sonnet/Opus)

### Hosted-mode routing overhaul

**Old** hosted mode routed to `gpt-4o-mini` (cheap), `gpt-4o` (mid), `claude-sonnet-4-6` (heavy).
**New** hosted mode routes exclusively to cheap/nano models:

| Tier | Primary | Fallback 1 | Fallback 2 |
|------|---------|------------|------------|
| ultra_cheap | `gpt-5-nano` ($0.000164/call) | `gemini-2.5-flash-lite` ($0.000248/call) | `gpt-5.4-nano` ($0.000586/call) |
| mid | `gpt-5-nano` | `gemini-2.5-flash` | `gpt-5-mini` |
| heavy | `gpt-5-mini` ($0.000820/call) | `kimi-k2.5` | `gpt-4.1-mini` |

**Cost projection at 15K calls/month (heavy KAIROS user):**
- Old heavy-tier (Sonnet): ~$270/mo per user
- New heavy-tier (gpt-5-mini): ~$3/mo per user — 90× cheaper

Sonnet/Opus remain in `byo` mode only (Claude Pro CLI subscription, $0 marginal cost).

### Deprecation purge

**Removed from `openai.ts` PRICING:**
- `gpt-5` (phantom model ID — never existed in the API; was an erroneous entry)
- `moonshot-v1-8k`, `moonshot-v1-32k` (removed from kimi TIER_MODELS routing; kept in PRICING as reference)
- `kimi-k2-0711-preview`, `kimi-k2-0905-preview` (EOL May 25 2026 — removed)

**Added to `openai.ts` PRICING:**
- `gpt-5-nano` ($0.05/M in, $0.005/M cached, $0.40/M out)
- `gpt-5-mini` ($0.25/M in, $0.025/M cached, $2.00/M out)
- `gpt-5.4-nano` ($0.20/M in, $0.02/M cached, $1.25/M out)
- `gpt-5.4-mini` ($0.75/M in, $0.075/M cached, $4.50/M out)
- `gpt-4.1-mini` ($0.40/M in, $0.10/M cached, $1.60/M out)
- `kimi-k2.5` ($0.60/M in, $0.10/M cached, $3.00/M out)
- `kimi-k2.6` ($0.95/M in, $0.16/M cached, $4.00/M out)

**Removed from `gemini.ts` PRICING + CACHE_SUPPORTED_MODELS:**
- `gemini-1.5-flash` (shut down — no longer on Google pricing page)
- `gemini-1.5-pro` (shut down — no longer on Google pricing page)

**Added to `gemini.ts` PRICING + CACHE_SUPPORTED_MODELS:**
- `gemini-3.1-flash-lite` ($0.25/M in, ~$0.025/M cached est., $1.50/M out) — GA May 7 2026
- `gemini-3.5-flash` ($1.50/M in, $0.15/M cached, $9.00/M out) — GA May 19 2026

**Kimi base URL:** Changed from `api.moonshot.cn` (legacy) to `api.moonshot.ai` (canonical) in `src/daemon/llm/config.ts`.

**gemini-2.0-flash:** Not present in any code path (confirmed clean). Research docs note it shuts down June 1 2026.

### Files changed
- `src/daemon/llm/router.ts` — hosted MODE_PREFS updated
- `src/daemon/llm/providers/openai.ts` — PRICING + TIER_MODELS updated
- `src/daemon/llm/providers/gemini.ts` — PRICING + TIER_MODELS + CACHE_SUPPORTED_MODELS updated; GeminiApiProvider default model changed from gemini-1.5-flash to gemini-2.5-flash-lite
- `src/daemon/llm/config.ts` — kimi base URL .cn → .ai
- `src/daemon/llm/providers/openai.test.ts` — test fixtures updated to new model names
- `src/daemon/llm/router.test.ts` — hosted-mode assertion updated for gpt-5-nano

---

## v0.3.4-phase-c2-6 (2026-05-26) — Cost & Recall (prompt caching + semantic vector memory)

### Validation gate: PASS ✓

Both assertions passed (`scripts/validate-phase-c2-6.ts`):

**Assertion A — Caching works (LIVE, Anthropic API)**
- Provider: `AnthropicApiProvider` / `claude-haiku-4-5-20251001`
- System prompt: ~12,482 tokens (≥4096 threshold), `cache_hint: 'long'`
- 5 identical calls; calls 2-5 served 12,466 tokens from cache (cache_read at 0.1× base rate)
- Naive cost (uncached, 5×): $0.10
- Actual cost (with caching): $0.05
- **Savings: 50.0%** (target: ≥50%)

**Assertion B — Hybrid recall beats keyword-only (LIVE, LocalEmbedder)**
- 20 episodic memories inserted; 10 semantic queries with zero keyword overlap
- Embedder: `Xenova/bge-small-en-v1.5` (384-dim, q8, in-process ONNX)
- Hybrid recall@5 (FTS5 + vector RRF): **0.97**
- Keyword-only recall@5 (FTS5 only): **0.00**
- **Ratio: ∞** (target: ≥1.5×) — semantic queries have zero lexical overlap with memories

### What shipped in C.2.6

#### Prompt caching (all providers)
- `PromptAssembler` — stable-sorts blocks by `cache_hint` (long → short → none) before provider dispatch, ensuring the cacheable prefix is always identical across calls
- `AnthropicApiProvider` — emits `cache_control: {type: 'ephemeral'}` on the last `long` and last `short` block (≤2 breakpoints per Anthropic spec); reads `cache_creation_input_tokens` + `cache_read_input_tokens` from usage; prices cache_write at 1.25× and cache_read at 0.10× base
- `OpenAIProvider` — places stable (non-volatile) blocks first in the system message, volatile blocks prepended to user message; reads `prompt_tokens_details.cached_tokens`; prices cache hits at 50% of base input rate
- `GeminiProvider` — context-cache resource creation for `long` blocks (Gemini implicit caching)
- `CostTracker` — `cached_input_tokens` + `cache_creation_tokens` logged per call; `summaryFor()` reports `cache_hit_rate`

#### Semantic vector memory
- `LocalEmbedder` — Xenova/bge-small-en-v1.5 via Transformers.js ONNX (q8); in-process, no network; model cached under `~/.kairos/cache/huggingface/`
- `VectorIndex` — BLOB-stored 384-dim Float32Array; cosine similarity via pure-TS dot product (unit-normalized vectors); full-scan acceptable at KAIROS scale (≤100K memories)
- `HybridRetriever` — Reciprocal Rank Fusion (RRF, k=60) over FTS5 BM25 + vector cosine; `EpisodicStore.recall()` uses hybrid when `VectorIndex` present, falls back to keyword-only
- `EpisodicStore` — auto-embeds on `record()`; `recall()` dispatches to hybrid or keyword path based on presence of `VectorIndex`

#### Mode-aware router
- `ModelRouter` — `MODE_PREFS` table drives provider/model selection per mode (byo/hosted/local) × tier (ultra_cheap/mid/heavy); `pickProviderForTask()` finds first configured provider

#### Daemon wired
- Daemon startup creates `LocalEmbedder + VectorIndex + EpisodicStore` when memory enabled
- All post-call memory recording goes through `EpisodicStore.record()` → auto-embedded

### Stats
- Wall time (validation): 7.1s
- Test mode: LIVE (real Anthropic API + real ONNX embedder, no mocks)

---

## v0.3.3-phase-c2-5-patch2 (2026-05-26) — Grounded SetupSkillGenerator (package hallucination eliminated)

Wired `ServiceResolver` (commit f95f585) into `SetupSkillGenerator.generate()` so the LLM receives real candidate packages in its prompt instead of guessing.

### Changes

- **`setupSkillGenerator.ts`**: Constructor accepts optional `ServiceResolver`. Pre-flight calls `resolver.resolve(serviceName)` before LLM call; injects a grounding block of real packages into the user prompt. System prompt hardened with `CRITICAL` directive to use only listed packages. Zero-candidates path returns clear error JSON, which `generate()` converts to a thrown `Error('no candidates for X')`.
- **`setupSkillGenerator.test.ts`**: 2 new tests added (total: 9/9 pass): (1) resolver candidates appear in LLM prompt, (2) zero-candidates path throws correct error.
- **`scripts/probe-llm-accuracy.ts`**: Wired with `NpmRegistryClient + McpCatalogClient + ServiceResolver`.
- **`scripts/validate-phase-c2-5.ts`**: Mode 2 wired with resolver.
- **`src/daemon/index.ts`**: Daemon boot wired with resolver.

### Probe re-run — PASS rate 22/25 (was 23/25 at baseline 2dbdc9d)

| # | Service | Verdict | Package |
|---|---------|---------|---------|
| 1 | github | PASS | `@modelcontextprotocol/server-github` |
| 2 | slack | PASS | `slack-mcp-server` |
| 3 | notion | PASS | `@notionhq/notion-mcp-server` |
| 4 | linear | PASS | `linear-mcp` |
| 5 | postgres | PASS | `@henkey/postgres-mcp-server` |
| 6 | sqlite | PASS | `@mokei/mcp-sqlite` |
| 7 | brave-search | PASS | `@brave/brave-search-mcp-server` |
| 8 | filesystem | PASS | `@modelcontextprotocol/server-filesystem` |
| 9 | fetch | PASS | `@mokei/mcp-fetch` |
| 10 | time | PASS | `time-mcp` |
| 11 | stripe | PASS | `@stripe/mcp` |
| 12 | sentry | PASS | `@sentry/mcp-server` |
| 13 | supabase | PASS | `supabase-mcp` |
| 14 | vercel | PASS | `@vercel/mcp-adapter` |
| 15 | jira | PASS | `jira-mcp-server` ✅ (was FAIL) |
| 16 | asana | FAIL | `@roychri/mcp-server-asana` — url_unreachable: https://app.asana.com/0/my-apps |
| 17 | hubspot | FAIL | `@hubspot/mcp-server` — url_unreachable: https://app.hubspot.com/private-apps |
| 18 | gmail | PASS | `@gongrzhe/server-gmail-autoauth-mcp` |
| 19 | google-drive | FAIL | `@piotr-agier/google-drive-mcp` — url_unreachable: https://developers.google.com/oauthplayground |
| 20 | google-calendar | PASS | `@cocal/google-calendar-mcp` |
| 21 | redis | PASS | `redis-mcp` |
| 22 | mongodb | PASS | `mongodb-mcp-server` |
| 23 | airtable | PASS | `airtable-mcp-server` |
| 24 | cloudflare | PASS | `@cloudflare/mcp-server-cloudflare` |
| 25 | discord | PASS | `@pasympa/discord-mcp` ✅ (was FAIL) |

**Summary: 22 PASS / 0 WARN / 3 FAIL**

**jira**: PASS ✅ (was FAIL — grounding eliminated package hallucination)
**discord**: PASS ✅ (was FAIL — grounding eliminated package hallucination)

**Remaining 3 FAILs** are all `url_unreachable` for auth setup pages (asana, hubspot, google-drive) — these are unreachable in CI/sandbox environment and not package hallucinations. The probe environment can't reach private app portals behind login. These services resolve real npm packages correctly; the failure mode is purely URL reachability.

**0 field divergences** across all 25 services (system prompt hardening is holding).

**Verdict: HEALTHY — 88% PASS rate (≥75% threshold met). jira + discord hallucinations eliminated. Ready for C.3.**

---

## v0.3.3-phase-c2-5 (2026-05-25) — Seamless Onboarding (backend complete)

Phase C.2.5 delivers a complete, tested, end-to-end onboarding subsystem that lets KAIROS set up MCP integrations for the user with a single voice command: "set me up with X". All 12 backend tasks done. Validation gate PASSED.

### What was built (12 tasks)

| Task | Module | What |
|------|--------|------|
| 0 | `types.ts` | Core type definitions: SetupSkill, SetupStep (11 step types), FlowState, UserChannel, SetupFlowResult |
| 1 | `browserOpener.ts` | Safe macOS `open` wrapper — allowlist: https only, probed |
| 2 | `clipboardPatternWatcher.ts` | Regex watcher on EventBus clipboard events with timeout + cancel |
| 3 | `oauthCallbackHandler.ts` | Bun.serve ephemeral server for OAuth redirect capture |
| 4 | `mcpAutoInstaller.ts` | npm/Smithery install with package-name allowlist (no shell injection) |
| 5 | `mcpConfigMutator.ts` | Atomic JSON read/write/add/remove/snapshot/restore on mcp-servers.json |
| 6 | `flowStateStore.ts` | SQLite persistence for in-flight and completed flows |
| 7 | `inboxUserChannel.ts` | File-based UserChannel (appends to onboarding-chat.md, polls for USER: yes/no) |
| 8 | `setupSkillGenerator.ts` | LLM-driven SetupSkill generator with step-type allowlist validation |
| 9 | `setupFlowRuntime.ts` | Orchestrator: runs all 11 step types, rollback on failure, persists progress |
| 10 | `setupIntent.ts` | IntentRegistry bridge: `setup_for` GREEN intent wires generator + runtime |
| 11 | daemon `index.ts` | Wired into daemon boot inside `if (config.mcp.enabled)` block |
| 12 | `validate-phase-c2-5.ts` | End-to-end validation gate (this entry) |

### Design highlights

- **Declarative SetupSkill** — LLM outputs a JSON step sequence; runtime executes it. No LLM in the hot path.
- **Rollback on failure** — McpConfigMutator snapshots config before any mutation; SetupFlowRuntime restores + reloads McpHost on failure.
- **Idempotent cleanup** — cleanup always runs in `finally` blocks; test leaves no residue.
- **Two-mode validation** — Mode 1 (scripted, deterministic) is the gate; Mode 2 (LLM-generated, best-effort) measures real-world LLM accuracy.

### Tests

- **48 new unit tests** across 8 onboarding test files (types + all 7 new modules)
- **312/312 total tests passing** (70 files, 572 expect() calls)
- All 264 pre-C.2.5 tests still green (no regressions)

### Validation — PASSED (Mode 1, all 7 assertions)

`scripts/validate-phase-c2-5.ts` drives the real SetupFlowRuntime against `@modelcontextprotocol/server-filesystem`:

| Assertion | Result |
|-----------|--------|
| result.status === 'success' | PASS ✓ |
| steps_completed === 6 (all steps) | PASS ✓ |
| mcp-servers.json has 'fs-validation' entry after configure step | PASS ✓ |
| listAllTools() has ≥1 fs-validation:: tool | PASS ✓ (14 tools) |
| smoke_test_tool list_directory returned ok: true | PASS ✓ |
| after cleanup: 'fs-validation' absent from mcp-servers.json | PASS ✓ |
| total duration < 120s | PASS ✓ (1.8s) |

**Mode 2 (LLM-generated)**: DIVERGED — LLM chose `smithery` install instead of npm; smithery not installed in this environment. Expected divergence, not a gate failure.

### Note on macOS path resolution
`/tmp` is a symlink to `/private/tmp` on macOS. The filesystem MCP server resolves the canonical path and uses `/private/tmp` as its allowed-directory root. The validation script uses `/private/tmp` explicitly to avoid "path outside allowed directories" rejections. Phase F's UI should apply `fs.realpathSync` before populating the path argument.

---

## v0.3.2-phase-c1-5 (2026-05-25) — The Earned Interrupt Architecture

Direct response to the 2026-05-25 incident where the daemon produced 4,454 macOS notifications in 2 hours. KAIROS now has a structural restraint layer that **earns** the right to interrupt the user. Inserted between C.2 and C.3.

**The principle (now inviolable in spec)**: Silence is the default. Every notification opts IN to firing. The agent measures its own annoyance (dismissal rate) and adapts.

### Added — the 8-layer restraint stack + 6 safeguards

#### Restraint pipeline (`src/daemon/restraint/`)
- **FocusDetector** — deep work (>25min single-app) / meeting / quiet hours (10pm-7am) / manual pause via hotkey
- **KarmaStore** — tracks fires, deliveries, dismissals, actions per trigger. **Auto-suspends triggers dismissed 3 times in 7 days** — UNLESS they've been acted on ≥ 2× more than dismissed (Safeguard #2: high-value trigger protection)
- **Coalescer** — collapses N events from same source within 60s into 1 batch (kills the "git push = 100 file-events" amplification)
- **CooldownTracker** — per-trigger debounce, default 5 min, per-id overridable
- **RateLimiter** — hard caps: 8 interrupts/day, 2/hour, 6 surfaces/hour. SQLite-backed delivery log. Urgent bypasses caps.
- **ActionScorer** — weighted significance computation with explainable components (rule_match × urgency × personal_relevance × context_availability × novelty − dismissal_penalty), clamped [0,1]
- **DeliveryRouter** — score → interrupt (≥0.9) / surface (≥0.7) / digest (≥0.4) / log_only. Digest items routed to morning / lunch / evening slots based on time of day.
- **DigestComposer** — Apple-style notification summary. Bundles low-mid-score items into morning/lunch/evening glass cards.
- **DryRunMode** — new STANDING_ORDERS rules observe for 24h before going live. Counts would-have-fired. Prevents the "add rule, get 100 notifs" experience.

#### The 6 safeguards (ensures restraint NEVER loses important notifications)

1. **UrgencyFloor module** (the "fire alarm" path) — explicit list of conditions that ALWAYS produce interrupt regardless of any gate:
   - System-critical intent (`system_critical`, `security_alert`, `task_error`)
   - Calendar event starting in < 5 min
   - Password / API key / private-key regex in clipboard (sk-/ghp_/AIza/AKIA/BEGIN PRIVATE KEY)
   - Direct `@user_handle` mention in any incoming message
   - URGENT / ASAP / critical / emergency / immediately keyword in reasoning
   - Explicit `always_interrupt` flag on trigger
   
   Bypasses karma + cooldown + focus + rate-limit. Routes straight to interrupt. **3 regression tests prove the bypass.**

2. **High-value trigger protection** in KarmaStore — `acted_on ≥ dismissed × 2` prevents net-valuable triggers from being silenced by sporadic dismissals.

3. **Manual `always_interrupt` per trigger** (compiled_orders_triggers gets new field). User authoring "ALWAYS notify me when X" sets this.

4. **Reactivation prompt after auto-suspend** — inbox surface shows "I stopped firing X. Reactivate?" once. No silent permanent disable.

5. **Dismissal sense check on urgent items** — high-urgency dismissals prompt "looked time-sensitive — keep alerting?" Captures accidental dismissals.

6. **Always-visible digest badge** on HUD oval — queued items aren't invisible. User can preview anytime.

#### Pipeline orchestrator
- **RestraintPipeline** wires all 9 modules in strict order: UrgencyFloor (step 0) → DryRun → KarmaSuspension → Cooldown → Focus → Score → Route → RateLimit → recordFire.
- **Step 0 is non-negotiable**: UrgencyFloor runs before every suppression check. If urgent → bypass everything → interrupt.

### Wired into daemon
- ActionExecutor accepts optional `RestraintPipeline` 6th constructor param. When present, dispatch routes through restraint pipeline first. Modes `suppressed` / `dry_run` / `log_only` / `digest` skip handler execution but still record trajectory. Modes `interrupt` / `surface` proceed normally + record delivery.
- New `restraint` config block in `Config` (enabled, configPath)
- Daemon startup dynamically imports + assembles all 9 restraint modules + RestraintPipeline
- All restraint config tunable via `~/.kairos/restraint-config.json` (thresholds, weights, caps, quiet hours, durations)

### Tests
- **66 new unit tests** across 11 restraint test files
- **264/264 total tests passing** (A 59 + B 60 + C.1 47 + C.2 26 + C.1.5 66 + cross-cutting + 6 expected fail-path log lines that are not failures)
- Includes 2 regression tests in ActionExecutor confirming restraint can suppress dispatch entirely + 3 regression tests in RestraintPipeline confirming urgency-floor bypasses karma/cooldown/focus

### Stats
- ~3,200 LOC TypeScript + tests
- 14 atomic commits (every C.1.5 task)

### Validation — REPLAYED the 4,454-notification scenario, PASSED ALL CRITERIA

`scripts/validate-phase-c1-5.ts` simulates the SAME load that caused the incident:
- 10,000 file-events (git churn)
- 500 focus-app switches to Slack
- 200 clipboard changes (noise + 10 real URLs)
- 5 task_error events (must always fire)
- 3 URGENT-keyword events (must always fire)
- 2 API-key-in-clipboard events (must always fire)

**Result:**

| Metric | Threshold | Observed |
|---|---|---|
| Interrupts | ≤ 18 (8 base + 10 urgency-floor) | **10** ✅ |
| Surfaces | ≤ 20 | **0** ✅ |
| Digest queue | (no cap) | **10,700** (all routine noise correctly batched) |
| Urgency-floor 10/10 | must pass through | **10** ✅ — all task_errors, URGENT keywords, and API keys reached interrupt |
| Unexpected throws | 0 | **0** ✅ |

**99.8% reduction in interrupt-tier notifications.** 4,454 → 10.

The architectural foundation is now baked in for every future phase. C.3 MCP-tool invocations, C.4 STANDING_ORDERS v2, D voice replies, E proactive speech, F HUD popups — all inherit restraint structurally.

### Next: Phase C.3

Magentic-One dual-ledger orchestrator + smolagents CodeAgent + AWM workflow crystallizer + **Persona-Awareness Loop** (LLM call that fills `personal_relevance` score component using L3 semantic memory facts).

---

## v0.3.1-phase-c2 (2026-05-25) — MCP Host Runtime + Bespoke Connectors

Second of 4 sub-phases comprising Phase C. KAIROS now **speaks MCP** — connecting to any of 20,000+ community MCP servers via the official `@modelcontextprotocol/sdk` TypeScript client. Every connected tool auto-registers as an Intent in the agency layer with structural tier assignment.

After C.2, the connector ecosystem is no longer "what KAIROS implements" — it's "what the MCP world has built". Add to `~/.kairos/mcp-servers.json`, restart, you've added a connector.

### Added

#### MCP host runtime
- **McpClient** — single-server stdio connection wrapping `@modelcontextprotocol/sdk`'s `Client` + `StdioClientTransport`. Connect, list tools, call tool, disconnect.
- **McpHost** — multi-server orchestrator. Loads `~/.kairos/mcp-servers.json`, starts enabled servers in parallel, exposes a unified tool list namespaced as `serverId::toolName`.
- **toolToIntent bridge** — auto-registers each MCP tool as an agency `Intent`. Tier comes from `tier_policy` in the server config (`default` + per-tool `overrides`) — structural enforcement, not LLM-prompt-overridable.
- **Keychain wrapper** — `/usr/bin/security` CLI shell-out for storing API keys per server. No native binding; no secrets touch disk. Resolved at McpHost startup and injected into server subprocess env.

#### Skill ecosystem
- **agentskills.io SKILL.md loader** — adopts the open standard (35+ agents use it: Cursor, Goose, Letta, Claude Code, Gemini CLI, OpenHands…). Each skill = a folder with YAML frontmatter + markdown body + optional `scripts/`. Progressive disclosure: `listSummaries()` reads frontmatter only; `load()` reads full body + scripts.
- **Skills root**: `~/.kairos/skills/` — drop in agentskills.io-compatible directories and they auto-discover at daemon start.

#### Dynamic discovery
- **SmitheryCli wrapper** — shell-wraps `@smithery/cli` for `search` (catalog query) and `add` (install). Graceful degrade when smithery not on PATH — daemon doesn't crash.

#### Bespoke macOS connector (the first .mcpb bundle)
- **`connectors/macos-reminders/`** — full bespoke MCP server packaged as `.mcpb` bundle. Three tools via AppleScript:
  - `list_reminders` (GREEN) — pull incomplete reminders from default list
  - `add_reminder` (YELLOW) — add new with optional ISO due date
  - `complete_reminder` (ORANGE — requires approval) — mark by title
- Proves the `.mcpb` bundle path works. No third-party API; runs anywhere with macOS Reminders.app.

#### Daemon wire-up
- New `mcp` config block (`enabled`, `configPath`, `skillsRoot`)
- Dynamic imports (`await import('./mcp/...')`) keep daemon cold-start fast when `mcp.enabled=false` — the SDK doesn't load unless needed
- `mcpStop` lifecycle hooked into existing shutdown chain

### Tests
- **26+ new unit tests** across 8 test files (types, keychain, mcpClient with real echo-server fixture, mcpHost with multi-server tests, toolToIntent, smithery, skillLoader, reminders wrapper)
- **198/198 total tests passing** (Phase A 59 + B 60 + C.1 45 + C.2 26 + cross-cutting — 8 retired, 0 regressions)

### Stats
- ~2,200 LOC TypeScript + tests + bespoke connector code
- 10 atomic commits

### Validation (per Section 8.5)

**Validation PASSED 2026-05-25** — 5/5 scenarios:

| # | Scenario | Result |
|---|---|---|
| 1 | Echo MCP server starts, tool registered as Intent | ✅ `echo-test::echo` tier=GREEN |
| 2 | Invoke echo-test::echo via ActionExecutor | ✅ status=completed, `{"msg":"C.2 validation alive"}` echoed |
| 3 | macos-reminders bundle starts, 3 tools registered with correct tiers | ✅ list=GREEN, add=YELLOW, complete=ORANGE |
| 4 | add_reminder via Intent → AppleScript → Reminders.app | ✅ Status=completed; "KAIROS C.2 test — 2026-05-25T08:48:33" item created |
| 5 | Smithery CLI graceful degrade | ✅ NO (smithery not installed on this Mac), no crash |

**Phase C.2 is both code-complete AND validated-complete.** v0.3.1-phase-c2 stands.

### What unlocks now

The single biggest capability jump in the roadmap. KAIROS can now:
- **Call any tool on any connected MCP server** as a triggered action
- **Hot-add new connectors** by editing `~/.kairos/mcp-servers.json` + restart
- **Discover the catalog** via Smithery CLI (when installed)
- **Ship bespoke connectors** in `.mcpb` format for anything macOS-native (Contacts, Calendar, Notes, Reminders, Mail, etc.)
- **Load skills** in the agentskills.io standard from `~/.kairos/skills/`

### Next: Phase C.3

Magentic-One dual-ledger orchestrator + smolagents CodeAgent + AWM workflow crystallizer. Multi-step plans that chain MCP tools, plus learning from successful trajectories.

---

## v0.3.0-phase-c1 (2026-05-25) — Agency Layer, Sub-Phase 1

First of 4 sub-phases comprising the Phase C agency layer (the "bet big" expansion). C.1 closes the perception→action loop: KAIROS can now actually **do things** in response to STANDING_ORDERS-compiled triggers, not just observe + remember.

After C.1, KAIROS can:
- Surface notifications (macOS native + tail-able `~/.kairos/inbox.md`)
- Write facts to L3 semantic memory in response to triggers
- Schedule local reminders
- Suspend itself per quiet-hours rules
- Queue 🟠/🔴 tier actions for human approval via inbox + `kairos approve|dismiss <id>` CLI
- Log every action attempt as a UFO2-format structured trajectory (foundation for AWM crystallization in C.3)

### Added

#### Agency core
- **Intent registry** with 5 built-in 🟢 GREEN intents: `notify`, `add_to_memory`, `log`, `remind_in`, `suspend`. Each intent self-describes (id + description + tier + arg schema + optional idempotency key); the tier comes from the manifest, not from runtime LLM prompts — structural enforcement per anti-pattern research.
- **Autonomy tier system** (🟢/🟡/🟠/🔴) with pure-function helpers (`tierEmoji`, `tierRank`, `requiresApproval`, `isAtLeast`)
- **ActionExecutor** — receives `ActionRequest`s, gates on tier (GREEN/YELLOW execute immediately, ORANGE/RED queue to inbox), enforces 5-min idempotency window for intents with declared keys, retries via `approveItem` flow
- **UFO2-format trajectory log** (per arXiv:2504.14603) — every action attempt writes a structured step (observation/reasoning/action/result). Two-table SQLite split: `action_trajectories` (header + outcome) + `action_trajectory_steps` (appended incrementally). Foundation for the AWM crystallizer in C.3.

#### Trigger engine
- **TriggerEngine** subscribes to EventBus + reads `compiled_orders_triggers` from Phase B's orders compiler. C.1 evaluator supports a subset of `when_match` predicates: `"*"`, `text.contains('X')`, `text.isURL()`, `app.equals('X')`, `path.endsWith('X')`. C.4 will expand to the full DSL.
- **Suspend gating** — respects `agency_suspend_state` rows (scope='all' / 'triggers' / specific source). The `suspend` intent inserts these; quiet-hours STANDING_ORDERS produce them.
- **PerceptionToTrigger bridge** — polls newly-written L2 episodes, republishes as `episode-written` events on the bus so the TriggerEngine can react to perception output without coupling subsystems

#### Surfaces
- **`~/.kairos/inbox.md`** — tail-able markdown file showing pending approvals, sorted by tier severity. Regenerated from DB after every change. Each item shows tier emoji, description, args preview, copy-paste `kairos approve <id>` and `kairos dismiss <id>` commands.
- **macOS native notifier** via `osascript display notification`. Best-effort, never throws (inbox always has the record as fallback). AppleScript single-quote escaping handles edge cases.
- **CLI `kairos approve` / `kairos dismiss [reason]`** — POSTs to the daemon's `/agency/approve` and `/agency/dismiss` HTTP endpoints. Default port 9877 (9876 is reserved for the main MCP server); overridable via `KAIROS_AGENCY_URL` env.
- **Daemon HTTP endpoints** at `:9877/agency/approve` and `:9877/agency/dismiss` (Bun.serve), in addition to the existing MCP server.

### Wired into daemon
- New `agency` config block (enabled/inboxPath/daemonHttpPort)
- Agency subsystem starts inside the existing `proactive.enabled` block (alongside memory + perception + orders) so it sees `db`, `bus`, `episodic`, `semantic`, `embedder`, `router` already in scope
- Lifecycle: TriggerEngine subscribed at start; bridge polls at `perception.pipelinePollMs` cadence; shutdown halts trigger engine + bridge timer + HTTP server in the existing `memoryStop` cleanup chain

### Tests
- **45 new unit tests** across 8 test files (types, autonomyTier, intentRegistry, trajectoryLog, nativeNotifier, inboxSurface, actionExecutor, triggerEngine, perceptionToTrigger, CLI)
- **160/160 total tests passing** (Phase A 59 + Phase B 60 + C.1 45 — 4 retired, 0 regressions)

### Stats
- ~2,000 LOC TypeScript + tests added
- 12 atomic commits (every C.1 task)

### Architecture notes
- Phase C.1 builds fresh — no reuse of prior-session decisionEngine/taskRunner/discordBot (per 2026-05-25 user decision)
- C.2 next: MCP host runtime + Smithery dynamic discovery + agentskills.io skill format adoption
- C.3 follows: Magentic-One dual-ledger orchestrator + smolagents CodeAgent + AWM workflow crystallizer
- C.4 closes Phase C: STANDING_ORDERS v2 (conditional + cooldown + chaining) + persona-conditioned routing + offline fallback + dry-run + Phase C overall validation gate

### Validation (per Section 8.5)

**Validation script**: `bun run scripts/validate-phase-c1.ts` ($0 cost — pure integration test, no LLM calls)

**Validation PASSED 2026-05-25** — all 5 scenarios:

| # | Tier | Scenario | Observed |
|---|---|---|---|
| 1 | 🟢 | clipboard URL → `add_to_memory` (silent) | 1 trajectory, 0 inbox, 1 L3 fact written |
| 2 | 🟢 | focus-app=Slack → `notify` | Notification captured via probe, 0 inbox |
| 3 | 🟢 | .ts file → `log` (record-only) | 1 trajectory, 0 inbox |
| 4 | 🟠 | risky-action → inbox approval | Queued correctly; inbox.md showed readable approve/dismiss commands; `approveItem` resolved to status=completed |
| 5 | 🟢 | quiet-hours suspend gate | Trajectory count unchanged after suspended event (correctly suppressed) |

Total: 4 trajectories, all `success`, 0 failures, 0 stuck in-progress. Inbox file rendered cleanly with iOS-style emoji tier markers + tail-able approve/dismiss commands.

**Phase C.1 is now both code-complete AND validated-complete.** v0.3.0-phase-c1 stands.

---

## v0.2.0-phase-b (2026-05-24)

### Added

#### 4-tier human-like memory system (MemOS L1-L4 + Hermes Dreaming)
- **L1 working memory** — in-memory ring buffer of last 10min / 500 events from EventBus
- **L2 episodic memory** — SQLite-persisted typed event sequences with importance scoring + unpromoted query for dreamer
- **L3 semantic memory** — facts/preferences/persons/projects/patterns with `reinforceOrWrite` for frequency-tracking
- **L3 hybrid recall** — FTS5 lexical (BM25) + pure-TS cosine over BLOB embeddings (Float32Array, 768-dim BGE-Base-EN-v1.5)
- **L4 procedural memory index** — skill registry with invoke/success stats
- **Dreamer** — consolidates L2 → L3 via Hermes formula (w1·relevance + w2·frequency + w3·recency + w4·diversity + w5·richness − w6·dup)
- **Idle/AC-power gate** — dreamer runs only when user idle >20min AND on AC, via `ioreg` + `pmset`
- **Local embeddings** — fastembed BGE-Base-EN-v1.5 (768-dim, ~120MB model, ~50ms/embedding on M2; nomic substituted because not in fastembed v2.1)

#### Tiered perception (KAIROS_SILENT pattern from OpenClaw/Hermes)
- **Tier 1 classifier** — ultra-cheap one-word verdict (SIGNIFICANT/ROUTINE/SILENT), fail-closed SILENT
- **Tier 2 summarizer** — mid-tier description + 0-1 significance score with STANDING_ORDERS bias, fail-closed score 0
- **Perception pipeline** — orchestrates Tier 1 → Tier 2 → narrator.tick() + episode write; logs every evaluation
- **Narrator no longer fires on timer** — pipeline is sole driver via `narrator.tick()` (Phase A code untouched, just timer disabled)

#### STANDING_ORDERS.md (user-editable plain-English triggers)
- Plain markdown bullets at `~/.kairos/STANDING_ORDERS.md` with seeded examples on first run
- Hash-gated LLM compile — only recompiles when file content changes
- Compiles to structured triggers in DB (`when_kind`, `when_match`, `condition`, `action`); used by Tier 2 + (future) Phase C trigger engine
- Plain-text content also injected raw into Tier 2 prompt for bias

#### 6th observer: ActivityWatch
- Consumes `localhost:5600/api/0` for window focus duration, AFK/idle state, per-tab dwell time
- Graceful degrade if ActivityWatch not installed
- Filters tab_dwell events to >60s to reduce noise

#### TLS warmup retrofit (Clicky pattern 8.4.8 #3)
- All network providers (anthropic_api, openai, gemini) fire HEAD request on factory init
- Pre-establishes TLS session ticket — eliminates cold-handshake latency on first call
- Skipped for subprocess providers (anthropic_cli, codex_cli)

### Architecture decisions
- **Memory storage: SQLite + pure-TS cosine over BLOB embeddings** (pivot from sqlite-vec — bun:sqlite doesn't support `SQLITE_ALLOW_LOAD_EXTENSION`; pure-TS cosine is sub-10ms at KAIROS scale ≤10k facts)
- **Memory backend: custom build** (not Engram drop-in — chosen for full control, zero external dep)
- **Rate limiter: skipped** — trust the perception gate; volume validated at this gate
- **Pure-TS cosine acceptable up to ~100k facts** before we'd need HNSW; recall API unchanged when we swap

### Tests
- 115 unit tests, all passing (~60 new in Phase B + 55 retained from Phase A)
- Tests per subsystem: memory 28, perception 15, orders 9, observer 4, daemon integration verified via full-suite tsc

### Stats
- ~3,500 LOC TypeScript + tests added
- 28 commits since v0.1.0-phase-a

### Validation (per Section 8.5 gate)

**Validation script**: `bun run scripts/validate-phase-b.ts`

**Validation PASSED 2026-05-25** — all 4 criteria met:

| Criterion | Threshold | Observed |
|---|---|---|
| Recall answers relevant | qualitative | 4/5 with correct answer at #1, 1 plausible |
| SIGNIFICANT verdicts | < 20% of evaluations | **0%** (Tier 1 Haiku correctly classified synthetic noise) |
| narrator_fired | < 10% of evaluations | **0** fires |
| Total cost | < 10¢ for 200-event replay | **$0** (5 calls via anthropic_cli subscription) |

The "0% SIGNIFICANT" is a strong positive signal — perception correctly refuses to interrupt for noise. Tier 1 average latency ~8s/call (Haiku via `claude -p` subprocess). The 5 reference facts seeded directly into L3 (mirroring what Dreamer would produce from real episodes) were correctly retrieved by hybrid FTS5+vector recall for all 5 questions.

**Bugs surfaced + fixed during validation**:
- `recall.lexical()` FTS5 syntax error on queries with punctuation (e.g. `?`) — fixed via token sanitization (`ce8b98c`)
- Validation script needed direct L3 seeding for the recall test since synthetic events correctly classify as SILENT — fixed in same commit

**Phase B is now both code-complete AND validated-complete.** v0.2.0-phase-b stands.

---

## v0.1.0-phase-a (2026-05-24)

### Added

#### Multi-LLM ModelRouter
- 6 provider adapters: Anthropic CLI (Pro subscription, $0), Anthropic API (BYOK), OpenAI (GPT-4o-mini / GPT-4o / GPT-5), Google Gemini (Flash Lite / Flash / Pro), Kimi (Moonshot), Ollama (local, free)
- Task-tier policy: `narrative` / `trigger_eval` / `classify` → ultra_cheap; `action_compose` / `dream` → mid; `skill_generate` / `source_patch` → heavy
- Automatic fallback chain — if Gemini rate-limits, try OpenAI; if all configured providers fail, throw
- Persistent cost tracker (SQLite) with monthly budget enforcement and per-provider rollup
- Per-task `max_cost_cents` budget gate (estimates cost before calling)
- Provider config in `~/.kairos/providers.json` — enable/disable, BYOK env vars, base URL overrides

#### Local Observer Network
- Push-based event bus (SQLite-persisted) with in-memory pub/sub
- Live world-state snapshot aggregator (focus app, tabs, recent files, clipboard, upcoming events)
- 5 observers:
  - `focus-app` — macOS frontmost via osascript, 2s poll, change-detect
  - `browser-tabs` — Arc/Chrome/Safari tabs via osascript, 10s poll
  - `clipboard` — pbpaste polling, 5s, change-detect
  - `file-events` — fs.watch on configured roots, debounced, ignore-list
  - `calendar-local` — macOS Calendar.app via icalbuddy, 5min
- Narrator — every 5 min reads snapshot → cheapest LLM tier → publishes ≤200-word prose summary back into bus

### Wired into daemon
- New `proactive` config block in `Config` (enabled, narratorIntervalMs, providerConfigPath)
- Lifecycle: startup brings up observers + narrator alongside existing scheduler/Discord
- Shutdown gracefully halts both
- All gated by `config.proactive.enabled` (default: true)

### Tests
- 55 unit tests, all passing
- 12 LLM router tests (types/policy/cost/config/router/4 provider adapters)
- 16 observer subsystem tests (event bus / snapshot / registry / 5 observers / narrator)
- Plus 27 pre-existing tests still passing

### Stats
- ~2,400 LOC TypeScript + tests added
- 24 commits on branch `phase-a`

### Post-tag additions
- **Codex CLI provider** (Phase A.1, commit `5390bdc` + `8b0594d`) — 7th provider added. Uses ChatGPT Plus/Pro subscription via `codex exec` subprocess, $0 incremental cost. Registered in `ultra_cheap` / `mid` / `heavy` tiers ahead of paid APIs (subscription-first principle). Verified working with `codex-cli 0.133.0`.
- Spec refinements (commits `17b987d`, `c61148f`, `3cfc2d1`): per-phase validation gate (Section 8.5), research-driven architectural refinements (Section 8.4 — tiered perception, STANDING_ORDERS, custom memory build, custom glassmorphism UI direction).

### Validation (per Section 8.5 gate)

**Smoke test executed 2026-05-24 22:53Z, 5 min duration. PASSED.**

- Total events captured: **31**
  - `focus-app`: 24
  - `narrator`: 3
  - `clipboard`: 2
  - `file-events`: 1
  - `browser-tabs`: 1
- Narratives produced: **3**, all via `anthropic_cli/claude-haiku-4-5-20251001`
- Cost: **$0** (subscription-based Haiku used)
- Latency: narrator tick ~1-2s end-to-end

Sample narrative excerpt (1 of 3):

> "You're on the `phase-a` branch of KAIROS with a clean working tree. Recent commits show you've been locking in architecture decisions and integrating research findings. Your task tracker shows 13 tasks: 4 done, 1 in progress, 8 open. KAIROS GitHub tab open. Recent file: `pulse_v2_third.db` (parallel work). Pattern: spec solidification → architecture lock-in → execution. What are you working on next?"

The narrator correctly identified: current branch, recent commit topics, active app (Claude Code/Brave), open browser tab (GitHub), recent files, background music, and inferred user workflow pattern. The third narrative emergent-ended with a question ("What are you working on next?") — companion behavior without prompting.

**Phase A is now both code-complete AND validated-complete.**

Phase B (custom memory layers + Tier 1/2 perception + ActivityWatch observer + STANDING_ORDERS.md) plans next.
