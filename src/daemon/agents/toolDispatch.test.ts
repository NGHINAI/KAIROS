// src/daemon/agents/toolDispatch.test.ts
import { test, expect } from "bun:test"
import { buildToolDispatchTools } from "./toolDispatch"

const fakeRetriever = {
  retrieve: async (q: string, _k?: number) => {
    if (q.includes("linear")) return [{ name: "LINEAR_LIST_ISSUES", toolkit: "linear", description: "List issues", parameters: { type: "object", properties: { limit: { type: "number" } } } }]
    return []
  },
}

test("search_tools returns retrieved tool name/description/parameters for the model to then call", async () => {
  const { searchTool } = buildToolDispatchTools({ retriever: fakeRetriever as any, execute: async () => ({}) })
  expect(searchTool.name).toBe("search_tools")
  const out = await searchTool.execute({ query: "my linear issues" })
  expect(out.tools[0].name).toBe("LINEAR_LIST_ISSUES")
  expect(out.tools[0].parameters).toEqual({ type: "object", properties: { limit: { type: "number" } } })
})

test("search_tools tells the model how to act when nothing is found", async () => {
  const { searchTool } = buildToolDispatchTools({ retriever: fakeRetriever as any, execute: async () => ({}) })
  const out = await searchTool.execute({ query: "send a fax" })
  expect(out.tools).toEqual([])
  expect(String(out.note ?? "")).toMatch(/connect|no.*tool/i)
})

test("execute_tool dispatches by tool_name with args", async () => {
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
