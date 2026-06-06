# KAIROS — Dynamic Loop + Background Sub-Agents (design)

**Date:** 2026-06-01 · **Status:** proposed · **Builds on:** Phase 1 (tool retrieval) + Phase 2 (owned agent loop), both shipped + verified.

## Goal
Make the agentic loop *feel and behave* like Codex/Claude Code: speak live (no dead air), act in parallel, reach common tools instantly, chain multi-step work reliably via generalized production prompts, recover when stuck — and, for heavy/long tasks, **spawn a background sub-agent so the foreground voice stays free and the user can keep talking** (HeyClicky's voice-lane vs agent-lane split). Each phase is TDD'd + live-verified before the next.

The work splits into two batches the user requested:
- **Batch 1 — "Dynamic Loop"** (the 5 points): streaming voice, parallel tools, hot-tool set, multi-step chaining via generalized prompts, reflection/replan.
- **Batch 2 — "Sub-Agents / Background Execution"** (its own phase): foreground-non-blocking background workers + report-back by voice; deep-model/heavy work runs here.

---

## Batch 1 — Dynamic Loop

### 1A. Streaming voice (Phase 3) — "really dynamic and good"
**Problem:** the conductor speaks the whole reply at once *after* the loop finishes (`conductor.ts:119-129`), and tool acks are post-hoc (`:214-228`) → up to ~45s of dead air on smart turns. The loop already emits `assistant_delta`/`tool_call_start`/`tool_call_done`/`final` (`agentLoop.ts:65,97,99,126`); the `StreamingSpeaker` already accepts incremental `feed()/end()/cancel()/begin()` (`streamingSpeaker.ts:25-50`). The only gap: `defaultPlannerRunner` calls `runAgentLoop` **without `onEvent`** (`conductor.ts:287`).

**Design:**
- Add `onEvent` to the `PlannerRunner` contract; `defaultPlannerRunner` passes it into `runAgentLoop`.
- `handleSmart` provides an `onEvent` that drives a **streaming speak controller**:
  - `tool_call_start` → `narrator.speakAck(name)` **live, before the tool runs** ("okay, pulling that up…"). Replaces the post-hoc loop at `:214-228`.
  - `assistant_delta` → `streamingSpeaker.feed(token)` — the final answer is spoken **as it generates**, sentence-by-sentence (the speaker already chunks at `.!?`).
  - `final` → `streamingSpeaker.end()` (flush tail). The conductor no longer one-shot-speaks at `:119-129` for the smart tier (it's already streamed); keep one-shot for fast.
  - On a slow gap before first token, arm `narrator.startFillerTimer()` (currently dead code) → a single "one sec…" filler, cleared on first delta/tool event.
- **Fast tier** also streams: swap `handleFast`'s `fastLlm.complete()` for the streaming adapter's `.stream()`, feeding the speaker.
- **Barge-in preserved:** `streamingSpeaker.cancel()` on a new utterance / abort signal (existing path at `index.ts:2147`); the loop's `signal` already stops mid-stream.
- **Double-speak guard:** a per-turn flag so the smart-tier streamed answer isn't re-spoken by the conductor's final block.

**Tests:** unit — a `StreamSpeechController` that, given a sequence of LoopEvents, calls `feed`/`speakAck`/`end` in the right order and never double-speaks; the empty-final guard still speaks a fallback. Live — "summarize my last 3 emails": first audio starts within ~1-2s, not after the whole turn.

### 1B. Parallel tool execution
**Problem:** the loop runs tool calls serially (`agentLoop.ts:65-74`) → slow multi-tool turns.
**Design:** add optional `concurrencySafe?: boolean` to `ToolDef` (default false). The bridge/retriever marks read-only tools safe (`search_tools`, `*_LIST/_GET/_SEARCH/_FETCH`, calendar/email reads); writes stay false. In the loop's tool round, execute the `concurrencySafe` calls of a turn with `Promise.all` (bounded), serialize the rest. Order of appended tool results preserved by call id.
**Tests:** unit — a turn with 3 safe + 1 unsafe tool calls runs the 3 concurrently (assert via timing/markers) and the unsafe one serially; results all appended with matching ids.

### 1C. Hot-tool set
**Problem:** every action goes through the `search_tools → execute_tool` hop (2 LLM rounds) — slower + more chaining fumbles on common actions.
**Design:** pre-load the user's top ~5 most-used connected tools as **direct** ToolDefs in the planner's core set (alongside search_tools/execute_tool), so common actions ("send email", "create event") skip the search hop. "Most-used" = a simple usage counter persisted per tool (increment on execute_tool dispatch), top-N by count, refreshed on prefix invalidation. Falls back to retrieval for the long tail. Cap to keep the core small (~8 tools total).
**Tests:** unit — a usage tracker returns top-N by count; the hot-set loader exposes them as direct ToolDefs; the toolset stays ≤ cap.

### 1D. Multi-step chaining via GENERALIZED production prompts (Phase 4)
**Problem:** "read the latest email, then delete *that* one" failed — the model didn't thread the `messageId` between steps. This is prompt + model, not loop.
**Design — generalized (no hardcoding), production-grade rewrite of every tier prompt:**
- **Planner/smart system prompt:** add a tight, *general* "working with tools" contract: (a) plan briefly with `update_plan` for ≥2-step tasks; (b) **carry identifiers/values forward** — when a step returns an id/handle, use that exact value in the next call, never a placeholder; (c) after each tool result, decide the next step from the actual result; (d) if a tool errors, try an alternative before giving up; (e) confirm before irreversible actions. All phrased generally (applies to any toolkit), with ONE generic good/bad chaining example.
- **Classifier prompt:** keep fast/smart routing; add the `background` signal (Batch 2) generally ("a long-running or multi-step task that shouldn't block conversation").
- **Fast prompt:** the slim already-split `fastSystem` — tighten for pure conversation.
- **Voice/response-style (folds in old Phase 5):** general rules — plain spoken English, no markdown/bullets/IDs; **summarize collections** ("you've got a few reopened issues — want me to run through them?") instead of enumerating; speak numbers/dates naturally. One good/bad example pair.
- **Narrator + memory prompts:** audit + tighten for production; keep generalized.
- Deep-model escalation (point 4) for genuinely hard chains is delivered via the **background sub-agent** (Batch 2), not a foreground stall.
**Tests:** prompt changes verified live (classifier routing already has a harness; add chaining + response-style live checks). A regression that the prompts contain the key general rules (guards against accidental deletion).

### 1E. Reflection / replan
**Problem:** after repeated tool failures the loop just keeps going or gives up.
**Design:** in the loop, track consecutive tool failures; after N (env, default 2) in a turn, inject a short "re-plan" system note ("the last approaches failed — step back and try a different route or ask the user") before the next model call. Bounded; never loops.
**Tests:** unit — after 2 failed tool results, a replan note is injected into messages before the next round.

---

## Batch 2 — Sub-Agents / Background Execution (own phase)

**The UX (HeyClicky's two-lane model):** the foreground voice is the fast "companion" — it must never block on heavy work. When a task is long/complex, KAIROS **spawns a background sub-agent**, immediately says "on it — I'll let you know when it's done," and stays free to chat. The sub-agent runs the full agent loop (deep model, more turns) detached. When done, KAIROS **proactively speaks the result**. The user can ask "how's that going?" anytime and keep talking meanwhile.

**Reuse (already built):**
- `taskRunner.ts` — spawns detached sub-agent subprocesses, concurrency cap, timeout, cost, status. ✅
- `tasks` table + `getTask/getRunningTasks/getRecentTasks` — status store ("how's it going?"). ✅
- `TrajectoryLog`, `InboxSurface`, `messages`, `DeliveryRouter` (interrupt/surface/digest scoring), Discord/macOS notify. ✅
- `VoiceConductor.proactiveSpeak` — speaks a proactive line; **exists, currently 0 callers.** ✅ (needs wiring)

**Design:**
1. **Promotion decision (3 triggers, HeyClicky-style):** (a) the planner calls a new `spawn_background_task(goal, context)` tool; (b) the classifier emits a `background` signal for long/multi-step work; (c) a hard keyword ("kairos, in the background…"). Add an extra-effort gate for very heavy runs (confirm first).
2. **Spawn + immediate ack:** in `handleUtterance`, a `background` decision calls `createTask(goal, ...)` + `void taskRunner.runTask(taskId)` (fire-and-forget) and speaks an immediate ack — `await conductor.handle` is NOT blocked. Foreground voice stays live.
3. **The sub-agent brain = our own loop, deep tier.** Prefer running `runAgentLoop` with the **deep model** + higher max-turns in-process (async, off the voice turn) rather than only the `claude -p` subprocess — so sub-agents share our tools/memory/retrieval. (TaskRunner's subprocess path remains for code/heavy isolation.) A `BackgroundAgentManager` owns spawn/track/cancel and a `spawnDepth` cap.
4. **Report-back (3 surfaces, fired on completion):** route the summary through `DeliveryRouter` → (a) **spoken** via `proactiveSpeak` (wire it), (b) a HUD/inbox card + `messages` row, (c) optional chime. Live "commentary" updates stream to the HUD mid-run.
5. **Status + steering:** give the conductor a `background_task_status` tool over `getRunningTasks/getTask` so "how's that going?" is answerable by voice. (Steering/`sessions_send` is a later increment.)
6. **Concurrency:** multiple background tasks allowed (TaskRunner already caps); foreground voice never blocks; idle-teardown gated on "any task running."

**Tests:** unit — promotion classifier emits `background` for a long task; `handleUtterance` background branch returns immediately + creates a task (mock taskRunner); on task `done`, the completion bridge calls `proactiveSpeak` with the summary; the status tool reads running tasks. Live — "organize my inbox into folders" → immediate "on it…", voice stays responsive to a follow-up, completion spoken.

---

## Batch 2 — LOCKED DECISIONS (2026-06-02)
- **Brain:** in-process — background agent runs **our `runAgentLoop`** with the **deep model**, reusing soul/persona/memory/skills/retrieval (NOT `claude -p`). Same arch as foreground, "feels like KAIROS."
- **Tool scope:** Composio + KAIROS skills + reminders **+ gated file read/write + gated shell exec** (sandbox workdir, path-traversal guard, destructive-command denylist). Computer-use DEFERRED (Phase H).
- **Approval (destructive in background):** **pause + ask by voice**; if not answered immediately → also drop into the **approval inbox** AND **park the agent** (await, zero tokens); resume on a voice answer OR inbox approval. (Cross-restart state-persistence = future; inbox entry persists + re-runs the action on approval.)
- **Promotion:** **auto** (classifier `background` signal for heavy/long/multi-step) **+ explicit** (`spawn_background_task` tool / "do this in the background").
- **UI-ready by design:** `BackgroundAgentManager` exposes a queryable task store + a typed event stream (`task_spawned/task_progress/task_tool/task_approval/task_done/task_failed`) broadcast over the existing WS, so a HUD subscribes-and-renders with no further backend work.
- **Self-evolving:** sub-agent trajectories log to `~/.kairos/traj/` so the AwmWorker mines background work into new skills too.

## Batch 2 — components & build order (each TDD'd)
1. **Gated system tools** (`systemTools.ts`): `read_file`/`list_dir` (safe), `write_file` (workdir-scoped), `run_shell` (denylist + timeout + workdir). Path-traversal guarded.
2. **ApprovalGate** (`approvalGate.ts`): request(action) → emits voice ask + inbox item → awaits resolution (voice/inbox), parked (no tokens). resolve(key, yes/no).
3. **BackgroundAgentManager** (`backgroundAgentManager.ts`): spawn(goal) → async runAgentLoop (deep model, background tier, system tools + Composio + skills), status in `tasks` table, typed events, concurrency + spawn-depth caps.
4. **Promotion**: classifier `background` signal + `spawn_background_task` tool + handleUtterance non-blocking branch (immediate spoken ack).
5. **Report-back**: on done → DeliveryRouter → `proactiveSpeak` (wire it) + UI card; live commentary events mid-run.
6. **Status tool** (`background_tasks`) + sub-agent trajectory logging.
7. Integration + live test + regression.

## Build order (each TDD'd + live-verified before the next)
1. **Phase 3 streaming** (biggest felt win; threads `onEvent`).
2. **Parallel tools** (clean loop addition).
3. **Hot-tool set** (usage tracker + core loader).
4. **Phase 4 generalized prompts** (chaining + response-style + classifier `background` signal).
5. **Reflection/replan** (small loop addition).
6. **Batch 2 — background sub-agents** (wire promotion → taskRunner/deep-loop → proactiveSpeak + status tool).
7. (Future) steering, multiple-agent HUD, Phase H computer-use sub-agents.

## Cross-cutting / risks
- **Barge-in** must keep working through streaming (cancel the speaker + abort the loop) — preserve existing wiring.
- **Double-speak** between streamed answer and the conductor's final block — guard with a per-turn flag.
- **Prompt regressions** — keep prompts generalized; add a content-regression test for the key rules.
- **Background safety** — destructive actions inside a background sub-agent still go through the verify-gate + restraint; confirm-before-irreversible holds.
- **Cost** — background deep-model runs cost more; gate heavy effort behind the classifier/approval.
