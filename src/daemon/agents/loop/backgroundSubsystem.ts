// src/daemon/agents/loop/backgroundSubsystem.ts
// Wires the whole "agent lane" together into one cohesive subsystem the daemon can
// drop in. The sub-agent reuses the SAME context the foreground uses (memory,
// persona, skills, Composio tools — via buildContext) and ADDS the background layer:
//   • file + shell tools scoped to a private per-agent workdir (buildSystemTools)
//   • nested-spawn tools (so a sub-agent can fan out, depth-capped)
//   • approval-gating on every destructive call (wrapToolsWithApproval → ApprovalGate)
//   • the deep model + context compaction, run via our owned agent loop
// Returns the manager (the lane), the approval gate (voice/inbox resolution), and the
// two FOREGROUND tools (spawn_background_task + background_tasks) so the voice agent
// can launch sub-agents and check on them in human language.
//
// Everything external (LLM construction, speaking, broadcasting, the inbox, fs/exec)
// is injected, so this factory is testable without booting the daemon.

import { BackgroundAgentManager } from "./backgroundAgentManager"
import { ApprovalGate, type ApprovalRequest } from "./approvalGate"
import { buildSystemTools, type SystemToolsDeps } from "./systemTools"
import { buildBackgroundTools } from "./backgroundTools"
import { wrapToolsWithApproval } from "./approvalWrap"
import { buildUpdatePlanTool } from "./updatePlanTool"
import { buildCompactor, COMPACT_PROMPT } from "./compactor"
import { buildDestructiveVerifier } from "./verifier"
import { runAgentLoop } from "./agentLoop"
import { join } from "node:path"
import type { ToolDef } from "../types"
import type { LoopEvent, LoopLlm, LoopMsg } from "./types"

export interface BackgroundSubsystemDeps {
  /** Build the SAME memory/persona/skills/tools context the foreground gets for a
   *  goal — i.e. contextBuilder.build({ utterance: goal, tier: 'smart', conversationId }).
   *  conversationId (when the spawn inherited one) gives the sub-agent the foreground
   *  conversation's recent turns too — full context parity. */
  buildContext: (goal: string, opts?: { conversationId?: string }) => Promise<{ system: string; tools: ToolDef[] }>
  /** Construct a streaming LoopLlm for a model id (e.g. new OpenRouterAdapter). */
  makeLlm: (model: string) => LoopLlm
  /** The heavy model the sub-agent thinks with (deep tier). */
  deepModel: () => string
  /** A cheap model for compaction summaries. */
  fastModel: () => string
  /** Root dir for per-agent private workdirs (<sandboxDir>/state/agents). */
  agentsDir: string
  /** Shell + file primitives for buildSystemTools (Node child_process / fs). */
  exec: SystemToolsDeps["exec"]
  fs: SystemToolsDeps["fs"]
  /** Speak a line (report-back on completion + the approval ask). */
  speak: (text: string) => Promise<void>
  /** Emit a UI/HUD event over the WS (task_* + approval_*). */
  broadcast: (event: any) => void
  /** Park an unanswered approval into the user's inbox. */
  inbox: (req: ApprovalRequest) => void
  /** Append a finished sub-agent trajectory for skill evolution mining. */
  appendTraj?: (runId: string, entry: any) => void
  /** R8: a hint about similar PAST successful sub-agent runs, injected into the
   *  sub-agent's system prompt so it reuses what worked (Hermes AWM reuse half). */
  priorRunsHint?: (goal: string) => string | Promise<string>
  caps?: { maxConcurrent?: number; maxDepth?: number; voiceWindowMs?: number }
  newId?: () => string
  mkdir?: (dir: string) => void
  log?: (m: string) => void
}

export interface BackgroundSubsystem {
  manager: BackgroundAgentManager
  approvalGate: ApprovalGate
  /** spawn_background_task + background_tasks — added to the FOREGROUND toolset. */
  foregroundTools: ToolDef[]
}

/** Instructions appended to the foreground system prompt so the sub-agent knows it
 *  runs unattended, has system tools, and that its final message is the spoken report. */
const BACKGROUND_ADDENDUM = `

## Background mode (you are an autonomous sub-agent)
You are running as a BACKGROUND sub-agent. The user is NOT watching this live — they're talking to the foreground KAIROS. Work the task to completion on your own:
- You have the user's memory, skills, and all the app tools (search_tools / execute_tool) the foreground has, PLUS file + shell tools (read_file, list_dir, write_file, run_shell). read_file/list_dir/write_file are confined to your own private working directory.
- Destructive or irreversible EXTERNAL actions (send, delete, pay, connect a service) and any non-read-only shell command are paused for the user's approval automatically — just call the tool. Read-only shell (ls, cat, grep, git log…) and writes to your private workdir run without interruption. If an action is declined you'll be told and should adapt.
- Be decisive and thorough. Do NOT ask clarifying questions mid-run — the user can't see you. Make a reasonable assumption and note it in your final report.
- Your FINAL message is what the user hears when you finish. Make it a crisp 1–3 sentence summary of what you actually did (and anything you couldn't).`

export function buildBackgroundSubsystem(deps: BackgroundSubsystemDeps): BackgroundSubsystem {
  // Late binding: runAgent references the manager (for nested spawn), but the manager
  // is constructed FROM runAgent. A holder breaks the cycle.
  let manager: BackgroundAgentManager
  let runSeq = 0

  // ── The approval gate: ask out loud now, fall back to the inbox if unanswered ──
  const approvalGate = new ApprovalGate({
    ask: (req) => {
      deps.broadcast({ event: "approval_request", id: req.id, summary: req.summary, toolName: req.toolName })
      void deps
        .speak(`Quick approval — I want to ${req.summary}. Say "yes" to go ahead, or "no" to skip.`)
        .catch(() => { /* speaking the ask must never throw into the gate */ })
    },
    inbox: (req) => {
      try { deps.inbox(req) } catch { /* */ }
      deps.broadcast({ event: "approval_inboxed", id: req.id, summary: req.summary })
    },
    voiceWindowMs: deps.caps?.voiceWindowMs,
  })

  // ── The sub-agent runner: contextBuilder (memory/persona/skills/composio) + the
  //    background layer (system tools + nested spawn) + approval-gating + deep model.
  const runAgent = async (
    goal: string,
    opts: { onEvent: (e: LoopEvent) => void; signal: AbortSignal; depth: number; conversationId?: string; runId?: string; parentRunId?: string | null },
  ): Promise<{ finalText: string }> => {
    const ctx = await deps.buildContext(goal, { conversationId: opts.conversationId })

    // runId (= the manager's BgTask id) doubles as the workdir/traj id AND the
    // parentRunId for any nested run_subtask children — so the UI tree links up.
    const subRunId = opts.runId ?? (deps.newId ? deps.newId() : `sub_${++runSeq}`)
    const workdir = join(deps.agentsDir, subRunId)
    try { deps.mkdir?.(workdir) } catch { /* */ }

    const sysTools = buildSystemTools({ workdir, exec: deps.exec, fs: deps.fs })
    // Nested spawns run one level DEEPER so the depth cap can stop runaways.
    const nestedBgTools = buildBackgroundTools({
      manager: {
        spawn: (g) => manager.spawn(g, { depth: opts.depth + 1 }),
        listAll: () => manager.listAll(),
      },
    })

    // R5: nested-only sub-agent JOIN. Lets THIS sub-agent decompose its work — fan out
    // several run_subtask calls (concurrencySafe → the loop runs them in parallel),
    // collect the workers' reports, and synthesize. spawnAndWait is depth-bounded and
    // bypasses the concurrency cap (no deadlock). This tool is added ONLY here (the
    // sub-agent toolset) — NEVER the foreground, which must never block on the voice.
    const runSubtaskTool: ToolDef = {
      name: "run_subtask",
      description:
        "Delegate a self-contained SUB-TASK to a worker sub-agent and WAIT for its result. " +
        "To parallelize, emit several run_subtask calls in one turn (one per independent piece), then synthesize their reports. " +
        "The worker has the same tools, skills, and memory you do. Returns the worker's final report.",
      parameters: { type: "object", properties: { goal: { type: "string", description: "The full, self-contained sub-task." } }, required: ["goal"] },
      concurrencySafe: true, // fan-out: multiple run_subtask calls run in parallel
      execute: async (a: { goal: string }) => {
        const subGoal = String(a?.goal ?? "").trim()
        if (!subGoal) return "I need a clear sub-task goal to delegate."
        const r = await manager.spawnAndWait(subGoal, { depth: opts.depth + 1, conversationId: opts.conversationId, parentRunId: subRunId })
        return r.ok ? r.finalText : `Sub-task didn't complete: ${r.finalText || "unknown error"}`
      },
    }

    // CRITICAL: ctx.tools (from contextBuilder.build) already contains the FOREGROUND
    // spawn_background_task/background_tasks (depth-0, added by the actionTools loader).
    // If we just concat nestedBgTools, those names appear TWICE → (1) duplicate tool
    // schemas sent to the provider (a 400 on strict providers kills the whole run),
    // and (2) first-match-wins resolution picks the depth-0 foreground copy, defeating
    // the depth cap. So drop the duplicates from ctx.tools and keep the depth-aware
    // nested versions.
    const bgNames = new Set(nestedBgTools.map((t) => t.name))
    const baseTools = ctx.tools.filter((t) => !bgNames.has(t.name))

    // Approval-wrap EVERYTHING so any destructive call (foreground tool, composio
    // execute, or a shell/write op) routes through the gate before it runs. The run
    // signal is threaded so a cancel resolves parked approvals as denials and an
    // approval that lands after a cancel cannot fire the action.
    const allTools = wrapToolsWithApproval(
      [...baseTools, ...sysTools, ...nestedBgTools, runSubtaskTool, buildUpdatePlanTool({})],
      approvalGate,
      opts.signal,
    )

    const deepLlm = deps.makeLlm(deps.deepModel())
    const fastLlm = deps.makeLlm(deps.fastModel())
    const compactor = buildCompactor({
      summarize: async (msgs: LoopMsg[]) => {
        const transcript = msgs
          .map((m: any) => `${m.role}: ${m.content ?? (m.tool_calls ? "[requested tools]" : "")}`)
          .join("\n")
          .slice(0, 40000)
        const r = await (fastLlm as any).complete({
          messages: [{ role: "system", content: COMPACT_PROMPT }, { role: "user", content: transcript }],
          max_tokens: 512,
        })
        return r.text
      },
    })

    // R8: inject a hint about similar PAST successful runs so the sub-agent reuses
    // what worked (best-effort; never blocks the run).
    let priorHint = ""
    try { priorHint = (await deps.priorRunsHint?.(goal)) ?? "" } catch { /* */ }

    // Grounded verify gate, run INSIDE the loop — the unattended lane needs this
    // MORE than the foreground (the user wasn't watching), so on a flag it
    // self-corrects (actually performs the claimed action / restates from results)
    // rather than just appending a hedge. Same general check: claim ⊆ tool ledger.
    const verifier = buildDestructiveVerifier({ llm: { complete: (b: any) => (fastLlm as any).complete(b) } })

    const startedAt = Date.now()
    const res = await runAgentLoop(
      [
        { role: "system", content: ctx.system + BACKGROUND_ADDENDUM + (priorHint ? "\n\n" + priorHint : "") },
        { role: "user", content: goal },
      ],
      {
        llm: deepLlm,
        tools: allTools,
        signal: opts.signal,
        onEvent: opts.onEvent,
        compact: (m, t) => compactor.maybeCompact(m, t),
        verify: (o) => verifier.verify({ utterance: goal, finalText: o.finalText, toolCalls: o.toolCalls }),
      },
    )

    const finalText = res.finalText // already verified/self-corrected by the in-loop gate

    // Trajectory → skill evolution mining (best-effort; never breaks the run). The
    // daemon feeds this to the SAME AWM TrajWriter the foreground uses, so the
    // self-evolving-skills pipeline crystallizes recurring sub-agent workflows too.
    try {
      deps.appendTraj?.(subRunId, {
        goal,
        finalText,
        toolCalls: res.toolCalls.map((c) => ({ name: c.name, args: c.args, error: c.error })),
        stopped: res.stopped,
        plan: res.plan, // R4: the plan the sub-agent followed, for AWM/recipe mining
        durationMs: Date.now() - startedAt,
      })
    } catch { /* */ }

    return { finalText }
  }

  manager = new BackgroundAgentManager({
    runAgent,
    onEvent: (e) => deps.broadcast({ event: e.kind, ...e }),
    onActivity: (a) => deps.broadcast({ event: "agent_activity", activity: a }),
    onReport: (id, goal, summary) => {
      deps.broadcast({ event: "task_report", id, goal, summary })
      void deps.speak(reportLine(goal, summary)).catch(() => { /* */ })
    },
    maxConcurrent: deps.caps?.maxConcurrent,
    maxDepth: deps.caps?.maxDepth,
    newId: deps.newId,
  })

  const foregroundTools = buildBackgroundTools({ manager })

  return { manager, approvalGate, foregroundTools }
}

/** The spoken "I'm done" line. Short goal echo + the agent's own summary. */
function reportLine(goal: string, summary: string): string {
  const g = goal.length > 60 ? goal.slice(0, 60) + "…" : goal
  const s = (summary ?? "").trim() || "It's finished."
  return `Done with "${g}". ${s}`
}
