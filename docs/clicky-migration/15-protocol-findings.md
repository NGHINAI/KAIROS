# 15 — Codex app-server protocol findings (A0 ground-truth, 2026-06-13)

Generated the real bindings (`codex app-server generate-ts`, pinned codex
0.133.0) and validated the architecture against them BEFORE writing CodexBrain.
Bindings vendored at `src/daemon/codex/proto/`.

## Our 3 load-bearing claims — ALL CONFIRMED ✓

1. **`turn/start` has NO `instructions` field** (`v2/TurnStartParams.ts`). It has
   `threadId, input[], cwd?, approvalPolicy?, sandboxPolicy?, model?, effort?,
   summary?, personality?, outputSchema?`. So per-turn context CANNOT ride
   turn/start — it goes via `thread/inject_items`. (Confirms 14§A1.)
2. **`thread/inject_items` EXISTS** (`v2/ThreadInjectItemsParams.ts`):
   `{ threadId, items: JsonValue[] }`, doc = "Raw Responses API items to append
   to the thread's model-visible history." This IS our per-turn delta channel
   (memory delta + lessonContext + per-app knowledge). Confirmed real.
3. **`ReasoningEffort = none|minimal|low|medium|high|xhigh`** and **`turn/start`
   carries per-turn `effort` + `model` overrides** ("for this turn and subsequent
   turns"). One model, per-turn effort (smart=low, deep=high) is exactly right.
   (Confirms 00 decision #3, 14§A.)

Plus: **`thread/start` HAS `baseInstructions`** (+ `developerInstructions`,
`config`, `ephemeral`, `model`, `modelProvider`, `sandbox`) → durable persona on
baseInstructions confirmed. `turn/steer` + `turn/interrupt` exist (barge-in).

## NEW native capabilities discovered → decisions

4. **Native `Personality = "none" | "friendly" | "pragmatic"`** (thread + turn).
   DECISION: too coarse for our witty/sarcastic, onboarding-driven, user-tunable
   persona — **keep the real persona in `baseInstructions`** (full text control,
   the cacheable prefix per 14§H3). Optionally set native `personality:"friendly"`
   as a floor; baseInstructions is the driver. (→ 09, 01.)
5. **Native memory: `ThreadMemoryMode = "enabled" | "disabled"` + `MemoryCitation`
   on agentMessage.** Codex has its OWN memory system. DECISION: **set
   `ThreadMemoryMode: "disabled"`** — KAIROS memory (L2/L3/L4 + AwmWorker) stays
   the SINGLE source of truth; running codex's competing memory store alongside
   ours would double-write, drift, and leak our memory into codex's. Our memory
   reaches the model via baseInstructions (durable) + thread/inject_items
   (volatile) + the `recall_memory` MCP tool. (→ 09 — important, update it.)
6. **Native sub-agents: `collabAgentToolCall`** (spawn/senderThreadId/
   receiverThreadIds, per-agent `model` + `reasoningEffort`). The "codex
   sub-agents / parallel tools" advanced capability is BUILT IN — we deferred it
   (14 F-deferred), but it's free to adopt later for parallel/background fan-out.
   Note for post-v1; our background lane can map onto it. (→ advanced backlog.)
7. **`ThreadItem` union = the exact ledger-translation shapes** the CodexBrain
   adapter consumes: `mcpToolCall {server, tool, status, arguments, result,
   error, durationMs}`, `dynamicToolCall {namespace, tool, …}`, `agentMessage
   {text, phase, memoryCitation}`, `reasoning`, `commandExecution`, `webSearch`,
   `fileChange`, `contextCompaction`, etc. → the namespace-strip for the verifier
   keys off `mcpToolCall.server`+`tool` (14§A3). The adapter maps these →
   our `LoopEvent`s. (→ 01/11 — the translation table is now exact.)
8. **Native shell/fs: `command/exec`, `thread/shellCommand`, `fs/*`** exist and
   bypass any MCP tool filter — confirming 14§B7: the SANDBOX (`workspace-write`
   default), not the tool list, must be the security boundary.

## Net
Architecture validated; no redesign needed. Three doc updates fall out: 09 (set
ThreadMemoryMode disabled + persona-in-baseInstructions not native), 01/11 (the
exact ThreadItem→LoopEvent translation table), advanced-backlog (collab agents).
A0-2 (vendor bindings) DONE. Next A0: CODEX_HOME generation + arch shim (no key).
