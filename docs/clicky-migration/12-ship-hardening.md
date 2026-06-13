# 12 — Ship hardening (the gaps the completeness critic flagged)

These are not "nice to have" — they're the difference between "works on my Mac"
and "vendor codex like a real product" (the user's words). Four items.

## A. Code-signing / notarization of the vendored runtime (SHIP BLOCKER)

We bundle a ~171–193MB third-party Mach-O (`codex`) + `rg` per arch inside
`Contents/Resources/` (01 §5, 10 §7). On a shipped, notarized `.app` this trips
Gatekeeper unless handled:

- **Codesign every vendored binary** with our Developer ID, deep, at build
  time: `codesign --force --options runtime --timestamp --sign "<Dev ID>"
  codex rg`. They must be signed BEFORE the outer `.app` is signed/notarized.
- **Hardened Runtime + the right exceptions.** `Bun.spawn`-ing a separately
  signed binary under Hardened Runtime needs either matching team-id or the
  `com.apple.security.cs.disable-library-validation` entitlement (codex loads
  its own dylibs). Prefer signing with OUR team id over disabling library
  validation; fall back to the entitlement only if codex ships unsigned dylibs.
- **Notarization** of the whole bundle must include the nested binaries
  (`--deep` or per-binary submission); staple the ticket.
- **Quarantine**: dropped/updated binaries (Sparkle auto-update path) must not
  carry `com.apple.quarantine` for the spawned child — strip on install.
- **Decision needed (07):** ship the binaries inside the app bundle (HeyClicky's
  choice — reliable, +340MB universal) vs a first-run signed download (smaller
  app, fragile, needs integrity check). Lean: bundle, single-arch per build.

## B. Warm-child + MCP-server lifecycle (orphan reaping)

01 covers spawn + stale-exit guard + per-request timeouts, but NOT teardown.
A 193MB `codex app-server` child orphaned on every daemon restart is a real
leak — and MEMORY already warns "don't restart the daemon during user testing."

- **On daemon shutdown** (SIGINT/SIGTERM/`beforeExit`): send the child
  `turn/interrupt` for any in-flight turn, then `thread`-close, then
  `child.kill()`, then await exit with a 2s hard-kill fallback. Tear down the
  `/mcp` route with the daemon's `Bun.serve` (same process — see C/port note).
- **On daemon (re)start**: detect a prior orphan by pidfile
  (`state/codex/app-server.pid`) and reap it before spawning a fresh child;
  never adopt an orphan (its CODEX_HOME state may be mid-write).
- **In-flight turns across restart are LOST by design** — the conductor already
  treats a superseded/aborted turn as a quiet abort (no phantom agent_done);
  a restarted daemon emits `agent_interrupted` for any turn that was live.
- **Crash of the child mid-turn**: the protocol adapter surfaces a transport
  error → conductor hedges (our existing "I hit a problem, try again") and the
  watchdog respawns the child for the next turn. Mirror the HUD's
  connection-generation guard so a stale child's late event can't drive a new
  turn.
- **Double-send guard on respawn (14 §C12).** A child crash AFTER a destructive
  write already executed, followed by a watchdog respawn that retries the turn, can
  double-send. The outbound idempotency key on `execute_tool` —
  `hash(conversationId, turnId, toolName, args)` (08 §F) — is the defense-in-depth
  that covers this respawn path (and the verifier-retry / daemon-restart paths): a
  re-issued identical write returns the first result instead of hitting the
  Composio API twice. The respawn MUST carry the same `conversationId`/`turnId` so
  the key matches; the per-turn idempotency memo is reconstructed from the Codex
  ledger on respawn so an already-succeeded irreversible call is NOT re-triggered.

## C. Unattended / proactive security posture (DECISION, not an open question)

openclicky spawns codex with `sandbox_mode="danger-full-access"` +
`approval_policy="never"`. We do NOT inherit that default (14 §B6/§B7, both HIGH).
`danger-full-access` is wrong even for interactive turns, and a minimal spawn env
is required so the agent never sees the daemon's provider keys.

Two reasons full-access can't be the default:
- **Provider-key leak via inherited env (14 §B6).** Spawning codex with
  `{...process.env}` hands the agent the daemon's keys (OpenRouter, Composio, etc.),
  defeating the whole proxy-hiding premise. We MUST spawn with an EXPLICIT minimal
  allowlisted env — only `KAIROS_BRAIN_KEY` (the per-install proxy token),
  `KAIROS_MCP_TOKEN`, `CODEX_HOME`, `PATH` (the vendored-runtime dir), and `HOME`.
  **Never spread `process.env`.**
- **The restrained unattended subset can't be enforced at the MCP tool-filter layer
  alone (14 §B7).** Codex's native shell bypasses the MCP tool list, so the SANDBOX
  itself must be the boundary, not just the advertised tools.

Posture (DECISION, not an open question):
- **Default sandbox = `workspace-write`** with network egress restricted to the
  proxy host — for BOTH interactive and unattended turns. `danger-full-access` is
  available ONLY behind an explicit, interactive opt-in (never on the proactive
  path, never as a silent default). This is what makes the restrained subset
  enforceable.
- **Spawn env = minimal allowlist** (`KAIROS_BRAIN_KEY`, `KAIROS_MCP_TOKEN`,
  `CODEX_HOME`, `PATH`=vendored runtime dir, `HOME`); never `{...process.env}`.
- **Interactive turns**: full tool surface; destructive Composio + `click_element`/
  `type_text` keep their OWN approval/confirm gate (independent of codex's
  `approval_policy`), exactly as today.
- **Unattended/proactive turns**: a RESTRAINED tool subset — read/search/draft
  only. NO `click_element`/`type_text`, NO destructive Composio writes, NO
  shell writes outside the codex workspace. Anything irreversible becomes a
  PARKED proposal surfaced as a chip/notification for the user to approve later
  (the background approval-gate we already have). Enforced at TWO layers: the MCP
  layer (08) tells the turn's mode and filters the tool list, AND the
  `workspace-write` sandbox bounds the native shell that the filter can't reach.
- This makes "proactive coming soon" safe by construction rather than by prompt.

## D. The `[[task]]` / `[[think]]` parse seam (the literal trigger)

Everything routes on `route ∈ {task, think}`, but the marker is produced by the
fast front and parsed in `conductor.ts`:
- Produced: the fast model emits `[[task]]` / `[[think]]` on its first line
  (FRONT_ADDENDUM instructs it); `parseFrontDirective(resp.text)` extracts
  `{route, say}` (conductor.ts, the `frontFlow` body around the
  `parseFrontDirective` call).
- Mapped to effort: `route==="task"` → CodexBrain `turn/start { effort: low }`;
  `route==="think"` → `{ effort: high }`. The deterministic overrides already
  in place (EXPLICIT_THINK_RE, DO_ASK_RE/TEACHING_RE/GUIDE_RE → force task,
  FABRICATED_ACTION_RE) run BEFORE the CodexBrain dispatch, unchanged.
- This is the only place the brain fork is decided; CodexBrain itself never
  sees the markers (they're stripped) — it gets the clean utterance +
  instructions + effort. One function, one seam.

## E. Secure-input overlay suppression + CODEX_HOME hardening (14 §B11, SHIP BLOCKER)

Two on-disk/on-screen security gaps that must close before any password/payment
demo:

- **`IsSecureEventInputEnabled()` → hide ALL overlays, always (ship-blocking).**
  When macOS secure event input is active (the OS sets this whenever a password
  field, payment sheet, or other sensitive control has focus), the HUD orb, the
  guide-mode comet, approval chips, and EVERY other overlay must be hidden — not
  dimmed, not partially — for the entire duration secure input is enabled. This is
  ship-blocking before we demo any password/payment flow: an overlay drawn over a
  secure field is both a screen-capture/recording leak and an interference risk.
  Poll/observe `IsSecureEventInputEnabled()` and treat `true` as a hard global
  hide; restore overlays only when it returns `false`.
- **chmod the generated `CODEX_HOME`.** The boot-generated `config.toml`
  (08 §C, written into the isolated `state/codex/home/`) and the home dir itself
  must be locked down: `chmod 600` the `config.toml`, `700` the home directory, so
  no other local user/process can read the codex config (which references the
  bearer-token env var and the proxy URL).
- **Bearer token via env, not on disk.** Keep the loopback bearer (`KAIROS_MCP_TOKEN`)
  and the proxy token (`KAIROS_BRAIN_KEY`) in the spawn env (the minimal allowlist
  from §C / 14 §B6), NOT written into `config.toml` or any on-disk file where
  possible — the config references `bearer_token_env_var`, it does not embed the
  secret.

## Cross-refs
- Vendoring mechanics: 01 §5, 10 §7. Proxy: 02. MCP/tools + per-turn mode: 08.
- Memory/trajectory: 09. Proactive routing + restraint ordering: 05.C, 10.
- The verifier post-turn port: 01 §D. Event seam: 11, 00 "The seam, restated".
- Architecture revisions source of truth: 14 (§B6/§B7 spawn+sandbox, §B11
  secure-input+chmod, §C12 idempotency).
