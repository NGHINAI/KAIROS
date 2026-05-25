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

To be run by user. Replays 200 synthetic events through the full pipeline, runs the Dreamer, asks 5 recall questions, prints perception-volume + cost breakdown.

PASS criteria:
- Recall answers are roughly relevant to the questions
- SIGNIFICANT verdicts < 20% of evaluations (gate is working)
- narrator_fired < 10% of evaluations (effectively rate-limited as intended)
- Total cost < 10¢ for the 200-event replay

Phase B tag is provisional until user runs the validation script and updates this changelog with observed numbers.

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
