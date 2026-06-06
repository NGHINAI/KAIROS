# KAIROS — Durable Conversation Memory + Replay (production)

**Status:** in implementation · **Date:** 2026-06-05 · **Branch:** `phase-e2-core`

## Problem (from the 2026-06-05 20:24–20:32 live session)

KAIROS sent an email (`GMAIL_SEND_EMAIL` → `threadId 19e9976612c3c003`), then on
"reply to that same email" it could not identify the email, re-asked the user for the
recipient/subject, ran a doomed search on a hallucinated subject, and earned
"you are fucking dumb." Root cause: **KAIROS destroys the structured results of its
own actions at the turn boundary.**

- `conversationStore` persists only `{role, text}` — the spoken reply, never tool results.
- The agent loop's `msgs` array (incl. tool results) is local and discarded at turn end.
- The planner is re-seeded `[system, user]` every turn (`conductor.ts` `defaultPlannerRunner`).
- The only cross-turn context is `recentTurns(3)` rendered as **prose** in the system prompt — no tool results, no `threadId`.
- The grounding rule (`contextBuilder.ts:111/127`) *forbids* reconstructing from "something said earlier," so the model punts instead of recovering.

## Research: how Claude Code / Codex / Hermes / OpenClaw / OpenHands solve it

Every serious agent converges on **one architecture**:

1. **Append-only durable transcript** (JSONL or SQLite) that records *everything* — user, assistant, tool calls **and tool results**. (Claude Code `~/.claude/projects/*.jsonl`; Codex `~/.codex/sessions` rollouts; Hermes SQLite+FTS5; OpenClaw `~/.openclaw/.../sessions/*.jsonl`; OpenHands immutable EventLog.)
2. **The model is fed a bounded VIEW** over that log, not the raw log.
3. **Compaction is a view transformation, not data loss**: keep_first (goal) + keep_recent verbatim, summarize/elide the middle. The log keeps full fidelity. (OpenHands: condensation is an *appended view event*; the log is the source of truth.)
4. **Two-tier compaction**: cheap **no-LLM prune** of stale reproducible tool results first (Claude Code microcompact / Hermes phase-1 / OpenClaw), then LLM summary only at a token threshold.
5. **Tool-pair integrity**: never split an assistant `tool_call` from its `tool_result` (KAIROS's `compactor.ts` already guards this).
6. **Durable cross-session memory = curated files** (`CLAUDE.md`/`AGENTS.md`/`MEMORY.md`/Memory-Bank) + (best ones) RAG retrieval.
7. **Memory-flush before compaction** (OpenClaw): write salient ids/facts to durable memory *before* raw results get summarized away.

**The one adaptation for a VOICE agent:** the LLM summary must run **off the hot path**
(voice latency budget). We adopt OpenHands' model — **event-log-as-truth + a cheap
per-turn VIEW** — and run summarization between turns / on idle, never inline.

## KAIROS already has ~80% of the parts

- `conversationStore` SQLite — extend (it's text-only today).
- `compactor.ts` — has the exact keep-goal/last-tool-block recipe **and** the tool-call-id orphan guard. Reuse its invariant for replay.
- `TurnLogger` JSONL — already captures `toolCalls{name,args,result}` per turn.
- `conductor.ts` `defaultPlannerRunner` seed `[system, user]` — the single change point → `[system, …replay, user]`.
- `anthropicApi.ts`/`cacheHints.ts` — a complete `cache_control` design the OpenRouter path doesn't use yet.

## Design

### Durable layer — `ConversationMessageStore` (new)
Table `conversation_messages(id, conversation_id, turn_id, role, content, tool_calls JSON, tool_call_id, tool_name, at)`, append-only, conversation-keyed. Stores the full `LoopMsg` array per turn (user + assistant tool_calls + tool results + final answer). This is "remember everything."

### View layer — bounded real-message replay
`handleSmart` loads the last *N* complete turns (tool-pair-safe, char-bounded) and seeds the loop `[system, …replayedRealMessages, user]`. The model sees its own prior tool results natively → `threadId` carries forward. Reuses the orphan guard so no dangling `tool_call_id` → no provider 400s.

### Grounding carve-out (`contextBuilder.ts`)
Add a precise exception: *identifiers/handles from actions YOU completed earlier this
conversation (a thread/message id you sent, a file you created) ARE valid to reuse to
chain a follow-up — distinct from re-reading stale live data.* Keeps "re-fetch live
data fresh" while unblocking "reply to the thing you just did."

### Compaction (off the hot path)
- **Tier 1 (no-LLM):** on load, drop stale reproducible tool results beyond the last *K*; keep side-effecting ones (Claude Code microcompact rule). Tool-pair-safe.
- **Tier 2 (LLM, between turns):** a background summarizer folds older turns into a rolling summary stored per conversation, injected as one message. Memory-flush salient ids first.

### Tool-result shaping (`toolExecutor.ts`) — "seeing a lot at once"
Lower `KAIROS_MAX_TOOL_CHARS` default 16000→6000, switch to **middle-elision** (keep head+tail), and **shape list-shaped Composio results** (`*_FETCH/_LIST/_SEARCH`) to `{id, threadId, from, subject, snippet}` before clamping — preserves the `threadId` while cutting a verbose inbox dump from ~16KB to ~1–2KB.

### Phantom GPT-4o
`verifyModel()`/`vision` fall back to `KAIROS_SMART_MODEL` before the hardcoded `openai/gpt-4o`; add a per-verify-call model log line (today no per-turn model is logged anywhere).

### Prompt caching (OpenRouter path)
Lift the existing `cache_control` breakpoint design onto the OpenRouter adapter so the stable prefix + older replayed messages are cached — makes a growing replay affordable + low-latency (Claude Code's economic model).

## Phases (each independently shippable + feature-flagged via `KAIROS_*`)

| Phase | Deliverable | Files | Flag |
|---|---|---|---|
| **0** | Phantom-GPT fix + verify-model observability | `agents/types.ts`, `conductor.ts`, `.env` | — |
| **1** | `ConversationMessageStore` (durable full history) | new `voice/conversationMessageStore.ts`, `index.ts` | always-on store |
| **2** | Real-message replay + grounding carve-out + **regression test** | `conductor.ts`, `contextBuilder.ts`, `index.ts` | `KAIROS_CONV_REPLAY` (default on) |
| **3** | Tool-result shaping/clamp (over-context) | `loop/toolExecutor.ts` | `KAIROS_MAX_TOOL_CHARS` |
| **4** | Off-hot-path rolling summary + cross-turn compaction | new `memory/conversationSummarizer.ts`, `conductor.ts` | `KAIROS_CONV_SUMMARY` |
| **5** | Prompt caching on OpenRouter path | `openRouterAdapter.ts`, `cacheHints.ts` | `KAIROS_OR_CACHE` |

## Acceptance regression test (the gate)

Replay the exact failing arc as a deterministic test:
1. Turn A: user "send an email to pateln062@gmail.com saying I'm available tomorrow" → stub `GMAIL_SEND_EMAIL` returns `{id, threadId: "19e9976612c3c003"}`.
2. Persist the turn via `ConversationMessageStore`.
3. Turn B: user "reply to that same email" → assert the planner's seeded history **contains** `threadId 19e9976612c3c003`, and (with a stub planner that echoes its history) the reply path can reach the thread id **without** a clarifying question.

Plus unit tests per phase: store round-trip preserves tool results + pairs; replay loader is tool-pair-safe + char-bounded; verify-model resolution; tool-result shaper preserves `threadId`.

## Production-readiness checklist
- Persistence + summarization **off the hot path** (never block TTS).
- Tool-pair integrity (orphan guard) on every replay/compaction.
- Privacy: store ids/recipients/subjects, **never bodies**; honor the existing forget/soft-delete; TTL.
- Caching: compact only at a threshold; append after the cache boundary; never mutate the prefix mid-call.
- Feature-flagged per phase; additive `addColumnIfMissing`-style migration; backward-safe.
