# 18 — opencode brain: decision + empirically-captured contract (2026-06-14)

## Decision (locked)
After the codex MCP-namespace blocker (doc 17), investigated alternatives. HeyClicky
proved codex-with-tools is OpenAI-ONLY. Evaluated **qwen-code vs opencode hands-on**
(minimax-m3 + OpenRouter + a stdio MCP `read_screen`, marker-proven): BOTH passed.
**User chose opencode** (anomalyco/opencode, MIT, v1.17.6) — it exposes MCP tools as
FLAT `<server>_<tool>` function tools any OpenRouter model calls (no codex namespace,
no qwen-code `tool_search` deferral). The codex driver (codexJsonRpc/codexEvents/
codexBrain, committed fd1beb2/782f496) is SHELVED; its reusable concepts (PlannerRunner,
verifier port, C12 write-guard, LoopEvent translation, the 2 critical LESSONS) carry over.

## Empirically captured contract (live probe, opencode 1.17.6 SDK under Bun)

### Boot + drive (the warm brain)
- `@opencode-ai/sdk`: `createOpencode({ config })` → `{ client, server }` boots `opencode
  serve` (subprocess) + returns an HTTP client. Works under Bun. Server picks a port.
- `client.session.create({ body: { title } })` → `res.data.id` (sessionID).
- `client.session.prompt({ path:{id}, body:{ model:{providerID,modelID}, parts:[{type:"text",text}], system? } })`
  — **BLOCKS until the turn completes**, returns the FINAL assistant message (parts:
  step-start/reasoning/text/step-finish — NOTE: the final message does NOT include the
  tool part; tool parts are in the PRIOR assistant message / the event stream).
- `client.session.abort({ path:{id} })` — barge-in.
- `client.global.event()` → `{ stream: AsyncGenerator }` — the GLOBAL SSE event stream.
- `client.session.postSessionIdPermissionsPermissionId({ path:{id, permissionID}, body:{ response:"always" } })`
  — respond to a `permission.updated` (auto-allow for unattended).

### Event envelope (THE gotcha)
Events are wrapped: the real event is `raw.payload.{ type, properties }` (NOT `raw.type`).
Some are sync-wrapped (`payload.type==="sync"`, `payload.syncEvent`). Every turn event
carries `sessionID` → route by it (the codex stale-turn bug is naturally avoided).

### Turn event sequence (per turn)
```
message.updated (user, then assistant created)
session.status {type:"busy"}
message.part.updated part=step-start
message.part.updated part=reasoning   (properties.part.text CUMULATIVE: 0→92→189…)
message.part.updated part=tool         (state.status: pending → running → completed|error)
message.part.updated part=step-finish
  …(possibly another step: step-start, reasoning, text)…
message.part.updated part=text         (properties.part.text CUMULATIVE: 0→118…)  ← spoken answer
message.part.updated part=step-finish
session.status {type:"idle"}
session.idle {sessionID}               ← TERMINAL
session.error {…}                      ← terminal error path (watchdog still needed)
```

### Part shapes
- text:      `{ type:"text", id, sessionID, messageID, text }` (CUMULATIVE — diff for deltas)
- reasoning: `{ type:"reasoning", id, text }` (model thinking; not spoken)
- tool:      `{ type:"tool", id, callID, tool:"<server>_<tool>", state:{ status, input, output, error? } }`
  - status: pending|running|completed|error. `state.input`=args, `state.output`=result string.
  - tool NAME = `<server>_<tool>` (single underscore). We control the server name ("kairos"),
    so strip the `kairos_` prefix → bare action ("read_screen", "GMAIL_SEND_EMAIL") for the
    verifier (the A3 namespace-strip invariant carries over).

### Config (passed as an OBJECT to createOpencode — no file needed)
```js
{
  provider: { kairosbrain: { npm:"@ai-sdk/openai-compatible", name:"…",
    options:{ baseURL:"https://openrouter.ai/api/v1", apiKey:<KAIROS_BRAIN_KEY> },
    models:{ "minimax/minimax-m3": { tool_call:true } } } },
  mcp: { kairos: { type:"remote", url:"http://127.0.0.1:9876/mcp",
                   headers:{ authorization:"Bearer <KAIROS_MCP_TOKEN>" } } },  // our in-daemon MCP
  permission: { edit:"allow", bash:"allow", webfetch:"allow" },               // + auto-respond permission.updated
}
```
Our existing `mcpServer.ts` (mounted at the daemon's `/mcp`) plugs straight in as a
`type:"remote"` server — opencode connects over loopback HTTP; tools reach the model FLAT.

## Driver plan (TDD, mirrors the codex driver shape)
- `openCodeEvents.ts` — pure: unwrap payload → per-session turn accumulator → LoopEvents
  (text delta diff → assistant_delta; tool pending/running → tool_call_start, completed →
  tool_call_done, error → tool_call_failed) + verifier ledger (name stripped, input/output).
  Terminal on session.idle/session.error. Filter by sessionID (id-match lesson).
- `openCodeBrain.ts` — PlannerRunner: lazy `createOpencode` (warm, reuse) + global event
  subscriber routing to the active turn accumulator by sessionID; session per conversationId
  (reuse); run() = prompt() (blocking, streams via subscriber) → POST-TURN verifier → corrective
  retry as a new prompt (write-guard C12); abort→session.abort; PER-TURN WATCHDOG (deadline →
  abort + graceful final, the codex hang lesson); permission auto-respond. Implements
  conductor `deps.runPlanner` (conductor.ts:663) — same swap point.
- Config builder (object, not file) + warm `opencode serve` lifecycle (stale-exit guard).
- Reuse: verifier.ts (post-turn), the C12 write-guard, the LoopEvent seam (loop/types.ts).

Live-proven already: under Bun, minimax-m3 called the MCP `read_screen` (marker), result
flowed back into a correct answer, clean stream, ~9-11s. Smoke artifact: `_smoke-mcp.mjs`.
