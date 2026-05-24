# KAIROS Sandbox

An always-on autonomous AI assistant that runs alongside Claude Code and uses
your Claude Pro subscription via `claude -p` subprocess.

> **Current status**: Phase 0 (skeleton & build pipeline). Not yet functional —
> the daemon starts and exits, nothing more.
> See [BUILD_PLAN](#build-plan-9-phases) below for what's coming.

## What is KAIROS?

KAIROS is the leaked name of Anthropic's internal "always-on assistant" mode for
Claude Code. This project is a from-scratch reimplementation of that idea, built
to run alongside your Claude Code installation as an MCP server.

It's a separate background process that:

- Wakes up every minute or so to decide if it should do anything
- Has the same tools Claude Code has (because it spawns `claude -p` subprocesses
  to do work — no separate API key, uses your subscription)
- Maintains persistent memory across sessions via `MEMORY.md`
- Periodically "dreams" to consolidate raw observations into long-term memory
- Has its own voice (witty, slightly theatrical, never corporate)
- Refuses to run `git push`, `npm publish`, `gh pr merge`, etc. without explicit
  approval (PreToolUse hook)
- Cleanly shuts down when the last Claude Code session closes

The full design lives in `~/Desktop/kairos-design.md`.

## Architecture (one paragraph)

A Bun TypeScript daemon spawns `claude -p` subprocesses to do thinking and
working. It exposes itself to Claude Code as a stdio MCP server with 7 tools
(`assign`, `tell`, `status`, `inbox`, `approve`, `history`, `cancel`). It runs
a tick loop that wakes every 60-300 seconds to decide whether to SLEEP, WORK,
INVESTIGATE, NOTIFY, or CONSOLIDATE — with cost controlled by spam/subprocess
budgets, safety guaranteed by a PreToolUse hook that blocks pushes/publishes,
memory built from a SQLite raw log distilled into a 200-line MEMORY.md via
periodic dream consolidations, and personality enforced by a system prompt +
voice guide + template variation pools.

## Build plan (9 phases)

| Phase | Capability | Status |
|-------|-----------|--------|
| **0** | Build pipeline + skeleton | ⏳ in progress |
| **1** | DB + HTTP server + lifecycle | pending |
| **2** | MCP shim | pending |
| **3** | Tick scheduler (mock decisions) | pending |
| **4** | Real Haiku decisions (KAIROS thinks) | pending |
| **5** | Task execution (KAIROS acts) | pending |
| **6** | Push-protection hooks (KAIROS is safe) | pending |
| **7** | Memory + dreams (KAIROS remembers) | pending |
| **8** | Personality polish (KAIROS has voice) | pending |

Each phase has a validation gate. See `~/Desktop/kairos-design.md` Section 7
for the gates and what to test after each phase.

## Quick start (Phase 0 — skeleton only)

```bash
# Install dependencies
bun install

# Build the daemon binary
bun run build

# Run via source (no compile)
bun run daemon

# Or run the compiled binary
bun run daemon:bin
```

Phase 0 just prints version info and exits. Phase 1 will add the real daemon.

## Sandbox safety

This whole project lives in `~/Desktop/kairos-sandbox/` and writes nothing
outside it. Specifically:

- **Source**: `src/`, `hooks/`, `scripts/`, `package.json`, etc.
- **Runtime state**: `state/` (SQLite DB, MEMORY.md, inboxes, logs)
- **Ephemeral**: `runtime/` (port file, PID file, ready flag)
- **Binaries**: `bin/` (compiled by `bun run build`)

To wipe everything except source code:
```bash
bun run nuke
```

To completely remove KAIROS from your machine:
```bash
rm -rf ~/Desktop/kairos-sandbox
```

Nothing in `~/.kairos/` or `~/.claude/` is touched until you explicitly graduate
the sandbox to a real install (Phase 8+ — see design doc Section 7).

## Project layout

```
kairos-sandbox/
├── README.md                  ← you are here
├── package.json               ← Bun deps + npm scripts
├── tsconfig.json              ← TypeScript config
├── .gitignore                 ← excludes state/, runtime/, bin/
│
├── src/
│   ├── daemon/                ← the KAIROS brain (TypeScript)
│   ├── shim/                  ← the MCP bridge (TypeScript, added Phase 2)
│   ├── prompts/               ← system prompt + tick prompt + dream prompt
│   └── templates/             ← voice variation pools (JSON)
│
├── hooks/                     ← bash scripts that run inside Claude Code
│   └── lib/                   ← shared bash utilities
│
├── scripts/                   ← build, nuke, inspect helpers
├── bin/                       ← compiled binaries (gitignored)
├── state/                     ← runtime state (gitignored)
└── runtime/                   ← ephemeral lock files (gitignored)
```

## Troubleshooting

**`bun: command not found`** — Install Bun: `curl -fsSL https://bun.sh/install | bash`,
then either open a new terminal or `source ~/.zshrc`.

**Build fails** — Make sure you ran `bun install` first. If TypeScript errors
appear, check that `@types/bun` is in `node_modules/`.

**Daemon won't start in Phase 1+** — Check `state/logs/daemon.log` for errors.
Common cause: stale `runtime/daemon.pid` from a previous run. Run `bun run nuke`
to wipe and retry.

## License

Personal project. Not affiliated with Anthropic.
