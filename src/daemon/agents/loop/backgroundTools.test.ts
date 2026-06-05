// src/daemon/agents/loop/backgroundTools.test.ts
import { test, expect } from "bun:test"
import { buildBackgroundTools } from "./backgroundTools"

function fakeManager(over: any = {}) {
  return {
    spawn: (goal: string) => ({ id: "bg1", accepted: true }),
    listAll: () => [] as any[],
    ...over,
  }
}
const get = (tools: any[], name: string) => tools.find((t) => t.name === name)!

test("spawn_background_task spawns a task and confirms (mentions the goal)", async () => {
  const calls: string[] = []
  const m = fakeManager({ spawn: (g: string) => { calls.push(g); return { id: "bg1", accepted: true } } })
  const r = await get(buildBackgroundTools({ manager: m as any }), "spawn_background_task").execute({ goal: "organize my inbox" })
  expect(calls).toEqual(["organize my inbox"])
  expect(String(r).toLowerCase()).toMatch(/started|on it|background/)
})

test("spawn_background_task surfaces the rejection reason when at capacity", async () => {
  const m = fakeManager({ spawn: () => ({ id: "", accepted: false, reason: "at capacity (too many running tasks)" }) })
  const r = await get(buildBackgroundTools({ manager: m as any }), "spawn_background_task").execute({ goal: "x" })
  expect(String(r).toLowerCase()).toMatch(/capac|couldn't|can't/)
})

test("background_tasks reports running + recent tasks (goal, status, what it's doing) for the agent to humanize", async () => {
  const m = fakeManager({
    listAll: () => [
      { id: "a", goal: "research competitors", status: "running", lastActivity: "using search_tools", toolsUsed: 3 },
      { id: "b", goal: "sort old emails", status: "done", summary: "Archived 40 emails." },
    ],
  })
  const r: any = await get(buildBackgroundTools({ manager: m as any }), "background_tasks").execute({})
  expect(r.tasks.length).toBe(2)
  const running = r.tasks.find((t: any) => t.status === "running")
  expect(running.goal).toBe("research competitors")
  expect(running.doing).toContain("search_tools")
  const done = r.tasks.find((t: any) => t.status === "done")
  expect(done.summary).toContain("Archived 40")
})

test("background_tasks says so when nothing is running", async () => {
  const m = fakeManager({ listAll: () => [] })
  const r: any = await get(buildBackgroundTools({ manager: m as any }), "background_tasks").execute({})
  expect(r.tasks).toEqual([])
  expect(String(r.note ?? "").toLowerCase()).toMatch(/no background|nothing/)
})

test("background_tasks is concurrencySafe; spawn_background_task is not", () => {
  const tools = buildBackgroundTools({ manager: fakeManager() as any })
  expect(get(tools, "background_tasks").concurrencySafe).toBe(true)
  expect(get(tools, "spawn_background_task").concurrencySafe).toBeFalsy()
})
