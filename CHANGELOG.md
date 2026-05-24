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
