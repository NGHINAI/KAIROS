// taskRunner.test.ts — the proactive WORK lane runs through the IN-HOUSE sub-agent
// runner (runWork), NOT a `claude -p` subprocess. These tests pin that contract:
// runWork is called with the task framing, its {finalText, ok} maps to the task
// lifecycle (done / failed / re-queued watch), and a missing runWork fails safely
// (it must NEVER fall back to spawning claude — no claude models at runtime).
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { initDatabase, createTask, getTask, getUnreadMessages } from "./db"
import { TaskRunner } from "./taskRunner"
import type { Config } from "./types"

function testConfig(sandboxDir: string): Config {
  return {
    sandboxDir,
    isSandbox: true,
    verbose: false,
    port: 8765,
    tick: { defaultIntervalMs: 60_000, minSleepMs: 30_000, maxSleepMs: 1_800_000 },
    budget: { maxSubprocessPerHour: 60, maxProactiveMsgsPerHour: 10, maxCostCentsPerHour: 100 },
    task: { maxConcurrent: 3, timeoutMs: 30 * 60 * 1000 },
    models: { tick: "openai/gpt-4o-mini", work: "minimax/minimax-m3", dream: "openai/gpt-4o-mini" },
  } as unknown as Config
}

describe("TaskRunner WORK lane → in-house runWork (no claude subprocess)", () => {
  let db: ReturnType<typeof initDatabase>
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kairos-taskrunner-"))
    db = initDatabase(":memory:")
  })
  afterEach(() => {
    try { db.close() } catch { /* */ }
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* */ }
  })

  test("runTask calls the injected runWork with the task description and marks a one-shot done", async () => {
    const seen: Array<{ goal: string; conversationId?: string | null }> = []
    const runWork = async (goal: string, opts: { conversationId?: string | null }) => {
      seen.push({ goal, conversationId: opts.conversationId })
      return { finalText: "Booked the 9am flight, confirmation ABC123.", ok: true }
    }
    const runner = new TaskRunner(db, testConfig(dir), { runWork })
    const taskId = createTask(db, { description: "Book the cheapest morning flight", sessionId: null, workingDir: dir })

    const res = await runner.runTask(taskId)

    expect(seen.length).toBe(1)
    expect(seen[0]!.goal).toContain("Book the cheapest morning flight")
    expect(res.status).toBe("success")
    expect(res.summary).toContain("ABC123")
    const task = getTask(db, taskId)!
    expect(task.status).toBe("done")
  })

  test("runWork ok:false → task failed", async () => {
    const runWork = async () => ({ finalText: "Couldn't reach the booking site.", ok: false })
    const runner = new TaskRunner(db, testConfig(dir), { runWork })
    const taskId = createTask(db, { description: "do a thing", sessionId: null, workingDir: dir })

    const res = await runner.runTask(taskId)

    expect(res.status).toBe("failed")
    expect(getTask(db, taskId)!.status).toBe("failed")
  })

  test("a watching task is RE-QUEUED (not done) so the scheduler checks it again", async () => {
    const runWork = async () => ({ finalText: "PR #42 just merged — that's new.", ok: true })
    const runner = new TaskRunner(db, testConfig(dir), { runWork })
    const taskId = createTask(db, { description: "watch the repo for merges", sessionId: null, workingDir: dir, watch: true, tickInterval: 300 })

    const res = await runner.runTask(taskId)

    expect(res.status).toBe("success")
    expect(getTask(db, taskId)!.status).toBe("queued") // re-queued, lives on
  })

  test("NO runWork wired → fails safely, never falls back to a claude subprocess", async () => {
    const runner = new TaskRunner(db, testConfig(dir)) // no deps
    const taskId = createTask(db, { description: "x", sessionId: null, workingDir: dir })

    const res = await runner.runTask(taskId)

    expect(res.status).toBe("failed")
    expect(res.summary.toLowerCase()).toMatch(/no work runner|not configured|unavailable/)
  })

  test("investigate routes through runWork and stores an observation candidate", async () => {
    let calledWith = ""
    const runWork = async (goal: string) => { calledWith = goal; return { finalText: "Repo has 3 uncommitted files.", ok: true } }
    const runner = new TaskRunner(db, testConfig(dir), { runWork })

    await runner.investigate("uncommitted changes")

    expect(calledWith).toContain("uncommitted changes")
    const cand = db.query("SELECT content FROM memory_candidates WHERE category = 'observation'").get() as { content: string } | null
    expect(cand?.content).toContain("3 uncommitted files")
  })
})
