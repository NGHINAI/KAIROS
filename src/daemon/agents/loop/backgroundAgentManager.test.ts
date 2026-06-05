// src/daemon/agents/loop/backgroundAgentManager.test.ts
import { test, expect } from "bun:test"
import { BackgroundAgentManager } from "./backgroundAgentManager"

function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: any) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
const tick = () => new Promise((r) => setTimeout(r, 0))

test("spawn is NON-BLOCKING: returns an id immediately + emits task_spawned, task stays running", async () => {
  const d = deferred<{ finalText: string }>()
  const events: any[] = []
  const m = new BackgroundAgentManager({ runAgent: () => d.promise, onEvent: (e) => events.push(e), newId: () => "t1" })
  const r = m.spawn("organize my inbox")
  expect(r.accepted).toBe(true)
  expect(r.id).toBe("t1")
  expect(events.find((e) => e.kind === "task_spawned")).toBeDefined()
  expect(m.get("t1")!.status).toBe("running")
})

test("on completion → status done + task_done event + onReport(summary)", async () => {
  const d = deferred<{ finalText: string }>()
  const events: any[] = []
  const reports: any[] = []
  const m = new BackgroundAgentManager({ runAgent: () => d.promise, onEvent: (e) => events.push(e), onReport: (id, goal, s) => reports.push({ id, goal, s }), newId: () => "t1" })
  m.spawn("sort emails")
  d.resolve({ finalText: "Sorted 12 emails into folders." })
  await tick()
  expect(m.get("t1")!.status).toBe("done")
  expect(events.find((e) => e.kind === "task_done")?.summary).toContain("Sorted 12")
  expect(reports[0]).toMatchObject({ id: "t1", goal: "sort emails", s: "Sorted 12 emails into folders." })
})

test("on failure → status failed + task_failed event", async () => {
  const d = deferred<{ finalText: string }>()
  const events: any[] = []
  const m = new BackgroundAgentManager({ runAgent: () => d.promise, onEvent: (e) => events.push(e), newId: () => "t1" })
  m.spawn("do X")
  d.reject(new Error("boom"))
  await tick()
  expect(m.get("t1")!.status).toBe("failed")
  expect(events.find((e) => e.kind === "task_failed")?.error).toContain("boom")
})

test("concurrency cap rejects spawns beyond maxConcurrent", async () => {
  let n = 0
  const m = new BackgroundAgentManager({ runAgent: () => new Promise(() => {}), maxConcurrent: 2, newId: () => `t${++n}` })
  expect(m.spawn("a").accepted).toBe(true)
  expect(m.spawn("b").accepted).toBe(true)
  const third = m.spawn("c")
  expect(third.accepted).toBe(false)
  expect((third.reason ?? "").toLowerCase()).toMatch(/capac|limit|busy/)
})

test("depth cap rejects sub-agents spawning too deep (runaway guard)", () => {
  const m = new BackgroundAgentManager({ runAgent: () => new Promise(() => {}), maxDepth: 1, newId: () => "t1" })
  expect(m.spawn("deep", { depth: 1 }).accepted).toBe(false)
})

test("maps loop tool events to task_tool events for the UI", async () => {
  const events: any[] = []
  let captured: ((e: any) => void) | null = null
  const m = new BackgroundAgentManager({
    runAgent: (_goal, opts) => { captured = opts.onEvent; return new Promise(() => {}) },
    onEvent: (e) => events.push(e),
    newId: () => "t1",
  })
  m.spawn("x")
  captured!({ kind: "tool_call_start", id: "c1", name: "GMAIL_SEND_EMAIL", args: {} })
  expect(events.find((e) => e.kind === "task_tool" && e.tool === "GMAIL_SEND_EMAIL")).toBeDefined()
})

test("R4: a plan_update LoopEvent → task_progress 'step N of M' + lastActivity", async () => {
  const events: any[] = []
  let captured: ((e: any) => void) | null = null
  const m = new BackgroundAgentManager({
    runAgent: (_g, opts) => { captured = opts.onEvent; return new Promise(() => {}) },
    onEvent: (e) => events.push(e),
    newId: () => "t1",
  })
  m.spawn("multi-step task")
  captured!({ kind: "plan_update", plan: [
    { step: "research the project", status: "completed" },
    { step: "draft the summary", status: "in_progress" },
    { step: "write the file", status: "pending" },
  ] })
  const prog = events.find((e) => e.kind === "task_progress")
  expect(prog).toBeDefined()
  expect(prog.note).toContain("step 2 of 3")
  expect(prog.note).toContain("draft the summary")
  expect(m.get("t1")!.lastActivity).toContain("draft the summary")
})

test("tracks lastActivity + toolsUsed so the foreground can report 'how's it going?'", async () => {
  let captured: ((e: any) => void) | null = null
  const m = new BackgroundAgentManager({
    runAgent: (_g, opts) => { captured = opts.onEvent; return new Promise(() => {}) },
    newId: () => "t1",
  })
  m.spawn("research competitors")
  expect(m.get("t1")!.lastActivity).toBe("getting started")
  captured!({ kind: "tool_call_start", id: "c1", name: "search_tools", args: {} })
  captured!({ kind: "tool_call_start", id: "c2", name: "GMAIL_FETCH_EMAILS", args: {} })
  expect(m.get("t1")!.lastActivity).toBe("using GMAIL_FETCH_EMAILS")
  expect(m.get("t1")!.toolsUsed).toBe(2)
})

test("R5: spawnAndWait resolves with the child's result; bypasses maxConcurrent (no deadlock); no report", async () => {
  const d = deferred<{ finalText: string }>()
  const reports: any[] = []
  let n = 0
  const m = new BackgroundAgentManager({
    runAgent: (g) => (g === "child" ? d.promise : new Promise(() => {})), // parent hangs, child resolves
    onReport: (...a) => reports.push(a),
    maxConcurrent: 1,
    newId: () => `t${++n}`,
  })
  expect(m.spawn("parent").accepted).toBe(true) // occupies the only slot
  const p = m.spawnAndWait("child", { depth: 1 })  // must NOT be blocked by the cap
  d.resolve({ finalText: "child done" })
  expect(await p).toEqual({ finalText: "child done", ok: true })
  expect(reports.length).toBe(0) // spawnAndWait does not speak a report (parent uses the result)
})

test("R5: spawnAndWait respects the depth cap", async () => {
  const m = new BackgroundAgentManager({ runAgent: () => new Promise(() => {}), maxDepth: 2, newId: () => "t1" })
  const r = await m.spawnAndWait("too deep", { depth: 2 })
  expect(r.ok).toBe(false)
  expect(r.finalText.toLowerCase()).toMatch(/depth/)
})

test("R5: a failing child resolves ok:false (never rejects the parent)", async () => {
  const d = deferred<{ finalText: string }>()
  const m = new BackgroundAgentManager({ runAgent: () => d.promise, newId: () => "t1" })
  const p = m.spawnAndWait("child", { depth: 1 })
  d.reject(new Error("boom"))
  expect(await p).toEqual({ finalText: "", ok: false })
})

test("UI: emits agent_activity (lane B) with parentRunId/depth; top-level links to the active turn", async () => {
  const acts: any[] = []
  let captured: ((e: any) => void) | null = null
  const m = new BackgroundAgentManager({
    runAgent: (_g, opts) => { captured = opts.onEvent; return new Promise(() => {}) },
    onActivity: (a) => acts.push(a),
    newId: () => "child1",
  })
  m.setActiveRunId("turnX")
  m.spawn("do it") // top-level → parentRunId = turnX
  expect(acts.find((a) => a.kind === "subagent_start")).toMatchObject({ runId: "child1", parentRunId: "turnX", depth: 0, lane: "B" })
  captured!({ kind: "tool_call_start", id: "c1", name: "GMAIL_SEND_EMAIL", args: {} })
  expect(acts.find((a) => a.kind === "tool_call" && a.tool === "GMAIL_SEND_EMAIL" && a.lane === "B")).toBeDefined()
})

test("UI: passes runId (=task id) to runAgent so nested run_subtask can set parentRunId", async () => {
  let opts: any
  const m = new BackgroundAgentManager({ runAgent: (_g, o) => { opts = o; return new Promise(() => {}) }, newId: () => "child1" })
  m.spawn("x")
  expect(opts.runId).toBe("child1")
})

test("UI: spawnAndWait stamps the child's parentRunId for nested lineage", async () => {
  const acts: any[] = []
  const d = deferred<{ finalText: string }>()
  const m = new BackgroundAgentManager({ runAgent: () => d.promise, onActivity: (a) => acts.push(a), newId: () => "w1" })
  const p = m.spawnAndWait("worker", { depth: 1, parentRunId: "parentRun" })
  expect(acts.find((a) => a.kind === "subagent_start")).toMatchObject({ runId: "w1", parentRunId: "parentRun", depth: 1, lane: "B" })
  d.resolve({ finalText: "ok" }); await p
  expect(acts.find((a) => a.kind === "final" && a.status === "done")).toBeDefined()
})

test("cancel aborts a running task", async () => {
  let abortSeen = false
  const m = new BackgroundAgentManager({
    runAgent: (_g, opts) => { opts.signal.addEventListener("abort", () => { abortSeen = true }); return new Promise(() => {}) },
    newId: () => "t1",
  })
  m.spawn("x")
  expect(m.cancel("t1")).toBe(true)
  expect(abortSeen).toBe(true)
  expect(m.get("t1")!.status).toBe("cancelled")
})

test("listRunning returns only running tasks", async () => {
  const d = deferred<{ finalText: string }>()
  let n = 0
  const m = new BackgroundAgentManager({ runAgent: () => (n === 1 ? d.promise : new Promise(() => {})), newId: () => `t${++n}` })
  m.spawn("a"); m.spawn("b")
  d.resolve({ finalText: "done" })
  await tick()
  expect(m.listRunning().map((t) => t.id)).toEqual(["t2"])
})
