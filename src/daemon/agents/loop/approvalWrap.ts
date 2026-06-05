// src/daemon/agents/loop/approvalWrap.ts
// Wraps a background sub-agent's tools so that any DESTRUCTIVE/irreversible call
// (send/delete/connect/pay) AND any system-mutating call (run_shell, write_file)
// first goes through the ApprovalGate — pause, ask the user (voice + inbox), and
// only run on approval. Read-only calls pass straight through. The destructive
// heuristic (isDestructiveCall) only inspects tool NAMES, so the system tools —
// whose names carry no destructive keyword — are force-gated by name here, and
// the user hears the ACTUAL command/path/recipient they're approving.
//
// The run's AbortSignal is threaded in so that (a) a parked approval resolves to a
// denial the instant the task is cancelled (instead of hanging forever), and (b)
// even if an approval resolves true after a cancel, the destructive action does
// NOT fire (re-checked after the await). This closes the "destructive action runs
// after the user cancelled" hole.

import type { ToolDef } from "../types"
import { isDestructiveCall } from "./verifier"
import { isReadOnlyShell } from "./systemTools"

export interface ApprovalLike {
  requestApproval: (
    req: { id: string; summary: string; toolName: string; args: any },
    signal?: AbortSignal,
  ) => Promise<{ approved: boolean }>
}

let approvalSeq = 0

// File tools confined to the agent's private scratch workdir (safePath + symlink
// guard). Mutating only a throwaway dir is NOT user-destructive, so they run free —
// even edit_file, whose name contains "EDIT" and would otherwise trip the destructive
// heuristic. (When R1 lets a sub-agent target the USER's real project dir, this set
// must change so writes outside the scratch dir get gated.)
const CONFINED_FILE_TOOLS = new Set(["read_file", "list_dir", "write_file", "edit_file", "grep", "glob"])

/** Decide whether a tool call needs human approval. isDestructiveCall keys off
 *  destructive VERBS in the (effective) tool name — which covers Composio actions
 *  (GMAIL_SEND_EMAIL…) and connect_service. run_shell carries no such keyword, so
 *  it's judged on its COMMAND: read-only commands run free (autonomy), anything
 *  that can mutate / hit the network / run code is gated. */
function callNeedsApproval(toolName: string, args: any): boolean {
  if (CONFINED_FILE_TOOLS.has(toolName)) return false // sandboxed to the scratch workdir
  if (toolName === "run_shell") return !isReadOnlyShell(String(args?.command ?? ""))
  return isDestructiveCall({ name: toolName, args })
}

export function wrapToolsWithApproval(tools: ToolDef[], gate: ApprovalLike, signal?: AbortSignal): ToolDef[] {
  return tools.map((tool) => ({
    ...tool,
    execute: async (args: any) => {
      const effective = tool.name === "execute_tool" ? String(args?.tool_name ?? "") : tool.name
      const needsApproval = callNeedsApproval(tool.name, args)
      if (needsApproval) {
        if (signal?.aborted) return "Skipped — the task was cancelled."
        const id = `appr_${++approvalSeq}`
        const summary = humanSummary(tool.name, effective, args)
        const { approved } = await gate.requestApproval({ id, summary, toolName: effective || tool.name, args }, signal)
        // Re-check abort AFTER the await: a cancel that landed while we were parked
        // must not let the (now-approved) destructive action fire.
        if (signal?.aborted) return "Skipped — the task was cancelled."
        if (!approved) return `Skipped — you didn't approve: ${summary}.`
      }
      return tool.execute(args)
    },
  }))
}

/** A short spoken-friendly description of the pending action — includes the actual
 *  command / target path / recipient so the user knows exactly what they approve. */
function humanSummary(toolName: string, effective: string, args: any): string {
  if (toolName === "run_shell") return `run a shell command: ${String(args?.command ?? "").slice(0, 120)}`
  if (toolName === "write_file") return `write to the file ${String(args?.path ?? "?").slice(0, 80)}`
  const label = effective || toolName
  const verb = /SEND/i.test(label) ? "send"
    : /DELETE|REMOVE|TRASH/i.test(label) ? "delete"
    : /CREATE/i.test(label) ? "create"
    : /PAY|CHARGE/i.test(label) ? "pay"
    : label === "connect_service" ? "connect a service"
    : "do"
  const target = args?.args?.to ?? args?.to ?? args?.args?.recipient ?? args?.toolkit_slug ?? ""
  return `${verb} via ${label}${target ? ` (${String(target).slice(0, 40)})` : ""}`
}
