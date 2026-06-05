// src/daemon/agents/loop/approvalWrap.test.ts
import { test, expect } from "bun:test"
import { wrapToolsWithApproval } from "./approvalWrap"
import type { ToolDef } from "../types"

const tools: ToolDef[] = [
  { name: "search_tools", description: "", parameters: {}, concurrencySafe: true, execute: async () => ({ tools: [] }) },
  { name: "execute_tool", description: "", parameters: {}, execute: async (a: any) => ({ ran: a.tool_name }) },
]

test("read-only tool calls run WITHOUT approval", async () => {
  let asked = 0
  const gate = { requestApproval: async () => { asked++; return { approved: true } } }
  const w = wrapToolsWithApproval(tools, gate as any)
  await w.find((t) => t.name === "search_tools")!.execute({ query: "x" })
  await w.find((t) => t.name === "execute_tool")!.execute({ tool_name: "LINEAR_LIST_ISSUES" }) // read
  expect(asked).toBe(0)
})

test("destructive tool call REQUESTS approval, runs only if approved", async () => {
  const reqs: any[] = []
  const gate = { requestApproval: async (r: any) => { reqs.push(r); return { approved: true } } }
  const w = wrapToolsWithApproval(tools, gate as any)
  const r = await w.find((t) => t.name === "execute_tool")!.execute({ tool_name: "GMAIL_SEND_EMAIL", args: { to: "sam" } })
  expect(reqs.length).toBe(1)
  expect(reqs[0].toolName).toContain("GMAIL_SEND_EMAIL")
  expect(r).toEqual({ ran: "GMAIL_SEND_EMAIL" }) // ran after approval
})

test("denied approval → does NOT run, returns a 'skipped' result", async () => {
  let ran = false
  const t: ToolDef[] = [{ name: "execute_tool", description: "", parameters: {}, execute: async () => { ran = true; return {} } }]
  const gate = { requestApproval: async () => ({ approved: false }) }
  const w = wrapToolsWithApproval(t, gate as any)
  const r = await w[0]!.execute({ tool_name: "GMAIL_DELETE_MESSAGE", args: {} })
  expect(ran).toBe(false)
  expect(String(r).toLowerCase()).toMatch(/skip|declin|did not|not approv/)
})

// ── run_shell: gated on COMMAND CONTENT (mutating → ask; read-only → run free) ──
test("run_shell with a MUTATING command is gated; summary includes the command", async () => {
  let ran = false
  const reqs: any[] = []
  const t: ToolDef[] = [{ name: "run_shell", description: "", parameters: {}, execute: async () => { ran = true; return "ok" } }]
  const gate = { requestApproval: async (r: any) => { reqs.push(r); return { approved: false } } }
  const w = wrapToolsWithApproval(t, gate as any)
  const r = await w[0]!.execute({ command: "npm publish" })
  expect(reqs.length).toBe(1)
  expect(reqs[0].summary).toContain("npm publish")
  expect(ran).toBe(false)
  expect(String(r).toLowerCase()).toMatch(/skip|not approv/)
})

test("run_shell with a READ-ONLY command runs WITHOUT approval (autonomy preserved)", async () => {
  let asked = 0, ran = false
  const t: ToolDef[] = [{ name: "run_shell", description: "", parameters: {}, execute: async () => { ran = true; return "files" } }]
  const gate = { requestApproval: async () => { asked++; return { approved: true } } }
  const w = wrapToolsWithApproval(t, gate as any)
  await w[0]!.execute({ command: "ls -la && git log --oneline -5" })
  expect(asked).toBe(0)
  expect(ran).toBe(true)
})

test("run_shell with redirection is gated (could write outside)", async () => {
  const reqs: any[] = []
  const t: ToolDef[] = [{ name: "run_shell", description: "", parameters: {}, execute: async () => "ok" }]
  const gate = { requestApproval: async (r: any) => { reqs.push(r); return { approved: false } } }
  const w = wrapToolsWithApproval(t, gate as any)
  await w[0]!.execute({ command: "cat secret > /tmp/leak" })
  expect(reqs.length).toBe(1)
})

test("confined file tools (read/list/write/edit/grep/glob) are NOT gated", async () => {
  let asked = 0
  const names = ["read_file", "list_dir", "write_file", "edit_file", "grep", "glob"]
  const t: ToolDef[] = names.map((name) => ({ name, description: "", parameters: {}, execute: async () => "ok" }))
  const gate = { requestApproval: async () => { asked++; return { approved: true } } }
  const w = wrapToolsWithApproval(t, gate as any)
  // edit_file contains "EDIT" — would trip the destructive heuristic — but it's
  // workdir-confined, so it must NOT be gated.
  for (const tool of w) await tool.execute({ path: "x", old_string: "a", new_string: "b", content: "c" })
  expect(asked).toBe(0)
})

// ── abort safety: a cancelled run never fires the destructive action ──────────
test("if the signal is already aborted, a destructive call is SKIPPED without asking", async () => {
  let ran = false, asked = 0
  const ac = new AbortController(); ac.abort()
  const t: ToolDef[] = [{ name: "run_shell", description: "", parameters: {}, execute: async () => { ran = true; return "ok" } }]
  const gate = { requestApproval: async () => { asked++; return { approved: true } } }
  const w = wrapToolsWithApproval(t, gate as any, ac.signal)
  const r = await w[0]!.execute({ command: "npm publish" }) // mutating → would gate
  expect(asked).toBe(0)
  expect(ran).toBe(false)
  expect(String(r).toLowerCase()).toContain("cancel")
})

test("if the run aborts WHILE parked, the approved action still does NOT fire", async () => {
  let ran = false
  const ac = new AbortController()
  const t: ToolDef[] = [{ name: "run_shell", description: "", parameters: {}, execute: async () => { ran = true; return "ok" } }]
  // Gate that "approves" but only after the run was aborted mid-park.
  const gate = { requestApproval: async () => { ac.abort(); return { approved: true } } }
  const w = wrapToolsWithApproval(t, gate as any, ac.signal)
  const r = await w[0]!.execute({ command: "rm file" })
  expect(ran).toBe(false) // post-await abort re-check blocks execution
  expect(String(r).toLowerCase()).toContain("cancel")
})
