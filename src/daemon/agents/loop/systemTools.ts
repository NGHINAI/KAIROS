// src/daemon/agents/loop/systemTools.ts
// Gated shell + file tools for the BACKGROUND sub-agent (Batch 2) — the
// Codex/Claude-Code-grade "do real work on the machine" surface, but fenced:
//   • all file ops are confined to a sandbox workdir (path-traversal guarded)
//   • run_shell refuses a denylist of catastrophic commands, runs in the workdir
//     with a timeout, and caps output
// Foreground voice does NOT get these — only the background agent, where the
// user has opted into autonomous real-task work.

import { resolve, sep, dirname, basename } from "path"
import type { ToolDef } from "../types"

/** Catastrophic / irreversible shell patterns we NEVER run — even with approval.
 *  This is the hard floor (defense-in-depth); the ApprovalGate is the primary
 *  control for everything else dangerous. Covers the bypasses an audit found in
 *  the old single-regex denylist (split/long rm flags, find -delete/-exec,
 *  truncate/shred, recursive chown, pipe-to-shell RCE, shell-rc edits incl. the
 *  user's hard "never touch ~/.zshrc" rule, and persistence installs). */
const DESTRUCTIVE_SHELL_PATTERNS: RegExp[] = [
  /\brm\s+-[a-z]*r[a-z]*f/i,                                  // rm -rf
  /\brm\s+-[a-z]*f[a-z]*r/i,                                  // rm -fr
  /\brm\b(?:\s+-[a-z]+|\s+--[a-z]+)*\s+(?:-r|--recursive)\b/i, // rm with split -r/--recursive
  /\brm\b[^\n]*--force\b/i,                                   // rm --force
  /\bfind\b[^\n]*-delete\b/i,                                 // find ... -delete
  /\bfind\b[^\n]*-exec\b/i,                                   // find ... -exec <cmd>
  /\b(?:truncate|shred)\b/i,                                  // truncate / shred
  /\bchown\s+-R\b/i,                                          // recursive chown
  /\bchmod\s+-R\s+0?777\b/i,                                  // chmod -R 777
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /:\s*\(\s*\)\s*\{/,                                         // fork bomb :(){ :|:& };:
  /\bDROP\s+(?:TABLE|DATABASE)\b/i,
  /git\s+push\b[^\n]*--force|--force\b[^\n]*\bpush/i,         // force-push
  />\s*\/dev\/(?:r?disk\d|sd[a-z]|nvme\d|hd[a-z])/i,          // write to a raw block device — macOS disk0 / Linux sda (NOT /dev/null|zero, which are safe sinks)
  /\b(?:shutdown|reboot|halt|poweroff|killall)\b/i,
  /\bsudo\b/i,
  /\b(?:curl|wget|fetch)\b[^\n|]*\|\s*(?:sh|bash|zsh|python3?|node|ruby|perl)\b/i, // pipe-to-shell RCE
  /(?:>>?|\btee\b)[^\n]*\.(?:zshrc|zprofile|zshenv|bashrc|bash_profile|profile)\b/i, // edit a shell rc (esp. ~/.zshrc)
  /\b(?:launchctl|crontab|systemctl)\b/i,                     // persistence
]

export function isDestructiveShell(command: string): boolean {
  const c = String(command ?? "")
  return DESTRUCTIVE_SHELL_PATTERNS.some((re) => re.test(c))
}

// Binaries that only READ. A run_shell command built entirely from these (with no
// redirection / command-substitution) is safe to run WITHOUT approval, preserving
// the background agent's autonomy for inspection while still gating anything that
// can mutate state, hit the network destructively, or run arbitrary code.
const READONLY_BINS = new Set([
  "ls", "cat", "head", "tail", "grep", "egrep", "fgrep", "rg", "ag", "pwd", "echo",
  "printf", "wc", "which", "type", "file", "stat", "tree", "date", "whoami", "id",
  "uname", "hostname", "du", "df", "ps", "basename", "dirname", "realpath", "readlink",
  "sort", "uniq", "cut", "column", "head", "tail", "true", "sleep", "jq", "cksum",
  "md5", "md5sum", "shasum", "sha256sum", "diff", "comm", "look", "tr",
])
const GIT_READ = new Set(["status", "log", "diff", "show", "branch", "remote", "rev-parse", "describe", "blame", "ls-files", "ls-tree", "cat-file", "shortlog", "tag"])

/** True if EVERY segment of a (possibly piped/chained) command is read-only — used
 *  to decide whether run_shell needs human approval. Conservative: anything it
 *  can't prove read-only requires approval. */
export function isReadOnlyShell(command: string): boolean {
  const cmd = String(command ?? "").trim()
  if (!cmd) return true
  // Redirection, append, tee, command substitution, or process substitution can
  // write/run arbitrary things — never auto-approve. (Benign stderr redirects
  // 2>&1 and 2>/dev/null are stripped first so normal reads aren't penalised.)
  const stripped = cmd.replace(/2>&1/g, " ").replace(/2>\s*\/dev\/null/g, " ")
  if (/>|\btee\b|\$\(|`|<\(/.test(stripped)) return false
  // Split on EVERY command separator — pipes, &&, ||, ;, a single & (background),
  // AND newlines. Missing & / newline let "ls\nrm -rf /" or "ls & rm -rf /" be
  // judged by their harmless FIRST token while the destructive part rode along
  // un-checked → auto-approved. Split the stripped form so a benign 2>&1 survives.
  for (const seg of stripped.split(/\r?\n|&&|\|\||;|\||&/).map((s) => s.trim()).filter(Boolean)) {
    const toks = seg.split(/\s+/)
    const bin = (toks[0] ?? "").replace(/^.*\//, "") // strip any path prefix
    if (bin === "git") { if (!GIT_READ.has(toks[1] ?? "")) return false; continue }
    if (bin === "find") { if (/\s-(?:delete|exec|execdir|fprint|fprintf|ok)\b/.test(seg)) return false; continue }
    if (bin === "sed") { if (/\s-[a-z]*i/.test(seg)) return false; continue } // sed -i edits in place
    if (bin === "awk") { if (/system\s*\(|\bprint(?:f)?\b[^|]*>/.test(seg)) return false; continue }
    if (!READONLY_BINS.has(bin)) return false
  }
  return true
}

export interface SystemToolsDeps {
  /** Sandbox root — all file ops confined here; shell runs here. */
  workdir: string
  exec: (command: string, opts: { cwd: string; timeoutMs: number }) => Promise<{ stdout: string; stderr: string; code: number }>
  fs: {
    readFile: (path: string) => Promise<string>
    writeFile: (path: string, content: string) => Promise<void>
    readdir: (path: string) => Promise<string[]>
    /** Optional: sync realpath (e.g. node:fs.realpathSync). When provided, file
     *  ops also reject symlinks that ESCAPE the workdir — the lexical check alone
     *  can't catch a symlink inside the workdir pointing outside it. */
    realpath?: (path: string) => string
    /** Optional: stat for the recursive walk behind grep/glob. Absent → those
     *  tools degrade gracefully (report unavailable) instead of crashing. */
    stat?: (path: string) => Promise<{ isDirectory: boolean; isFile: boolean; size: number; mtimeMs: number }>
  }
  shellTimeoutMs?: number
  maxOutput?: number
}

/** Resolve a user-given path INSIDE the workdir, or null if it escapes — both
 *  lexically (../, sibling-prefix dirs) AND, when realpath is available, through
 *  symlinks (a link inside the workdir that points outside it). */
function safePath(workdir: string, p: string, realpath?: (s: string) => string): string | null {
  const wd = resolve(workdir)
  const r = resolve(wd, p ?? ".")
  if (r !== wd && !r.startsWith(wd + sep)) return null
  if (realpath) {
    try {
      const realWd = realpath(wd)
      const realTarget = realAncestor(r, realpath)
      if (realTarget !== realWd && !realTarget.startsWith(realWd + sep)) return null
    } catch { /* if realpath can't run, fall back to the lexical result */ }
  }
  return r
}

/** realpath of the deepest EXISTING ancestor of p, with the not-yet-existing tail
 *  re-appended — so a write to a new file under a symlinked dir is still caught. */
function realAncestor(p: string, realpath: (s: string) => string): string {
  let cur = resolve(p)
  const tail: string[] = []
  for (;;) {
    try {
      const real = realpath(cur)
      return tail.length ? resolve(real, ...tail) : real
    } catch {
      const parent = dirname(cur)
      if (parent === cur) return cur // reached root; nothing more to resolve
      tail.unshift(basename(cur))
      cur = parent
    }
  }
}

const REFUSE_PATH = "Refused: that path is outside the allowed working directory."

// Dirs/extensions the walk skips — noise + binaries that grep/glob shouldn't touch.
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".cache", "coverage", ".turbo", "vendor", ".venv", "__pycache__"])
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|mp[34]|mov|wav|woff2?|ttf|otf|node|wasm|so|dylib|class|jar|exe|bin|lock)$/i

/** Bounded recursive walk of a directory → relative file paths. Skips junk dirs,
 *  binaries, and oversized files. Needs fs.stat; returns [] (with a flag) if absent. */
async function walkFiles(deps: SystemToolsDeps, root: string): Promise<{ files: string[]; ok: boolean }> {
  if (!deps.fs.stat) return { files: [], ok: false }
  const stat = deps.fs.stat
  const out: string[] = []
  const MAX_FILES = 4000
  const MAX_DEPTH = 12
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES) return
    let names: string[] = []
    try { names = await deps.fs.readdir(dir) } catch { return }
    for (const name of names) {
      if (out.length >= MAX_FILES) return
      if (name.startsWith(".") && SKIP_DIRS.has(name)) continue
      const full = resolve(dir, name)
      // Symlink-escape guard: stat() follows symlinks, so a link inside the workdir
      // pointing OUTSIDE it would otherwise be walked + read (exfiltration). Drop any
      // entry whose realpath escapes the workdir — same guard read_file/write_file use.
      if (deps.fs.realpath && safePath(deps.workdir, full, deps.fs.realpath) === null) continue
      let st: { isDirectory: boolean; isFile: boolean; size: number; mtimeMs: number }
      try { st = await stat(full) } catch { continue }
      if (st.isDirectory) {
        if (SKIP_DIRS.has(name)) continue
        await walk(full, depth + 1)
      } else if (st.isFile) {
        if (BINARY_EXT.test(name) || st.size > 512 * 1024) continue
        out.push(full)
      }
    }
  }
  await walk(root, 0)
  return { files: out, ok: true }
}

const NEVER_MATCH = /(?!)/ // matches nothing — for pathological/unsupported globs

/** Convert a glob (*, **, ?) to an anchored regex over a relative path. ReDoS-safe:
 *  translates PER SEGMENT so two unbounded quantifiers can never sit adjacent (the
 *  exponential-backtracking shape, e.g. `**a**a**`), caps input length, and rejects
 *  any single segment with >2 `*` (no real glob needs that) → never-match instead
 *  of a catastrophic regex. A whole-segment doublestar becomes `.*` (crosses dirs);
 *  within a segment a star becomes `[^/]*`, `?` becomes `[^/]`. A leading
 *  doublestar-slash is treated as an optional any-directory prefix. */
function globToRegex(glob: string): RegExp {
  const g = String(glob ?? "")
  if (g.length > 256) return NEVER_MATCH
  let prefix = ""
  let rest = g
  if (rest.startsWith("**/")) { prefix = "(?:.*/)?"; rest = rest.slice(3) }
  const segs: string[] = []
  for (const seg of rest.split("/")) {
    if (seg === "**") { segs.push(".*"); continue }
    if ((seg.match(/\*/g) ?? []).length > 2) return NEVER_MATCH // pathological → no ReDoS
    let out = ""
    for (const c of seg) {
      if (c === "*") out += "[^/]*"
      else if (c === "?") out += "[^/]"
      else out += "\\^$.|+()[]{}".includes(c) ? "\\" + c : c
    }
    segs.push(out)
  }
  try { return new RegExp("^" + prefix + segs.join("/") + "$", "i") } catch { return NEVER_MATCH }
}

export function buildSystemTools(deps: SystemToolsDeps): ToolDef[] {
  const timeoutMs = deps.shellTimeoutMs ?? 60_000
  const maxOutput = deps.maxOutput ?? 16_000
  const cap = (s: string) => (s.length > maxOutput ? s.slice(0, maxOutput) + `\n…(truncated, ${s.length} chars)` : s)

  return [
    {
      name: "read_file",
      description: "Read a text file inside the working directory.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      concurrencySafe: true,
      execute: async (a: { path: string }) => {
        const p = safePath(deps.workdir, a?.path, deps.fs.realpath)
        if (!p) return REFUSE_PATH
        try { return cap(await deps.fs.readFile(p)) } catch (e) { return `Error reading file: ${(e as Error).message}` }
      },
    },
    {
      name: "list_dir",
      description: "List files in a directory inside the working directory.",
      parameters: { type: "object", properties: { path: { type: "string", description: "default '.'" } } },
      concurrencySafe: true,
      execute: async (a: { path?: string }) => {
        const p = safePath(deps.workdir, a?.path ?? ".", deps.fs.realpath)
        if (!p) return REFUSE_PATH
        try { return cap((await deps.fs.readdir(p)).join("\n")) } catch (e) { return `Error listing dir: ${(e as Error).message}` }
      },
    },
    {
      name: "write_file",
      description: "Write/overwrite a text file inside the working directory.",
      parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
      execute: async (a: { path: string; content: string }) => {
        const p = safePath(deps.workdir, a?.path, deps.fs.realpath)
        if (!p) return REFUSE_PATH
        try { await deps.fs.writeFile(p, String(a?.content ?? "")); return `Wrote ${String(a?.content ?? "").length} chars to ${a.path}.` }
        catch (e) { return `Error writing file: ${(e as Error).message}` }
      },
    },
    {
      name: "edit_file",
      description:
        "Make a surgical edit to a text file: replace an EXACT string with a new one (Claude-Code-style). " +
        "old_string must match the file exactly (including whitespace) and be UNIQUE — include surrounding " +
        "context to disambiguate, or set replace_all to change every occurrence. Far cheaper/safer than rewriting the whole file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_string: { type: "string", description: "Exact text to find (must be unique unless replace_all)." },
          new_string: { type: "string", description: "Replacement text." },
          replace_all: { type: "boolean", description: "Replace every occurrence (default false)." },
        },
        required: ["path", "old_string", "new_string"],
      },
      execute: async (a: { path: string; old_string: string; new_string: string; replace_all?: boolean }) => {
        const p = safePath(deps.workdir, a?.path, deps.fs.realpath)
        if (!p) return REFUSE_PATH
        const oldS = String(a?.old_string ?? "")
        const newS = String(a?.new_string ?? "")
        if (!oldS) return "Error: old_string is required and must be non-empty."
        if (oldS === newS) return "Error: old_string and new_string are identical — nothing to change."
        let content: string
        try { content = await deps.fs.readFile(p) } catch (e) { return `Error reading file: ${(e as Error).message}` }
        const count = content.split(oldS).length - 1
        if (count === 0) return `Error: old_string not found in ${a.path}. It must match exactly (whitespace included).`
        if (count > 1 && !a.replace_all) return `Error: old_string is not unique (${count} matches in ${a.path}). Add surrounding context to make it unique, or set replace_all: true.`
        // Function replacer: new_string is inserted LITERALLY (a 2-string .replace would
        // expand $&, $1, $`, $$ etc. — silently corrupting edits containing those, common
        // in shell/regex/snapshot code). split/join is already literal.
        const updated = a.replace_all ? content.split(oldS).join(newS) : content.replace(oldS, () => newS)
        try { await deps.fs.writeFile(p, updated) } catch (e) { return `Error writing file: ${(e as Error).message}` }
        return `Edited ${a.path} (${a.replace_all ? count : 1} replacement${(a.replace_all ? count : 1) === 1 ? "" : "s"}).`
      },
    },
    {
      name: "grep",
      description: "Search file CONTENTS for a regex inside the working directory. Returns matching lines as path:line: text. Read-only.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regular expression to search for." },
          path: { type: "string", description: "Sub-directory to search (default: whole workdir)." },
          glob: { type: "string", description: "Only search files whose relative path matches this glob (e.g. '**/*.ts')." },
          ignore_case: { type: "boolean" },
          max_results: { type: "number", description: "Cap on matches (default 100)." },
        },
        required: ["pattern"],
      },
      concurrencySafe: true,
      execute: async (a: { pattern: string; path?: string; glob?: string; ignore_case?: boolean; max_results?: number }) => {
        const root = safePath(deps.workdir, a?.path ?? ".", deps.fs.realpath)
        if (!root) return REFUSE_PATH
        let re: RegExp
        try { re = new RegExp(String(a?.pattern ?? ""), a?.ignore_case ? "i" : "") } catch (e) { return `Error: invalid regex — ${(e as Error).message}` }
        const { files, ok } = await walkFiles(deps, root)
        if (!ok) return "grep is unavailable here (no filesystem stat)."
        const globRe = a?.glob ? globToRegex(a.glob) : null
        const limit = Math.min(Number(a?.max_results) || 100, 500)
        const wd = resolve(deps.workdir)
        const hits: string[] = []
        for (const f of files) {
          if (hits.length >= limit) break
          const rel = f.startsWith(wd + sep) ? f.slice(wd.length + 1) : f
          if (globRe && !globRe.test(rel)) continue
          let text: string
          try { text = await deps.fs.readFile(f) } catch { continue }
          if (text.includes("\x00")) continue // binary content (NUL byte) — skip, regardless of extension
          const lines = text.split("\n")
          for (let i = 0; i < lines.length && hits.length < limit; i++) {
            if (re.test(lines[i]!)) hits.push(`${rel}:${i + 1}: ${lines[i]!.trim().slice(0, 200)}`)
          }
        }
        return hits.length ? cap(hits.join("\n")) : "No matches."
      },
    },
    {
      name: "glob",
      description: "Find files by path pattern inside the working directory (e.g. '**/*.ts', 'src/**/index.*'). Returns matching relative paths. Read-only.",
      parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] },
      concurrencySafe: true,
      execute: async (a: { pattern: string }) => {
        const { files, ok } = await walkFiles(deps, resolve(deps.workdir))
        if (!ok) return "glob is unavailable here (no filesystem stat)."
        const globRe = globToRegex(String(a?.pattern ?? "*"))
        const wd = resolve(deps.workdir)
        const matched = files
          .map((f) => (f.startsWith(wd + sep) ? f.slice(wd.length + 1) : f))
          .filter((rel) => globRe.test(rel))
          .sort()
        return matched.length ? cap(matched.join("\n")) : "No files matched."
      },
    },
    {
      name: "run_shell",
      description: "Run a shell command in the working directory. Use for builds, scripts, git, file ops. Destructive commands are blocked.",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      execute: async (a: { command: string }) => {
        const command = String(a?.command ?? "").trim()
        if (!command) return "Error: empty command."
        if (isDestructiveShell(command)) return `Refused: "${command}" looks destructive/irreversible and is blocked. Use a safer, more specific command.`
        try {
          const r = await deps.exec(command, { cwd: deps.workdir, timeoutMs })
          const out = [r.stdout && `stdout:\n${r.stdout}`, r.stderr && `stderr:\n${r.stderr}`, `exit: ${r.code}`].filter(Boolean).join("\n")
          return cap(out)
        } catch (e) { return `Error running command: ${(e as Error).message}` }
      },
    },
  ]
}
