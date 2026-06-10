# Smarter Pipeline — Batch 2 (2026-06-10)

Eight production features shipped end-to-end in one pass: schema prefetch, JIT memory
recall, learnings harvest, recorder-side failure filter, voice cost metering,
drain-grace supersede, layered conversation history, and streaming think.
All unit-tested (575+ tests green across suites) and live-verified against the running
daemon. Nothing committed (house rule); the daemon runs from source so a restart applies
everything.

---

## 1. Schema prefetch + schema-on-failure teaching

**Problem:** `search_tools` returned full JSON Schemas per tool, but the tool-result
shaper (`shapeObservation` → `compactScalars`) drops non-scalar fields — the model
NEVER saw the schemas. First calls guessed args and failed (the CREATE_EVENT incident).

**Fix:**
- `src/daemon/agents/schemaCompact.ts` — `compactSchemaLine(schema)` renders a JSON
  Schema as one signature line: required-first, `*` = required, enums inlined, one
  nesting level, `+N more optional`, 320-char cap.
- `search_tools` (toolDispatch.ts) now returns **TEXT** (strings pass the shaper
  losslessly): `Found N tools (* = required arg)…` with `args:` signature per hit.
- `execute_tool` failures (envelope OR thrown) get `Expected args for TOOL (* =
  required): …` appended to the guidance — the model's next call is schema-correct.
  Raw provider results are never mutated (copies only); guidance hunting is shared via
  `envelopeFailureText()` exported from toolExecutor.ts.

**Live proof:** "add a comment saying 'shakedown ok' to the linear issue called test3" →
search → search → LINEAR_SEARCH_ISSUES (first try) → LINEAR_CREATE_LINEAR_COMMENT
(first try, correct `issue_id`+`body`) → precise spoken report. Zero failed calls.

## 2. JIT `recall_memory` tool (planner)

`src/daemon/agents/recallTool.ts` — the per-turn delta injects memory keyed on the
UTTERANCE; `recall_memory(query)` lets the planner pull memory MID-TASK with its own
query. Same hygiene as the delta: FAILURE_ECHO filtered, `[L3 · 3d ago]` age
annotations, text output, 300-char/hit clip. Registered in `actionTools` (index.ts),
added to verifier LOCAL_TOOLS (never approval-gated). Live-verified (returns fused
L2+L3 hits with ages; honest miss handling). Note: overlaps with `kairos_memory_search`
(the MCP introspection tool) — the model may pick either; recall_memory is the curated
one.

## 3. Learnings harvest (background lane)

BACKGROUND_ADDENDUM now asks for an explicit final `Learning: <one sentence>` line
(only when a genuinely reusable lesson exists). `extractLearning()`
(backgroundSubsystem.ts) peels it off the report — **stored, not spoken** — into the
L2 episodic store with `source: 'learning'` (wired in index.ts via
`__kairosEpisodicStore`). Guards: 8–240 chars, FAILURE_ECHO rejected (a failure excuse
is never a lesson), session-scoped dedupe, store errors never break the lane.
Recalled later by both the context delta and recall_memory.

## 4. Recorder-side failure filter (self-poisoning, closed for good)

`src/daemon/memory/voiceObservation.ts` — `voiceTurnObservation(utterance, reply)`
drops a failure-narrative REPLY at **write time** (the injection-side FAILURE_ECHO
filter already protected reads). The user's words are always kept. Wired at the
per-turn episodic record in index.ts.

## 5. Voice cost metering (record-only)

The voice/agent path bypassed the cost ledger entirely. Now:
- `OpenRouterAdapter` reports EVERY call (once, incl. aborted streams) to
  `(globalThis).__kairosLlmUsage` with exact provider tokens (chars/4 estimate
  fallback) + a `usageLabel` (`voice_fast/smart/deep`, `planner_smart/fast`, `verify`,
  `subagent`, `memory`, `agent`).
- Deepgram TTS (chars), Deepgram STT (metadata.duration / PCM math), Whisper STT
  report to `__kairosVoiceUsage`.
- `src/daemon/llm/usageMeter.ts` — hook builders writing into the same `llm_call_log`
  via CostTracker. **Record-only: voice is metered, never budget-blocked.**
- Rates env-overridable: `KAIROS_PRICE_TTS_CENTS_PER_1K_CHARS` (1.5),
  `KAIROS_PRICE_STT_CENTS_PER_MIN` (0.43).

**Live proof:** llm_call_log now shows voice_fast/voice_deep/planner_smart/verify/
subagent/memory/voice_tts rows with real costs (whole shakedown ≈ 11.5¢).

## 6. Drain-grace supersede (truncation diagnosis #4-b)

`src/daemon/voice/drainGrace.ts` — on supersede, a short nearly-finished spoken tail
(≤ `KAIROS_DRAIN_GRACE_CHARS`=120) is allowed to FINISH its sentence (capped at
`KAIROS_DRAIN_GRACE_MS`=2500) instead of being cut mid-word; a long in-flight reply
is a real interrupt and cancels immediately. `StreamingSpeaker` gained `remaining()`
(buf + queue + mid-TTS phrase) and `drainQuietly(capMs)` (flushes a punctuation-less
tail). The conductor turn is still aborted either way. **Fired 6× during the live
shakedown** ("supersede: let the prior reply tail finish").

## 7. Layered conversation history (L0 → L1 → L2)

`conversationMessageStore.ts` — the pyramid:
- **L0**: most recent 8 turns raw (existing, with observation masking).
- **L1**: aged-out turns get a **deterministic** one-line digest each (NO LLM — free,
  instant, can't hallucinate): `user: "…" → KAIROS: "…" (via gmail send email;
  threadId=…)` — execute_tool unwrapped, handles extracted. New table
  `conversation_turn_digests`. Window `KAIROS_HISTORY_L1_TURNS`=24.
- **L2**: turns older than L0+L1 fold into the rolling summary (LLM, incremental);
  their digests are deleted — each fact lives in exactly one layer.
`loadForReplay` injects `[L2 summary] → [L1 digest block (≤3000ch)] → raw turns`.
Compaction now kicks after **every** persisted turn (fast chit-chat included — was
smart-turns-only, so chatty conversations never compacted).

**Live proof:** 13-turn conversation → 5 digests in the table; "what color do I like
again?" answered correctly after the teal turn aged out of the raw window.

## 8. Streaming think

`conductor.streamThink()` — the deep answer streams sentence-by-sentence
(OpenRouterAdapter.stream → SpokenStreamFilter → shared StreamingSpeaker):
- The request fires BEFORE the ack is spoken (lazy-generator prefetch) — the ack masks
  model startup.
- The cap became a **first-token deadline** (`KAIROS_THINK_FIRST_TOKEN_MS`, default
  max(cap, 20000)): reasoning stays internal (excluded), so the first CONTENT delta
  means "answer started" — from there the answer runs to completion under a generous
  hard wall (`KAIROS_THINK_HARD_CAP_MS`=60000), masked by its own audio.
- Thinks on the **SLIM fast-tier system prompt** (think is tool-less; the full smart
  prompt made minimax-m3 reason silently past 12s — measured ~3s first-token slim).
- Fillers at 5s/13s only before speech begins; barge-in cancels cleanly; no first
  token → background conversion (goal = user's words verbatim); transcript persisted.
- Blocking path kept as fallback (no thinkStream wired / tests).

**Live proof:** "think it through: should I lease or buy a car?" → 8 delta chunks
streamed live, full substantive answer, no background conversion.

---

## Env knobs added
| Var | Default | What |
|---|---|---|
| `KAIROS_THINK_FIRST_TOKEN_MS` | max(think cap, 20000) | streaming think first-token deadline |
| `KAIROS_THINK_HARD_CAP_MS` | 60000 | streaming think hard wall |
| `KAIROS_DRAIN_GRACE_CHARS` | 120 | supersede tail size that may finish |
| `KAIROS_DRAIN_GRACE_MS` | 2500 | max drain wait |
| `KAIROS_HISTORY_L1_TURNS` | 24 | digest-layer window |
| `KAIROS_PRICE_TTS_CENTS_PER_1K_CHARS` | 1.5 | TTS metering rate |
| `KAIROS_PRICE_STT_CENTS_PER_MIN` | 0.43 | STT metering rate |
| `KAIROS_MONTHLY_BUDGET_USD` | 50 | ledger constructor (record-only here) |

## Verification
- Suites: agents 342 ✓ · voice 79 ✓ (+1 pre-existing integration boot-timeout fail) ·
  llm 63 ✓ · wrapApi ✓ · connectors 136 ✓ · memory all green per-file (suite-level Bun
  teardown crash is pre-existing). `bun build` bundles clean (1053 modules).
- Live (headless daemon, `test_inject_utterance`): calendar first-try · Linear
  discovery+write first-try with the new search format · streaming think live ·
  recall_memory live · background task + spoken report · cost rows in llm_call_log ·
  L1 digests built · drain-grace fired 6×.

## Observed, out of scope (pre-existing)
- `[skills] curator failed: path must be a string or TypedArray` warn at boot.
- Composio re-drops the half-connected `twitter` toolkit at every boot (self-heal
  works; the connectionStore row apparently keeps re-qualifying for the session).
