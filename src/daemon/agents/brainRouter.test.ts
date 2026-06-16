// src/daemon/agents/brainRouter.test.ts
import { test, expect } from "bun:test"
import { pickBrain, createBrainRouter, type BrainBackend } from "./brainRouter"

const both = { inhouse: true, opencode: true }

test("pickBrain: interactive (voice) prefers in-house, opencode as fallback", () => {
  expect(pickBrain({ lane: "guidance" }, both)).toEqual(["inhouse", "opencode"])
})

test("pickBrain: background prefers opencode, in-house as fallback", () => {
  expect(pickBrain({ lane: "general" }, both)).toEqual(["opencode", "inhouse"])
})

test("pickBrain: background with opencode unavailable → in-house only", () => {
  expect(pickBrain({ lane: "general" }, { inhouse: true, opencode: false })).toEqual(["inhouse"])
})

test("pickBrain: voice with in-house unavailable → opencode", () => {
  expect(pickBrain({ lane: "guidance" }, { inhouse: false, opencode: true })).toEqual(["opencode"])
})

test("pickBrain: nothing available → in-house base (never empty)", () => {
  expect(pickBrain({ lane: "general" }, { inhouse: false, opencode: false })).toEqual(["inhouse"])
})

test("pickBrain: force=opencode pins it first even on a voice lane", () => {
  expect(pickBrain({ lane: "guidance", force: "opencode" }, both)).toEqual(["opencode", "inhouse"])
})

test("pickBrain: force is ignored when that engine is unavailable", () => {
  expect(pickBrain({ lane: "guidance", force: "opencode" }, { inhouse: true, opencode: false })).toEqual(["inhouse"])
})

test("router: routerOpts.force pins the engine across lanes", async () => {
  const calls: string[] = []
  const r = createBrainRouter([
    backend("inhouse", () => { calls.push("inhouse"); return okResult("inhouse") }),
    backend("opencode", () => { calls.push("opencode"); return okResult("opencode") }),
  ], undefined, { force: "opencode" })
  const res = await r.run("hi", { tools: [], instructions: "", lane: "guidance" } as any)
  expect(res.finalOutput).toBe("done by opencode")
  expect(calls).toEqual(["opencode"])
})

// ── router dispatch + fallback ──
function backend(name: "inhouse" | "opencode", impl: (input: string) => any, available = true): BrainBackend {
  return { name, available: () => available, run: async (input: string) => impl(input) }
}
const okResult = (tag: string) => ({ finalOutput: `done by ${tag}`, toolCalls: [{ id: "1", name: "x", args: {} }] })

test("router: a voice turn runs on in-house", async () => {
  const calls: string[] = []
  const r = createBrainRouter([
    backend("inhouse", () => { calls.push("inhouse"); return okResult("inhouse") }),
    backend("opencode", () => { calls.push("opencode"); return okResult("opencode") }),
  ])
  const res = await r.run("hi", { tools: [], instructions: "", lane: "guidance" } as any)
  expect(res.finalOutput).toBe("done by inhouse")
  expect(calls).toEqual(["inhouse"])
})

test("router: a background task runs on opencode", async () => {
  const calls: string[] = []
  const r = createBrainRouter([
    backend("inhouse", () => { calls.push("inhouse"); return okResult("inhouse") }),
    backend("opencode", () => { calls.push("opencode"); return okResult("opencode") }),
  ])
  const res = await r.run("do research", { tools: [], instructions: "", lane: "general" } as any)
  expect(res.finalOutput).toBe("done by opencode")
  expect(calls).toEqual(["opencode"])
})

test("router: background falls back to in-house when opencode THROWS", async () => {
  const calls: string[] = []
  const r = createBrainRouter([
    backend("inhouse", () => { calls.push("inhouse"); return okResult("inhouse") }),
    backend("opencode", () => { calls.push("opencode"); throw new Error("serve died") }),
  ])
  const res = await r.run("do research", { tools: [], instructions: "", lane: "general" } as any)
  expect(res.finalOutput).toBe("done by inhouse")
  expect(calls).toEqual(["opencode", "inhouse"])
})

test("router: background falls back to in-house when opencode returns EMPTY", async () => {
  const r = createBrainRouter([
    backend("inhouse", () => okResult("inhouse")),
    backend("opencode", () => ({ finalOutput: "", toolCalls: [] })),
  ])
  const res = await r.run("do research", { tools: [], instructions: "", lane: "general" } as any)
  expect(res.finalOutput).toBe("done by inhouse")
})

test("router: background with opencode UNAVAILABLE goes straight to in-house", async () => {
  const calls: string[] = []
  const r = createBrainRouter([
    backend("inhouse", () => { calls.push("inhouse"); return okResult("inhouse") }),
    backend("opencode", () => { calls.push("opencode"); return okResult("opencode") }, false),
  ])
  const res = await r.run("do research", { tools: [], instructions: "", lane: "general" } as any)
  expect(res.finalOutput).toBe("done by inhouse")
  expect(calls).toEqual(["inhouse"])
})
