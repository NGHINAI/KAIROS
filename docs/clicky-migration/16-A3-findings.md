# 16 — A3 live findings: codex brain + MCP integration (2026-06-13)

Wired the daemon to mount BOTH the hidden proxy (/brain) and the MCP server
(/mcp), then drove the REAL codex binary (`codex exec --json`) against them with
the dedicated OpenRouter key. Results — the brain works; the tool path has a
clear, documented frontier.

## ✅ WORKS (verified with the real codex binary + real OpenRouter)

1. **Codex → hidden proxy → OpenRouter → codex** — a real `codex exec` turn
   completed and answered "pong". Daemon logged
   `[brain-proxy] POST /v1/responses model=kairos-smart→minimax/minimax-m3 → 200 (stream)`.
   The whole brain path is live: alias rewrite, server-side key, SSE streaming.
2. **OpenRouter supports the Responses API natively** — so /brain is a thin
   pass-through, not a translator (A1).
3. **codex's rmcp HTTP client CONNECTS to /mcp and fetches the toolset** — the
   full handshake (`POST initialize → POST initialized → GET standalone-stream →
   POST tools/list → DELETE`) ran, and our server returned all 28 tools.
4. **The stdio bridge works standalone** — `mcpStdioBridge.ts` over raw stdin:
   `initialize` + `tools/list` return the full 28-tool set (it proxies to the
   daemon /mcp via the SDK client, which is reliable).

## ❌ THE FRONTIER: codex `exec` does not make our MCP tools callable

Two transports, two failure modes, same outcome (the model can't call our tools):

- **HTTP /mcp (rmcp client):** intermittent `rmcp::transport::streamable_http_client:
  fail to get common stream … error sending request for url (…/mcp)`. tools/list
  succeeds, but the standalone-stream handshake flakes, and the tools are NOT
  exposed to the model. Proof: asked gpt-4o-mini to call `kairos__read_screen`;
  it wasn't in the model's function list, so the model fell back to running it as
  a SHELL command (`command not found`). No `tools/call` ever reached us.
- **stdio bridge (codex spawns it):** `codex exec` HANGS after "Reading
  additional input from stdin…" — codex waits on MCP-server startup. The bridge
  runs fine standalone, so the likely cause is that the bridge, **spawned by
  codex under `sandbox_mode=workspace-write`, can't reach the daemon's loopback
  HTTP** (sandbox network restriction) — its `client.connect()` to 127.0.0.1:9876
  hangs, so it never starts its stdio server, so codex blocks.

## Hypotheses (ranked) + the recommended next step

1. **`codex exec` is the wrong lane for MCP tools.** exec is non-interactive
   ("rollout step 1"); the PRODUCTION brain is the warm `app-server` (A4).
   openclicky/HeyClicky drive MCP tools through the app-server, not exec. → Build
   the A4 app-server driver and test MCP-tool exposure THERE before concluding
   anything about the transport. This is the highest-value next move.
2. **Sandbox network for the bridge.** If the stdio bridge can't reach loopback
   under codex's sandbox, either (a) configure codex to not network-sandbox
   spawned MCP servers, or (b) give the bridge a sandbox-exempt IPC. Verify what
   sandbox the spawned MCP server actually runs under in app-server mode.
3. **rmcp standalone-stream robustness.** If we keep HTTP, the GET common-stream
   needs to satisfy rmcp (an immediate heartbeat event, or a stateless mode rmcp
   tolerates). Lower priority than (1).
4. **Model tool-calling via /responses.** minimax-m3 did NOT emit a tool call
   even when willing models (gpt-4o-mini) tried — so once exposure works, we must
   re-verify minimax-m3 actually emits function calls through OpenRouter's
   /responses. If not, the agentic brain may need a different model (the proxy
   alias makes that a one-line swap).

## What's committed + stands regardless
- /brain proxy + /mcp server both mounted on the daemon (A1 + A2), fully unit +
  E2E tested at the daemon level.
- mcpStdioBridge.ts (standalone-verified) — kept; likely the codex-facing
  transport once the spawn/sandbox issue is resolved.
- Both transports coexist: HTTP /mcp serves SDK clients + the bridge; the bridge
  serves codex over stdio.

## Decision
A3's brain half is DONE (codex↔proxy↔OpenRouter live). The tool half is gated on
the A4 app-server lane + the spawn/sandbox resolution — NOT on more `codex exec`
debugging. Proceed to A4 (app-server driver) next; re-test MCP-tool exposure there.
