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

## C. Unattended / proactive security posture (DECISION, not an open question)

openclicky spawns codex with `sandbox_mode="danger-full-access"` +
`approval_policy="never"`. For an interactive, user-present voice turn that's
fine (the user is watching; our verifier gates + per-tool confirm gate cover
irreversible acts). For UNATTENDED proactive runs (05.C, 10) it is NOT — an
always-on co-worker with full disk access acting with no human present is a
broad blast radius.

Posture (proposed, confirm in 07):
- **Interactive turns**: full tool surface; destructive Composio + `click_element`/
  `type_text` keep their OWN approval/confirm gate (independent of codex's
  `approval_policy`), exactly as today.
- **Unattended/proactive turns**: a RESTRAINED tool subset — read/search/draft
  only. NO `click_element`/`type_text`, NO destructive Composio writes, NO
  shell writes outside the codex workspace. Anything irreversible becomes a
  PARKED proposal surfaced as a chip/notification for the user to approve later
  (the background approval-gate we already have). This is enforced at the MCP
  layer (08): the MCP server is told the turn's mode and filters the tool list.
- **Sandbox**: keep `workspace-write` (not full-access) as the default for the
  codex workspace; full-access only behind an explicit interactive opt-in.
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

## Cross-refs
- Vendoring mechanics: 01 §5, 10 §7. Proxy: 02. MCP/tools + per-turn mode: 08.
- Memory/trajectory: 09. Proactive routing + restraint ordering: 05.C, 10.
- The verifier post-turn port: 01 §D. Event seam: 11, 00 "The seam, restated".
