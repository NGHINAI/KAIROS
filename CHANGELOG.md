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

Phase A is complete. Phase B (memory layers) starts next.
