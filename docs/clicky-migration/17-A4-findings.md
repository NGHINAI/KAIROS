# 17 — A4 findings: the warm app-server driver + the MCP-tool exposure blocker (2026-06-13)

Built the warm `codex app-server` `CodexBrain` driver (A4.1–A4.3, TDD, committed
`fd1beb2`) and ran the live tools/call proof (A4.4). The driver works; the brain
path works; **a hard model/transport incompatibility blocks MCP tool exposure
through OpenRouter.** This is the crux finding for the whole codex brain-swap.

## ✅ Built + unit-proven (A4.1–A4.3) — 34 tests, version-agnostic

- **codexJsonRpc.ts** — newline-delimited JSON-RPC transport matching the REAL
  codex 0.133 wire (loose JSON-RPC: response `{"id",..,"result"}` has NO
  `"jsonrpc"` field; dispatch by shape — method+id ⇒ server request, method ⇒
  notification, id ⇒ response). Per-request timeouts, rejectAll on exit,
  partial-line buffering. (12 tests)
- **codexEvents.ts** — ThreadItem/notification → LoopEvent translation + the
  verifier ledger; strips the MCP namespace before the ledger (A3). (11 tests)
- **codexBrain.ts** — initialize→thread/start→inject_items→turn/start→stream→
  POST-TURN verifier→corrective retry (new turn/start, A2) gated by the C12
  write-guard; B6 minimal-env spawn; abort→turn/interrupt; one thread per
  conversation. Implements PlannerRunner. (11 tests + a fake-app-server lifecycle)

These three modules are CORRECT and reusable under ANY of the paths below — they
are the JSON-RPC + driver layer, independent of how tools get exposed.

## ✅ Live-verified WORKS

1. **Brain path:** real `codex app-server` (spawned by CodexBrain) → our `/brain`
   proxy → OpenRouter (minimax-m3) → streamed answer back. The model talks.
2. **MCP server connects + tools listed:** `mcpServerStatus/list` shows
   `server="kairos" tools=read_screen,guide_user,recall_memory,wait_for_screen`.
   The A3 stdio-bridge + `network_access=true` fix is CONFIRMED — codex starts our
   MCP server and ingests its tools. (The "bridge log not created" was a red
   herring: codex spawns the bridge with only `[mcp_servers.kairos.env]`, so our
   `KAIROS_BRIDGE_LOG` never reached it — the tools list proves it ran.)

## ❌ THE BLOCKER: MCP tools are not CALLABLE through OpenRouter

codex serializes MCP-server tools to the model as a Responses-API **grouped tool**:
```json
{ "type": "namespace", "name": "mcp__kairos__", "description": "Tools in the mcp__kairos__ namespace.",
  "tools": [ { "type": "function", "name": "read_screen", ... }, { "name": "guide_user", ... } ] }
```
(Captured by tee-logging the exact request body our `/brain` proxy forwards.)

**OpenRouter's `/v1/responses` does not expand the `type:"namespace"` construct,**
so the inner tools (read_screen, guide_user, …) are invisible/uncallable:
- **minimax-m3:** doesn't parse the namespace wrapper at all → "I don't have a
  read_screen tool; my tools are exec_command, view_image, web_search…" (those are
  codex's FLAT built-ins, which it DOES see). No tools/call ever fires.
- **openai/gpt-4o-mini AND openai/gpt-4o (capable):** also never call the inner
  tools — both fumble to codex's flat built-in `read_mcp_resource` with a bogus
  server name ("unknown MCP server 'screen'/'local'"). So this is NOT just a
  weak-model issue; the inner tools aren't presented as callable by OpenRouter for
  ANY model family tested.

**Wire-flattening at the proxy doesn't work either.** If the proxy expands the
namespace into flat `type:"function"` tools, the model DOES call them — but codex's
own tool ROUTER rejects every flat name it gets back:
```
ERROR codex_core::tools::router: error=unsupported call: mcp__kairos__read_screen
ERROR codex_core::tools::router: error=unsupported call: read_screen
```
codex only registered the *namespace*; it will not route a flattened child call. So
fixing the request side alone is insufficient — codex's router is the gatekeeper.

**Version pin doesn't fix it.** Tested codex **0.124.0** (HeyClicky's shipped
version) too: it flattens the built-in `multi_agent` tools (namespaced in 0.133)
but STILL groups MCP-server tools under `namespace:mcp__kairos__`. And **both 0.124
and 0.133 hard-reject `wire_api="chat"`** (`"\`wire_api = \"chat\"\` is no longer
supported"`) — Responses is the only wire API, so the classic flat-function
chat-tools path is gone in both.

## Why this matters

The fast/no-tool tier already works through the proxy (A3 "pong"). But the SMART
`[[task]]` and DEEP `[[think]]` tiers are agentic — they NEED KAIROS tools
(read_screen, guide_user, search_tools/execute_tool, recall_memory, background).
codex can't expose those tools to a non-OpenAI OpenRouter model. So the codex
brain-swap, AS DESIGNED (codex + arbitrary OpenRouter model + KAIROS tools via MCP),
does not deliver tool-using agentic work.

## Paths forward (a strategic fork — needs a product decision)

**A) Proxy namespace-translation (any model, most engineering).** The proxy expands
`type:"namespace"`→flat in the request AND reverse-translates the model's flat
`function_call` into the exact item shape codex's router accepts for a namespaced
tool. Unknown: codex's accepted wire format for a namespace call (it rejected every
flat form tried). Requires reverse-engineering + is codex-version-fragile, but
preserves the any-model + full-codex architecture.

**B) Native OpenAI Responses upstream for the agentic tiers (works natively, OpenAI-
only for tools).** Point the proxy's upstream at OpenAI's REAL `/responses` for
smart/deep so the namespace expands server-side (codex's designed path). Keep
OpenRouter for the fast/no-tool voice tier. The proxy still hides the provider from
the shipped app. Cost = OpenAI pricing on the agentic tiers; needs an OpenAI key to
even validate (we only have the OpenRouter key today). NOT YET VALIDATED — must
confirm OpenAI's real /responses expands the namespace and the model calls
read_screen.

**C) Keep the in-house KAL loop for tool-using tiers.** Our existing `runAgentLoop`
already does tools + verifier + streaming with ANY OpenRouter model. Use codex only
where it clearly wins (or reconsider the brain-swap for the agentic path). Lowest
risk (we already ship a working tool-using brain); concedes the codex agentic
benefit for now.

## Recommendation

Decide A vs B vs C before building further. The driver (A4.1–A4.3) stands regardless.
Engineering-honest read: **C is the safe default** (we already have a working
any-model tool-using brain); **B is the cleanest way to actually ship codex's
agentic brain** if an OpenAI model on the agentic tiers is acceptable (proxy hides
it); **A is the "have it all" but highest-risk/most-fragile** option. Recommend
confirming B end-to-end (needs an OpenAI key) before committing the migration to it.

## Cleanup / state
- Throwaway protocol probe (`_probe.ts`) deleted after use.
- codex 0.124.0 installed at `/tmp/codex124` for the version comparison (temp).
- Vendored bindings remain pinned to 0.133.
