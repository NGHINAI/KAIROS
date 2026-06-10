// src/daemon/agents/toolDispatch.test.ts
import { test, expect } from "bun:test"
import { buildToolDispatchTools } from "./toolDispatch"

const LINEAR_DOC = {
  name: "LINEAR_LIST_ISSUES",
  toolkit: "linear",
  description: "List issues",
  parameters: { type: "object", properties: { limit: { type: "number" }, team: { type: "string" } }, required: ["team"] },
}

const fakeRetriever = {
  retrieve: async (q: string, _k?: number) => {
    if (q.includes("linear")) return [LINEAR_DOC]
    return []
  },
  getByNames: (names: string[]) => names.includes("LINEAR_LIST_ISSUES") ? [LINEAR_DOC] : [],
}

test("search_tools returns a TEXT observation with name, toolkit and the compact args signature", async () => {
  const { searchTool } = buildToolDispatchTools({ retriever: fakeRetriever as any, execute: async () => ({}) })
  expect(searchTool.name).toBe("search_tools")
  const out = await searchTool.execute({ query: "my linear issues" })
  expect(typeof out).toBe("string")
  expect(out).toContain("LINEAR_LIST_ISSUES (linear)")
  expect(out).toContain("List issues")
  // required-first signature with the star, optional after
  expect(out).toContain("args: team*:string, limit:number")
  expect(out).toContain("* = required")
})

test("search_tools tells the model how to act when nothing is found", async () => {
  const { searchTool } = buildToolDispatchTools({ retriever: fakeRetriever as any, execute: async () => ({}) })
  const out = await searchTool.execute({ query: "send a fax" })
  expect(typeof out).toBe("string")
  expect(out).toMatch(/connect|no.*tool/i)
})

test("a tool without an indexed schema says so instead of inventing one", async () => {
  const retriever = {
    retrieve: async () => [{ name: "X_DO", toolkit: "x", description: "Does X" }],
  }
  const { searchTool } = buildToolDispatchTools({ retriever: retriever as any, execute: async () => ({}) })
  const out = await searchTool.execute({ query: "do x" })
  expect(out).toContain("schema unknown")
})

test("execute_tool dispatches by tool_name with args and passes a success result through untouched", async () => {
  const calls: Array<{ name: string; args: any }> = []
  const { executeTool } = buildToolDispatchTools({
    retriever: fakeRetriever as any,
    execute: async (name, args) => { calls.push({ name, args }); return { issues: ["a"] } },
  })
  expect(executeTool.name).toBe("execute_tool")
  const r = await executeTool.execute({ tool_name: "LINEAR_LIST_ISSUES", args: { limit: 3 } })
  expect(calls[0]).toEqual({ name: "LINEAR_LIST_ISSUES", args: { limit: 3 } })
  expect(r).toEqual({ issues: ["a"] })
})

test("execute_tool tolerates a missing args object", async () => {
  const calls: any[] = []
  const { executeTool } = buildToolDispatchTools({
    retriever: fakeRetriever as any,
    execute: async (name, args) => { calls.push({ name, args }); return {} },
  })
  await executeTool.execute({ tool_name: "X_DO" })
  expect(calls[0]).toEqual({ name: "X_DO", args: {} })
})

test("an envelope failure gets the expected args signature appended (schema-on-failure teaching)", async () => {
  const raw = { successful: false, error: "Missing required field 'team'", data: { weird: 1 } }
  const { executeTool } = buildToolDispatchTools({
    retriever: fakeRetriever as any,
    execute: async () => raw,
  })
  const r = await executeTool.execute({ tool_name: "LINEAR_LIST_ISSUES", args: {} })
  expect(r.successful).toBe(false)
  expect(r.error).toContain("Missing required field 'team'")
  expect(r.error).toContain("Expected args for LINEAR_LIST_ISSUES")
  expect(r.error).toContain("team*:string")
  // the original envelope must not be mutated (raw is kept for verify/replay)
  expect(raw.error).toBe("Missing required field 'team'")
  expect(r.data).toEqual({ weird: 1 })
})

test("guidance hiding in data.message survives AND gains the signature", async () => {
  const { executeTool } = buildToolDispatchTools({
    retriever: fakeRetriever as any,
    execute: async () => ({ successful: false, error: null, data: { message: "team is required; see docs" } }),
  })
  const r = await executeTool.execute({ tool_name: "LINEAR_LIST_ISSUES", args: {} })
  expect(r.error).toContain("team is required; see docs")
  expect(r.error).toContain("team*:string")
})

test("a thrown failure carries the signature in its message", async () => {
  const { executeTool } = buildToolDispatchTools({
    retriever: fakeRetriever as any,
    execute: async () => { throw new Error("400 invalid request") },
  })
  await expect(executeTool.execute({ tool_name: "LINEAR_LIST_ISSUES", args: {} }))
    .rejects.toThrow(/400 invalid request — expected args for LINEAR_LIST_ISSUES.*team\*:string/)
})

test("failures for tools with no indexed schema pass through unchanged", async () => {
  const raw = { successful: false, error: "boom" }
  const { executeTool } = buildToolDispatchTools({
    retriever: fakeRetriever as any,
    execute: async () => raw,
  })
  const r = await executeTool.execute({ tool_name: "UNKNOWN_TOOL", args: {} })
  expect(r).toBe(raw)
})

test("a successful envelope is never rewritten by the failure path", async () => {
  const ok = { successful: true, data: { items: [1, 2] }, error: 0 } // falsy error ≠ failure
  const { executeTool } = buildToolDispatchTools({
    retriever: fakeRetriever as any,
    execute: async () => ok,
  })
  const r = await executeTool.execute({ tool_name: "LINEAR_LIST_ISSUES", args: { team: "x" } })
  expect(r).toBe(ok)
})
