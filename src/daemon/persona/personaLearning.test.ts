// src/daemon/persona/personaLearning.test.ts
// Unit 3 — LLM-driven persona diff + recordNudge tool path.
import { describe, it, expect } from "bun:test"
import { Database } from "bun:sqlite"
import { DreamingExtension } from "./dreamingExtension"
import { PersonaUpdater } from "./personaUpdater"
import { TrajWriter } from "./trajWriter"
import { buildIntrospectionTools } from "../agents/introspectionTools"
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

function tmp() { return mkdtempSync(join(tmpdir(), "kairos-persona-")) }

describe("DreamingExtension — LLM diff (Unit 3)", () => {
  it("uses the router to compose a rich persona diff when present", async () => {
    const dir = tmp()
    const personaUpdater = new PersonaUpdater({ path: join(dir, "persona.md") })
    const trajWriter = new TrajWriter({ dir: join(dir, "traj") })
    // seed a trajectory so promotable is non-empty
    trajWriter.record({
      ts: Date.now(), task_goal: "summarize emails tersely", intent_id: "summarize",
      args_summary: "", steps: [{ action: "summarize", result_summary: "done" }],
      outcome: "success", duration_ms: 100,
    })
    let routerCalled = false
    const router = {
      complete: async () => {
        routerCalled = true
        return { text: '{"communication_style":"Prefers terse, direct summaries.","preferences":"Likes email digests."}' }
      },
    }
    const dreaming = new DreamingExtension({ trajWriter, personaUpdater, router: router as any })
    await dreaming.runCycle("deep")
    expect(routerCalled).toBe(true)
    const p = personaUpdater.get()
    expect(p.communication_style).toMatch(/terse/i)
    expect(p.preferences).toMatch(/digest/i)
  })

  it("falls back to heuristic (recent_themes only) when no router", async () => {
    const dir = tmp()
    const personaUpdater = new PersonaUpdater({ path: join(dir, "persona.md") })
    const trajWriter = new TrajWriter({ dir: join(dir, "traj") })
    trajWriter.record({
      ts: Date.now(), task_goal: "x", intent_id: "do_thing",
      args_summary: "", steps: [{ action: "a", result_summary: "r" }],
      outcome: "success", duration_ms: 10,
    })
    const dreaming = new DreamingExtension({ trajWriter, personaUpdater }) // no router
    await dreaming.runCycle("deep")
    const p = personaUpdater.get()
    expect(p.communication_style).toBeUndefined()
    // heuristic may set recent_themes (activity tally) — that's the fallback shape
  })
})

describe("kairos_remember_preference tool (Unit 3)", () => {
  it("records a preference via personaUpdater.recordNudge", async () => {
    let nudged = ""
    const tools = buildIntrospectionTools({
      soulLoader: { load: async () => "" },
      skillRegistry: { listActive: async () => [] },
      ordersStore: { list: async () => [] },
      semanticMemory: { add: async () => ({}), search: async () => [] },
      episodicMemory: { recent: async () => [], search: async () => [] },
      memoryStore: { read: async () => "" },
      dreamLog: { last: async () => null, search: async () => [] },
      connectionStore: { list: async () => [] },
      personaUpdater: { recordNudge: (n: string) => { nudged = n; return {} } },
    })
    const tool = tools.find(t => t.name === "kairos_remember_preference")
    expect(tool).toBeDefined()
    const out = await tool!.execute({ preference: "keep replies short" })
    expect(out.saved).toBe(true)
    expect(nudged).toBe("keep replies short")
  })
})
