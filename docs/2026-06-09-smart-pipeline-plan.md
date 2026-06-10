# Making KAIROS's Main Pipeline as Smart as Possible — Plan
**Date:** 2026-06-09 · Synthesizes best-in-class research (context engineering, tool-result shaping, model escalation) onto KAIROS's actual code. Build order at the end.

**Organizing principle (Anthropic):** put in the model's window the *"smallest possible set of high-signal tokens that maximize the likelihood of the desired outcome."* The enemy is **context rot** — recall/reasoning degrade as the window fills with noise. On a *weak/fast* model this is the dominant lever: its effective IQ drops fast as noise rises, so signal-curation often beats the model itself. Three workstreams, each mapped to a file.

---

## 1. Generalized tool-result shaper — `toolExecutor.ts` (✅ BUILT + adversarially reviewed, 2026-06-09)

**Status: shipped in code (not committed).** `shapeObservation()` replaces the list-only `shapeToolResult`: shape-based (list / single-object / scalar / text / error), NL headline + compact structured tail, small results pass through losslessly, blobs/noise dropped, ids/handles/URLs preserved, single-read body kept as a clamped excerpt, Composio `{data,successful,error}` envelope handled incl. **double-wrap `data.data` collapse** and **falsy-error (0/false/"") = not-a-failure**, circular-ref safe. Raw kept on `ToolResult.result` for the verify gate/replay. Optional cheap-LLM prose distiller wired through `agentLoop` deps → background + foreground (reusing each lane's fast model), **gated to over-budget prose only**, **extractive + faithfulness-validated** (id whole-token match; number digit-stream so "$1,234.56"→"1234" is faithful but "99999" is rejected), **abort-cancellable + 2.5s timeout**. A 2-reviewer adversarial pass found 7 real data-loss/edge bugs — all fixed. **273 agent tests green** (`toolExecutor.shape.test.ts` 21 cases). Restart the daemon (runs from source) to pick it up. — original design below:

## 1. Generalized tool-result shaper — `toolExecutor.ts` (BUILD FIRST)

**Why first:** highest leverage, most contained, lifts *every* tool turn on *both* tiers, low risk. Today `shapeToolResult` only handles list results via a hardcoded `KEEP_FIELDS` and only for lists; single objects go out as raw `JSON.stringify`. Replace with a principled shaper that works on **shape (type/size/cardinality), not field-name guessing**, and keeps the raw for KAIROS.

**Design (research-backed):**
- The shaper sits between tool execution and the observation written to the model, producing **two artifacts**: a **distilled observation** (model sees) + **retained raw** (system keeps, keyed by `callId` → `rawRef`). [Anthropic tool-result clearing; ReAct observation]
- **Decision tree:** classify shape → `error | scalar | object | list | text/html`. **Deterministic shaping first** (extraction + flatten depth≤2 + top-N + truncation). Fits budget → ship. **Cheap-LLM distill ONLY when still over budget AND content is unstructured prose/HTML** — never LLM-summarize structured rows (you'd lose ids/precision). "Extractive before abstractive."
- **Per-shape:** OBJECT → keep declared/scalar fields, resolve handles to `label (handle)`, drop big blobs; LIST → `N items (top K)` + compact one-liners + numeric min/max/sum + middle-elision; TEXT → strip markup, head+tail elision, LLM-distill if over budget; ERROR → message + code, never a stack trace.
- **Render = hybrid:** an NL headline (weak model reasons here) + a compact structured tail (ids + cited field-paths). e.g. `Order #A1742 — paid, £42.50, sent to Stream POS.` + `{status, total_pence, order_handle, fields:{status←payment.state}}`.
- **Accuracy guardrails (critical — distillation can omit/hallucinate ~1.5%/3.5%):** deterministic extraction owns ALL numbers/ids/statuses; the cheap LLM may only *phrase*, under an extract-not-invent prompt; a **post-distill validator** checks every numeric/id token appears in the raw → else fall back to deterministic truncation. Keep raw for the verify gate (matches KAIROS grounded-verify: claim ⊆ ledger).
- **Handles:** show a human label, keep a stable opaque id reachable for follow-up actions (Anthropic: resolving UUIDs→names cut hallucination).
- **Per-toolkit formatters** for the heavy hitters (gmail/calendar/linear/slack/web-search) as `fieldHints`; generic structural shaper as the fallback. Optionally read salience from the Composio output schema.
- **History compaction:** after a result is K turns old, replace its observation with a mask `[result for <tool> hidden — N tokens, rawRef=…]` (observation masking ≈ LLM-summary quality at ~52% less cost; matches Anthropic tool-result clearing). Restore on demand if the agent re-references the handle.
- Defaults: `verbosity:"concise"`, ~2k tokens/tool, 25k hard cap (Anthropic).

**Keeps raw for KAIROS** ✓ (the user's requirement) — raw retained by `callId`; verify gate / follow-up tools / replay read it; the model never re-reads it.

---

## 2. Autonomous escalation — `conductor.ts` (✅ BUILT, 2026-06-09 — "fast-front collapse")

**Status: shipped in code (not committed), 971 daemon tests green.** Per the user's choices: full collapse (classifier OUT of the hot path), keep existing tier models, ~6s think cap, sparse background updates.
- **Fast-front:** every turn → ONE fast completion (with recent turns as real messages + `FRONT_ADDENDUM` routing rules). The model either ANSWERS (chit-chat — now 1 LLM call instead of classify+answer = faster) or routes via a first-line directive: **`[[task]]`** → smart planner (tools, streaming, verify gate — context rebuilt at smart tier) · **`[[think]]`** → `thinkLlm` (deep tier, `buildAgentLlmCompleter('deep')`) synchronous under `KAIROS_THINK_TIMEOUT_MS` (6s default) → on timeout converts to `spawn_background_task` + "I'll get back to you". An optional ≤8-word say-line after the directive is spoken immediately (latency mask), sanitized. Escalation-biased by prompt ("when in doubt → [[task]]; never claim to have done anything"); the front has NO tools so it structurally cannot act/claim falsely.
- **Escape hatch:** `KAIROS_CLASSIC_ROUTER=1` restores the old classify→route flow (kept as `classicFlow`).
- **Events/compat:** `agent_intent` tier reflects the route (fast/smart/deep); planner path unchanged (acks, stream, block-writes, replay, activity log all as before).
- **Sparse background spoken updates** (user request): at most ONE mid-run spoken update per task, only after `KAIROS_BG_UPDATE_AFTER_MS` (60s default) of running, via the idle-aware speak path; `KAIROS_BG_SPOKEN_UPDATES=0` disables (`backgroundSubsystem.ts`).
- **Tests:** `conductor.fastfront.test.ts` (9 cases: routes, say-line ordering, think timeout→bg conversion, fallbacks, recent-turn threading, classic escape, directive scrubbing) + 2 bg-update tests; old conductor tests migrated to the front (classic-specific ones pinned via env). — original design below:

## 2. Autonomous escalation — `conductor.ts` (BUILD SECOND)

**Goal:** fast is the always-on conversational front; it delegates to smart (sync) / deep (async) by its own judgment. Three outcomes per turn:
1. **`answer_now`** — fast speaks its own answer (chit-chat, acks, single known facts).
2. **`think_harder(query)`** — **synchronous** hand-off to the smart+thinking model; needed when a *correct spoken answer this turn* is required and fast can't confidently produce it. Caller waits → must be speech-masked.
3. **`spawn_background_task(task)`** — **async** hand-off to the deep agent for long/multi-tool work; fast speaks a commit-phrase, turn ends, result surfaced later (exists already).

**Make the weak model's decision robust (the key finding — small models are overconfident → systematically *under*-escalate):**
- **Router rules FIRST** (no double-latency on obvious cases): consequential/irreversible intent (send/pay/delete/book) → **always escalate to strong** regardless of confidence (FrugalGPT: once error-cost dominates, skip the cascade); long/research/multi-tool → background; greeting/known-fact → answer_now.
- Otherwise the fast model emits a **discrete decision** `{answer_now|think_harder|background}` + a binary `can_i_answer_correctly_now` — *not* a verbalized confidence %. Discrete tokens calibrated to correctness beat verbalized confidence (Self-REF; AgentCollab structured progress assessment).
- **Bias the threshold toward escalation** — ties/maybes escalate. A wrong escalation costs (maskable, recoverable) latency; a wrong `answer_now` is a confidently-wrong spoken statement (not recoverable). Asymmetric cost → asymmetric threshold.
- Optional: self-consistency — if the fast answer flips across a quick paraphrase, force `think_harder`.

**Mask the sync `think_harder` latency (voice budget is 300–500 ms TTFA; thinking model = seconds):**
1. At decision time, fast immediately speaks a **content-relevant interim** that commits to no facts: *"Good question — let me work that out."* (Sierra: be relevant, not a content-free "uh-huh".)
2. **Stream** the strong model's answer sentence-by-sentence as it arrives.
3. Generic "thinking" sound only as a fallback if the strong model's first token is still missing (LiveKit), capped per caller.
4. **Predictive prefetch:** start the strong model the instant the decision fires (speculatively on the partial transcript for consequential intents).
5. **Hard timeout (~4–6 s):** convert to background ("this is taking a moment — I'll get back to you") rather than dead air past the 2 s disengagement threshold.

**Never answer-then-escalate** (double-latency + contradiction). The only thing spoken before escalation is the fact-free interim bridge.

**Also (from the earlier analysis):** point the smart tier at a frontier model and **enable thinking** for the `think_harder` path (today thinking is force-disabled for latency — that's fine for `answer_now`, but `think_harder` should reason). This is the single biggest raw-smartness lever.

---

## 3. Context engineering + ecosystem hygiene (✅ BUILT, 2026-06-10 — production pass)

**Status: shipped in code (not committed), all suites green (1 pre-existing voice boot-timeout, 1 flaky file-watch test pass isolated), live-verified.** Sources: the Anthropic/Copilot research + the non-proactive steals from `docs/research/2026-06-08-proactive-repos-handoff.md` (memU/Hermes observation masking, GAIA background banner + anti-slop, Vellum description discipline).
- **Pre-retrieval gate** (`contextBuilder.needsMemoryRecall`): greetings/acks/compound filler skip memory recall entirely — deterministic, 0ms, no irrelevant hits polluting the window (memU's RETRIEVE/NO_RETRIEVE, done without an LLM for voice latency).
- **Per-turn delta budget + hygiene** (`renderDelta`): each memory hit clipped to 300 chars, recent turns to 400, whole delta hard-capped ~2.6k chars; hits carry **age annotations** ("[L3 · 3d ago]") and the memory section is labeled *"may be stale; live data still needs a tool"* (grounding nudge).
- **Observation masking in replay** (`conversationMessageStore.maskToolResult` + `keepRawTurns`, default 2, env `KAIROS_REPLAY_KEEP_RAW_TURNS`): tool results in older turns collapse to `[older result, body elided] … handles: threadId=…, id=… | ok` — Hermes-style ~half the tokens with the ids preserved so "reply to that same email" still chains. Recent turns stay raw.
- **Few-shot routing exemplars** in `FRONT_ADDENDUM` (13 examples: answer/task/think incl. follow-up "yes" and explicit think-asks) — small models follow examples far better than rules; fixes the stochastic routing.
- **Skill-tool hygiene** (`skillToolAdapter`): every crystallized skill is described as `Saved procedure "name": … (Use ONLY when the request matches this exact procedure; for ordinary app actions use search_tools/execute_tool)` — a skill description can never outbid real app tools again.
- **Meta-skill ban at crystallization** (`crystallizer.isMetaSkill` + reject in `crystallize()`): router/orchestrator/"any request"/"appropriate tool"-shaped skills are rejected at the source, so the junk class (agent-turn-smart) cannot regrow.
- **Background-agent discipline v2** (`BACKGROUND_ADDENDUM`): GAIA-banner essence — no questions/no filler/plan-then-execute, **park-the-unanswerable-question in the final report**, verify-before-claim, results-first spoken report with counts/names + ONE learning line.
- Tests: `contextBuilder.quality.test.ts` (gate + budget + age), `conversationMessageStore.masking.test.ts` (handles survive, old masked, recent raw), `skillToolAdapter.hygiene.test.ts`, `crystallizer.test.ts` (meta rejection). Live smoke: greeting (no recall) + calendar (full tool chain) verified on the real daemon.

**Remaining (deliberately deferred):** JIT recall tools for the planner (`search_activity` exists as kairos_activity; a general `recall` tool is a small follow-up), L0/L1/L2 layered summarization of long history (rolling summary covers the basic case), salience-weighted memory ranking inside the L2/L3 stores (they already use hybrid FTS5+vector RRF — good enough until proven otherwise), Learnings-store harvesting from background reports (AwmWorker already mines trajectories).

## 3. Context engineering — `contextBuilder.ts` (original design)

Map the Copilot/Cursor/Claude-Code/Anthropic playbook onto KAIROS's sources (memory, activity log, screen/world state, conversation, persona/soul, Composio catalog):

- **Retrieve + rank, don't stuff.** Score memory/activity candidates for relevance to *this* utterance; include only top-k within a token budget. Use the cheapest signal that ranks well (token-overlap/recency first; embeddings if cached) — Copilot's neighbor-window+Jaccard, Aider's PageRank centrality, Cursor's embedding NN are the references.
- **Recency + relevance + placement.** Keep last N conversation turns (recency); add top-k relevant memories (relevance); **place highest-signal at the start and end** of the window (LLMs are weakest in the middle — "lost in the middle", up to 15-pt swings).
- **Just-in-time / agentic retrieval (hybrid, Claude Code model).** Eagerly inject only the small, durable, high-signal core (persona/soul = KAIROS's `CLAUDE.md`); give **tools to pull** the rest on demand (`recall`/`search_activity`/`read_memory`) rather than pre-loading. Avoids stale/bloated context; the model's own reasoning picks what's relevant.
- **Compaction.** KAIROS already has a rolling summary; add **observation masking** (shared with §1) and trigger roll-up near ~70% budget, preserving load-bearing facts (decisions, open threads) and dropping redundant tool outputs.
- **Tool-description quality.** Critical because of the `search_tools`/`execute_tool` indirection — the model can only pick well if each tool's description is crisp/accurate. Audit + tighten.
- **Token budget + headroom.** Cache stable blocks (persona/rules) with prompt-cache hints (KAIROS has layered blocks); keep volatile blocks (time/screen) fresh; **leave headroom** for reasoning + tool results — a brimming window has no room to think.
- **Voice-specific:** assembly must be fast (cheap signals, cached embeddings) and the window tight (voice answers are short — don't bloat).

---

## Build order (by leverage × containment × risk)
1. **Tool-result shaper** (`toolExecutor.ts`) — contained, lifts every turn, low risk, keeps raw. **Start here.**
2. **Escalation** (`conductor.ts`) — biggest smartness jump; needs the smart-tier→frontier+thinking change + speech masking. Router rules first.
3. **Context engineering** (`contextBuilder.ts`) — broadest; partly present (layering, rolling summary); do incrementally: ranked retrieval → JIT pull tools → masking → tool-desc audit.

## Sources
Anthropic (effective context engineering; writing tools for agents; tool-result clearing), ReAct, FrugalGPT (TMLR 2024), Speculative Cascades (Google 2025), GATEKEEPER (2502.19335), Self-REF (2410.13284), AgentCollab (2603.26034), Lost-in-the-Middle (2307.03172), GitHub Copilot internals, Cursor indexing, Aider repomap, LlamaIndex response synthesizers, Composio processing-tools, Hermes observation masking, Sierra / LiveKit / AssemblyAI / Hamming voice-latency. (Full URLs in the workflow research output.)
