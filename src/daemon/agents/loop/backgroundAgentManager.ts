// src/daemon/agents/loop/backgroundAgentManager.ts
// KAIROS's "agent lane" (HeyClicky-style). Spawns background sub-agents that run
// OUR agent loop (deep model, real tools) detached from the foreground voice, so
// the user keeps talking while heavy work runs. Tracks status, emits typed events
// for the UI/HUD, reports back on completion, and caps concurrency + spawn-depth
// so a runaway can't blow up cost. The actual loop is injected (runAgent) so this
// orchestrator is testable and decoupled from model/tool wiring.

import type { LoopEvent } from "./types"
import type { AgentActivity } from "../types"

export type BgStatus = "running" | "done" | "failed" | "blocked" | "cancelled"

export interface BgTask {
  id: string
  goal: string
  status: BgStatus
  /** Human-readable "what it's doing right now" — last tool / progress note.
   *  Powers the foreground "how's my task going?" check-in. */
  lastActivity?: string
  toolsUsed: number
  summary?: string
  error?: string
  depth: number
  /** The run that spawned this one — foreground turn (top-level) or parent sub-agent
   *  (nested). null for an unparented spawn. Lets the UI reconstruct the activity tree. */
  parentRunId?: string | null
  startedAt: number
  endedAt?: number
}

export type BgEvent =
  | { kind: "task_spawned"; id: string; goal: string }
  | { kind: "task_tool"; id: string; tool: string }
  | { kind: "task_progress"; id: string; note: string }
  | { kind: "task_done"; id: string; summary: string }
  | { kind: "task_failed"; id: string; error: string }
  | { kind: "task_cancelled"; id: string }

export interface BackgroundAgentManagerDeps {
  /** Run the agent loop for a goal. Injected so model/tool wiring lives in the
   *  daemon and this stays testable. conversationId lets the sub-agent pull the
   *  originating conversation's recent turns + fresh memory delta (context parity). */
  runAgent: (goal: string, opts: { onEvent: (e: LoopEvent) => void; signal: AbortSignal; depth: number; conversationId?: string; runId?: string; parentRunId?: string | null }) => Promise<{ finalText: string }>
  /** Typed events → WS broadcast (UI/HUD) + reporting. */
  onEvent?: (e: BgEvent) => void
  /** The unified activity envelope → WS broadcast for the live nested UI tree. */
  onActivity?: (a: AgentActivity) => void
  /** Completion hook → DeliveryRouter → proactiveSpeak + a UI card. */
  onReport?: (id: string, goal: string, summary: string) => void
  maxConcurrent?: number
  maxDepth?: number
  /** SA1 runaway backstop: max concurrent run_subtask children a SINGLE parent may
   *  have in flight. spawnAndWait bypasses maxConcurrent to avoid deadlock, so without
   *  this a sub-agent could fan out unboundedly. Per-parent (not global) so it can't
   *  deadlock a parent waiting on its own child. Default 12. */
  maxNestedConcurrent?: number
  newId?: () => string
}

/** How many finished (done/failed/cancelled) tasks to retain for check-ins/UI
 *  before evicting the oldest — comfortably more than backgroundTools' slice(0,8)
 *  window. Bounds memory on a long-lived daemon. */
const KEEP_TERMINAL = 24

export class BackgroundAgentManager {
  private tasks = new Map<string, { task: BgTask; controller?: AbortController }>()
  private seq = 0
  /** The foreground's current conversation — sub-agents spawned mid-turn inherit it
   *  for context parity (recent turns + fresh memory delta). Set per turn. */
  private activeConversationId?: string

  constructor(private deps: BackgroundAgentManagerDeps) {}

  /** The foreground turn's runId — top-level spawns link to it (parentRunId) so the
   *  UI nests background sub-agents under the turn that started them. */
  private activeRunId?: string

  /** Called by the foreground at the start of each turn so spawns inherit the
   *  current conversation context. */
  setActiveConversation(conversationId?: string): void {
    this.activeConversationId = conversationId
  }

  /** Called by the foreground at turn start so top-level spawns link to the turn. */
  setActiveRunId(runId?: string): void {
    this.activeRunId = runId
  }

  /** Build + emit the unified activity envelope for a task lifecycle event. */
  private emitActivity(task: BgTask, kind: string, extra: Partial<AgentActivity> = {}): void {
    try {
      this.deps.onActivity?.({
        runId: task.id,
        parentRunId: task.parentRunId ?? null,
        depth: task.depth,
        lane: "B",
        kind,
        ts: Date.now(),
        ...extra,
      })
    } catch { /* activity is best-effort UI telemetry */ }
  }

  private runningCount(): number {
    let n = 0
    for (const { task } of this.tasks.values()) if (task.status === "running") n++
    return n
  }

  /** On task completion: drop the AbortController (so it can be GC'd) and evict the
   *  oldest terminal tasks beyond KEEP_TERMINAL. Running tasks are never evicted. */
  private retire(id: string): void {
    const entry = this.tasks.get(id)
    if (entry) entry.controller = undefined
    const terminal = [...this.tasks.values()]
      .map((e) => e.task)
      .filter((t) => t.status !== "running")
      .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))
    for (let i = 0; i < terminal.length - KEEP_TERMINAL; i++) this.tasks.delete(terminal[i]!.id)
  }

  /** Core launcher (shared by spawn + spawnAndWait): register the task, run the loop,
   *  track status + events, retire. Returns the task id + a promise that resolves with
   *  the result and NEVER rejects. `report` gates the spoken onReport (top-level spawns
   *  speak; nested joined children return their result to the parent silently). */
  private launch(goal: string, depth: number, conversationId: string | undefined, report: boolean, parentRunId: string | null): { id: string; promise: Promise<{ finalText: string; ok: boolean }> } {
    const id = this.deps.newId ? this.deps.newId() : `bg_${++this.seq}_${Date.now()}`
    const controller = new AbortController()
    const task: BgTask = { id, goal, status: "running", depth, parentRunId, startedAt: Date.now(), toolsUsed: 0, lastActivity: "getting started" }
    this.tasks.set(id, { task, controller })
    this.emit({ kind: "task_spawned", id, goal })
    this.emitActivity(task, "subagent_start", { status: "running", summary: goal.slice(0, 140) })

    const promise = this.deps
      .runAgent(goal, {
        depth,
        conversationId,
        runId: id,          // the sub-agent's own runId = this task id (so nested run_subtask links to it)
        parentRunId,
        signal: controller.signal,
        onEvent: (e) => {
          if (e.kind === "tool_call_start") {
            task.toolsUsed++
            task.lastActivity = `using ${e.name}`
            this.emit({ kind: "task_tool", id, tool: e.name })
            this.emitActivity(task, "tool_call", { tool: e.name, status: "running" })
          } else if (e.kind === "plan_update" && Array.isArray(e.plan)) {
            // R4: surface plan progress so "how's my task going?" says "step 3 of 4:
            // drafting the summary" instead of "using write_file".
            const plan = e.plan as Array<{ step: string; status: string }>
            const done = plan.filter((s) => s.status === "completed").length
            const current = plan.find((s) => s.status === "in_progress") ?? plan.find((s) => s.status === "pending")
            const note = current ? `step ${Math.min(done + 1, plan.length)} of ${plan.length}: ${current.step}` : `${done} of ${plan.length} steps done`
            task.lastActivity = note.slice(0, 140)
            this.emit({ kind: "task_progress", id, note: task.lastActivity })
            this.emitActivity(task, "plan_update", { summary: task.lastActivity })
          } else if (e.kind === "self_correct") {
            // The grounded-verify gate caught the sub-agent about to report an
            // unsupported result; it's correcting itself. Surface it so a check-in
            // says "double-checking its work" instead of looking stalled.
            task.lastActivity = "double-checking its work"
            this.emit({ kind: "task_progress", id, note: task.lastActivity })
            this.emitActivity(task, "self_correct", { status: "running", summary: e.concern })
          } else if (e.kind === "assistant_delta" && e.text.trim()) {
            // a flash of what it's narrating, so check-ins feel alive
            task.lastActivity = e.text.trim().slice(0, 120)
          }
        },
      })
      .then((res) => {
        const entry = this.tasks.get(id)
        if (!entry || entry.task.status === "cancelled") return { finalText: res.finalText, ok: false }
        entry.task.status = "done"
        entry.task.summary = res.finalText
        entry.task.endedAt = Date.now()
        this.emit({ kind: "task_done", id, summary: res.finalText })
        this.emitActivity(entry.task, "final", { status: "done", summary: res.finalText.slice(0, 200) })
        if (report) { try { this.deps.onReport?.(id, goal, res.finalText) } catch { /* */ } }
        this.retire(id)
        return { finalText: res.finalText, ok: true }
      })
      .catch((err) => {
        const entry = this.tasks.get(id)
        if (entry && entry.task.status !== "cancelled") {
          entry.task.status = "failed"
          entry.task.error = (err as Error).message
          entry.task.endedAt = Date.now()
          this.emit({ kind: "task_failed", id, error: (err as Error).message })
          this.emitActivity(entry.task, "final", { status: "failed", summary: (err as Error).message })
          this.retire(id)
        }
        return { finalText: "", ok: false }
      })

    return { id, promise }
  }

  /** Spawn a background sub-agent, NON-BLOCKING. Top-level (foreground-initiated):
   *  concurrency + depth gated; speaks a report on completion. */
  spawn(goal: string, opts: { depth?: number; conversationId?: string; parentRunId?: string | null } = {}): { id: string; accepted: boolean; reason?: string } {
    const depth = opts.depth ?? 0
    const conversationId = opts.conversationId ?? this.activeConversationId
    const parentRunId = opts.parentRunId ?? this.activeRunId ?? null // top-level → the foreground turn
    const maxConcurrent = this.deps.maxConcurrent ?? 3
    const maxDepth = this.deps.maxDepth ?? 2
    if (depth >= maxDepth) return { id: "", accepted: false, reason: "spawn depth limit reached" }
    if (this.runningCount() >= maxConcurrent) return { id: "", accepted: false, reason: "at capacity (too many running tasks)" }
    const { id } = this.launch(goal, depth, conversationId, true, parentRunId) // fire-and-forget
    return { id, accepted: true }
  }

  /** R5: spawn a child sub-agent and AWAIT its result — for sub-agent → sub-agent
   *  decomposition (orchestrator fans out workers, collects, synthesizes). Bounded by
   *  maxDepth only; it deliberately BYPASSES the maxConcurrent cap to avoid deadlock
   *  (a parent holding a slot must never block its own child from getting one). Speaks
   *  NO report (the parent uses the returned result). MUST stay nested-only — never
   *  exposed to the foreground, which must never block. */
  async spawnAndWait(goal: string, opts: { depth?: number; conversationId?: string; parentRunId?: string | null } = {}): Promise<{ finalText: string; ok: boolean }> {
    const depth = opts.depth ?? 0
    const maxDepth = this.deps.maxDepth ?? 2
    if (depth >= maxDepth) return { finalText: "Couldn't run the sub-task: nesting depth limit reached.", ok: false }
    // SA1: bound fan-out WIDTH per parent so a sub-agent can't spawn run_subtask
    // workers unboundedly (depth alone doesn't cap width).
    const parentId = opts.parentRunId ?? null
    const maxFanout = this.deps.maxNestedConcurrent ?? 12
    if (parentId) {
      const siblings = [...this.tasks.values()].filter((e) => e.task.status === "running" && e.task.parentRunId === parentId).length
      if (siblings >= maxFanout) return { finalText: `Couldn't run the sub-task: this agent already has ${siblings} sub-tasks running (limit ${maxFanout}). Wait for some to finish.`, ok: false }
    }
    const conversationId = opts.conversationId ?? this.activeConversationId
    return this.launch(goal, depth, conversationId, false, parentId).promise
  }

  get(id: string): BgTask | undefined { return this.tasks.get(id)?.task }
  listRunning(): BgTask[] { return [...this.tasks.values()].map((e) => e.task).filter((t) => t.status === "running") }
  listAll(): BgTask[] { return [...this.tasks.values()].map((e) => e.task) }

  cancel(id: string): boolean {
    const entry = this.tasks.get(id)
    if (!entry || entry.task.status !== "running") return false
    entry.task.status = "cancelled"
    entry.task.endedAt = Date.now()
    try { entry.controller?.abort() } catch { /* */ }
    this.emit({ kind: "task_cancelled", id })
    // SA2: cancel in-flight NESTED children too. A cancelled orchestrator must not
    // orphan its run_subtask workers — they would keep burning tokens and could still
    // fire an already-approved destructive action. Collect children BEFORE recursing
    // (cancel() mutates the map via retire). Recursion reaches grandchildren.
    const children = [...this.tasks.values()].filter((c) => c.task.status === "running" && c.task.parentRunId === id).map((c) => c.task.id)
    for (const childId of children) this.cancel(childId)
    this.retire(id)
    return true
  }

  private emit(e: BgEvent): void {
    try { this.deps.onEvent?.(e) } catch { /* events must never break the manager */ }
  }
}
