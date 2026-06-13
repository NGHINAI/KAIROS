// codexJsonRpc.test.ts — the newline-delimited JSON-RPC transport codex
// app-server speaks. Asserts the REAL wire shape captured from codex 0.133:
//   • request  → {"id":N,"method":"…","params":{…}}\n   (no "jsonrpc" field)
//   • response ← {"id":N,"result":{…}}  OR  {"id":N,"error":{…}}
//   • notification ← {"method":"…","params":{…}}        (no id)
//   • server→client request ← {"id":N,"method":"…","params":{…}} (id + method)
// Transport-agnostic: `send` collects outgoing lines, `receive` pumps stdout bytes.
import { describe, expect, test } from "bun:test"
import { createCodexRpc } from "./codexJsonRpc"

function harness(opts: { defaultTimeoutMs?: number } = {}) {
  const sent: string[] = []
  const notifications: Array<{ method: string; params: any }> = []
  const serverRequests: Array<{ id: any; method: string; params: any }> = []
  const rpc = createCodexRpc({ send: (line) => sent.push(line), ...opts })
  rpc.onNotification((method, params) => notifications.push({ method, params }))
  rpc.onServerRequest((req) => serverRequests.push(req))
  const parseSent = () => sent.map((l) => JSON.parse(l))
  return { rpc, sent, parseSent, notifications, serverRequests }
}

describe("codexJsonRpc — newline-delimited JSON-RPC transport", () => {
  test("request() frames {id,method,params} with a trailing newline and resolves on matching id", async () => {
    const h = harness()
    const p = h.rpc.request("initialize", { clientInfo: { name: "k" } })
    // framed exactly once, ends with \n, carries an integer id + method + params, NO jsonrpc field
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]!.endsWith("\n")).toBe(true)
    const frame = JSON.parse(h.sent[0]!)
    expect(frame.method).toBe("initialize")
    expect(frame.params).toEqual({ clientInfo: { name: "k" } })
    expect(typeof frame.id).toBe("number")
    expect("jsonrpc" in frame).toBe(false)
    // server replies with the matching id → promise resolves with `result`
    h.rpc.receive(JSON.stringify({ id: frame.id, result: { userAgent: "codex/0.133" } }) + "\n")
    expect(await p).toEqual({ userAgent: "codex/0.133" })
  })

  test("ids increment per request", () => {
    const h = harness()
    h.rpc.request("thread/start", {})
    h.rpc.request("turn/start", {})
    const ids = h.parseSent().map((f) => f.id)
    expect(ids[0]).toBeLessThan(ids[1])
  })

  test("notify() frames {method,params} with NO id", () => {
    const h = harness()
    h.rpc.notify("initialized")
    const frame = JSON.parse(h.sent[0]!)
    expect(frame.method).toBe("initialized")
    expect("id" in frame).toBe(false)
  })

  test("a notification (method, no id) dispatches to onNotification, never resolves a request", async () => {
    const h = harness()
    let resolved = false
    h.rpc.request("turn/start", {}).then(() => { resolved = true })
    h.rpc.receive(JSON.stringify({ method: "item/agentMessage/delta", params: { delta: "hi" } }) + "\n")
    expect(h.notifications).toEqual([{ method: "item/agentMessage/delta", params: { delta: "hi" } }])
    await Promise.resolve()
    expect(resolved).toBe(false)
  })

  test("partial line is buffered across receive() chunks and parsed once complete", () => {
    const h = harness()
    const line = JSON.stringify({ method: "turn/completed", params: { ok: true } }) + "\n"
    h.rpc.receive(line.slice(0, 10))
    expect(h.notifications).toHaveLength(0)   // nothing yet — incomplete line
    h.rpc.receive(line.slice(10))
    expect(h.notifications).toHaveLength(1)
    expect(h.notifications[0]!.method).toBe("turn/completed")
  })

  test("multiple frames in one chunk both dispatch", () => {
    const h = harness()
    const a = JSON.stringify({ method: "turn/started", params: { turn: { id: "t1" } } })
    const b = JSON.stringify({ method: "item/started", params: { item: { type: "agentMessage" } } })
    h.rpc.receive(a + "\n" + b + "\n")
    expect(h.notifications.map((n) => n.method)).toEqual(["turn/started", "item/started"])
  })

  test("an interleaved notification between request and response does not cross-talk", async () => {
    const h = harness()
    const p = h.rpc.request("turn/start", {})
    const id = JSON.parse(h.sent[0]!).id
    h.rpc.receive(JSON.stringify({ method: "turn/started", params: { turn: { id: "t" } } }) + "\n")
    h.rpc.receive(JSON.stringify({ id, result: { turn: { id: "t" } } }) + "\n")
    expect(await p).toEqual({ turn: { id: "t" } })
    expect(h.notifications).toHaveLength(1)
  })

  test("a server→client request (id + method) routes to onServerRequest, not onNotification", () => {
    const h = harness()
    h.rpc.receive(JSON.stringify({ id: 99, method: "item/commandExecution/requestApproval", params: { x: 1 } }) + "\n")
    expect(h.serverRequests).toEqual([{ id: 99, method: "item/commandExecution/requestApproval", params: { x: 1 } }])
    expect(h.notifications).toHaveLength(0)
  })

  test("an error response rejects the matching request", async () => {
    const h = harness()
    const p = h.rpc.request("thread/start", {})
    const id = JSON.parse(h.sent[0]!).id
    h.rpc.receive(JSON.stringify({ id, error: { code: -32000, message: "boom" } }) + "\n")
    await expect(p).rejects.toThrow(/boom/)
  })

  test("request times out when no response arrives", async () => {
    const h = harness({ defaultTimeoutMs: 25 })
    await expect(h.rpc.request("turn/start", {})).rejects.toThrow(/timed out|timeout/i)
  })

  test("rejectAll rejects every pending request and drains the map", async () => {
    const h = harness()
    const p1 = h.rpc.request("a", {})
    const p2 = h.rpc.request("b", {})
    expect(h.rpc.pendingCount()).toBe(2)
    h.rpc.rejectAll(new Error("child exited"))
    await expect(p1).rejects.toThrow(/child exited/)
    await expect(p2).rejects.toThrow(/child exited/)
    expect(h.rpc.pendingCount()).toBe(0)
  })

  test("a malformed (non-JSON) line is ignored, not fatal", () => {
    const h = harness()
    expect(() => h.rpc.receive("this is not json\n")).not.toThrow()
    h.rpc.receive(JSON.stringify({ method: "warning", params: {} }) + "\n")
    expect(h.notifications.map((n) => n.method)).toEqual(["warning"])
  })
})
