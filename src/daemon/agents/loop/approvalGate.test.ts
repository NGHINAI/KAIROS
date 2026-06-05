// src/daemon/agents/loop/approvalGate.test.ts
import { test, expect } from "bun:test"
import { ApprovalGate } from "./approvalGate"

function fakes() {
  const asked: any[] = []
  const inboxed: any[] = []
  let timerFn: (() => void) | null = null
  const gate = new ApprovalGate({
    ask: (r) => asked.push(r),
    inbox: (r) => inboxed.push(r),
    voiceWindowMs: 1000,
    setTimer: (fn) => { timerFn = fn; return 1 },
    clearTimer: () => { timerFn = null },
  })
  return { asked, inboxed, gate, fireTimer: () => timerFn?.() }
}
const req = (id: string) => ({ id, summary: "send email to Sam", toolName: "execute_tool", args: { tool_name: "GMAIL_SEND_EMAIL" } })

test("asks immediately and resolves approved (no tokens burned — it just awaits)", async () => {
  const { asked, gate } = fakes()
  const p = gate.requestApproval(req("a1"))
  expect(asked.length).toBe(1)
  expect(gate.resolve("a1", true)).toBe(true)
  expect(await p).toEqual({ approved: true })
})

test("resolves denied", async () => {
  const { gate } = fakes()
  const p = gate.requestApproval(req("a1"))
  gate.resolve("a1", false)
  expect(await p).toEqual({ approved: false })
})

test("if unanswered within the voice window → drops into inbox, STILL parked, then inbox approval resolves it", async () => {
  const { inboxed, gate, fireTimer } = fakes()
  const p = gate.requestApproval(req("a1"))
  expect(inboxed.length).toBe(0)
  fireTimer() // voice window elapsed, no answer
  expect(inboxed.length).toBe(1) // parked into inbox
  expect(gate.resolve("a1", true)).toBe(true) // later approved (via inbox or voice)
  expect(await p).toEqual({ approved: true })
})

test("resolveLatest resolves the most recent pending (bare voice 'yes')", async () => {
  const { gate } = fakes()
  const p = gate.requestApproval(req("a1"))
  expect(gate.resolveLatest(true)).toBe(true)
  expect(await p).toEqual({ approved: true })
})

test("resolve unknown id returns false", () => {
  const { gate } = fakes()
  expect(gate.resolve("nope", true)).toBe(false)
})

test("listPending exposes parked approvals (for the UI/inbox)", async () => {
  const { gate } = fakes()
  gate.requestApproval(req("a1"))
  expect(gate.listPending().map((p: any) => p.id)).toContain("a1")
  gate.resolve("a1", true)
  expect(gate.listPending().length).toBe(0)
})

test("a parked approval resolves to DENIAL when the run is aborted, and is purged", async () => {
  const { gate } = fakes()
  const ac = new AbortController()
  const p = gate.requestApproval(req("a1"), ac.signal)
  expect(gate.listPending().length).toBe(1)
  ac.abort()
  expect(await p).toEqual({ approved: false }) // unblocked as a denial, not hung
  expect(gate.listPending().length).toBe(0)    // purged so a later 'yes' can't resurrect it
})

test("an already-aborted signal denies immediately without asking", async () => {
  const { asked, gate } = fakes()
  const ac = new AbortController(); ac.abort()
  const p = gate.requestApproval(req("a1"), ac.signal)
  expect(asked.length).toBe(0)
  expect(await p).toEqual({ approved: false })
})

test("SERIALIZES asks: a 2nd concurrent approval queues to inbox; bare 'yes' resolves the ACTIVE one; next is promoted", async () => {
  const { asked, inboxed, gate } = fakes()
  const p1 = gate.requestApproval(req("a1"))
  const p2 = gate.requestApproval(req("a2"))
  expect(asked.map((r) => r.id)).toEqual(["a1"])    // only a1 is spoken
  expect(inboxed.map((r) => r.id)).toEqual(["a2"])  // a2 queued straight to inbox
  expect(gate.listPending().map((r) => r.id)).toEqual(["a1", "a2"])
  expect(gate.resolveLatest(true)).toBe(true)        // bare "yes" → the ACTIVE ask (a1), unambiguous
  expect(await p1).toEqual({ approved: true })
  expect(asked.map((r) => r.id)).toEqual(["a1", "a2"]) // a2 now promoted + spoken
  expect(gate.resolve("a2", false)).toBe(true)
  expect(await p2).toEqual({ approved: false })
})

test("max-park auto-DENIES a never-answered, never-cancelled approval (no forever-hang)", async () => {
  const timers: Array<() => void> = []
  const gate = new ApprovalGate({
    ask: () => {}, inbox: () => {}, voiceWindowMs: 1000, maxParkMs: 5000,
    setTimer: (fn) => { timers.push(fn); return timers.length },
    clearTimer: () => {},
  })
  const p = gate.requestApproval(req("a1"))
  timers[0]!() // timers[0] = the max-park timer (armed in requestApproval, before the voice timer)
  expect(await p).toEqual({ approved: false })
  expect(gate.listPending().length).toBe(0)
})
