// src/daemon/agents/conductor.streamthink.test.ts
// Streaming [[think]]: the deep answer streams sentence-by-sentence to the speaker.
// The cap is a FIRST-TOKEN deadline — once speech begins the answer runs to completion.
import { test, expect } from "bun:test"
import { Conductor } from "./conductor"
import type { ToolDef } from "./types"

function recorderSink() {
  const fed: string[] = []
  const calls: string[] = []
  return {
    fed, calls,
    sink: {
      begin: () => { calls.push("begin") },
      feed: (t: string) => { fed.push(t); calls.push("feed") },
      end: async () => { calls.push("end") },
      cancel: () => { calls.push("cancel") },
    },
  }
}

function baseDeps(over: any = {}) {
  const spoken: string[] = []
  const events: any[] = []
  const turns: any[] = []
  return {
    spoken, events, turns,
    deps: {
      classifyLlm: { complete: async () => ({ text: "{}" }) },
      fastLlm: { complete: async () => ({ text: "[[think]] one sec." }) },
      smartLlm: { complete: async () => ({ text: "smart" }) },
      thinkLlm: { complete: async () => ({ text: "blocking answer" }) },
      tools: [] as ToolDef[],
      contextBuilder: { build: async () => ({ system: "SYS", tools: [] as ToolDef[] }) },
      onEvent: (e: any) => events.push(e),
      speakBackend: { speak: async (t: string) => { spoken.push(t) } },
      conversationMessages: {
        loadForReplay: async () => [],
        appendTurn: async (_c: string, _t: string, msgs: any[]) => { turns.push(msgs) },
      },
      runPlanner: async () => { throw new Error("planner must not run for streaming think") },
      ...over,
    },
  }
}

async function* streamOf(events: any[], opts?: { delayMs?: number; signalFrom?: () => AbortSignal | undefined }) {
  for (const e of events) {
    if (opts?.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs))
    yield e
  }
}

test("the deep answer streams to the speaker sentence-by-sentence and is persisted", async () => {
  const { sink, fed, calls } = recorderSink()
  const { deps, events, turns, spoken } = baseDeps({
    streamSink: sink,
    thinkStream: () => streamOf([
      { kind: "delta", text: "Lease if you value flexibility. " },
      { kind: "delta", text: "Buy if you keep cars **eight** years." },
      { kind: "done", text: "" },
    ]),
  })
  const c = new Conductor(deps as any)
  await c.handle({ utterance: "think it through: lease or buy?", conversationId: "c1" })

  expect(spoken[0]).toBe("one sec.")                       // the ack masked startup
  expect(calls[0]).toBe("begin")                            // speaker armed on first token
  expect(calls[calls.length - 1]).toBe("end")               // drained at the end
  const streamed = fed.join("")
  expect(streamed).toContain("Lease if you value flexibility.")
  expect(streamed).not.toContain("**")                      // markdown never reaches TTS
  const done = events.find((e) => e.kind === "agent_done")
  expect(done.text).toContain("eight")
  expect(done.text).not.toContain("**")
  expect(turns.length).toBe(1)                              // transcript stays continuous
  expect(turns[0][1].role).toBe("assistant")
})

test("no first token within the deadline → background conversion (stream cancelled, not the turn)", async () => {
  process.env.KAIROS_THINK_FIRST_TOKEN_MS = "40"
  try {
    const { sink } = recorderSink()
    let spawned: any = null
    const spawnTool: ToolDef = {
      name: "spawn_background_task",
      description: "", parameters: { type: "object", properties: {} },
      execute: async (a: any) => { spawned = a; return "ok" },
    }
    const { deps, events, spoken } = baseDeps({
      streamSink: sink,
      contextBuilder: { build: async () => ({ system: "SYS", tools: [spawnTool] }) },
      thinkStream: (body: any) => (async function* () {
        // Respects the abort signal like the real adapter: never yields if cancelled first.
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, 5_000)
          body.signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")) })
        })
        yield { kind: "delta", text: "too late" }
      })(),
    })
    const c = new Conductor(deps as any)
    await c.handle({ utterance: "think hard about this", conversationId: "c1" })

    expect(spawned?.goal).toBe("think hard about this")     // the user's words, verbatim
    const done = events.find((e) => e.kind === "agent_done")
    expect(done.text).toContain("get back to you")
    expect(spoken.some((s) => s.includes("get back to you"))).toBe(true)
  } finally { delete process.env.KAIROS_THINK_FIRST_TOKEN_MS }
})

test("the think prompt uses the SLIM system, not the smart planner context", async () => {
  const { sink } = recorderSink()
  let seenSystem = ""
  const { deps } = baseDeps({
    streamSink: sink,
    contextBuilder: {
      build: async (o: any) => o.tier === "fast"
        ? { system: "SLIM_SYSTEM", tools: [] }
        : { system: "BIG_SMART_SYSTEM_WITH_TOOL_RULES", tools: [] },
    },
    thinkStream: (body: any) => {
      seenSystem = body.messages?.[0]?.content ?? ""
      return streamOf([{ kind: "delta", text: "Answer. " }, { kind: "done", text: "" }])
    },
  })
  const c = new Conductor(deps as any)
  await c.handle({ utterance: "think: hard question", conversationId: "c1" })
  expect(seenSystem).toContain("SLIM_SYSTEM")
  expect(seenSystem).not.toContain("BIG_SMART_SYSTEM")
  expect(seenSystem).toContain("Think mode")
})

test("a stream error before any speech also converts to background", async () => {
  const { sink, calls } = recorderSink()
  let spawned: any = null
  const spawnTool: ToolDef = {
    name: "spawn_background_task",
    description: "", parameters: { type: "object", properties: {} },
    execute: async (a: any) => { spawned = a; return "ok" },
  }
  const { deps } = baseDeps({
    streamSink: sink,
    contextBuilder: { build: async () => ({ system: "SYS", tools: [spawnTool] }) },
    thinkStream: () => streamOf([{ kind: "error", message: "provider 500" }]),
  })
  const c = new Conductor(deps as any)
  await c.handle({ utterance: "hard question", conversationId: "c1" })
  expect(spawned?.goal).toBe("hard question")
  expect(calls).not.toContain("begin")                      // never started speaking
})

test("a barge-in mid-stream interrupts cleanly — no done, no background spawn", async () => {
  const { sink } = recorderSink()
  const controller = new AbortController()
  let spawned = false
  const spawnTool: ToolDef = {
    name: "spawn_background_task",
    description: "", parameters: { type: "object", properties: {} },
    execute: async () => { spawned = true; return "ok" },
  }
  const origFeed = sink.feed
  sink.feed = (t: string) => { origFeed(t); controller.abort() }   // user barges in after the first sentence
  const { deps, events } = baseDeps({
    streamSink: sink,
    contextBuilder: { build: async () => ({ system: "SYS", tools: [spawnTool] }) },
    thinkStream: () => streamOf([
      { kind: "delta", text: "First sentence. " },
      { kind: "delta", text: "Second sentence. " },
      { kind: "done", text: "" },
    ], { delayMs: 5 }),
  })
  const c = new Conductor(deps as any)
  await c.handle({ utterance: "think about it", conversationId: "c1", signal: controller.signal })

  expect(events.some((e) => e.kind === "agent_interrupted")).toBe(true)
  expect(events.some((e) => e.kind === "agent_done")).toBe(false)
  expect(spawned).toBe(false)
})

test("an answer that finishes mid-stream still flushes its unpunctuated tail", async () => {
  const { sink, fed } = recorderSink()
  const { deps, events } = baseDeps({
    streamSink: sink,
    thinkStream: () => streamOf([
      { kind: "delta", text: "Roughly 441" },     // no sentence boundary — held by the filter
      { kind: "done", text: "" },
    ]),
  })
  const c = new Conductor(deps as any)
  await c.handle({ utterance: "what's 18% of 2450, think", conversationId: "c1" })
  expect(fed.join("")).toContain("441")            // flushed, not swallowed
  expect(events.find((e) => e.kind === "agent_done").text).toContain("441")
})

test("without thinkStream the blocking path still works (legacy)", async () => {
  const { deps, events, spoken } = baseDeps({})    // no streamSink/thinkStream
  const c = new Conductor(deps as any)
  await c.handle({ utterance: "think: which is better?", conversationId: "c1" })
  expect(events.find((e) => e.kind === "agent_done").text).toContain("blocking answer")
  expect(spoken.some((s) => s.includes("blocking answer"))).toBe(true)
})
