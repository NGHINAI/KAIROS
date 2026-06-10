// src/daemon/agents/controlTools.ts
// FULL COMPUTER CONTROL for the foreground assistant — the "it can actually DO
// anything on the Mac" layer. Two universal tools:
//   • run_applescript — AppleScript/JXA: system volume, media, scriptable apps
//     (Spotify/Music/Safari/Notes/Mail), and generic UI scripting via System Events.
//   • run_shell — anything else a Mac command line can do.
// Both run WITHOUT approval prompts (the user opted into a hands-on assistant), but
// a hard destructive denylist (isDestructiveShell — rm -rf, dd, mkfs, sudo, shutdown,
// raw-device writes, pipe-to-shell, shell-rc edits, persistence) is REFUSED outright,
// never run. Results are text (the tool-result shaper passes strings losslessly),
// time-boxed, and output-capped. argv exec (no parent shell) avoids injection at the
// spawn layer; the command itself still runs under bash -lc by design (that's the point).

import type { ToolDef } from "./types"
import { isDestructiveShell } from "./loop/systemTools"

export interface ControlToolsDeps {
  /** Run argv with a timeout; resolves stdout/stderr/code. Injected for tests. */
  exec?: (argv: string[], opts: { timeoutMs: number }) => Promise<{ stdout: string; stderr: string; code: number }>
  timeoutMs?: number
}

const OUT_MAX = 4000

function defaultExec(argv: string[], opts: { timeoutMs: number }): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    try {
      const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" })
      const timer = setTimeout(() => { try { proc.kill() } catch { /* */ } }, opts.timeoutMs)
      void (async () => {
        try {
          const [stdout, stderr] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
          ])
          const code = await proc.exited
          clearTimeout(timer)
          resolve({ stdout, stderr, code })
        } catch (e) {
          clearTimeout(timer)
          resolve({ stdout: "", stderr: (e as Error).message, code: 1 })
        }
      })()
    } catch (e) {
      resolve({ stdout: "", stderr: (e as Error).message, code: 1 })
    }
  })
}

function clip(s: string): string {
  const t = s.trimEnd()
  return t.length > OUT_MAX ? t.slice(0, OUT_MAX) + "\n…(truncated)" : t
}

/** AppleScript that shells out to a destructive command is just shell with a costume. */
function appleScriptIsDestructive(src: string): boolean {
  const m = /do\s+shell\s+script\s+"([^"]*)"/gi
  let mm: RegExpExecArray | null
  while ((mm = m.exec(src)) !== null) if (isDestructiveShell(mm[1]!)) return true
  return isDestructiveShell(src)   // also catch destructive verbs in the raw source
}

export function buildControlTools(deps: ControlToolsDeps = {}): ToolDef[] {
  const exec = deps.exec ?? defaultExec
  const timeoutMs = deps.timeoutMs ?? 12_000

  const runApplescript: ToolDef = {
    name: "run_applescript",
    concurrencySafe: false,
    description:
      "Control the Mac and its apps via AppleScript — the BEST tool for concrete actions. Examples:\n" +
      "• System volume: `set volume output volume 30` (0–100), mute: `set volume output muted true`\n" +
      "• Spotify: `tell application \"Spotify\" to set sound volume to 30` · `… to playpause` · `… to next track`\n" +
      "• Music, Safari (`tell application \"Safari\" to set URL of current tab of window 1 to \"…\"`), Notes, Mail, Reminders\n" +
      "• Anything else: `tell application \"System Events\" to …` for generic UI scripting.\n" +
      "Prefer this over run_shell for app/system actions. Return any value you want spoken back.",
    parameters: {
      type: "object",
      properties: {
        script: { type: "string", description: "The AppleScript source (use \\n for multi-line)." },
      },
      required: ["script"],
    },
    execute: async (args: { script: string }) => {
      const script = String(args?.script ?? "").trim()
      if (!script) return "Give run_applescript a script."
      if (appleScriptIsDestructive(script)) {
        return "Refused: that script would run a destructive system command. Do it a safe way or tell the user it's not something I'll do."
      }
      const r = await exec(["osascript", "-e", script], { timeoutMs })
      if (r.code !== 0) {
        const err = clip(r.stderr || r.stdout || `exit ${r.code}`)
        return `AppleScript error: ${err}. Fix the script (check the app name and that it's scriptable) or try another approach.`
      }
      const out = clip(r.stdout)
      return out ? `Done. Result: ${out}` : "Done."
    },
  }

  const runShell: ToolDef = {
    name: "run_shell",
    concurrencySafe: false,
    description:
      "Run a macOS shell command to inspect or change the system when no cleaner tool fits " +
      "(open files/URLs, query state, manage windows via cli, etc.). For app/system actions prefer run_applescript. " +
      "Destructive commands (rm -rf, dd, sudo, shutdown, disk formatting, …) are refused. Returns stdout/stderr.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command (runs under bash -lc)." },
      },
      required: ["command"],
    },
    execute: async (args: { command: string }) => {
      const command = String(args?.command ?? "").trim()
      if (!command) return "Give run_shell a command."
      if (isDestructiveShell(command)) {
        return "Refused: that's a destructive command I won't run. If the user needs it, tell them to run it themselves."
      }
      const r = await exec(["bash", "-lc", command], { timeoutMs })
      const out = clip(r.stdout)
      const err = clip(r.stderr)
      if (r.code !== 0) {
        return `Command exited ${r.code}.${out ? `\nstdout: ${out}` : ""}${err ? `\nstderr: ${err}` : ""}\nFix the command or try another approach.`
      }
      return out || (err ? `(stderr) ${err}` : "Done (no output).")
    },
  }

  return [runApplescript, runShell]
}
