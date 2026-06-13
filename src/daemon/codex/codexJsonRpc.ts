// codexJsonRpc.ts — the newline-delimited JSON-RPC transport `codex app-server`
// speaks (verified against codex 0.133, 2026-06-13). It is TRANSPORT-AGNOSTIC:
// the caller supplies `send(line)` (→ child stdin) and pumps stdout bytes through
// `receive(chunk)`. CodexBrain wires both to a Bun.spawn child; tests wire them to
// in-memory arrays. Keeping the framing/dispatch here (no child) makes the whole
// protocol unit-testable without spawning a process.
//
// Wire shape (loose JSON-RPC — NO "jsonrpc" field on the wire):
//   request       → { id, method, params }
//   notification  → { method, params }                 (no id)
//   response      ← { id, result } | { id, error }
//   server→client ← { id, method, params }             (id AND method)
// Dispatch keys purely on shape: method+id ⇒ server request; method only ⇒
// notification; id only ⇒ a response to one of our requests.

export type RpcId = number | string

export interface ServerRequest {
  id: RpcId
  method: string
  params: any
}

export interface CodexRpcDeps {
  /** Write ONE serialized JSON-RPC message to the child. The client appends the
   *  trailing newline itself, so `send` receives a line that already ends in "\n". */
  send: (line: string) => void
  /** Default per-request deadline (ms). A request with no reply by then rejects.
   *  CodexBrain restarts the child on a timeout (the loop must never hang). */
  defaultTimeoutMs?: number
  log?: (m: string) => void
}

export interface CodexRpc {
  request<T = any>(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<T>
  notify(method: string, params?: unknown): void
  onNotification(handler: (method: string, params: any) => void): void
  onServerRequest(handler: (req: ServerRequest) => void): void
  /** Pump raw stdout bytes from the child. Buffers partial lines across calls. */
  receive(chunk: string): void
  /** Reject every in-flight request (child exited / restart). */
  rejectAll(err: Error): void
  pendingCount(): number
}

interface Pending {
  resolve: (v: any) => void
  reject: (e: any) => void
  timer: ReturnType<typeof setTimeout>
}

const DEFAULT_TIMEOUT_MS = 90_000

export function createCodexRpc(deps: CodexRpcDeps): CodexRpc {
  const log = deps.log ?? (() => {})
  const defaultTimeoutMs = deps.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
  const pending = new Map<RpcId, Pending>()
  let nextId = 1
  let buf = ""
  let notificationHandler: (method: string, params: any) => void = () => {}
  let serverRequestHandler: (req: ServerRequest) => void = () => {}

  function request<T = any>(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<T> {
    const id = nextId++
    return new Promise<T>((resolve, reject) => {
      const timeoutMs = opts?.timeoutMs ?? defaultTimeoutMs
      const timer = setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`codex RPC "${method}" (id=${id}) timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      // Bun/Node timers keep the event loop alive; a long turn deadline must not
      // pin the process if everything else is idle.
      ;(timer as any)?.unref?.()
      pending.set(id, { resolve, reject, timer })
      // Frame is { id, method, params } — params omitted when undefined (some
      // codex methods take no params, e.g. account/logout).
      const frame: Record<string, unknown> = { id, method }
      if (params !== undefined) frame.params = params
      deps.send(JSON.stringify(frame) + "\n")
    })
  }

  function notify(method: string, params?: unknown): void {
    const frame: Record<string, unknown> = { method }
    if (params !== undefined) frame.params = params
    deps.send(JSON.stringify(frame) + "\n")
  }

  function dispatch(msg: any): void {
    // Server→client REQUEST: has both a method and an id (e.g. approval prompts).
    // We suppress these via approvalPolicy:never, but must route — never mistake
    // one for a notification and never try to resolve a pending of ours.
    if (msg && typeof msg.method === "string" && msg.id !== undefined) {
      serverRequestHandler({ id: msg.id, method: msg.method, params: msg.params })
      return
    }
    // Notification: method, no id.
    if (msg && typeof msg.method === "string") {
      notificationHandler(msg.method, msg.params)
      return
    }
    // Response to one of our requests: keyed by id, carries result | error.
    if (msg && msg.id !== undefined) {
      const p = pending.get(msg.id)
      if (!p) { log(`codex RPC: response for unknown id ${msg.id} (ignored)`); return }
      pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) {
        const e = msg.error
        p.reject(new Error(typeof e === "string" ? e : (e?.message ?? JSON.stringify(e))))
      } else {
        p.resolve(msg.result)
      }
      return
    }
    log(`codex RPC: unrecognized message ${JSON.stringify(msg).slice(0, 200)}`)
  }

  function receive(chunk: string): void {
    buf += chunk
    let nl: number
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      const trimmed = line.trim()
      if (!trimmed) continue
      let msg: any
      try { msg = JSON.parse(trimmed) }
      catch { log(`codex RPC: skipping malformed line: ${trimmed.slice(0, 200)}`); continue }
      try { dispatch(msg) }
      catch (e) { log(`codex RPC: dispatch error: ${String((e as Error)?.message ?? e)}`) }
    }
  }

  function rejectAll(err: Error): void {
    for (const [, p] of pending) { clearTimeout(p.timer); p.reject(err) }
    pending.clear()
  }

  return {
    request,
    notify,
    onNotification: (h) => { notificationHandler = h },
    onServerRequest: (h) => { serverRequestHandler = h },
    receive,
    rejectAll,
    pendingCount: () => pending.size,
  }
}
