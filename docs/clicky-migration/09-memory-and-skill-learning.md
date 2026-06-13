# 09 — Memory + self-learning across the Codex swap

How KAIROS's memory stack (persona/soul.md, L2/L3/L4 tiers, conversation
replay, per-app knowledge docs) and its self-learning loop (trajectories →
AwmWorker → crystallized skills) **survive intact** when `[[task]]`/`[[think]]`
move onto the warm `codex app-server` brain (01).

**The thesis, in one line:** *KAIROS owns the user model; Codex's home is
generated and disposable.* Self-learning reads the **file** trajectory store,
never the model — so once each Codex turn emits the same `TrajWriter.record()`
shape the foreground/background already produce, the AWM pipeline keeps working
**with zero changes**. Memory is fed to Codex *both* as turn `instructions`
**and** as an MCP `recall_memory` tool (asymmetric split below).

Reference for every design call: openclicky's `CodexVoiceSession` injects
"voice policy AND memory" as the per-turn **input text** (`composePrompt`,
CodexVoiceSession.swift:571–600) and puts durable doctrine in `thread/start`
`baseInstructions` read from a `modelInstructionsFile` (the AGENTS.md
equivalent, :578) — it does **not** expose memory as an MCP tool. KAIROS goes
one step further (both layers + a recall tool) because our memory is richer.

---

## A. What Codex provides natively vs what KAIROS owns

| Capability | Codex 0.133.0 native | KAIROS-owned (authoritative) | Decision |
|---|---|---|---|
| **Durable doctrine** | `AGENTS.md` (root + CWD-to-root auto-included; `AGENTS.override.md`, `~/AGENTS.md`; `/init` generates) + `thread/start baseInstructions` | `ContextBuilder.buildSessionPrefix()` cached prefix (persona/soul.md + About-the-user + MEMORY.md overview + standing orders + character/talk/act rules) | KAIROS writes its prefix INTO the codex home's AGENTS.md / instructions file on every (re)generation. Never author KAIROS facts in codex's own AGENTS.md by hand. |
| **Long-term facts / episodes** | persistent SQLite thread history in `CODEX_HOME` (`state_*.sqlite`, `history.persistence`), per-thread `memoryMode`, `memory/reset`, `memory_consolidation` | L2 EpisodicStore (`mem_l2_observations` FTS5 + hybrid vector recall, soft-delete) + L3 semantic + L4 procedural skills, merged by `MemoryInjector` | **KAIROS owns it.** Codex's home is disposable/regenerated; we never let it be the source of truth for the user model. `memoryMode=disabled` is acceptable since we feed memory ourselves. |
| **Per-turn relevant memory** | nothing automatic | utterance-keyed L2(≤3)+L3(≤5) delta from `buildTurnDelta`, self-echo-stripped | Injected as the **turn `instructions`** (B) + on-demand **`recall_memory` MCP tool** (C). |
| **Conversation continuity** | thread SQLite, `thread/resume`, `thread/fork` | `ConversationMessageStore` (full LoopMsg transcript incl. tool ids/threadIds; layered L0/L1/L2 replay; rolling summary) | **KAIROS-authoritative** (F). One thread per `conversationId`, Codex's history kept minimal to avoid double-history. |
| **Web** | native Responses `web_search` (`--search`) | free DDG `web_search`/`read_webpage` tools | Codex-native on responses path; KAIROS DDG only for fast-tier/background (08). Out of scope here. |
| **Self-learning / skills** | `[[skills.config]]` dirs (Codex loads bundled+learned skill dirs) | TrajWriter → AwmWorker (cluster on intent_id + tool-seq, ≥3×>5tools×>30s) → SkillCrystallizer → PersonaGate → `<sandbox>/skills/active/` | **KAIROS-owned induction.** Crystallized skills surface as MCP tools to Codex (D); we do NOT outsource skill genesis to codex's skills loader. |
| **Persona / soul.md** | none | `soul.md` digest (vibe/core-truths/boundaries) + `KAIROS_PERSONA_TONE` layer | Rides in the durable prefix → AGENTS.md (E). |
| **Per-app knowledge** | none (HeyClicky ships ~28 app `.md` playbooks they inject) | `knowledge/apps/<app>.md` (05.B) | Appended to the **turn instructions** when a turn targets an app (G). |

**Hard rule:** the daemon is the source of truth. Anything written into
`CODEX_HOME` (AGENTS.md, instructions file, skill dirs) is a **projection** that
the daemon re-writes on every home (re)generation. A `delete-and-regenerate` of
`state/codex/home` must lose **nothing** that matters (05.F).

---

## B. + C. Inject memory as turn `instructions` AND expose `recall_memory` as MCP — BOTH

The decision is **both, asymmetrically split** — mirroring openclicky's two
layers, extended with a tool for mid-task pulls:

1. **DURABLE doctrine → `thread/start` instructions (the AGENTS.md layer).**
   Write the **cached session prefix** (`buildSessionPrefix().system`:
   persona/soul.md + About-the-user + MEMORY.md overview + standing orders +
   character + talk + act rules) into the codex home's instructions file ONCE
   per thread. This is the slow-changing doctrine; it lives in the prefix cache
   today (contextBuilder.ts:55–172) and is exactly what openclicky reads from
   its `modelInstructionsFile` at `thread/start` (CodexVoiceSession.swift:578).

2. **VOLATILE per-turn memory → `turn/start` instructions (the composePrompt layer).**
   Pass the **fresh per-turn delta** — utterance-keyed L2/L3 hits + recent turns
   + date/time + connected apps (+ lessonContext + per-app doc, G) — as the
   turn's instructions. This is *exactly* what `contextBuilder.build()` already
   returns (`## Right now` + `## Current context`, contextBuilder.ts:231–234)
   and what `composePrompt` ships per turn in openclicky. **Call
   `contextBuilder.build()` to produce the Codex turn instructions** rather than
   re-implementing assembly — that way all hygiene comes for free:
   `needsMemoryRecall` pre-gate, `isSelfEchoMemory` drop, `stripSelfEcho`
   (contextBuilder.ts:191–205). Skipping this re-opens the promise/denial-echo
   poisoning that was fixed for the planner (the 2026-06-10 learned-helplessness
   bug).

3. **MID-TASK pulls → `recall_memory` MCP tool (the surprise layer).**
   `buildRecallTool` already returns a `ToolDef` (recallTool.ts:26–65, wired at
   index.ts:2026–2031). Expose it on the KAIROS MCP server (08) so Codex can
   pull memory with its OWN query mid-turn ("did the user ever mention a
   dentist?"). Same self-echo hygiene; returns plain text. This is a round-trip
   (Codex → MCP → MemoryInjector → FTS/vector) so it must **not** replace the
   cheap pre-injected delta — the delta covers the common case at turn open; the
   tool covers mid-task surprises.

Why all three: the prefix is the personality/rules (set once, cached); the
turn delta is the relevant-right-now memory (cheap, pre-fetched, the 90% case);
the tool is the escape hatch for memory the delta didn't anticipate. Dropping
any one regresses something (no prefix → no persona; no delta → cold opens; no
tool → mid-task amnesia).

### Where the prefix goes in the codex config

The durable prefix is written as the model-instructions file referenced by the
generated config (mirrors openclicky's `modelInstructionsFile` and HeyClicky's
`ClickyModelInstructions.md`). Confirm the exact 0.133.0 surface via
`codex app-server generate-ts --experimental` — the candidates are: (a) the home
`AGENTS.md`, (b) a `[instructions]`/`base_instructions` config field, (c) the
`thread/start { baseInstructions }` param. Pick the one that survives a thread
restart cleanly; openclicky uses (c) seeded from a file on disk. Write it on
**every** CODEX_HOME (re)generation — never only into the disposable home, or a
regen wipes the persona (05.F).

---

## D. Codex turn trajectories → AwmWorker skill-genesis

**Self-learning is unchanged because AwmWorker reads the FILE store
(`~/.kairos/traj/YYYY-MM-DD.md`), never the model** (awmWorker.ts:140–151).
AwmWorker clusters on `intent_id + sorted action-tool sequence`
(awmWorker.ts:163), requires `≥3 occurrences × >5 tool calls × >30s × outcome
'success'` (awmWorker.ts:20–26,153–158), crystallizes via SkillCrystallizer,
gates via PersonaGate, lands skills in `<sandbox>/skills/active/`. None of that
touches the brain. The ONLY new work is a **translator at the CodexBrain
boundary** that emits one `TrajEntry` per turn — exactly like the background
lane already does at index.ts:2386–2413.

### Where trajectories are captured from the app-server event stream

The translator accumulates a per-turn ledger from these app-server
notifications (digest-confirmed event names), then writes one `TrajEntry` at
`turn/completed`:

| App-server event | Feeds | TrajEntry field |
|---|---|---|
| `turn/started` | start ledger, capture `t0` | — |
| `item/started` (commandExecution / mcpToolCall / webSearch / fileChange) | push a step | `steps[].action` (tool name) |
| `item/mcpToolCall/progress`, `item/completed` | finalize the step | `steps[].result_summary`, `steps[].observation` |
| `item/agentMessage/delta` | accumulate final text (also → TTS) | (final text, for outcome) |
| `turn/plan/updated` | ignore for traj (it's `update_plan`, filtered like the digest does at conversationMessageStore.ts:120) | — |
| `thread/tokenUsage/updated`, `turn/completed.time_to_first_token_ms` | metering (05.G), not traj | `llm_cost_cents` (optional) |
| `turn/completed` (status) | **flush the TrajEntry** | `outcome`, `duration_ms` |

```
codex app-server notifications
        │  (CodexBrain translator — same module that maps → LoopEvents)
        ▼
  TrajEntry {
    ts, task_goal: utterance,
    intent_id: 'codex_smart' | 'codex_deep',   // per-turn coarse id (see below)
    args_summary: utterance.slice(0,200),
    steps: [{ action: <UNWRAPPED tool name>, result_summary, observation? }],
    outcome: turn/completed.status → 'success'|'failed'|'cancelled'|'partial',
    duration_ms: now - t0,
  }
        ▼
  __kairosTrajWriter.record(entry)   ← SAME global the bg lane + conductor use
        ▼
  ~/.kairos/traj/YYYY-MM-DD.md  (append-only YAML, secret-sanitized)
        ▼
  AwmWorker.runOnce()  (timer/test_run_awm) → cluster → crystallize → PersonaGate
        ▼
  <sandbox>/skills/active/<skill>/   → SkillRegistry hot-reload → MCP tool (D loop closes)
```

### Trajectory design: unwrap MCP names or self-learning degrades

AwmWorker clusters on the **sorted action-tool sequence**
(awmWorker.ts:163–166). Two pitfalls the translator MUST handle:

1. **MCP namespacing.** Codex reports MCP tools namespaced
   (`kairos__guide_user`, `kairos.search_tools`). Strip the `kairos`
   namespace before writing `steps[].action`, or every tool collapses to a
   different signature than the in-house loop produced and clusters never match
   across the brain swap. (This same stripping is needed for the verifier's
   `LOCAL_TOOLS` exemption — do it once in the translator, see 01.D / 08.)

2. **`execute_tool` unwrap.** Composio rides the dispatcher
   (`search_tools`/`execute_tool`). If every Composio action logs as
   `execute_tool`, the cluster signature degrades to noise. **Reuse the
   `buildTurnDigest` unwrap logic** (conversationMessageStore.ts:116–120):
   when the tool is `execute_tool`, read `args.tool_name` and record THAT (e.g.
   `gmail_send_email`) as the action. `update_plan` is dropped, same as the
   digest does.

### intent_id granularity

Default to per-turn `'codex_smart'` / `'codex_deep'` (coarse, simple). This
keeps the bg lane's `'subagent'` convention and is enough for AwmWorker to find
"the deep-research recipe" patterns. If clustering proves too coarse in
practice, the translator can instead key `intent_id` on the dominant unwrapped
tool name (per-action) — the tool-sequence is captured either way, so this is a
tuning knob, not a rewrite. **Recommendation:** ship coarse, measure, refine.

**Net:** the foreground conductor turn, the background sub-agent, AND every
Codex turn all feed the **one** `__kairosTrajWriter`. AwmWorker mines all three
uniformly. The `test_run_awm` daemon hook (index.ts:2858–2875, relaxed
thresholds, off in production) tests the Codex path identically.

---

## E. Persona / soul.md / preferences ride along

All persona surfaces are part of the **cached session prefix**
(`buildSessionPrefix`, contextBuilder.ts:55–172), so they ride into the durable
AGENTS.md/instructions layer (B.1):

- **`soul.md` digest** → `## Persona` header (contextBuilder.ts:70–78); takes
  precedence over the baseline character (contextBuilder.ts:86).
- **About-the-user / learned profile** → `## About the user`.
- **MEMORY.md overview** → `## Long-term memory`.
- **Standing orders** → `## Active standing orders`.
- **Baseline character + `KAIROS_PERSONA_TONE`** → `## Your character`
  (contextBuilder.ts:83–91).
- **Talk/act rules** (spoken-English discipline, grounding, anti-gaslighting) →
  `## How you talk` / `## How you act`.

When persona changes (SoulWizard re-run, profile update), the daemon calls
`contextBuilder.invalidatePrefix()` (contextBuilder.ts:174–176) **and** re-writes
the codex instructions file from the fresh prefix. Treat a prefix invalidation
as a trigger to re-project into CODEX_HOME — the model only sees the new persona
on the next thread (or via a `thread/start` re-seed). Live per-turn persona
hints (`in-focus`, `prefer-terse`) come through the **turn delta** `## Right now`
block (contextBuilder.ts:218–229), not the prefix, so they adapt every turn
without a regen.

---

## F. Conversation replay / episodic memory ↔ Codex threads

**One Codex thread per `conversationId`** (thread/start once, reuse;
01.C). Two history sources must NOT both feed the model (double-history token
bloat + confusion):

- **Decision: KAIROS-authoritative.** `ConversationMessageStore.loadForReplay`
  stays the transcript of record. The layered pyramid (L0 raw / L1 per-turn
  digests / L2 rolling summary), tool-pair-safe windowing, observation masking,
  and handle preservation are already tuned and cross-restart durable
  (conversationMessageStore.ts:178–246, 262–346). Codex's own
  `history.persistence` is kept minimal (or `memoryMode=disabled`) so the model
  doesn't see each turn twice.
- **Where replay enters the turn.** Match the conductor's existing wiring: pass
  `loadForReplay(conversationId)` as the turn's `history` and the contextBuilder
  output as `instructions` — i.e. `runFn(utterance, { tools, instructions,
  history })` (conductor.ts:658–673). The CodexBrain runner consumes the same
  `{ tools, instructions, history }` runner contract; it maps `history` LoopMsgs
  to the `turn/start` `input` array (text items, tool-pair-safe). This is the
  analog of openclicky's `composePrompt` "Recent conversation" section.
- **Persistence after the turn is UNCHANGED.** Keep `appendTurn` +
  `updateRollingSummary` exactly as conductor.ts:712–726 — they run off the hot
  path, keyed on `conversationId`, and don't care which brain produced the turn.

**Episodic / L2/L3** is the per-turn delta (B.2) + the recall tool (B.3); it is
**not** a function of the codex thread. EpisodicStore soft-delete ("forget X")
keeps working — it's a SQLite write the daemon owns, invisible to Codex.

**Block-writes invariant (risk to honor):** the verifier withholds the live
"done, deleted" claim on destructive tools until the gate confirms
(conductor.ts:685–693). Codex streams `item/agentMessage/delta` straight to TTS,
so the StreamSpeechController's `isDestructive` block behavior must be
re-implemented on the Codex delta path — detect the destructive tool early from
the (namespace-stripped) MCP tool name in the event stream and gate the stream,
or a write turn could voice a false "done" before the post-turn verify. This is
the one place the brain swap is NOT transparent and must be handled at the
delta→TTS seam.

---

## G. Per-app knowledge `.md` docs injection

Per 05.B: `knowledge/apps/<app>.md` (frontmatter `{ app, bundle_id?, match:
[name patterns] }`, body = concise operating notes). When a turn targets an app
(open_app / read_screen app / frontmost app on a guide/act/do ask),
`contextBuilder` appends the matching doc to the **turn instructions** — the
SAME channel as `lessonContext` (conductor.ts:664–669, `instructions =
${ctx.system}\n\n${lessonContext}`). For Codex this means the app doc is part of
the `turn/start` instructions, cache-keyed by app (cheap, bounded). These are
the ONLY `.md` docs KAIROS generates (no doc sprawl); eventually KAIROS WRITES
new app docs from successful sessions — which **ties back to D**: a clustered,
crystallized app-flow can emit/refresh a `knowledge/apps/<app>.md` as part of
crystallization, closing the self-learning loop into the knowledge layer.

---

## H. End-to-end data flow (one Codex turn)

```
                    ┌─────────────────────── DAEMON (source of truth) ───────────────────────┐
  user utterance →  │ contextBuilder.build({utterance,tier,conversationId})                   │
                    │   ├─ buildSessionPrefix()  (CACHED: persona/soul.md, MEMORY.md, rules)   │  ──(once/regen)──▶ CODEX_HOME instructions file (B.1, E)
                    │   └─ buildTurnDelta()      (FRESH: L2/L3 hits, recent turns, date/apps)  │
                    │       + per-app knowledge doc (G) + lessonContext                        │
                    │ loadForReplay(conversationId)  → history LoopMsgs (F)                    │
                    └───────────────┬─────────────────────────────────────────────────────────┘
                                    │  runFn(utterance, {tools, instructions=delta, history})
                                    ▼
                    ┌────────────── CodexBrain (PlannerRunner, 01) ───────────────┐
                    │ thread = threadFor(conversationId)                          │
                    │ turn/start { input: history+utterance, instructions: delta, │
                    │              effort: smart→low / deep→high }                 │
                    │   tools via MCP [mcp_servers.kairos]:                        │
                    │     recall_memory (B.3) ──▶ MemoryInjector (L2/L3) ──────────┼──▶ daemon
                    │     search_tools/execute_tool (Composio) ───────────────────┤
                    │     guide/act, background, crystallized skills (D) ──────────┤
                    └───────────────┬─────────────────────────────────────────────┘
                                    │  notifications: item/agentMessage/delta, item/mcpToolCall, turn/completed
              ┌─────────────────────┼───────────────────────────────────────────┐
              ▼                     ▼                                            ▼
   assistant_delta → TTS    tool_call_start/done → HUD+activity        translator builds TrajEntry
   (StreamSpeechController,   tree                                     (unwrap execute_tool, strip
    destructive block, F)                                              kairos__ namespace, D)
              │                     │                                            │
              ▼                     ▼                                            ▼
   POST-TURN verifier on (utterance, finalText, toolCallLedger)     __kairosTrajWriter.record()
   (01.D — retryable ⇒ one follow-up turn into SAME thread)          → ~/.kairos/traj/*.md
              │                                                              │
              ▼                                                              ▼
   appendTurn + updateRollingSummary (F, conductor.ts:712–726)   AwmWorker → crystallize → skills/active/
```

Everything left of CodexBrain and everything below the notifications row is
**unchanged KAIROS code**. The only net-new memory/learning code is the
translator (TrajEntry from the event stream) and the projection of the prefix
into CODEX_HOME.

---

## RefactorTargets

- **`src/daemon/agents/codexBrain.ts` (NEW — the seam).**
  - Per turn: call `contextBuilder.build()` for `instructions` (delta layer,
    B.2) + `loadForReplay()` for `history` (F); map to `turn/start`.
  - On `turn/start`/`turn/started`/notifications: translate to LoopEvents
    (01.C) AND accumulate the trajectory ledger.
  - On `turn/completed`: (a) run the post-turn verifier on
    `(utterance, finalText, toolCallLedger)` (01.D); (b) write **one**
    `TrajEntry` to `__kairosTrajWriter` (D) — unwrap `execute_tool`, strip the
    `kairos` MCP namespace, `intent_id='codex_smart'|'codex_deep'`,
    `outcome` from status, `duration_ms` from `t0`.
  - On destructive-tool detection in the stream: re-implement the
    StreamSpeechController block (F) so a false "done" can't be voiced
    pre-verify.

- **`src/daemon/agents/contextBuilder.ts`.**
  Add a method (or expose the existing split) that returns the **cached prefix**
  separately from the **per-turn delta**, so CodexBrain writes the prefix to
  CODEX_HOME once (B.1/E) and passes only the delta as turn instructions —
  instead of `build()` concatenating both (contextBuilder.ts:232). On
  `invalidatePrefix()`, signal the daemon to re-project the prefix into
  CODEX_HOME (E). Append the per-app knowledge doc to the delta (G).

- **`src/daemon/index.ts` (CODEX_HOME generation + wiring).**
  At the planned boot home-generation step (05.F), write
  `ContextBuilder.buildSessionPrefix().system` into the codex model-instructions
  file (re-write on every regen — source of truth, B.1/E). Wire the CodexBrain
  trajectory translator to `__kairosTrajWriter` **exactly like the bg lane at
  index.ts:2386–2413**. Route `tier ∈ {task,think} && KAIROS_BRAIN=codex` →
  CodexBrain, else current handleSmart/handleThink (01.E).

- **`src/daemon/agents/conductor.ts`.**
  In `handleSmart`/`handleThink`, the `KAIROS_BRAIN=codex` branch delegates to
  CodexBrain via `deps.runPlanner` while keeping the SAME
  `onEvent→controller→activity` wiring, the SAME `appendTurn` +
  `updateRollingSummary` persistence (conductor.ts:712–726), and the SAME
  `trajWriter.append` turn-level entry (conductor.ts:132–146) — so replay,
  observability, AND self-learning are untouched by the brain swap.

- **`src/daemon/mcp/kairosMcpServer.ts` (NEW — 08).**
  Expose `recall_memory` (`buildRecallTool`, B.3) on the KAIROS MCP server
  alongside guide/act/Composio/background/skill tools. Crystallized skills from
  `<sandbox>/skills/active/` (SkillRegistry) are advertised here too, closing
  the D loop (learned skill → MCP tool Codex can call).

- **`src/daemon/skills/awmWorker.ts` — NO CODE CHANGE (verify only).**
  Confirm the Codex translator's `steps[].action` values are unwrapped/
  namespace-stripped so `signatureOf` (awmWorker.ts:163) clusters Codex turns
  against in-house-loop turns. The induction pipeline, thresholds, crystallizer,
  PersonaGate, and `skills/active/` output are all unchanged.

- **`src/daemon/persona/trajWriter.ts` — NO CODE CHANGE.**
  Codex turns use the existing `record()` (secret sanitization included,
  trajWriter.ts:41–58). The translator just constructs a valid `TrajEntry`
  (persona/types.ts:35–52).

- **`knowledge/apps/<app>.md` (NEW dir — 05.B).**
  Seed System Settings / Finder / Mail / Safari + demo apps; matched + appended
  to turn instructions (G); future-writable by the crystallizer.

---

## Risks (memory/learning-specific)

- **Double-history:** if both KAIROS injects `loadForReplay` AND Codex keeps
  `history.persistence='save-all'` as a live context, the model sees turns
  twice. Mitigation: KAIROS-authoritative (F); keep codex history minimal /
  `memoryMode=disabled`.
- **Trajectory signature mismatch:** un-unwrapped `execute_tool` or un-stripped
  `kairos__` names → clusters never match → self-learning silently stops finding
  patterns. Mitigation: do both transforms in the translator (D), reuse
  `buildTurnDigest`'s unwrap.
- **Prefix lost on regen:** if persona is written ONLY into the disposable
  CODEX_HOME, a `delete-and-regenerate` wipes it. Mitigation: daemon re-writes
  the instructions file from `buildSessionPrefix` on every regen + on
  `invalidatePrefix` (E, 05.F).
- **Recall-tool latency replacing the cheap delta:** if Codex leans on the
  `recall_memory` round-trip for the common case instead of reading the
  pre-injected delta, every turn pays an MCP hop. Mitigation: keep the delta the
  primary path (B.2); the tool is for mid-task surprises only (B.3).
- **Block-writes regression:** Codex streams deltas straight to TTS; the
  destructive-claim withhold (conductor.ts:685–693) must be re-implemented on
  the delta path or write-turn anti-gaslighting breaks (F).
- **Self-echo poisoning re-entry:** bypassing `contextBuilder.build()` to
  hand-assemble Codex instructions would skip `isSelfEchoMemory`/`stripSelfEcho`
  and re-introduce the learned-helplessness bug. Mitigation: always go through
  `build()` for the turn delta (B.2).

## Open questions (carried to 07)

- Exact 0.133.0 instructions-injection surface for the durable prefix
  (`AGENTS.md` vs `[instructions]` config vs `thread/start baseInstructions`) —
  confirm via `generate-ts --experimental`. openclicky uses a `thread/start`
  file-seeded param.
- intent_id granularity: ship coarse (`codex_smart`/`codex_deep`) vs per-action.
  Recommend coarse, measure clustering, refine.
- Should `recall_memory` also expose `ConversationMessageStore` past-conversation
  replay + the activity log, or stay scoped to L2/L3 as today?
- Destructive-tool stream gating: detect from MCP tool name early enough to gate
  the delta stream, or accept a brief block on `turn/completed`?
