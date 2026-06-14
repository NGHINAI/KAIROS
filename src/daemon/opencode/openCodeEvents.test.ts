// openCodeEvents.test.ts — translate the opencode SSE event stream into KAIROS
// LoopEvents + the post-turn verifier ledger. Asserts the REAL contract captured
// from opencode 1.17.6 (docs/clicky-migration/18): events are wrapped in `payload`,
// text/reasoning parts are CUMULATIVE (delta = diff), tool parts carry the whole
// lifecycle in state.status, every event carries sessionID (route by it — the codex
// stale-turn lesson), and the MCP namespace `<server>_` is stripped before the ledger.
import { describe, expect, test } from "bun:test"
import { stripMcpPrefix, createOpenCodeTurnAccumulator } from "./openCodeEvents"
import type { LoopEvent } from "../agents/loop/types"

const SID = "ses_test"
function acc(opts: { mcpServerName?: string } = {}) {
  const events: LoopEvent[] = []
  const a = createOpenCodeTurnAccumulator({ sessionID: SID, mcpServerName: opts.mcpServerName ?? "kairos", emit: (e) => events.push(e) })
  return { a, events }
}

// opencode wraps every event: { payload: { type, properties } }
const partUpdate = (part: any, sessionID = SID) => ({ payload: { type: "message.part.updated", properties: { part: { sessionID, ...part } } } })
const textPart = (id: string, text: string, sessionID = SID) => partUpdate({ type: "text", id, text }, sessionID)
const reasoningPart = (id: string, text: string) => partUpdate({ type: "reasoning", id, text })
const toolPart = (id: string, tool: string, status: string, extra: any = {}) => partUpdate({ type: "tool", id, callID: "call_" + id, tool, state: { status, ...extra } })
const idle = (sessionID = SID) => ({ payload: { type: "session.idle", properties: { sessionID } } })
const sessionError = (msg: string, sessionID = SID) => ({ payload: { type: "session.error", properties: { sessionID, error: { message: msg } } } })

describe("openCodeEvents — stripMcpPrefix", () => {
  test("strips the known server prefix; leaves bare/built-in names alone", () => {
    expect(stripMcpPrefix("kairos_read_screen", "kairos")).toBe("read_screen")
    expect(stripMcpPrefix("kairos_GMAIL_SEND_EMAIL", "kairos")).toBe("GMAIL_SEND_EMAIL")
    expect(stripMcpPrefix("read_screen", "kairos")).toBe("read_screen")  // no prefix
    expect(stripMcpPrefix("bash", "kairos")).toBe("bash")                // built-in
  })
})

describe("openCodeEvents — per-session accumulator", () => {
  test("unwraps the payload envelope AND tolerates an already-unwrapped event", () => {
    const { a, events } = acc()
    a.handle(textPart("t1", "hi"))                                          // wrapped
    a.handle({ type: "message.part.updated", properties: { part: { sessionID: SID, type: "text", id: "t1", text: "hill" } } }) // unwrapped
    expect(events.filter((e) => e.kind === "assistant_delta").map((e: any) => e.text)).toEqual(["hi", "ll"])
  })

  test("CUMULATIVE text part → assistant_delta diffs; finalText accumulates", () => {
    const { a, events } = acc()
    a.handle(textPart("t1", "Hel"))
    a.handle(textPart("t1", "Hello"))
    a.handle(textPart("t1", "Hello!"))
    expect(events.filter((e) => e.kind === "assistant_delta")).toEqual([
      { kind: "assistant_delta", text: "Hel" },
      { kind: "assistant_delta", text: "lo" },
      { kind: "assistant_delta", text: "!" },
    ])
    expect(a.state().finalText).toBe("Hello!")
    expect(a.state().streamedText).toBe("Hello!")
  })

  test("tool part pending→running→completed → tool_call_start then tool_call_done; ledger stripped + input/output", () => {
    const { a, events } = acc()
    a.handle(toolPart("c1", "kairos_read_screen", "pending", { input: { foo: 1 } }))
    a.handle(toolPart("c1", "kairos_read_screen", "running", { input: { foo: 1 } }))
    a.handle(toolPart("c1", "kairos_read_screen", "completed", { input: { foo: 1 }, output: "CURRENT SCREEN: SettingsApp" }))
    const kinds = events.map((e) => e.kind)
    expect(kinds.filter((k) => k === "tool_call_start")).toHaveLength(1)   // ONCE despite pending+running
    expect(kinds.indexOf("tool_call_start")).toBeLessThan(kinds.indexOf("tool_call_done"))
    const start = events.find((e) => e.kind === "tool_call_start") as any
    expect(start.name).toBe("read_screen")        // namespace stripped
    expect(start.args).toEqual({ foo: 1 })
    const done = events.find((e) => e.kind === "tool_call_done") as any
    expect(done.result).toBe("CURRENT SCREEN: SettingsApp")
    const led = a.state().toolCalls
    expect(led).toHaveLength(1)
    expect(led[0]).toMatchObject({ name: "read_screen", args: { foo: 1 }, result: "CURRENT SCREEN: SettingsApp" })
  })

  test("tool part error → tool_call_failed + ledger error", () => {
    const { a, events } = acc()
    a.handle(toolPart("c2", "kairos_GMAIL_SEND_EMAIL", "running", { input: {} }))
    a.handle(toolPart("c2", "kairos_GMAIL_SEND_EMAIL", "error", { input: {}, error: "not connected" }))
    expect(events.at(-1)).toMatchObject({ kind: "tool_call_failed", name: "GMAIL_SEND_EMAIL", error: "not connected" })
    expect(a.state().toolCalls.at(-1)).toMatchObject({ name: "GMAIL_SEND_EMAIL", error: "not connected" })
  })

  test("a USER-message text part is NOT streamed or accumulated (prompt-echo guard)", () => {
    const { a, events } = acc()
    // opencode emits message.updated (carrying role) before the message's parts. REAL
    // shape: properties.info = Message (sessionID + role live on info, NOT top-level).
    a.handle({ payload: { type: "message.updated", properties: { info: { id: "m_user", sessionID: SID, role: "user" } } } })
    a.handle({ payload: { type: "message.updated", properties: { info: { id: "m_asst", sessionID: SID, role: "assistant" } } } })
    a.handle(partUpdate({ type: "text", id: "tu", messageID: "m_user", text: "what is on my screen?" }))   // the echoed prompt
    a.handle(partUpdate({ type: "text", id: "ta", messageID: "m_asst", text: "You are in Settings." }))      // the real answer
    expect(events.filter((e) => e.kind === "assistant_delta").map((e: any) => e.text)).toEqual(["You are in Settings."])
    expect(a.state().finalText).toBe("You are in Settings.")
  })

  test("reasoning + step parts do NOT produce assistant_delta or tool calls", () => {
    const { a, events } = acc()
    a.handle(reasoningPart("r1", "thinking hard about the screen"))
    a.handle(partUpdate({ type: "step-start", id: "s1" }))
    a.handle(partUpdate({ type: "step-finish", id: "s1" }))
    expect(events).toHaveLength(0)
  })

  test("session.idle for MY session is terminal; for another session it is ignored", () => {
    const { a } = acc()
    a.handle(idle("ses_other"))
    expect(a.isTerminal()).toBe(false)
    a.handle(idle(SID))
    expect(a.isTerminal()).toBe(true)
    expect(a.state().status).toBe("idle")
  })

  test("events for a DIFFERENT session are ignored entirely (id-match lesson)", () => {
    const { a, events } = acc()
    a.handle(textPart("t1", "leak", "ses_other"))     // cross-session text must NOT leak
    a.handle(idle("ses_other"))                        // cross-session idle must NOT terminate us
    expect(events.some((e) => e.kind === "assistant_delta")).toBe(false)
    expect(a.state().finalText).toBe("")
    expect(a.isTerminal()).toBe(false)
  })

  test("session.error is terminal and captures the message", () => {
    const { a } = acc()
    a.handle(sessionError("upstream 500"))
    expect(a.isTerminal()).toBe(true)
    expect(a.state().status).toBe("error")
    expect(a.state().errorMessage).toContain("upstream 500")
  })

  test("onTerminal fires once on idle (and on error) — lets the driver race terminal state", () => {
    const fired: string[] = []
    const a = createOpenCodeTurnAccumulator({ sessionID: SID, mcpServerName: "kairos", emit: () => {}, onTerminal: (s) => fired.push(s) })
    a.handle(idle("ses_other"))      // wrong session — no fire
    a.handle(idle(SID))              // fires "idle"
    a.handle(idle(SID))              // already terminal — no second fire
    expect(fired).toEqual(["idle"])

    const fired2: string[] = []
    const b = createOpenCodeTurnAccumulator({ sessionID: SID, mcpServerName: "kairos", emit: () => {}, onTerminal: (s) => fired2.push(s) })
    b.handle(sessionError("boom"))
    expect(fired2).toEqual(["error"])
  })

  test("close() stops accepting events (a late event can't mutate a finished turn)", () => {
    const { a, events } = acc()
    a.close()
    a.handle(textPart("t1", "late text"))
    expect(events).toHaveLength(0)
    expect(a.state().finalText).toBe("")
  })
})
