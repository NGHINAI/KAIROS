# KAIROS

An always-on autonomous AI assistant for macOS. KAIROS is a Bun/TypeScript
daemon that runs in the background, watches your environment (focused app,
browser tabs, clipboard, files, calendar), maintains long-term memory, talks
to you out loud (push-to-talk voice with barge-in), executes real actions
through Composio-connected services (Gmail, Calendar, Slack, ...), and learns
its own reusable skills from recurring work. It is voice-first and
configuration-by-conversation: there is no dashboard — KAIROS modifies itself
through its own in-process `/v1/*` wrap-API.

## Current status

- **Version:** `v0.6.0-alpha` (tagged at Phase E.1, 2026-05-29). Phase E.2
  (dynamic agent loop + subagents) is built and gated on branch
  `phase-e2-core`, plus June 2026 work: durable conversation memory + replay,
  activity recall, spoken-output sanitization, live voice-session fixes.
- **Note:** the `version` field in `package.json` (`0.1.0-phase0`) is stale
  metadata; `CHANGELOG.md` and git tags are the source of truth.
- ~831 tests passing at the v0.6.0-alpha gate (202 `*.test.ts` files under
  `src/` today, more added since). Phase gates: `scripts/validate-phase-*.ts`.

## Features

- **Voice** — global push-to-talk hotkey, STT (SFSpeechRecognizer / Whisper /
  Deepgram), TTS (macOS `say` stage-0, AVSpeech sidecar, OpenAI/Deepgram),
  Silero-VAD barge-in that aborts the agent mid-action, streaming
  speak-while-acting narration.
- **Agent loop** — Conductor classifies each utterance and routes fast-path
  (one-shot reply) or smart-path (Planner + tool-running agent loop with
  Narrator filler speech), with grounded verification of claims against tool
  results, context caching, and background agents for long work.
- **Proactivity** — perception observers feed a trigger engine and standing
  orders ("Orders v2": parse → compile → run rules); a restraint pipeline
  (scoring, karma, rate limits, focus detection, digests) decides if/when to
  interrupt you.
- **Memory** — SQLite working/episodic/semantic/procedural stores with vector
  recall, realtime fact extraction, periodic "dream" consolidation into a
  human-readable `state/MEMORY.md`, conversation replay, activity recall.
- **Connectors** — Composio OAuth integrations with live trigger ingestion
  (Pusher), dynamic tool discovery, and self-healing reconnection; plus an
  MCP host that can install and call external MCP servers (Smithery catalog).
- **LLM routing** — providers for Anthropic API, Anthropic CLI (`claude -p`,
  uses your subscription), Codex CLI, OpenAI, Gemini, OpenRouter. Haiku for
  tick decisions, Sonnet for work/dreams; agent loop tiers default to
  gpt-4o-mini (fast) / gpt-4o (smart) / kimi-k2-thinking (deep).
- **Safety** — destructive ops (`git push`, `npm publish`, ...) are blocked by
  a PreToolUse hook and an in-loop approval gate until explicitly approved;
  hourly cost/subprocess/message budgets in `config.json`.

## Quick start

```bash
bun install            # dependencies
bun run build          # compile daemon binary into bin/
bun run daemon         # run from source (--sandbox --verbose)
bun run daemon:bin     # run the compiled binary
bun run inspect        # peek at runtime state (DB, inbox, tasks)
bun run version        # print version info
bun run nuke           # wipe state/ runtime/ bin/ (keeps source)
```

Voice (needs `KAIROS_ANTHROPIC_KEY` or provider keys in `.env`):

```bash
bun scripts/voice-demo.ts   # end-to-end audible demo (stage-0 `say` TTS)
bun scripts/voice-repl.ts   # text-in / voice-out REPL
bash scripts/voice-hud.sh   # daemon + Swift HUD
```

## Project layout

```
kairos-sandbox/
├── src/
│   ├── daemon/         # the brain: tick loop, agents/, voice/, wrapApi/,
│   │                   #   llm/, memory/, perception/, proactive/, restraint/,
│   │                   #   agency/, orders/, connectors/, onboarding/, skills/, mcp/
│   ├── cli/            # `kairos` terminal CLI (HTTP to daemon)
│   ├── shim/           # stdio MCP server exposing KAIROS to Claude Code
│   ├── prompts/        # system / tick / dream prompts
│   └── templates/      # voice variation pools
├── apps/
│   ├── electron/       # Electron + React shell (alpha, wiring in progress)
│   └── macos/          # KairosHUD, KairosVoiceHelper (audio sidecar),
│                       #   KairosSpeechHelper (minimal STT/TTS for Electron)
├── hooks/              # Claude Code hooks: push-guard.sh, inject-inbox.sh, status-line.sh
├── connectors/         # local connectors (macos-reminders)
├── skills/active/      # crystallized skills KAIROS wrote for itself
├── scripts/            # build, demos, smoke tests, validate-phase-*.ts gates
├── docs/               # design notes; superpowers/{plans,specs} = phase plans & designs
├── growth/             # launch / growth playbooks
├── state/              # runtime state (SQLite DB, MEMORY.md, inbox, logs) — gitignored
├── runtime/            # ephemeral (pid, port, ready flag, prompt dumps) — gitignored
├── traj/               # agent trajectory logs
└── config.json         # runtime knobs (see below)
```

## Configuration

`config.json` (hot-editable, no rebuild):

| Section  | Knobs (defaults) |
|----------|------------------|
| `tick`   | `defaultIntervalMs` 120000, `minSleepMs` 60000, `maxSleepMs` 600000 |
| `budget` | `maxSubprocessPerHour` 60, `maxProactiveMsgsPerHour` 10, `maxCostCentsPerHour` 500 |
| `task`   | `maxConcurrent` 1, `timeoutMs` 600000 |
| `models` | `tick` claude-haiku-4-5, `work`/`dream` claude-sonnet-4-6 |
| `dream`  | `minIntervalMinutes` 5, `minCandidates` 3 |

Key environment variables (`cp .env.example .env`; `.env` is gitignored):

- `COMPOSIO_API_KEY` — enables connectors; `KAIROS_COMPOSIO_ENABLED`,
  `KAIROS_COMPOSIO_POLL_MS` to tune.
- `KAIROS_MODE` — `byo` (Claude/Codex CLI subscriptions, default), `hosted`
  (cheap APIs), `local` (Ollama).
- `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` / `KIMI_API_KEY`,
  plus `KAIROS_ANTHROPIC_KEY` (embedded pre-Cloud key for voice).
- `KAIROS_VOICE_BACKEND` — `say` (stage-0) or `sidecar` (Swift helper);
  `KAIROS_VOICE_NAME`, `KAIROS_VOICE_RATE`.
- Agent-loop model overrides: `KAIROS_FAST_MODEL`, `KAIROS_SMART_MODEL`,
  `KAIROS_DEEP_MODEL`, `KAIROS_VISION_MODEL`, `KAIROS_VERIFY_MODEL`
  (grounding verifier, default gpt-4o). `KAIROS_DAEMON_PORT` — wrap-API port
  (default 9876).

## Testing

```bash
bun test                            # full suite
bun test src/daemon/agents          # one subtree
bun scripts/validate-phase-e2.ts    # latest phase gate (also e1, d, c*, b)
bun scripts/smoke-all-llm.ts        # provider smoke tests (needs keys)
```

Two `fs.watch` flakes are known and pre-existing.

## Troubleshooting

- **`bun: command not found`** — `curl -fsSL https://bun.sh/install | bash`, then reopen the terminal.
- **Daemon won't start** — check `state/logs/daemon.log`; a stale `runtime/daemon.pid` is the usual cause (`bun run nuke` resets).
- **Port conflicts** — legacy daemon HTTP defaults to 8765; the wrap-API to 9876 (`KAIROS_DAEMON_PORT`).
- **No audio** — start with `KAIROS_VOICE_BACKEND=say` (no Xcode needed); the Swift sidecar needs `xcodebuild` + TCC mic/speech permissions (see `apps/macos/KairosVoiceHelper/BUILD.md`).
- **Composio actions fail** — verify `COMPOSIO_API_KEY` and check `kairos status` / `/v1/composio/connections` for pending OAuth.

## Roadmap

Next: the **Proactive Chief of Staff** —
`docs/superpowers/specs/2026-06-08-proactive-chief-of-staff-roadmap.md`
(Concern Engine, You-Policy behavioral memory, three learning loops).
Per-phase plans and designs live in `docs/superpowers/plans/` and
`docs/superpowers/specs/`; history in `CHANGELOG.md`.

## License

Personal project. Not affiliated with Anthropic.
