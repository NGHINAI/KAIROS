# 05 — Backend / daemon changes

Everything daemon-side that the migration needs, beyond the Codex module (01),
the proxy (02 + 09), the vendoring (08), the MCP/memory layer (11), and the
proactive hooks (10). This file is the catch-all for protocol extensions,
knowledge docs, proactive wiring, file hygiene, Composio discipline, the
CODEX_HOME lifecycle, and metering — with explicit cross-refs so nothing is
duplicated against 08/09/10/11.

## A. Guide/AX protocol extensions (for 03's affordances)

Prerequisites that DO NOT EXIST yet (grep confirmed: zero matches for
`ScrollArea|scroll|unionFrame|union|climb` in `AXFinder.swift`):

- `AXFinder.unionFrame(of: [indices|labels])` — group/region rect via the
  existing act-mode container-climb. Drives `RegionBlock` (03). The numbered
  inventory snapshot stays the addressing contract so guide-by-number, act-mode
  confirm-gate, and change-detection are untouched.
- `AXFinder.scrollableAncestor(of:)` — nearest `AXScrollArea` role + its frame +
  whether the target is above/below the current viewport (drives scroll
  direction). Both are additive helpers on the existing ~50ms AX walk.
- `GuideBridge`/`guideTools`: extend `guide_request`/`guide_user` with
  `kind:"point"|"region"|"scroll"|"label"` (default `"point"` = today's
  behavior, so old callers and verifier gates are unchanged) + `elements:[N..]`
  for regions + `{container_hint, direction, until}` for scroll. New
  `guide_scroll({direction, until, app})` wraps a region draw +
  `wait_for_screen(until)` — reuse the existing `handleWatch` poll loop
  (`GuideModel.swift` 95-120) so scroll guidance auto-advances.
- **Add an arrow affordance** (the user's explicit "add arrows" ask): a small
  reusable view (Capsule line + arrowhead) from the parked comet to the
  highlight, shared by point/region/scroll. Rendered in the existing
  click-through guide panel — no new window plumbing.
- Verifier: treat region/scroll/arrow successes as valid "pointed" outcomes in
  the walkthrough/false-blindness gates (extend the result-prefix checks). For
  multi-element regions, the toolCallLedger needs a region-evidence shape so
  the false-done gate doesn't misfire on a multi-element guide call.
- **Per-kind timeouts:** region/scroll resolution (union-rect walk, scrollable
  detection) can be slower than a point lookup; tune the guideBridge
  per-request timeouts per kind (today 8s/12s/15s) or the agent wrongly
  concludes "the HUD isn't running."

> Full SwiftUI specs (BullseyeRing, RegionBlock, ScrollGuide, ArrowAffordance,
> red/accent action-pill variant) live in 03; the orb stays our identity and the
> material stays warm-gold→cyan liquid glass (NOT Clicky's flat red).

## B. Per-app knowledge docs (the "how each app is used" system)

HeyClicky ships ~28 `.md` app playbooks (spotify.md, notion.md, four github-*,
imessage.md, maps.md, blender.md, …) injected when the agent works with that
app. This is their answer to "how does it know Photoshop."

- KAIROS: `knowledge/apps/<app>.md`, frontmatter `{ app, bundle_id?,
  match: [name patterns] }`, body = concise operating notes (where key controls
  live, common flows, gotchas, preferred structured route vs GUI).
- Injection: when a turn targets an app (open_app / read_screen app / frontmost
  app on a guide/act/do ask), `contextBuilder` injects the matching doc via
  **`thread/inject_items` before `turn/start`** (same per-turn channel as
  `lessonContext` — NOT a `turn/start.instructions` field, which does not exist in
  codex 0.133 [14] §A1; and NOT the durable `thread/start.baseInstructions`; see
  11.A for the split). Cheap, bounded, cache-keyed by app.
- IMPORTANT (user's explicit point): these are the ONLY md files we generate —
  app-knowledge docs so the agent has expertise. We are NOT spawning general
  doc sprawl. Seed a handful (System Settings, Finder, Mail, Safari, the apps
  in the demo) and grow from real usage; eventually KAIROS can WRITE new app
  docs itself from successful sessions (ties to the AWM skill-genesis path and
  the same trajectory store described in 11.D).

## C. Proactiveness on the tick (hooks now, wedge soon) — see 10 for the full design

The migration leaves CONCRETE HOOKS for proactivity; the full chief-of-staff
design lives in 10. The load-bearing reconciliation for THIS doc:

- KAIROS already runs the autonomous tick (`scheduler.ts` 38-41 / 66-72 /
  203-207) whose `DecisionEngine` emits six verbs (SLEEP/WORK/INVESTIGATE/
  NOTIFY/CONSOLIDATE/SUGGEST, `decisionEngine.ts` 148-170).
- **The single biggest correctness hook:** the `WORK` verb currently spawns
  `claude -p` as a one-shot subprocess (`taskRunner.ts` 78-115). This is REMOVED
  ENTIRELY — NO Claude anywhere in the runtime ([14] §H1). WORK routes through
  CodexBrain (`codex exec --json` background, or an app-server thread) in the SAME
  rollout step as background (step 1) so the proactive agent lane shares the
  conductor's brain, tools (MCP), and verifier gate. If we swapped only
  `[[task]]`/`[[think]]` and left WORK on `claude -p`, the proactive lane would
  silently diverge — two brains, two tool surfaces, no verifier wrapping proactive
  acts. (It also 401s in a shipped build: the Claude CLI is unauthenticated and
  Anthropic is off the cloud path by design.) A CI grep-gate (`grep -r "claude -p"`
  must be empty) enforces that no Claude path survives.
- Proactive turns are **background, non-voice Codex threads**: the
  synthetic-stimulus bridge (concern → plain-language intent) produces a turn
  that enters the SAME `handleSmart`/CodexBrain path, with `assistant_delta`
  NOT auto-piped to TTS unless the delivery plane decides to speak (matches
  HeyClicky keeping voice off Codex).
- **Restraint runs BEFORE Codex is invoked.** The gate stack (UrgencyFloor →
  deterministic gates → need-predictor + value-filter + you-policy reranker →
  breakpoint timing) fires pre-Codex; the deterministic verifier port (01.D)
  runs post-turn. `[NO_MESSAGE]`/silence is a first-class correct outcome.
- **Suggestion chips:** `knowledge/suggestion-rules.json` (frontmost app /
  recent activity → candidate), evaluated as a pre-tick hook; surfaced as a
  quiet HUD chip in the notch Home tab (04.B), NEVER spoken unless engaged.
  Only on engagement does a suggestion become a synthetic stimulus that may
  enter Codex. Restraint cooldowns from the proactive-cos spec gate frequency
  (07.6).
- `onSuggest`/`onNotify` (`index.ts` 459-493) stay the pre-agent delivery
  surfaces; the new Proposer's drafted actions enter via the synthetic-stimulus
  bridge rather than emitting only NOTIFY/SUGGEST.

> See 10 for: thread↔Agents-card mapping, durable concern↔thread continuity vs
> isolated background threads, and the restraint-only proactive tool subset.

## D. File-permission-storm hygiene (steal from HeyClicky AGENTS.md)

Their instructions forbid speculatively probing Desktop/Documents/Downloads
(each fires a separate macOS TCC prompt the agent never sees; a burst is
"extremely disruptive"). Default to the app's own working dir; touch ONE
protected folder deliberately when the task needs it; never scan to "find" a
file — ask/confirm the path.

- KAIROS: add this rule to the background sub-agent + Codex `thread/start`
  instructions (durable doctrine, 11.A), AND a daemon-side guard that refuses
  >1 distinct protected-root access per turn without an explicit user path. Our
  sub-agents have file tools and no such rule today.
- This holds under our DEFAULT posture — `sandbox_mode="workspace-write"` (egress
  restricted to the proxy host) + `approval_policy="never"` ([14] §B7), spawned with
  a minimal allowlisted env ([14] §B6). `danger-full-access` is ONLY an explicit
  interactive opt-in, never the unattended default. Because `approval_policy="never"`
  still bypasses codex's own approval, write/irreversible MCP tools keep their OWN
  approval gating independent of codex's policy (see E and 11.B).

## E. Composio discipline (already partially ours, tighten per their doctrine)

- "successful:true is not enough for writes — structured read-back to verify";
  "schemas as contracts, exact keys, no alias guessing across snake/camelCase";
  ~10-min schema cache; never agent-run OAuth → the daemon owns the connect
  flow. We have grounded-verify + toolkit-search; fold the read-back-after-write
  and no-alias rules explicitly into the durable `thread/start` instructions.
- **Auto-connect stays 100% daemon-side and invisible to Codex** (11.C). Codex
  only ever calls `search_tools` + `execute_tool`. When `execute_tool` returns a
  `NOT_CONNECTED` envelope (note: Composio returns `successful:false` envelopes,
  it does NOT throw), the daemon's `__kairosComposioExecute` wrapper invokes the
  already-built `SelfHealConnect.connectAndRetry` inline (the "future inline-on-
  error wiring" the comment at `index.ts` 2239 anticipates), does the browser
  OAuth + poll, retries, and returns only the final result to Codex. Codex never
  sees OAuth, redirect URLs, or tokens.

## F. CODEX_HOME / workspace lifecycle

- Generate `state/codex/home/` config at boot (01.B + 08); NEVER touch
  `~/.codex` (the user's home has a GSD `[[hooks]]` parse error in 0.133.0).
- `git init state/codex/workspace/` (codex assumes a git repo; otherwise `exec`
  needs `--skip-git-repo-check`); pre-trust via `[projects] trust_level="trusted"`.
- The home is **delete-and-regenerate safe**: re-write `config.toml`, the
  durable persona model-instructions file (from `ContextBuilder`'s session
  prefix — the daemon is the source of truth, NEVER the codex home; see 11.A),
  and the per-app + skills dirs on every (re)generation. Cache the prepared
  layout so we don't re-seed every session (openclicky's review flags re-prep as
  a beachball bug).
- Rotate/clean codex logs; the isolated home must survive daemon restart but be
  reproducible.
- **TOML safety (fix openclicky R8):** when templating `config.toml`, validate
  `model`/`effort`/provider strings against `[A-Za-z0-9./-]+` and escape control
  chars (`\n`/`\r`/`\t`), not just quote/backslash — an unescaped newline injects
  arbitrary config keys (including overriding `sandbox_mode`).

## G. Metering unification

- Codex turns → `llm_call_log` with task_type `codex_smart`/`codex_deep`
  (smart = effort low, deep = effort high — same model). Parse per-turn token
  usage from `turn/completed` (proves Codex surfaces per-turn usage for metering).
  TTFT is measured CLIENT-SIDE from the first delta — `time_to_first_token_ms` is
  NOT a field in the codex bindings ([14] §D17).
- The PROXY-side per-token/per-install counters (09) are the shipped source of
  truth (local code can't be trusted in a shipped app); the local log stays for
  dev visibility. Wire budget caps to the facade enforcement point. Add a
  `per-install/token` dimension to `usageMeter.ts` to mirror facade metering.
- Voice was already metered (task_type `voice_*`/`planner_*`) but never
  budget-BLOCKED; keep that contract for the Codex path.

## H. JSON-Schema → MCP shim (a gotcha, full detail in 11.B)

KAIROS `ToolDef.parameters` are raw JSON Schema; the MCP SDK's
`McpServer.registerTool` wants Zod or its json-schema-compat path. A shim is
required or the first tool call fails validation. Strip the MCP namespace
(`kairos__guide_user` → `guide_user`) in the ledger translator BEFORE the
verifier's `LOCAL_TOOLS` exemption and `isDestructiveCall`/`effectiveName`, and
switch the destructive gate from `startsWith('kairos_')` to an explicit
KAIROS-internal ALLOWLIST ([14] §A3) — otherwise the gate mis-fires on every tool
or Codex's namespaced Composio writes read as local-safe (11.B).
