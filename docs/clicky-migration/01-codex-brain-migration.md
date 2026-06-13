# 01 — Codex as the smart/deep brain (HeyClicky-style)

**Status:** design locked (decisions below reflect Nirmal's calls). Implementation-ready.

Goal: the **fast tier stays ours** (STT → fast LLM completion → TTS, single
completion, no agent loop — out of scope here). The `[[task]]` (smart) and
`[[think]]` (deep) tiers route to a **vendored, pinned OpenAI Codex CLI** running
as a **warm `codex app-server` child** over JSON-RPC. Models are served via
OpenRouter through OUR hidden proxy (see [02](./02-proxy-server.md)) using a
**separate dedicated key**; KAIROS tools are exposed to Codex via an MCP server;
Codex's event stream is translated 1:1 into the existing daemon `LoopEvent`
pipeline so the orb, captions, activity tree, TTS, and verifier keep working
unchanged.

The reference architecture is HeyClicky / openclicky, which ships exactly this
(warm `codex app-server --listen stdio://` child, hidden Cloudflare-Worker
provider, MCP tool exposure, per-turn effort override). We copy the proven
patterns and fix the bugs their own `FULL_SYSTEM_CODE_REVIEW` documents.

---

## 0. House decisions (do not re-litigate)

| Decision | Call |
|---|---|
| Fast tier | **Stays ours.** No agent loop. Codex never touches conversational fast-voice. |
| Smart `[[task]]` + deep `[[think]]` | **Codex app-server**, warm child, JSON-RPC v2. |
| Models | **OpenRouter** via the hidden proxy ([02]); **separate dedicated key** `KAIROS_BRAIN_KEY`. |
| Smart vs deep model | **SAME model, DIFFERENT reasoning effort** — confirmed first-class via **per-turn `effort` override** on `turn/start` (see §1). |
| Codex binary | **Vendored / built like a real product** — bundle the platform npm binary + arch-dispatch shim + bundled `rg`, pin an exact version. **Never the user's homebrew codex** (dev only). |
| Proxy | **Local now** (127.0.0.1 Bun facade), **host later** (Cloudflare Worker), zero app change ([02]). |
| Memory + self-learning + Composio auto-connect | **Preserved.** Memory split across thread/turn instructions + MCP `recall_memory`; trajectories keep feeding AwmWorker; Composio OAuth stays 100% daemon-side. |
| Proactive | **Coming soon.** Leave hooks (the WORK lane + synthetic-stimulus bridge route through CodexBrain; see §H). |

---

## 1. Reasoning effort: levels + per-turn override (the smart-vs-deep mechanism)

`ReasoningEffort` has **six** valid values, confirmed from the generated bindings
and the user's own `~/.codex/config.toml`:

```
none | minimal | low | medium | high | xhigh
```
> `/tmp/codex-ts/ReasoningEffort.ts`; `~/.codex/config.toml` uses `model_reasoning_effort = "xhigh"`.

**Per-turn override works — this is the load-bearing finding.** Both `model` and
`effort` are overridable PER TURN on the `turn/start` request, documented in the
bindings as *"Override … for this turn and subsequent turns."*

```ts
// /tmp/codex-ts/v2/TurnStartParams.ts
interface TurnStartParams {
  threadId: string;
  input: TurnInputItem[];     // [{ type: "text", text, text_elements: [] }, ...]
  cwd?: string | null;
  model?: string | null;      // override the thread's model for this turn
  effort?: ReasoningEffort | null;  // override effort for this turn
  // approvalPolicy / sandbox carried via thread defaults; see §4
}
```

openclicky proves this **in production**: voice turns send `turn/start` with
`effort: "low"` while Agent Mode keeps the user-selected (higher) effort —
*"Voice responses should prioritize first-token latency; Agent Mode keeps the
user-selected reasoning effort."*
> `/tmp/openclicky/cursor-buddy/CodexVoiceSession.swift:210-224` (voice `effort:"low"`),
> `CodexAgentSession.swift:608-624` (agent uses configured effort).

### What this means for KAIROS

- **ONE model in `thread/start`** (the `kairos-smart`/`kairos-deep` alias resolves
  server-side — see [02]); we may even use a single alias.
- **`[[task]]` smart → `turn/start { effort: "low" }`** (or `"minimal"` if latency
  demands — A/B per 07.4).
- **`[[think]]` deep → `turn/start { effort: "high" }`** (or `"xhigh"`).
- The per-turn `effort` override on `turn/start` is THE smart/deep mechanism: it's
  per-turn, requires no re-spawn, and is exactly the openclicky-proven path. We do
  NOT use `config.toml [profiles.smart]`/`[profiles.deep]` for effort — that split
  is retired and is not part of our design (any `[profiles.*]` that remains is
  codex's own inert config default, never the runtime authority). See doc 10.

> The user's call — "OK using the SAME model with DIFFERENT reasoning effort for
> smart vs deep" — is fully supported by the protocol. No per-profile model split needed.

---

## 2. max-turns / step-budget: there is no such knob

**There is no `max_turns` / iteration / tool-call-budget knob.** Confirmed by
grepping the v2 schema (only `budgetLimited` / `tokenBudget` exist) and the binary
strings. Run length is governed instead by:

- `model_context_window`
- `model_auto_compact_token_limit` (+ `_scope`) — auto-compaction
- `tool_output_token_limit`
- the per-turn **reasoning effort**
- for sub-agents only: `job_max_runtime_seconds`, `max_threads`, `max_depth`
- `ThreadGoal` carries `tokenBudget` / `tokensUsed` / `timeUsedSeconds`

`timeoutMs` fields exist ONLY for command/exec, not the agent loop.

**KAIROS mitigation for the missing iteration cap (deep turns can run long / burn
tokens):**
1. Set `model_auto_compact_token_limit` + `tool_output_token_limit` in the
   generated config.
2. **Hard $/token budgets enforced at the proxy** ([02]) — local code can't be
   trusted in a shipped app.
3. **Wall-clock watchdog in CodexBrain**: a per-turn deadline timer
   (e.g. smart ≈ 45s, deep ≈ 180s) that fires `turn/interrupt {threadId, turnId}`
   and surfaces a graceful final.
4. `ThreadGoal.tokenBudget` set per tier as a soft ceiling.

---

## 3. The app-server JSON-RPC sequence we will use

Transport: **`codex app-server --listen stdio://`**, newline-delimited JSON-RPC.
(0.133.0 also supports `unix://` and `ws://IP:PORT`; we use **stdio** — matches
openclicky/HeyClicky and is simplest from `Bun.spawn`.)

Framing: one JSON object per line on stdin/stdout. Encode with sorted keys + no
slash-escaping. Responses keyed by integer `id`; id-less messages are notifications.

### Startup handshake (once per process)
```
→ initialize { clientInfo, capabilities: { experimentalApi: true } }
← initialize result
→ initialized            (notification, no id)
```
> openclicky also does `account/read` then `account/login/start` — that is the
> ChatGPT-auth gate and is **N/A for us**: we use `preferred_auth_method = "apikey"`
> with the proxy token, so no account handshake. Skip it.

### Thread lifecycle (one thread per conversationId)
```
→ thread/start {
    model,                      // single alias (kairos-smart) — see [02]
    modelProvider: "kairos",
    cwd: "<state/codex/workspace abs>",
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    config: { approval_policy: "never", sandbox_mode: "danger-full-access" },
    baseInstructions: "<DURABLE doctrine — see §G>",   // set ONCE per thread
    serviceName: "kairos",
    personality: "friendly",
    ephemeral: false            // false → history persisted (deep); true acceptable for smart
  }
← thread/started { thread: { id } }      // map conversationId → thread.id, reuse

// later turns can resume across restart:
→ thread/resume { threadId }
→ thread/fork   { threadId }   (if we ever branch)
```

### Per turn
```
→ turn/start {
    threadId,
    input: [{ type: "text", text: "<utterance>", text_elements: [] }],
    cwd, approvalPolicy: "never", sandbox: "danger-full-access",
    config: { approval_policy, sandbox_mode },
    model,                      // optional override
    effort: "low" | "high",     // THE smart/deep switch (§1)
    instructions: "<VOLATILE per-turn memory delta — see §G>"
  }
← turn/started { turn: { id } }   // keep turnId for interrupt/steer
  ... notification stream (below) ...
← turn/completed { ..., time_to_first_token_ms, status }   // status: completed|failed|interrupted
```

### Notifications to translate (the event seam)
| Codex notification | → KAIROS LoopEvent / action |
|---|---|
| `thread/started` | (bookkeeping) |
| `turn/started` | bookkeeping; capture `turnId` |
| `item/started` (agentMessage / reasoning / commandExecution / webSearch / fileChange / mcpToolCall) | `tool_call_start` for tool-ish items |
| `item/agentMessage/delta` (`params.delta`) | `assistant_delta` → StreamSpeechController → TTS (debounce ~180ms before HUD, as openclicky does) |
| `item/reasoning/textDelta` | optional reasoning surface (deep tier only) |
| `item/mcpToolCall/progress` | activity-tree progress |
| `item/completed` | `tool_call_done` (or final agentMessage text) |
| `turn/plan/updated` | `plan_update` (activity tree) |
| `thread/tokenUsage/updated` | meter |
| `turn/completed` | `final` + metering (`time_to_first_token_ms`); reconstruct ledger → run verifier (§D) |
| `error` | `tool_call_failed` / surface error |

> Sources: `/tmp/codex-ts/ServerNotification.ts`; binary `TurnCompleteEvent …
> time_to_first_token_ms`; `openclicky CodexVoiceSession.swift:369-386`.

### Server→client requests we MUST suppress
`execCommandApproval`, `applyPatchApproval`,
`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`,
`item/permissions/requestApproval`, `item/tool/requestUserInput`,
`mcpServer/elicitation/request`. **Suppressed by `approvalPolicy: "never"` +
`sandbox_mode: "danger-full-access"`.** KAIROS's own gating (verifier + MCP
destructive-confirm) replaces these — see §D.

### Interrupt / steer (barge-in)
```
→ turn/interrupt { threadId, turnId }     // barge-in / supersede / watchdog
→ turn/steer     { threadId, expectedTurnId, input }   // inject into active turn (verifier retry, §D)
```
Resume the local pending promise with a cancellation FIRST (immediate UX), THEN
fire the RPC — openclicky's pattern.

---

## 4. CodexBrain module (`src/daemon/agents/codexBrain.ts` — NEW)

CodexBrain is implemented as a **`PlannerRunner`** injected via the Conductor's
`deps.runPlanner` (conductor.ts:663). This is the single swap point —
`defaultPlannerRunner` (conductor.ts:948) builds OpenRouter adapters + calls
`runAgentLoop`; CodexBrain emits the SAME `LoopEvent` shapes, so the
`onEvent` mapper at conductor.ts:624-651 (LoopEvent → flat `agent_*` events) is
**untouched**. handleSmart's onEvent→controller→activity wiring, `appendTurn` /
`updateRollingSummary` persistence (conductor.ts:712-726), and `trajWriter.append`
(conductor.ts:132-146) all stay as-is.

### Process management (mirror `CodexProcessManager.swift`, fix its bugs)
- Spawn ONE `codex app-server --listen stdio:// -c approval_policy="never" -c
  sandbox_mode="danger-full-access"` via `Bun.spawn`.
- `CODEX_HOME = state/codex/home/` (env), PATH prepended with the vendored
  runtime dir (so the bundled `rg` is found), `OPENAI_API_KEY = <proxy token>`
  (the per-install token from [02], NOT a provider key).
- Newline-JSON framing; incrementing integer `id`; **id-keyed promise map on a
  single serial queue**; id-less → `onNotification`.
- **Stale-exit guard** on restart ("Ignoring stale app-server exit").

**Fix the openclicky bugs from `FULL_SYSTEM_CODE_REVIEW` up front:**
- **A1 — continuation-leak race:** register the pending promise AND check
  `isRunning` inside the SAME critical section (serial queue), so a stop()
  interleaving with a send can't drop the stdin write and hang forever.
- **A3 — no RPC timeouts:** every request gets a deadline timer (≈30s
  initialize/thread-start, ≈90s `turn/start`) that rejects + triggers child
  restart.
- **A2 — double-startup race:** a single shared startup task that re-entrant
  callers await; never two `thread/start` for one thread.
- **R8 — TOML injection:** validate `model`/`effort` against `[A-Za-z0-9./-]+`
  and escape `\n \r \t` (not just `\` and `"`) before writing config.toml.

### Warm-up
Fire a throwaway turn ("reply 'ready' only") on first thread start, guarded by an
in-flight + did-warm-up flag, so the first real `[[task]]` hits a hot session.

### Binary resolution
- **dev:** `/opt/homebrew/bin/codex` (currently 0.133.0).
- **ship:** vendored pinned binary (§5).
- Locator prefers bundled → source-tree → `/Applications/...` → PATH; among
  candidates pick the highest `--version` (mirror `CodexRuntimeLocator`).
- The existing `CodexCliProvider.detectBinary` (codexCli.ts:7,104) already proves
  ENOENT handling; share its resolution logic but **do not** extend that one-shot
  `codex exec` provider into the warm brain — keep them separate.

---

## 5. Vendoring decision (build/bundle codex like a real product)

**Decision: vendor a pinned codex binary + arch-dispatch shim + bundled `rg`,
copying HeyClicky's layout verbatim. NEVER trust the user's homebrew codex at
ship time** (it's dev-only).

### Source of the binary
`@openai/codex` ships as a Rust binary wrapped via platform-specific OPTIONAL npm
deps (`@openai/codex-darwin-arm64`, the 193MB Mach-O arm64). Two equally valid
vendoring sources:
1. **GitHub Release per-arch archive** at build time (deterministic, no
   `node_modules` at runtime) — **preferred**.
2. `npm install @openai/codex@<exact>` + copy the binary out of its optionalDep.

### Bundle layout (copy HeyClicky)
```
<app bundle Resources>/CodexRuntime/
  bin/codex                                   # 648-byte POSIX sh arch-dispatch shim
  vendor/aarch64-apple-darwin/codex/codex     # pinned Mach-O arm64
  vendor/aarch64-apple-darwin/path/rg         # bundled ripgrep
  vendor/x86_64-apple-darwin/codex/codex      # (if shipping universal)
  vendor/x86_64-apple-darwin/path/rg
```
The shim detects `uname -m` (arm64 → `aarch64-apple-darwin`, x86_64 →
`x86_64-apple-darwin`), prepends `vendor/<triple>/path` to PATH, then
`exec vendor/<triple>/codex/codex "$@"`.

> Verified: `/Applications/HeyClicky.app/.../CodexRuntime/bin/codex` is exactly
> this 648-byte shim; vendored binary reports `codex-cli 0.124.0`; both arches
> shipped (171MB each, ~371MB total).

### Version pin
- HeyClicky shipped **0.124.0**; dev box is **0.133.0**; npm latest is ~0.139.0.
- **Pick ONE, validate end-to-end against the generated bindings AND the proxy's
  Responses translator, then freeze.** app-server is `[experimental]` and its
  JSON-RPC has changed across minors — treat a codex bump as a breaking-change
  event with its own test pass.
- **Recommendation: pin 0.133.0** (our dev box), so the bindings we generate match
  what we test, then re-validate before any bump. (Open question — see 07.)

### Generate + vendor the protocol bindings
```
codex app-server generate-ts --out src/daemon/agents/codexProto --experimental
# (or generate-json-schema --out … --experimental)
```
Vendor the output (`ClientRequest` / `ServerNotification` / `ServerRequest` /
`TurnStartParams` / `ReasoningEffort` / `v2/*`) for a typed JSON-RPC client. Pin
the bindings WITH the binary; regenerate only on version bump.

### Bundle-size mitigation
~193MB/arch roughly doubles app size for a universal build. Options:
arm64-only ship, OR download-on-first-run with a version pin + signature check.
(Open question — 07.9.) HeyClicky chose universal (~371MB).

---

## 6. Web search: Codex has it built in; KAIROS exposes its own only as fallback

**Codex has a NATIVE web tool** (Responses `web_search`), enabled via `--search`
or `tools.web_search = true`; modes `disabled | cached | live` with
domain/location/context-size config.

**Decision:**
- On the **Responses** wire path (our default — see [02] and §B), enable Codex's
  native `web_search` in the generated config. **Do NOT export KAIROS's DDG
  `web_search`/`read_webpage` to the Codex MCP server** — avoids a duplicate tool
  and stops the model from bypassing the metered proxy via the keyless DDG path.
- **Caveat:** native web_search rides the Responses path. If the chosen
  OpenRouter model behind the proxy does NOT serve `web_search` through
  OpenRouter's Responses beta, fall back to **exporting KAIROS's free DDG web
  tools via the KAIROS MCP server** so web works regardless of wire_api. Decide
  per-model in the 07.1 matrix.
- KAIROS's DDG tools (`webTools.ts`, free/keyless, SSRF-guarded) stay in use for
  the **fast tier** and **background sub-agents** that still run the in-house loop.

---

## 7. KAIROS tools → Codex via MCP (the tool surface)

KAIROS already assembles its whole planner toolset in one closure: `actionTools`
in `src/daemon/index.ts:1979-2074` (agency intents via `intentsAsTools`, Composio
`search_tools`/`execute_tool` + hot-set, background tools, `recall_memory`, DDG
web tools, guide/act tools), de-duped by name. Every tool is a uniform
`ToolDef { name, description, parameters (JSON Schema), execute }`
(`agents/types.ts:32-41`).

### Refactor: extract `buildActionToolset(deps): ToolDef[]`
Pull the `actionTools` closure body out of index.ts into an exported pure function
that takes the `__kairos*` singletons as explicit deps. This becomes the SINGLE
source of truth consumed by BOTH the in-house loop and the new MCP server, so
Codex and the legacy loop expose byte-identical tools.

### The MCP server (`src/daemon/mcp/kairosMcpServer.ts` — NEW)
The daemon today has ONLY MCP **client** code (`mcpClient.ts`/`mcpHost.ts`/
`httpMcpClient.ts`); the **server** half of `@modelcontextprotocol/sdk@1.0.4`
(`McpServer`, `StdioServerTransport`) is present and unused. Build the server to
re-use `buildActionToolset`: for each `ToolDef`, `McpServer.registerTool(name,
{ description, inputSchema }, async (args) => wrap ToolDef.execute → { content:
[{ type: "text", text }] })`.

> **CRITICAL — run IN-PROCESS, not as a `bun run kairosMcpServer.ts` child.** The tools
> close over live daemon singletons (`__kairosToolRetriever`,
> `__kairosComposioExecute`, GuideBridge, BackgroundAgentManager, MemoryInjector).
> A separate child would have NONE of these → a silent tool-less brain. **The
> migration plan's old `command=bun args=[run, kairosMcpServer.ts]` line is wrong and
> is corrected here.** Two acceptable transports:
> 1. **In-memory/stdio transport pair** created in-process and handed to the codex
>    child; OR
> 2. **StreamableHTTP mounted as the `/mcp` route on the EXISTING daemon `Bun.serve`
>    at 127.0.0.1:9876** (in-process, no second listener — per doc 11), registered as
>    `[mcp_servers.kairos] url = "http://127.0.0.1:9876/mcp"`.
> HTTP is easier to debug + decouples lifecycles; stdio matches HeyClicky/codex
> defaults. (Open question 07 — transport choice.)

### Schema shim
`ToolDef.parameters` are raw JSON Schema; `McpServer.registerTool` expects Zod or
the SDK's json-schema-compat path. Add a shim (the SDK exposes
`zod-json-schema-compat`) or first calls fail validation.

### Composio auto-connect stays 100% daemon-side
Codex only ever calls `search_tools` + `execute_tool`. The OAuth flow
(`ConnectionFlow`, `SelfHealConnect`, `connectionStore`, `TokenExpiryPoller`)
lives in the daemon process; Codex never sees redirect URLs or tokens. **Wire the
"future inline-on-error" hook (index.ts:2239):** on a `NOT_CONNECTED` envelope
from `composioClient.executeTool` (note: it returns `successful:false`, doesn't
throw), `__kairosComposioExecute` calls
`__kairosSelfHealConnect.connectAndRetry(toolkit, …)`, does the browser OAuth +
poll, then retries — returning ONLY the final result to Codex.

### Destructive gating + namespace stripping
- Port the existing `DestructiveActionConfirmer` / `DESTRUCTIVE_PATTERN`
  (mcpHost.ts:21-31,204-219) to wrap the server's execute callbacks; guide/act
  tools keep their own `DANGEROUS_LABEL_RE` gate.
- **Codex namespaces MCP tools** (e.g. `kairos__guide_user`). The verifier's
  `LOCAL_TOOLS` set and `startsWith("kairos_")` destructive check match BARE
  names. The ledger translator MUST strip the MCP namespace before feeding the
  verifier, or every tool mis-gates (verifier.ts:40-56). Reuse
  `conversationMessageStore.buildTurnDigest`'s `execute_tool` unwrap
  (lines 116-120) so the real action name (not `execute_tool`) reaches the
  trajectory clustering too.

### Per-tier tool gating (optional, latency)
The MCP server can advertise a trimmed list for the smart/voice tier (e.g.
withhold `composio_search_tools` catalog discovery + heavy tools, hot-set only)
and the full set for deep — mirroring the existing hot-set/search split. Filter
by an env flag CodexBrain sets per turn.

---

## 8. Memory + self-learning preserved (asymmetric split)

The reference (openclicky `CodexVoiceSession.composePrompt:578`) injects "voice
policy AND memory" as the per-turn `turn/start` input, and puts durable doctrine
in `thread/start baseInstructions`. KAIROS adopts the **same two-layer split**:

### G. Where memory goes
1. **DURABLE doctrine → `thread/start` `baseInstructions` (set once per thread).**
   Write `ContextBuilder`'s cached session prefix (persona/soul.md + "About the
   user" + MEMORY.md overview + standing orders + character/talk/act rules) into
   the CODEX_HOME AGENTS.md / model-instructions file as the thread base
   instructions. **KAIROS owns the user model — re-write this file from
   ContextBuilder on EVERY CODEX_HOME (re)generation** (the home is generated/
   disposable; a regen must not wipe the persona).
2. **VOLATILE per-turn delta → `turn/start` `instructions`.** Pass the fresh
   per-turn block (utterance-keyed L2/L3 hits via MemoryInjector + recent turns +
   date/time + connected apps + lessonContext). This is EXACTLY what
   `contextBuilder.build()` already returns. **Run the existing hygiene first**
   (`stripSelfEcho`/`isSelfEchoMemory`, `needsMemoryRecall` pre-gate) — call
   `contextBuilder.build()` rather than re-implementing, so promise/denial-echo
   poisoning stays fixed on the Codex path.
   - Refactor `contextBuilder.ts` to expose the cached prefix SEPARATELY from the
     per-turn delta (build() concatenates both today at line 232) so CodexBrain
     can route prefix→thread, delta→turn.
3. **`recall_memory` → MCP tool** for mid-task pulls (Codex queries memory with its
   own query). `buildRecallTool` already returns a ToolDef; expose it on the
   kairos MCP server. Keep BOTH: the cheap pre-injected delta for the opening, the
   tool for mid-task surprises.

### In-thread continuity (one source of truth)
**Decision: KAIROS-authoritative.** `ConversationMessageStore` stays the
transcript of record (the layered L0/L1/L2 replay pyramid + handle preservation +
cross-restart durability are already tuned). Map `conversationId → codex thread`
(thread/start once, reuse). To avoid **double-history**, do NOT let Codex's own
`history.persistence` re-feed the same turns the KAIROS replay already injects —
either inject `loadForReplay` output as the turn-input prefix and keep Codex
ephemeral, OR let Codex own continuity and stop injecting replay. **Pick one.**
Recommended: KAIROS-authoritative replay injected as the turn prefix.

### Self-learning: UNCHANGED (translate events → TrajWriter)
AwmWorker reads the FILE store at `~/.kairos/traj/YYYY-MM-DD.md`, never the model.
At the CodexBrain boundary, emit a `TrajWriter.record()` entry per turn —
`{ ts, task_goal, intent_id, args_summary, steps:[{action, result_summary}],
outcome, duration_ms }` — exactly the translation already done for the background
lane (index.ts:2386-2413). Set `intent_id` to the **per-MCP-tool action name**
(unwrapped from `execute_tool`) so AwmWorker's intent_id + sorted-tool-sequence
clustering (awmWorker.ts:163) stays meaningful. Crystallizer / PersonaGate /
skills-dir all keep working with zero changes.

---

## 9. D. The verifier-gate post-turn port (non-negotiable)

The deterministic verifier — promissory, fabrication, do-mode, walkthrough,
screen-offload, false-blindness, false-done — already runs **POST-TURN** purely
on `(utterance, finalText, toolCalls ledger)` (verifier.ts:163-219,197). Codex's
event stream yields exactly that tuple, so the gate ports without a rewrite:

1. From the Codex stream reconstruct: `utterance` (the turn input), `finalText`
   (item/completed agentMessage), `toolCallLedger` (item/mcpToolCall + command/exec
   begin/end), with **MCP namespace stripped** (§7).
2. Run `buildDestructiveVerifier.verify({ utterance, finalText, toolCalls })`
   post-turn. The LLM grounded-verify judge stays as-is.
3. On `retryable: true`, **inject ONE `[automatic check …]` follow-up turn into the
   SAME codex thread** (via `turn/steer` into a fresh turn) — mirrors today's
   in-loop self-correct round. Emit the existing `self_correct` event to the
   activity envelope.

### Streaming write-gate (the one thing that needs care)
The verifier's promissory/false-done gates assume KAIROS controls WHEN the final
is spoken — `block-writes` withholds the live claim until verify confirms. Codex
streams deltas straight to TTS. **Re-implement the StreamSpeechController
`isDestructive` "block" behavior on the Codex delta path:** detect a destructive
tool call from the MCP tool name in the event stream EARLY (item/started for an
mcpToolCall whose name matches the destructive set) and gate the stream so a
write turn can't voice "done, deleted" before the gate confirms. This is the exact
failure the gate exists to prevent; it must survive the streaming brain.

### Quiet-abort contract
On supersede emit `{ kind: "agent_interrupted" }`, NEVER `agent_done`
(conductor.ts:681,116). `agent_done` is load-bearing (sets lastAgentReply, ends
Lane A activity, persists the turn, clears turnActive) — emit exactly one terminal
`agent_done`, never after an abort, or the orb sticks in `.thinking` and replay
corrupts.

---

## 10. E. Routing + flags + escalation

- **Conductor branch:** `route in {task, think}` AND `KAIROS_BRAIN=codex` →
  CodexBrain (via `deps.runPlanner`); else current `handleSmart`/`handleThink`.
  The flag is the **permanent fallback** — `defaultPlannerRunner` stays.
  (handleSmart ~conductor.ts:574, handleThink ~conductor.ts:321.)
- **Per-turn effort:** task → `turn/start { effort: "low" }`; think →
  `turn/start { effort: "high" }`; single model (§1).
- **Lesson auto-continue** synthetic turns route the same way (they're tasks);
  verify `lessonContext` rides on `turn/start instructions`, not the utterance
  (conductor.ts:667-669).
- **Escalation ("extra effort"):** if a smart-tier turn ends with the budget /
  forced-final marker, re-run once on the deep tier (`effort: "high"`) — adopt
  HeyClicky's `agent_extra_effort_required` flow.
- **Quick-task carve-out (optional, post-pilot):** single-tool reads (calendar
  peek) MAY stay on our loop for latency; measure first (07.4). Avoid
  double-emitting `agent_intent` if so.
- **Non-voice turns** (background / proactive — §H): suppress the
  `assistant_delta → TTS` pipe; they must not speak unprompted.

---

## 11. F. Metering & budget

- Parse Codex usage events (`thread/tokenUsage/updated`, `turn/completed`
  `time_to_first_token_ms`) per turn → `llm_call_log` with task_type
  `codex_smart` / `codex_deep`; budget guard counts them like today's planner
  calls (the over-count bug is already fixed; voice is metered since 2026-06-10).
- The **proxy** ([02]) is the hard enforcement point (per-install/$ caps,
  kill-switch) — local metering mirrors it but cannot be the authority in a
  shipped app.

---

## 12. H. Proactive hooks (coming soon — leave seams now)

Proactive features are coming; leave the hooks so the proactive lane shares the
brain instead of diverging:

- **`taskRunner.runTask` (taskRunner.ts:78-115) currently spawns `claude -p`.**
  This is the proactive WORK "agent run" — gate it behind `KAIROS_BRAIN`; when
  codex, route WORK through CodexBrain (`codex exec --json` for background, or an
  app-server thread). **Do NOT leave it on `claude -p`** (it 401's on every tick
  without an authenticated Claude CLI, and Anthropic is removed from the cloud
  path by design). This is the single biggest proactive correctness risk.
- **Synthetic-stimulus bridge:** the locked proactive design turns an event into a
  fake user turn that enters the SAME planner. Route those as **non-voice
  background Codex threads** (HeyClicky keeps voice off Codex; background = the
  explicit agent run), gated by the **restraint stack BEFORE Codex is invoked**
  (UrgencyFloor → deterministic gates → value-filter → you-policy reranker →
  breakpoint timing; `[NO_MESSAGE]`/silence is a correct outcome). The verifier
  port (§D) still wraps proactive acts post-turn.
- **SUGGEST stays a quiet HUD chip** (notch Home tab, suggestion-rules.json on the
  tick); only on engagement does it become a synthetic stimulus that may enter
  Codex. Never auto-promote suggestions to Codex turns or speech.
- Background lane independently uses `runAgentLoop` today
  (backgroundSubsystem.ts:212-229) — migrate it FIRST via `codex exec --json`
  (rollout step 1).

---

## 13. Rollout order

1. **Background sub-agent executor on `codex exec --json`** (no voice risk).
   Validate the ledger-translation → verifier path here first.
2. **`[[think]]`/deep** on app-server threads (effort high).
3. **`[[task]]` smart-voice** behind `KAIROS_BRAIN=codex`; A/B latency + quality
   via `state/logs/turns.jsonl` before flipping the default.
4. **Proactive WORK lane** re-routed off `claude -p` (§H) when proactive ships.

---

## 14. Risks & mitigations

| Risk | Mitigation |
|---|---|
| app-server is `[experimental]`; v2 methods/fields can change between releases | Pin binary + regenerate bindings on bump; keep `codex exec --json` (stable) as the bg/sub-agent fallback. |
| `wire_api="responses"` on OpenRouter is beta; chat-only models lose native web_search + some effort fidelity | Per-model matrix (07.1); `wire_api="chat"` fallback per model; export KAIROS DDG web tools if native unavailable (§6). |
| First-token latency on voice (an agent loop is slower than our direct completion) | Measure `time_to_first_token_ms`; keep smart-voice flagged; A/B before default; HeyClicky keeps conversational voice off Codex entirely. |
| No iteration cap → deep turns run long / burn tokens | auto-compact + tool_output_token_limit + hard proxy budgets + wall-clock watchdog `turn/interrupt`. |
| ~193MB/arch bundle bloat | arm64-only or download-on-first-run with version pin + signature check. |
| npm platform sub-package fragility (`spawn -88`) | Vendor the binary directly (no runtime `npm i`); verify executability at boot. |
| Codex assumes a git workspace | `git init state/codex/workspace` + pre-trust via `[projects] trust_level="trusted"` (or `--skip-git-repo-check`). |
| The user's `~/.codex/config.toml` is broken (GSD `[[hooks]]` array vs codex 0.133's struct) | Use an **isolated CODEX_HOME** (`state/codex/home`); never read `~/.codex`. |
| `danger-full-access` + `approval_policy="never"` is a large blast radius | KAIROS's verifier (§D) + MCP destructive-confirm gates run independently of codex policy; deep tier needs a tighter posture before unattended ship. |
| MCP namespace mis-gates the verifier | Strip `kairos__`/`kairos.` in the ledger translator (§7, §D). |
| Realtime/speech model ids can't go through app-server | Guard with an `isSpeechModelID` check before the Codex attempt (don't copy openclicky's inverted REST-first ordering). |

---

## Refactor targets (file-level)

| File | Change |
|---|---|
| `src/daemon/agents/codexBrain.ts` (NEW) | Warm `codex app-server` child via `Bun.spawn` (isolated CODEX_HOME, newline JSON-RPC, initialize+initialized handshake, stale-exit guard, A1/A3/A2 fixes, per-request timeouts). Implement as a `PlannerRunner`. Per-turn `effort` override (task=low/think=high), single model. Translate events → LoopEvents. Post-turn verifier + same-thread retry. Emit TrajWriter record/turn. |
| `src/daemon/agents/codexProto/` (NEW, vendored) | `generate-ts --experimental` output, pinned with the binary. |
| `src/daemon/mcp/kairosMcpServer.ts` (NEW) | In-process MCP **server** exposing `buildActionToolset` (recall_memory, guide/act, search_tools/execute_tool, background, update_plan). JSON-Schema→schema shim. NOT a standalone `bun run` child. |
| `src/daemon/index.ts:1979-2074` | Extract `actionTools` closure → exported `buildActionToolset(deps): ToolDef[]` (deps passed explicitly). |
| `src/daemon/index.ts:897-900` (`__kairosComposioExecute`) | Wire inline SelfHealConnect on `NOT_CONNECTED` envelope (index.ts:2239 hook). |
| `src/daemon/index.ts` (boot) | Write ContextBuilder session prefix into CODEX_HOME model-instructions on every regen; wire CodexBrain traj translator → `__kairosTrajWriter`; route `{task,think}` + `KAIROS_BRAIN=codex` → CodexBrain; parse codex usage → `llm_call_log`. |
| `src/daemon/agents/conductor.ts` | `KAIROS_BRAIN=codex` branch in handleSmart/handleThink via `deps.runPlanner`; keep SAME onEvent/controller/activity wiring, appendTurn/rolling-summary, trajWriter.append. Keep `defaultPlannerRunner` as permanent fallback. |
| `src/daemon/agents/contextBuilder.ts` | Expose cached prefix SEPARATELY from per-turn delta (prefix→thread baseInstructions, delta→turn instructions). |
| `src/daemon/agents/loop/types.ts` | LoopEvent union (:36-46) is the STABLE seam — do not change during the swap; document it. Map any Codex-only signal onto existing kinds. |
| `src/daemon/agents/loop/verifier.ts:40-56` | Make LOCAL_TOOLS + `startsWith("kairos_")` robust to MCP namespacing (strip in the ledger translator). |
| `src/daemon/llm/providers/codexCli.ts` | Keep as the `codex exec --json` bg/fallback path; share `detectBinary`/vendored-pin resolution; do NOT extend into the warm brain. |
| `src/daemon/taskRunner.ts:78-115` | Gate `claude -p` behind `KAIROS_BRAIN`; route proactive WORK through CodexBrain when codex (§H). |
| app bundle `Resources/CodexRuntime/` (ship) | Vendor pinned `@openai/codex-<arch>` binary + `bin/codex` arch-dispatch shim + bundled `rg`; dev=homebrew, ship=bundled. |

---

## Open questions (tracked in 07)

- Exact codex version to pin (0.124 vs validated 0.133) + upgrade cadence.
- Which OR slug backs smart/deep, and does it serve `wire_api=responses` streaming
  with effort honored on OpenRouter's beta? (07.1) → also decides web_search (§6).
- First-token-latency budget that makes smart-VOICE-on-Codex acceptable (07.4).
- New dedicated key `KAIROS_BRAIN_KEY` confirmed separate from the daemon key (07.2).
- Ship-time binary: both arches (~193MB ea) vs arm64-only / download-on-first-run (07.9).
- MCP transport: in-memory/stdio pair vs StreamableHTTP on 127.0.0.1.
- In-thread continuity: KAIROS-authoritative replay (recommended) vs Codex
  `history.persistence`.
