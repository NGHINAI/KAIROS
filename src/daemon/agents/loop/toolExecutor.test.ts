// src/daemon/agents/loop/toolExecutor.test.ts
import { test, expect } from "bun:test"
import { executeToolCall } from "./toolExecutor"
import type { ToolDef } from "../types"

const tools: ToolDef[] = [
  { name: "echo", description: "echo", parameters: {}, execute: async (a: any) => ({ echoed: a }) },
  { name: "say", description: "say", parameters: {}, execute: async () => "hello" },
  { name: "boom", description: "boom", parameters: {}, execute: async () => { throw new Error("kaboom") } },
]

test("returns a tool result with the call id on success (object result is JSON-stringified)", async () => {
  const r = await executeToolCall({ id: "c1", name: "echo", argsJson: '{"x":1}' }, tools)
  expect(r.tool_call_id).toBe("c1")
  expect(r.ok).toBe(true)
  expect(JSON.parse(r.content)).toEqual({ echoed: { x: 1 } })
})

test("string results pass through as content", async () => {
  const r = await executeToolCall({ id: "c2", name: "say", argsJson: "{}" }, tools)
  expect(r.content).toBe("hello")
  expect(r.ok).toBe(true)
})

test("UNKNOWN tool → error result fed back to the model (not a throw)", async () => {
  const r = await executeToolCall({ id: "c3", name: "nope", argsJson: "{}" }, tools)
  expect(r.ok).toBe(false)
  expect(r.tool_call_id).toBe("c3")
  expect(r.content.toLowerCase()).toMatch(/no tool|unknown|search_tools/)
})

test("MALFORMED args JSON → error result fed back (self-correction), not a throw", async () => {
  const r = await executeToolCall({ id: "c4", name: "echo", argsJson: "{not json" }, tools)
  expect(r.ok).toBe(false)
  expect(r.content.toLowerCase()).toMatch(/json|parse|argument/)
})

test("tool that THROWS → error result fed back so the model can route around it", async () => {
  const r = await executeToolCall({ id: "c5", name: "boom", argsJson: "{}" }, tools)
  expect(r.ok).toBe(false)
  expect(r.content).toContain("kaboom")
})

test("oversized result is elided with an explicit marker (middle-elision, not a raw mid-JSON cut)", async () => {
  const huge = { headField: "HEAD", items: Array.from({ length: 5000 }, (_, i) => ({ i, name: "x".repeat(20) })) }
  const big: ToolDef[] = [{ name: "big", description: "", parameters: {}, execute: async () => huge }]
  const r = await executeToolCall({ id: "c7", name: "big", argsJson: "{}" }, big, { maxChars: 500 })
  expect(r.ok).toBe(true)
  expect(r.content.length).toBeLessThan(700)
  expect(r.content).toMatch(/elided/i)     // tells the model it was cut
  expect(r.content).toContain("HEAD")      // head preserved (middle-elision keeps both ends)
})

test("aborted signal → synthetic 'aborted' result (never an orphaned tool_call_id)", async () => {
  const ctrl = new AbortController()
  ctrl.abort()
  const r = await executeToolCall({ id: "c6", name: "echo", argsJson: "{}" }, tools, { signal: ctrl.signal })
  expect(r.ok).toBe(false)
  expect(r.tool_call_id).toBe("c6")
  expect(r.content.toLowerCase()).toContain("abort")
})
