// openCodeBrain.test.ts — the opencode warm-brain driver as a KAIROS PlannerRunner.
// Drives sessions through an injected OpenCodeHandle (the SDK seam) so the full
// lifecycle is proven against a scripted fake: prompt (blocking) + concurrent event
// streaming → LoopEvents → POST-TURN verifier → corrective retry (write-guarded) →
// abort + the per-turn WATCHDOG (the codex hang lesson). Events route by sessionID
// (the codex stale-turn lesson, enforced in the accumulator).
import { describe, expect, test } from "bun:test"
import { createOpenCodeBrain, type OpenCodeHandle } from "./openCodeBrain"
import { setToolNature } from "../agents/loop/verifier"
import type { LoopEvent } from "../agents/loop/types"

// A scripted fake OpenCodeHandle. `script(promptOpts, push, sent)` pushes the turn's
// opencode events (wrapped) via `push` then resolves (= prompt() returns). push calls
// the registered handler synchronously, so by the time prompt() resolves the
// accumulator has seen every event — deterministic.
type Push = (raw: any) => void
function fakeHandle(script: (o: any, push: Push, sent: any) => Promise<void> | void) {
  let handler: (raw: any) => void = () => {}
  const sent = { sessions: 0, prompts: [] as any[], aborts: 0, permissions: 0 }
  const push: Push = (raw) => handler(raw)
  const handle: OpenCodeHandle = {
    createSession: async () => { sent.sessions++; return `ses_${sent.sessions}` },
    prompt: async (o) => { sent.prompts.push(o); const r = await script(o, push, sent); return (r as any) ?? {} },
    abort: async () => { sent.aborts++ },
    onEvent: (h) => { handler = h },
    respondPermission: async () => { sent.permissions++ },
    close: () => {},
  }
  return { handle, sent }
}

// event builders (opencode wraps in payload)
const part = (p: any, sessionID: string) => ({ payload: { type: "message.part.updated", properties: { part: { sessionID, ...p } } } })
const idle = (sessionID: string) => ({ payload: { type: "session.idle", properties: { sessionID } } })
const sessionErr = (sessionID: string) => ({ payload: { type: "session.error", properties: { sessionID, error: { message: "upstream 500" } } } })
const permission = (sessionID: string) => ({ payload: { type: "permission.updated", properties: { sessionID, id: "perm1" } } })

// A normal turn: stream a delta, run a tool, finalize, go idle.
function normalTurn(finalText = "All set.") {
  return (o: any, push: Push) => {
    const sid = o.sessionID
    push(part({ type: "text", id: "t1", text: "On it. " }, sid))
    push(part({ type: "tool", id: "c1", tool: "kairos_read_screen", state: { status: "running", input: {} } }, sid))
    push(part({ type: "tool", id: "c1", tool: "kairos_read_screen", state: { status: "completed", input: {}, output: "CURRENT SCREEN: System Settings" } }, sid))
    push(part({ type: "text", id: "t1", text: "On it. " + finalText }, sid))
    push(idle(sid))
  }
}

const okVerifier = { verify: async () => ({ ok: true, severity: "read" as const }) }
function brain(connect: () => OpenCodeHandle, extra: any = {}) {
  return createOpenCodeBrain({
    connect: async () => connect(),
    modelProviderID: "kairosbrain",
    modelID: "minimax/minimax-m3",
    mcpServerName: "kairos",
    baseInstructions: "You are KAIROS. Be witty.",
    verifier: okVerifier,
    turnTimeoutMs: 200,
    ...extra,
  })
}

describe("openCodeBrain — lifecycle against a fake opencode handle", () => {
  test("run() creates a session, prompts (model+system+text), returns the final answer + streams events", async () => {
    const f = fakeHandle(normalTurn("All set."))
    const events: LoopEvent[] = []
    const res = await brain(() => f.handle).run("switch to dark mode", { tools: [], instructions: "", onEvent: (e) => events.push(e) })
    expect(res.finalOutput).toBe("On it. All set.")
    expect(res.toolCalls.map((c) => c.name)).toEqual(["read_screen"])
    const p = f.sent.prompts[0]
    expect(p.text).toBe("switch to dark mode")
    expect(p.model).toEqual({ providerID: "kairosbrain", modelID: "minimax/minimax-m3" })
    expect(p.system).toContain("You are KAIROS")
    const kinds = events.map((e) => e.kind)
    expect(kinds).toContain("assistant_delta")
    expect(kinds.indexOf("tool_call_start")).toBeLessThan(kinds.indexOf("tool_call_done"))
  })

  test("finalText from prompt() (the clean final message) is preferred over the streamed concatenation", async () => {
    const f = fakeHandle((o: any, push: Push) => {
      const sid = o.sessionID
      push(part({ type: "text", id: "t1", text: "streamed messy text across steps" }, sid))
      push(idle(sid))
      return { finalText: "Clean final answer." } as any
    })
    const res = await brain(() => f.handle).run("x", { tools: [], instructions: "" })
    expect(res.finalOutput).toBe("Clean final answer.")                 // prompt()'s clean final preferred
    expect(res.streamedText).toBe("Clean final answer.")                // uncorrected → reconciled to finalOutput (no double-speak)
  })

  test("FRESH session per turn (review CRITICAL #1 — airtight sessionID isolation)", async () => {
    const f = fakeHandle(normalTurn())
    const b = brain(() => f.handle)
    await b.run("one", { tools: [], instructions: "", conversationId: "A" } as any)
    await b.run("two", { tools: [], instructions: "", conversationId: "A" } as any)
    expect(f.sent.sessions).toBe(2)            // a new session per turn, not reused
    expect(f.sent.prompts).toHaveLength(2)
  })

  test("session.error mid-turn ends run() promptly — no watchdog hang (LESSON #2)", async () => {
    // prompt() never resolves (the real opencode contract on error); session.error must end it.
    const f = fakeHandle((o: any, push: Push) => new Promise<void>(() => { push(sessionErr(o.sessionID)) }))
    const t0 = Date.now()
    const res = await brain(() => f.handle, { turnTimeoutMs: 5000 }).run("x", { tools: [], instructions: "" })
    expect(Date.now() - t0).toBeLessThan(1500)   // terminated via session.error, NOT the 5s watchdog
    expect(f.sent.aborts).toBeGreaterThan(0)
    expect(res.corrected).toBeFalsy()
  })

  test("uncorrected read turn: streamedText === finalOutput (no read-tier double-speak)", async () => {
    // accumulator streams "On it. All set." but finalOutput comes from prompt()'s clean final;
    // when NOT corrected, the brain reports streamedText == finalOutput so the conductor won't re-speak.
    const f = fakeHandle((o: any, push: Push) => { normalTurn("All set.")(o, push); return { finalText: "All set." } as any })
    const res = await brain(() => f.handle).run("x", { tools: [], instructions: "" })
    expect(res.corrected).toBeFalsy()
    expect(res.streamedText).toBe(res.finalOutput)
    expect(res.finalOutput).toBe("All set.")
  })

  test("a superseded (aborted) turn's trailing events do NOT pollute the next turn (CRITICAL #1)", async () => {
    // Turn A hangs after streaming a fragment; we abort it, then run Turn B (fresh session).
    let pushA: Push | null = null
    let sidA = ""
    const f = fakeHandle((o: any, push: Push) => {
      if (!pushA) { pushA = push; sidA = o.sessionID; return new Promise<void>(() => { push(part({ type: "text", id: "ta", text: "STALE-FROM-A " }, o.sessionID)) }) }
      // Turn B: stream its own answer, then idle.
      push(part({ type: "text", id: "tb", text: "Clean B answer." }, o.sessionID)); push(idle(o.sessionID))
    })
    const b = brain(() => f.handle)
    const ctrl = new AbortController()
    const pA = b.run("A", { tools: [], instructions: "", signal: ctrl.signal, conversationId: "C" } as any)
    await new Promise((r) => setTimeout(r, 20))
    ctrl.abort(); await pA
    // While B runs, fire a trailing event for A's OLD session — must NOT reach B.
    const eventsB: LoopEvent[] = []
    const resB = await b.run("B", { tools: [], instructions: "", conversationId: "C", onEvent: (e: LoopEvent) => eventsB.push(e) } as any)
    if (sidA) (pushA as Push | null)?.(part({ type: "text", id: "ta2", text: "MORE-STALE-A" }, sidA))
    expect(resB.finalOutput).toBe("Clean B answer.")
    expect(eventsB.every((e: any) => !String(e.text ?? "").includes("STALE"))).toBe(true)
  })

  test("permission.updated is auto-responded (unattended)", async () => {
    const f = fakeHandle((o: any, push: Push) => { push(permission(o.sessionID)); push(idle(o.sessionID)) })
    await brain(() => f.handle).run("x", { tools: [], instructions: "" })
    expect(f.sent.permissions).toBeGreaterThan(0)
  })

  test("verifier retryable → a NEW corrective prompt + corrected + self_correct event", async () => {
    const f = fakeHandle(normalTurn("I'm highlighting it."))
    let n = 0
    const verifier = { verify: async () => (++n === 1
      ? { ok: false, severity: "read" as const, retryable: true, concern: "claimed an action with no successful tool" }
      : { ok: true, severity: "read" as const }) }
    const events: LoopEvent[] = []
    const res = await brain(() => f.handle, { verifier }).run("switch", { tools: [], instructions: "", onEvent: (e) => events.push(e) })
    expect(f.sent.prompts).toHaveLength(2)            // original + corrective
    expect(res.corrected).toBe(true)
    expect(events.some((e) => e.kind === "self_correct")).toBe(true)
  })

  test("verifier ok → no corrective prompt", async () => {
    const f = fakeHandle(normalTurn())
    const res = await brain(() => f.handle).run("x", { tools: [], instructions: "" })
    expect(f.sent.prompts).toHaveLength(1)
    expect(res.corrected).toBeFalsy()
  })

  test("write-guard (C12): corrective retry SUPPRESSED once a destructive tool succeeded", async () => {
    const destructive = (o: any, push: Push) => {
      const sid = o.sessionID
      push(part({ type: "tool", id: "w1", tool: "kairos_GMAIL_SEND_EMAIL", state: { status: "running", input: {} } }, sid))
      push(part({ type: "tool", id: "w1", tool: "kairos_GMAIL_SEND_EMAIL", state: { status: "completed", input: {}, output: "sent" } }, sid))
      push(part({ type: "text", id: "t1", text: "Sent!" }, sid))
      push(idle(sid))
    }
    const f = fakeHandle(destructive)
    const verifier = { verify: async () => ({ ok: false, severity: "write" as const, retryable: true, concern: "x" }) }
    setToolNature(new Map([["GMAIL_SEND_EMAIL", "write"]]))
    try {
      await brain(() => f.handle, { verifier }).run("email bob", { tools: [], instructions: "" })
      expect(f.sent.prompts).toHaveLength(1)   // NO corrective
    } finally { setToolNature(null) }
  })

  test("abort signal → handle.abort + quiet return (no hang)", async () => {
    // prompt that streams a delta then NEVER goes idle / never resolves until aborted.
    const hanging = (o: any, push: Push) => new Promise<void>(() => { push(part({ type: "text", id: "t1", text: "working" }, o.sessionID)) })
    const f = fakeHandle(hanging)
    const ctrl = new AbortController()
    const p = brain(() => f.handle).run("do it", { tools: [], instructions: "", signal: ctrl.signal })
    await new Promise((r) => setTimeout(r, 20))
    ctrl.abort()
    const res = await p
    expect(f.sent.aborts).toBeGreaterThan(0)
    expect(res.corrected).toBeFalsy()
  })

  test("WATCHDOG: a turn that never completes is aborted after turnTimeoutMs (the codex hang lesson)", async () => {
    const hanging = (o: any, push: Push) => new Promise<void>(() => { push(part({ type: "text", id: "t1", text: "stuck" }, o.sessionID)) })
    const f = fakeHandle(hanging)
    const t0 = Date.now()
    const res = await brain(() => f.handle, { turnTimeoutMs: 80 }).run("x", { tools: [], instructions: "" })
    expect(Date.now() - t0).toBeLessThan(2000)   // returned, did NOT hang forever
    expect(f.sent.aborts).toBeGreaterThan(0)
    expect(res.finalOutput).toBe("stuck")        // best-effort streamed text returned
  })
})
