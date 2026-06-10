// src/daemon/agents/loop/backgroundSubsystem.test.ts
import { test, expect } from "bun:test"
import { buildBackgroundSubsystem, extractLearning } from "./backgroundSubsystem"
import type { ToolDef } from "../types"

const tick = () => new Promise((r) => setTimeout(r, 0))
async function waitDone(m: any, id: string, tries = 200) {
  for (let i = 0; i < tries; i++) {
    const s = m.get(id)?.status
    if (s && s !== "running") return s
    await tick()
  }
  return m.get(id)?.status
}

// A turn-scripted fake LoopLlm: each call to stream() yields the next turn's events.
// `capture` (optional) receives the request body so tests can inspect the toolset.
function scriptedLlm(turns: any[][], capture?: (body: any) => void) {
  let i = 0
  return {
    async *stream(body: any) {
      capture?.(body)
      const t = turns[Math.min(i, turns.length - 1)] ?? []
      i++
      for (const ev of t) yield ev
    },
    // compaction path uses .complete() — never hit in these short runs, but stub it.
    complete: async () => ({ text: "summary" }),
  } as any
}

function baseDeps(over: any = {}) {
  const spoken: string[] = []
  const broadcasts: any[] = []
  const inboxed: any[] = []
  return {
    spoken, broadcasts, inboxed,
    deps: {
      buildContext: async () => ({ system: "You are KAIROS.", tools: [] as ToolDef[] }),
      makeLlm: () => scriptedLlm([[{ kind: "delta", text: "All set." }, { kind: "done" }]]),
      deepModel: () => "deep-model",
      fastModel: () => "fast-model",
      agentsDir: "/tmp/kairos-test-agents",
      exec: async () => ({ stdout: "", stderr: "", code: 0 }),
      fs: { readFile: async () => "", writeFile: async () => {}, readdir: async () => [] },
      speak: async (t: string) => { spoken.push(t) },
      broadcast: (e: any) => { broadcasts.push(e) },
      inbox: (r: any) => { inboxed.push(r) },
      mkdir: () => {},
      newId: (() => { let n = 0; return () => `t${++n}` })(),
      caps: { voiceWindowMs: 1_000_000 }, // long window so the inbox timer never fires in-test
      ...over,
    },
  }
}

test("foregroundTools exposes spawn_background_task + background_tasks for the voice agent", () => {
  const { deps } = baseDeps()
  const sub = buildBackgroundSubsystem(deps as any)
  const names = sub.foregroundTools.map((t) => t.name).sort()
  expect(names).toEqual(["background_tasks", "spawn_background_task"])
})

test("spawn → reuses context, runs the loop, and REPORTS BACK by speaking the summary", async () => {
  const ctxGoals: string[] = []
  const { deps, spoken, broadcasts } = baseDeps({
    buildContext: async (g: string) => { ctxGoals.push(g); return { system: "SYS", tools: [] } },
  })
  const sub = buildBackgroundSubsystem(deps as any)
  const { id, accepted } = sub.manager.spawn("organize my inbox")
  expect(accepted).toBe(true)
  expect(await waitDone(sub.manager, id)).toBe("done")

  expect(ctxGoals).toEqual(["organize my inbox"])           // reused the foreground context builder
  expect(spoken.some((s) => s.includes("All set."))).toBe(true) // spoke the agent's summary
  expect(broadcasts.find((b) => b.event === "task_report")).toBeDefined()
  expect(broadcasts.find((b) => b.event === "task_done")).toBeDefined()
})

test("active conversation threads into buildContext (context parity)", async () => {
  let ctxOpts: any = "unset"
  const { deps } = baseDeps({
    buildContext: async (_g: string, o?: any) => { ctxOpts = o; return { system: "SYS", tools: [] } },
  })
  const sub = buildBackgroundSubsystem(deps as any)
  sub.manager.setActiveConversation("cid-123")
  const { id } = sub.manager.spawn("do a thing")
  await waitDone(sub.manager, id)
  expect(ctxOpts?.conversationId).toBe("cid-123") // sub-agent inherited the conversation
})

test("a DESTRUCTIVE tool call inside the sub-agent is gated; DENY → it never runs", async () => {
  let sent = false
  const sendTool: ToolDef = {
    name: "execute_tool", description: "", parameters: {},
    execute: async (a: any) => { if (/SEND|DELETE/i.test(a?.tool_name)) sent = true; return { ok: true } },
  }
  const { deps } = baseDeps({
    buildContext: async () => ({ system: "SYS", tools: [sendTool] }),
    // turn 1: call execute_tool(GMAIL_SEND_EMAIL); turn 2: finish.
    makeLlm: () => scriptedLlm([
      [{ kind: "tool_use", id: "c1", name: "execute_tool", args_json: JSON.stringify({ tool_name: "GMAIL_SEND_EMAIL", args: { to: "sam" } }) }, { kind: "done" }],
      [{ kind: "delta", text: "Handled." }, { kind: "done" }],
    ]),
  })
  const sub = buildBackgroundSubsystem(deps as any)
  const { id } = sub.manager.spawn("email sam")

  // Wait for the gate to ask (a pending approval appears), then DENY it.
  for (let i = 0; i < 200 && sub.approvalGate.listPending().length === 0; i++) await tick()
  expect(sub.approvalGate.listPending().length).toBe(1)
  sub.approvalGate.resolveLatest(false)

  expect(await waitDone(sub.manager, id)).toBe("done")
  expect(sent).toBe(false) // denied → the real send never executed
})

test("sub-agent toolset has NO duplicate tool names even when ctx.tools already has the bg tools", async () => {
  // Mimic the real wiring: contextBuilder's actionTools loader already injected
  // foreground spawn_background_task + background_tasks into ctx.tools.
  const foregroundBg: ToolDef[] = [
    { name: "spawn_background_task", description: "", parameters: {}, execute: async () => "fg" },
    { name: "background_tasks", description: "", parameters: {}, concurrencySafe: true, execute: async () => ({ tasks: [] }) },
  ]
  let captured: any = null
  const { deps } = baseDeps({
    buildContext: async () => ({ system: "SYS", tools: foregroundBg }),
    makeLlm: () => scriptedLlm([[{ kind: "delta", text: "done." }, { kind: "done" }]], (b) => { captured = b }),
  })
  const sub = buildBackgroundSubsystem(deps as any)
  const { id } = sub.manager.spawn("x")
  await waitDone(sub.manager, id)
  const names = (captured?.tools ?? []).map((t: any) => t.function?.name)
  const dupes = names.filter((n: string, i: number) => names.indexOf(n) !== i)
  expect(dupes).toEqual([]) // no duplicate function names reach the provider
  expect(names).toContain("spawn_background_task")
  expect(names).toContain("background_tasks")
})

test("R5: the sub-agent toolset includes run_subtask, but the FOREGROUND tools never do", async () => {
  let captured: any = null
  const { deps } = baseDeps({
    buildContext: async () => ({ system: "SYS", tools: [] }),
    makeLlm: () => scriptedLlm([[{ kind: "delta", text: "done." }, { kind: "done" }]], (b) => { captured = b }),
  })
  const sub = buildBackgroundSubsystem(deps as any)
  // The foreground voice must NEVER get run_subtask (it would block the voice turn).
  expect(sub.foregroundTools.map((t) => t.name)).not.toContain("run_subtask")
  const { id } = sub.manager.spawn("x")
  await waitDone(sub.manager, id)
  const names = (captured?.tools ?? []).map((t: any) => t.function?.name)
  expect(names).toContain("run_subtask") // the sub-agent DOES have it (nested-only)
})

test("R5: a sub-agent that calls run_subtask gets the child's report and can use it", async () => {
  // Parent's scripted LLM: turn 1 calls run_subtask; turn 2 answers using the result.
  // The child (a fresh runAgent via spawnAndWait) is driven by the SAME scripted LLM,
  // so we script: [parent-calls-subtask] then [child-answers] then [parent-finishes].
  let turn = 0
  const { deps } = baseDeps({
    buildContext: async () => ({ system: "SYS", tools: [] }),
    makeLlm: () => ({
      async *stream() {
        const t = turn++
        if (t === 0) { yield { kind: "tool_use", id: "s1", name: "run_subtask", args_json: JSON.stringify({ goal: "do the piece" }) }; yield { kind: "done" } }
        else if (t === 1) { yield { kind: "delta", text: "worker: piece complete" }; yield { kind: "done" } } // the child
        else { yield { kind: "delta", text: "parent synthesized: piece complete" }; yield { kind: "done" } }
      },
      complete: async () => ({ text: "summary" }),
    }) as any,
  })
  const sub = buildBackgroundSubsystem(deps as any)
  const { id } = sub.manager.spawn("orchestrate")
  expect(await waitDone(sub.manager, id)).toBe("done")
  expect(sub.manager.get(id)!.summary).toContain("synthesized")
})

test("WS-approve path: resolving the parked approval BY ID (what the `approve` command does) runs the action", async () => {
  let sent = false
  const sendTool: ToolDef = {
    name: "execute_tool", description: "", parameters: {},
    execute: async (a: any) => { if (/SEND/i.test(a?.tool_name)) sent = true; return { ok: true } },
  }
  const { deps } = baseDeps({
    buildContext: async () => ({ system: "SYS", tools: [sendTool] }),
    makeLlm: () => scriptedLlm([
      [{ kind: "tool_use", id: "c1", name: "execute_tool", args_json: JSON.stringify({ tool_name: "GMAIL_SEND_EMAIL", args: { to: "sam" } }) }, { kind: "done" }],
      [{ kind: "delta", text: "Sent." }, { kind: "done" }],
    ]),
  })
  const sub = buildBackgroundSubsystem(deps as any)
  const { id } = sub.manager.spawn("email sam")
  for (let i = 0; i < 200 && sub.approvalGate.listPending().length === 0; i++) await tick()
  const pending = sub.approvalGate.listPending()
  expect(pending.length).toBe(1)
  // EXACTLY what the WS `approve` handler does: resolve the parked action by its id.
  expect(sub.approvalGate.resolve(pending[0]!.id, true)).toBe(true)
  expect(await waitDone(sub.manager, id)).toBe("done")
  expect(sent).toBe(true) // the destructive action ran after the by-id approval
})

test("a DESTRUCTIVE tool call APPROVED → it runs", async () => {
  let sent = false
  const sendTool: ToolDef = {
    name: "execute_tool", description: "", parameters: {},
    execute: async (a: any) => { if (/SEND/i.test(a?.tool_name)) sent = true; return { ok: true } },
  }
  const { deps } = baseDeps({
    buildContext: async () => ({ system: "SYS", tools: [sendTool] }),
    makeLlm: () => scriptedLlm([
      [{ kind: "tool_use", id: "c1", name: "execute_tool", args_json: JSON.stringify({ tool_name: "GMAIL_SEND_EMAIL", args: { to: "sam" } }) }, { kind: "done" }],
      [{ kind: "delta", text: "Sent it." }, { kind: "done" }],
    ]),
  })
  const sub = buildBackgroundSubsystem(deps as any)
  const { id } = sub.manager.spawn("email sam")
  for (let i = 0; i < 200 && sub.approvalGate.listPending().length === 0; i++) await tick()
  sub.approvalGate.resolveLatest(true)
  expect(await waitDone(sub.manager, id)).toBe("done")
  expect(sent).toBe(true)
})

test("background task speaks AT MOST ONE sparse mid-run update (then only the final report)", async () => {
  process.env.KAIROS_BG_UPDATE_AFTER_MS = "0"   // no wait in tests; default is 60s
  try {
    const { deps, spoken } = baseDeps({
      makeLlm: () => scriptedLlm([
        // turn 1 + 2: two plan updates → two task_progress events
        [{ kind: "tool_use", id: "c1", name: "update_plan", args_json: '{"plan":[{"step":"digging into flight prices","status":"in_progress"}]}' }, { kind: "done" }],
        [{ kind: "tool_use", id: "c2", name: "update_plan", args_json: '{"plan":[{"step":"digging into flight prices","status":"completed"},{"step":"comparing airlines","status":"in_progress"}]}' }, { kind: "done" }],
        [{ kind: "delta", text: "Found three good options." }, { kind: "done" }],
      ]),
    })
    const sub = buildBackgroundSubsystem(deps as any)
    const { id } = sub.manager.spawn("research flights to SF")
    await waitDone(sub.manager, id!)
    await tick(); await tick()
    const updates = spoken.filter((s) => s.startsWith("Quick update"))
    expect(updates.length).toBe(1)                                  // sparse: ONE update, not chatter
    expect(updates[0]).toContain("research flights to SF")
    expect(updates[0]).toMatch(/digging into flight prices/)        // the milestone note, humanized
    expect(spoken.some((s) => s.startsWith("Done with"))).toBe(true) // final report still spoken
  } finally { delete process.env.KAIROS_BG_UPDATE_AFTER_MS }
})

test("KAIROS_BG_SPOKEN_UPDATES=0 disables mid-run updates entirely", async () => {
  process.env.KAIROS_BG_UPDATE_AFTER_MS = "0"
  process.env.KAIROS_BG_SPOKEN_UPDATES = "0"
  try {
    const { deps, spoken } = baseDeps({
      makeLlm: () => scriptedLlm([
        [{ kind: "tool_use", id: "c1", name: "update_plan", args_json: '{"plan":[{"step":"working","status":"in_progress"}]}' }, { kind: "done" }],
        [{ kind: "delta", text: "Done." }, { kind: "done" }],
      ]),
    })
    const sub = buildBackgroundSubsystem(deps as any)
    const { id } = sub.manager.spawn("some goal")
    await waitDone(sub.manager, id!)
    await tick()
    expect(spoken.filter((s) => s.startsWith("Quick update")).length).toBe(0)
  } finally { delete process.env.KAIROS_BG_UPDATE_AFTER_MS; delete process.env.KAIROS_BG_SPOKEN_UPDATES }
})

// ── Learnings harvest ─────────────────────────────────────────────────────────────

test("extractLearning peels a valid Learning line off the spoken report", () => {
  const { spoken, learning } = extractLearning(
    "Booked the 9am ANA flight at $812.\nLearning: Kayak needed the city code, not the airport name.",
  )
  expect(spoken).toBe("Booked the 9am ANA flight at $812.")
  expect(learning).toBe("Kayak needed the city code, not the airport name.")
})

test("extractLearning accepts the 'One learning for next time:' phrasing too", () => {
  const { learning } = extractLearning("Done.\nOne learning for next time — use the v2 endpoint for bulk reads.")
  expect(learning).toBe("use the v2 endpoint for bulk reads.")
})

test("a failure-echo learning is neither stored nor spoken", () => {
  const { spoken, learning } = extractLearning(
    "I finished what I could.\nLearning: I was unable to access the Notion page.",
  )
  expect(learning).toBeUndefined()
  expect(spoken).toBe("I finished what I could.")
})

test("a report with no learning line passes through unchanged", () => {
  const { spoken, learning } = extractLearning("All set — three events created.")
  expect(spoken).toBe("All set — three events created.")
  expect(learning).toBeUndefined()
})

test("a learning-only report keeps its text for the spoken fallback", () => {
  const { spoken, learning } = extractLearning("Learning: the export needs ISO dates.")
  expect(learning).toBe("the export needs ISO dates.")
  expect(spoken).toContain("the export needs ISO dates")  // never return empty speech
})

test("a finished run stores its learning in memory and keeps it out of the spoken report", async () => {
  const recorded: any[] = []
  const { deps, spoken } = baseDeps({
    makeLlm: () => scriptedLlm([[
      { kind: "delta", text: "Sorted 14 emails into folders.\nLearning: Gmail batch-modify caps at 50 ids per call." },
      { kind: "done" },
    ]]),
    learnings: { record: async (input: any) => { recorded.push(input) } },
  })
  const sub = buildBackgroundSubsystem(deps as any)
  const { id } = sub.manager.spawn("sort my inbox")
  await waitDone(sub.manager, id)
  await tick()
  expect(recorded).toEqual([{ source: "learning", text: "Gmail batch-modify caps at 50 ids per call." }])
  const report = spoken.find((s) => s.includes("Sorted 14 emails"))
  expect(report).toBeDefined()
  expect(report!).not.toContain("Learning:")
  expect(report!).not.toContain("batch-modify")
})

test("the same learning is recorded only once per session (dedupe)", async () => {
  const recorded: any[] = []
  const { deps } = baseDeps({
    makeLlm: () => scriptedLlm([[
      { kind: "delta", text: "Done.\nLearning: Gmail batch-modify caps at 50 ids per call." },
      { kind: "done" },
    ]]),
    learnings: { record: async (input: any) => { recorded.push(input) } },
  })
  const sub = buildBackgroundSubsystem(deps as any)
  const a = sub.manager.spawn("sort my inbox")
  await waitDone(sub.manager, a.id)
  const b = sub.manager.spawn("sort my inbox again")
  await waitDone(sub.manager, b.id)
  await tick()
  expect(recorded.length).toBe(1)
})

test("a learnings-store failure never breaks the run or the report", async () => {
  const { deps, spoken } = baseDeps({
    makeLlm: () => scriptedLlm([[
      { kind: "delta", text: "Finished the research.\nLearning: site search beats the API here." },
      { kind: "done" },
    ]]),
    learnings: { record: async () => { throw new Error("db locked") } },
  })
  const sub = buildBackgroundSubsystem(deps as any)
  const { id } = sub.manager.spawn("research")
  expect(await waitDone(sub.manager, id)).toBe("done")
  await tick()
  expect(spoken.some((s) => s.includes("Finished the research"))).toBe(true)
})
