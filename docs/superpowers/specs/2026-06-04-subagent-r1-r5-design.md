# KAIROS Sub-Agent — R1 (work in the user's project dir) + R5 (sub-agent join) — Design

- **Date:** 2026-06-04
- **Status:** DESIGN ONLY — awaiting user approval. No code until signed off (both are ARCHITECTURE-CHANGE per the sub-agent roadmap).
- **Context:** R2/R3/R4/R6/R7/R8 are shipped. R1 + R5 are the two changes that alter the loop/manager/tool *contracts* + invert a safety invariant, so they're designed here first. Modeled on Codex CLI (cwd-rooted sandbox + approval policy) and Claude Code (Edit/Read confinement + the Task tool's subagent-returns-a-report semantics).

---

## R1 — Sub-agent works in the USER'S project directory (scoped, opt-in, approval-gated)

### Problem
Today every sub-agent is jailed to `state/agents/<runId>` (`backgroundSubsystem.ts:107`); `systemTools.safePath` confines all file ops + `run_shell` cwd there. So "build me an HTML file in my project" or "fix the bug in `~/Desktop/husk/src/x.ts`" is **impossible** — the ceiling is "write a throwaway file in a temp dir." This is the single biggest capability gap vs Codex/Claude Code.

### The safety invariant we're inverting
`approvalWrap.ts` currently treats the confined file tools (`read_file/list_dir/write_file/edit_file/grep/glob`) as **never needing approval** *because* they can't escape the scratch dir (`CONFINED_FILE_TOOLS`). R1 lets writes reach real user files, so that "writes are always safe" assumption no longer holds. **This is why R1 needs explicit sign-off** — a regression here = unapproved writes to the user's actual files.

### Design (Codex-style: a cwd root + a write/exec policy)
1. **Per-spawn `workspace`** — a spawn can target a real directory instead of the scratch dir. Three modes:
   - `scratch` (DEFAULT, unchanged) — private `state/agents/<id>`, writes free, today's behavior.
   - `project:<path>` — a specific directory the user named (e.g. `~/Desktop/husk`). Reads free; **every write/edit/mutating-shell gated** unless under an approved root (see #4).
   - Never the whole FS — `workspace` must resolve to a directory; `safePath` still confines ops to it (no `..` escape, symlink-guarded — already built).
2. **Thread `workspace` through the chain** (mirrors the conversationId threading already done):
   `spawn_background_task({goal, working_dir?})` → `manager.spawn(goal, {workspace})` → `runAgent(goal, {workspace})` → `buildSystemTools({workdir: resolved, sandboxScratch: false})`. Reads `READ`-free; writes gated.
3. **`run_shell` cwd** = the workspace; the existing `isReadOnlyShell`/`isDestructiveShell` + approval-gate-on-mutating logic already handles shell. For a project workspace, even `isReadOnlyShell` commands are fine (reads), mutating ones gate — no change needed there, it already keys on the command.
4. **Approval policy for project writes** — `approvalWrap.CONFINED_FILE_TOOLS` becomes conditional: a write/edit is free ONLY when its resolved path is under the agent's **scratch** dir; a write under a **project** workspace routes through the ApprovalGate (the gate + voice/inbox resolution already exist). Add an **"approve for this run"** scope so the user isn't prompted per-file (Codex's `--full-auto` within a session): once the user approves writes to `~/Desktop/husk` for run X, subsequent writes under that root in the same run are free (tracked in the gate by `{runId, root}`).
5. **How the workspace is chosen** — the foreground voice turn resolves it from intent: "fix the bug in husk" → the model passes `working_dir: "~/Desktop/husk"` (or a project the user has registered). A registry of allowed project roots (opt-in, in config/soul) prevents the model from inventing arbitrary paths; an unregistered path triggers a one-time "OK to let KAIROS work in <path>?" approval.

### Files touched
- `systemTools.ts` — `buildSystemTools` gains `{ scratchRoot }` distinct from `workdir`; the tools learn "is this path inside scratch?" for the gating decision. (No change to safePath confinement — still jailed to `workdir`, which is now the project root.)
- `approvalWrap.ts` — `callNeedsApproval` for write_file/edit_file becomes path-aware (free under scratch, gated under project); add per-run approved-root memory.
- `backgroundAgentManager.ts` — `spawn(goal, {workspace?})` + `BgTask.workspace`.
- `backgroundSubsystem.ts` — `runAgent` resolves the workspace (scratch default), passes it to buildSystemTools; threads through to the loop.
- `backgroundTools.ts` — `spawn_background_task` gains an optional `working_dir` arg; description explains scratch-vs-project.
- `index.ts` — a registry of allowed project roots (config/soul); resolve `~`; wire the gate's "approve for run" UX.
- New tests: write under scratch (free), write under project (gated→approve→runs / deny→skipped), path-escape still refused, symlink-escape still refused, approved-root memory within a run.

### Impact / risk
- **Inverts the write-confinement invariant** — the #1 review focus. Mitigation: default stays `scratch`; project writes ALWAYS gate (no silent writes); per-run approved-root is explicit; OS-level confinement (sandbox-exec) is a possible follow-up but the approval gate is the primary control.
- Honors the user's hard rules: `~/.zshrc` etc. still blocked by `isDestructiveShell`; destructive shell still gated.
- The UI (approval card §6.5) already models per-run approval scope — fits the existing contract.

---

## R5 — Sub-agent → sub-agent JOIN (`spawn_and_wait`), not just fire-and-forget

### Problem
Nested spawn works (`backgroundSubsystem.ts:111`, depth+1) but is **fire-and-forget**: `manager.spawn` returns `{id, accepted}` and the child's `finalText` only goes to `onReport` (spoken). A parent sub-agent **cannot await a child and use its result** — so there's no true orchestrator→worker decomposition (fan out 3 research workers, collect, synthesize), which is the defining pattern of Claude Code's Task tool and Hermes.

### Design (Claude-Code Task semantics: child returns a report to its caller)
1. **`manager.spawnAndWait(goal, {depth, conversationId}): Promise<{finalText, ok}>`** — like `spawn` but returns the run promise (resolves with the child's finalText, rejects→`{ok:false}`). Depth + concurrency caps still apply. Tracked as a normal `BgTask` (so the UI tree still shows it).
2. **A nested-only tool `run_subtask({goal})`** exposed ONLY to sub-agents (never the foreground), via the existing `nestedBgTools` seam. It `await`s the child and returns its report as the tool result, so the parent can `Promise.all([...])` workers and synthesize. The foreground keeps only the non-blocking `spawn_background_task` (blocking the foreground would freeze the voice — hard rule).
3. **The boundary that needs sign-off:** this introduces a **blocking/await** semantic into a manager that is *strictly non-blocking today*. It must NEVER leak to the foreground. Guard: `run_subtask` is added only to `nestedBgTools` (depth ≥ 1 context), and the foreground toolset is asserted to never contain it (a test enforces this).
4. **Concurrency / DEADLOCK avoidance (decided).** A parent awaiting children holds a running slot; if children also had to pass the `maxConcurrent` gate, N parents could fill all slots and their children could never start → deadlock. **Decision:** `spawnAndWait` (nested children) **bypasses the `maxConcurrent` cap and is bounded only by `maxDepth`** (default 2). Rationale: a nested child is sub-work of an already-admitted parent, not new top-level load, and `maxDepth` already bounds the total tree (depth 0 foreground-spawned → depth 1 workers → stop). Top-level `spawn` (foreground) keeps the `maxConcurrent` gate. This is simpler + safer than tracking a "blocked" parent status, and provably deadlock-free.
   - Implementation: refactor the manager's `spawn` body into a private `launch(goal, opts): Promise<{finalText}>` that registers the BgTask, runs `runAgent`, emits events, and retires; `spawn` = `launch` fire-and-forget returning `{id, accepted}` (keeps the `maxConcurrent` gate), `spawnAndWait` = depth-gate-only + `return launch(...)` (returns the awaitable). Zero duplication.

### Files touched
- `backgroundAgentManager.ts` — `spawnAndWait` returning the run promise; parent-waiting not counted toward `maxConcurrent` (the (a) decision).
- `backgroundSubsystem.ts` — build `run_subtask` into `nestedBgTools` only; wire it to `manager.spawnAndWait` at depth+1.
- `backgroundTools.ts` — the `run_subtask` tool def (nested-only).
- New tests: parent fans out 2 children + synthesizes; foreground toolset NEVER has `run_subtask`; depth cap still stops runaway; a waiting parent doesn't deadlock the cap.

### Impact / risk
- **Blocking semantic** added to a non-blocking manager — the review focus. Mitigation: nested-only (never foreground), depth-capped, waiting-parent doesn't hold a slot. A child that hangs is bounded by the loop's `maxTurns` + the run signal.
- Wall-clock: a parent awaiting children is slower than fire-and-forget, but that's the point (it needs the results). It runs in the background lane, so the foreground voice is unaffected.

---

## Build order (after approval)
1. R5 first (smaller, self-contained, no safety-invariant change) — `spawnAndWait` + `run_subtask` + tests.
2. R1 second (the safety-sensitive one) — scratch-vs-project gating + approved-root UX + tests + a focused security review.

Both TDD, then full regression + a live e2e (parent fans out workers for R5; "build an HTML file in ~/Desktop/test-proj" with approval for R1).
