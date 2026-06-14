// openCodeBrain.ts — the warm `opencode` agent as a KAIROS PlannerRunner. This is
// the brain-swap seam (replaces the shelved codex driver): the conductor injects
// `deps.runPlanner = brain.run` (conductor.ts:663); OpenCodeBrain emits the SAME
// LoopEvent shapes as the in-house defaultPlannerRunner, so the conductor's
// onEvent→controller→activity wiring, persistence, and trajectory hooks are untouched.
//
// Per turn: ensure warm opencode (createOpencode, reused) → session per conversation
// (reused) → session.prompt (BLOCKS until idle, returns the final message) while a
// global event subscriber streams parts → LoopEvents (openCodeEvents) → POST-TURN
// verifier gate (verifier.ts, ported) → corrective retry as a NEW prompt (write-guard
// C12). Codex lessons baked in: events route by sessionID (no stale-turn truncation);
// a per-turn WATCHDOG races the blocking prompt so a hung/silent turn can never wedge
// the voice loop; session.error is terminal.
//
// opencode exposes MCP tools as FLAT Chat-Completions function tools, so ANY OpenRouter
// model (minimax) can call them — the capability codex lacked (docs 17/18).

import { createOpenCodeTurnAccumulator, type OpenCodeToolCall } from "./openCodeEvents"
import { isDestructiveCall } from "../agents/loop/verifier"
import type { LoopEvent, LoopMsg } from "../agents/loop/types"

// ── the SDK seam (injected for tests; real impl = spawnOpenCode below) ─────────

export interface OpenCodeHandle {
  /** Create a session, return its id. */
  createSession(): Promise<string>
  /** Send a turn; BLOCKS until the turn completes. Events stream via onEvent. */
  prompt(o: { sessionID: string; text: string; system?: string; model: { providerID: string; modelID: string } }): Promise<{ finalText?: string }>
  /** Abort the active turn on a session (barge-in / watchdog). */
  abort(sessionID: string): Promise<void>
  /** Register the global event handler (every opencode event, wrapped). Called once. */
  onEvent(handler: (raw: any) => void): void
  /** Respond "always" to a permission request (unattended auto-allow). */
  respondPermission(sessionID: string, permissionID: string): Promise<void>
  close(): void
}

export interface OpenCodeVerifier {
  verify(o: { utterance: string; finalText: string; toolCalls: OpenCodeToolCall[] }): Promise<{
    ok: boolean
    concern?: string
    correction?: string
    severity: "read" | "write"
    retryable?: boolean
  }>
}

export interface OpenCodeBrainDeps {
  connect: () => Promise<OpenCodeHandle> | OpenCodeHandle
  modelProviderID: string
  modelID: string
  /** The MCP server name we registered KAIROS tools under (for prefix stripping). */
  mcpServerName: string
  /** Durable persona/doctrine → the per-turn system prompt when a turn provides none. */
  baseInstructions: string
  verifier?: OpenCodeVerifier
  log?: (m: string) => void
  /** Per-turn watchdog deadline (ms). A turn that neither completes nor goes idle by
   *  then is aborted + returns a best-effort final, so the loop can't wedge. */
  turnTimeoutMs?: number
}

export interface OpenCodeRunOpts {
  tools: any[]
  instructions: string
  signal?: AbortSignal
  onEvent?: (e: LoopEvent) => void
  history?: LoopMsg[]
  conversationId?: string
}

export interface OpenCodeRunResult {
  finalOutput: string
  streamedText?: string
  corrected?: boolean
  toolCalls: OpenCodeToolCall[]
}

interface ActiveTurn { sessionID: string; acc: ReturnType<typeof createOpenCodeTurnAccumulator> }

function payloadType(raw: any): { type?: string; properties?: any } {
  const p = raw?.payload ?? raw
  return { type: p?.type, properties: p?.properties }
}

export function createOpenCodeBrain(deps: OpenCodeBrainDeps) {
  const log = deps.log ?? (() => {})
  const turnTimeoutMs = deps.turnTimeoutMs ?? 120_000

  let handle: OpenCodeHandle | null = null
  let connectPromise: Promise<OpenCodeHandle> | null = null
  const sessions = new Map<string, Promise<string>>()
  let active: ActiveTurn | null = null

  function ensureConnected(): Promise<OpenCodeHandle> {
    if (handle) return Promise.resolve(handle)
    if (!connectPromise) {
      connectPromise = Promise.resolve(deps.connect()).then((h) => {
        handle = h
        // ONE event router for the process — routes every event to the CURRENT turn's
        // accumulator (it self-filters by sessionID, so this is safe) + auto-allows
        // permission requests for the active session.
        h.onEvent((raw) => {
          if (active) { try { active.acc.handle(raw) } catch (e) { log(`openCodeBrain: acc error: ${String((e as Error)?.message ?? e)}`) } }
          const { type, properties } = payloadType(raw)
          if (type === "permission.updated" && active && properties?.sessionID === active.sessionID) {
            h.respondPermission(active.sessionID, properties?.id).catch((e) => log(`openCodeBrain: permission respond failed: ${String((e as Error)?.message ?? e)}`))
          }
        })
        return h
      }).catch((e) => { connectPromise = null; throw e })
    }
    return connectPromise
  }

  function ensureSession(h: OpenCodeHandle, convId: string): Promise<string> {
    let p = sessions.get(convId)
    if (!p) {
      p = h.createSession().catch((e) => { sessions.delete(convId); throw e })
      sessions.set(convId, p)
    }
    return p
  }

  /** Drive ONE turn to completion / abort / timeout, streaming events live. */
  async function runOneTurn(h: OpenCodeHandle, sessionID: string, text: string, system: string, opts: OpenCodeRunOpts): Promise<{ state: ReturnType<typeof createOpenCodeTurnAccumulator>["state"] extends () => infer S ? S : never; outcome: "completed" | "timeout" | "aborted" | "error" }> {
    const acc = createOpenCodeTurnAccumulator({ sessionID, mcpServerName: deps.mcpServerName, emit: (e) => opts.onEvent?.(e) })
    active = { sessionID, acc }

    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    const promptP = h.prompt({ sessionID, text, system, model: { providerID: deps.modelProviderID, modelID: deps.modelID } })
      .then(() => "completed" as const)
      .catch((e) => { log(`openCodeBrain: prompt error: ${String((e as Error)?.message ?? e)}`); return "error" as const })
    const watchdogP = new Promise<"timeout">((res) => { timer = setTimeout(() => res("timeout"), turnTimeoutMs); (timer as any)?.unref?.() })
    const abortP = new Promise<"aborted">((res) => {
      if (opts.signal?.aborted) return res("aborted")
      onAbort = () => res("aborted")
      opts.signal?.addEventListener?.("abort", onAbort, { once: true })
    })

    const outcome = await Promise.race([promptP, watchdogP, abortP])
    if (timer) clearTimeout(timer)
    try { if (onAbort) opts.signal?.removeEventListener?.("abort", onAbort) } catch { /* */ }
    // On a non-clean exit, abort the session so opencode stops working the turn.
    if (outcome !== "completed") { try { await h.abort(sessionID) } catch { /* */ } }
    // Swallow the dangling prompt promise if it ever settles later (timeout/abort path).
    void promptP.catch(() => {})
    if (active?.sessionID === sessionID) active = null
    return { state: acc.state(), outcome }
  }

  function destructiveAlreadySucceeded(ledger: OpenCodeToolCall[]): boolean {
    return ledger.some((c) => isDestructiveCall(c as any) && !c.error)
  }

  async function run(input: string, opts: OpenCodeRunOpts): Promise<OpenCodeRunResult> {
    try {
      const h = await ensureConnected()
      const convId = opts.conversationId ?? "default"
      const sessionID = await ensureSession(h, convId)
      const system = opts.instructions && opts.instructions.length ? opts.instructions : deps.baseInstructions

      const turn = await runOneTurn(h, sessionID, input, system, opts)
      let finalOutput = turn.state.finalText
      let ledger = turn.state.toolCalls
      let corrected = false

      // Quiet-abort: a superseded/aborted turn ends without a verifier pass.
      if (turn.outcome === "aborted" || opts.signal?.aborted) {
        return { finalOutput, streamedText: turn.state.streamedText, corrected: false, toolCalls: ledger }
      }

      // POST-TURN verifier gate (ported). Only on a CLEAN completion (not timeout/error,
      // where the answer is partial). Corrective retry = a NEW prompt (write-guarded).
      if (deps.verifier && turn.outcome === "completed") {
        try {
          const v = await deps.verifier.verify({ utterance: input, finalText: finalOutput, toolCalls: ledger })
          if (!v.ok && v.retryable && !destructiveAlreadySucceeded(ledger)) {
            opts.onEvent?.({ kind: "self_correct", concern: v.concern ?? "" })
            const followUp = `[automatic check] ${v.concern ?? "re-check your last answer against what the tools actually returned and correct it."}`
            const corr = await runOneTurn(h, sessionID, followUp, system, opts)
            if (corr.state.finalText) finalOutput = corr.state.finalText
            ledger = ledger.concat(corr.state.toolCalls)
            corrected = true
          } else if (!v.ok && v.correction && !v.retryable) {
            finalOutput = v.correction
            corrected = true
          }
        } catch (e) { log(`openCodeBrain: verifier error (not blocking): ${String((e as Error)?.message ?? e)}`) }
      }

      return { finalOutput, streamedText: turn.state.streamedText, corrected, toolCalls: ledger }
    } catch (e) {
      log(`openCodeBrain: run failed: ${String((e as Error)?.message ?? e)}`)
      return { finalOutput: "", streamedText: "", corrected: false, toolCalls: [] }
    }
  }

  function shutdown(): void {
    try { handle?.close() } catch { /* */ }
    handle = null; connectPromise = null; sessions.clear(); active = null
  }

  return { run, shutdown }
}

// ── the real SDK adapter (not unit-tested; validated by the live E2E, B3) ──────

/** Build the opencode config object (passed to createOpencode — no file needed):
 *  OpenRouter(minimax) provider via @ai-sdk/openai-compatible + KAIROS's in-daemon /mcp
 *  as a remote MCP server + permissive permissions (we auto-respond anyway). */
export function buildOpenCodeConfig(o: {
  brainKey: string
  baseURL: string
  modelProviderID: string
  modelID: string
  mcpServerName: string
  mcpUrl: string
  mcpToken: string
}): any {
  return {
    provider: {
      [o.modelProviderID]: {
        npm: "@ai-sdk/openai-compatible",
        name: "KAIROS Brain",
        options: { baseURL: o.baseURL, apiKey: o.brainKey },
        models: { [o.modelID]: { name: o.modelID, tool_call: true } },
      },
    },
    mcp: {
      [o.mcpServerName]: {
        type: "remote",
        url: o.mcpUrl,
        headers: { authorization: `Bearer ${o.mcpToken}` },
        enabled: true,
      },
    },
    permission: { edit: "allow", bash: "allow", webfetch: "allow" },
  }
}

/** Spawn a warm opencode (createOpencode → opencode serve + HTTP client) and adapt the
 *  SDK to OpenCodeHandle. Reads minimal config; the client talks loopback HTTP+SSE. */
export async function spawnOpenCode(o: { config: any; log?: (m: string) => void }): Promise<OpenCodeHandle> {
  const log = o.log ?? (() => {})
  const { createOpencode } = await import("@opencode-ai/sdk")
  const { client, server } = await createOpencode({ config: o.config })
  log(`opencode serve up at ${server.url}`)
  let handler: (raw: any) => void = () => {}
  // Background: pump the global SSE stream → handler.
  void (async () => {
    try {
      const ev = await client.global.event()
      for await (const e of ev.stream) handler(e)
    } catch (e) { log(`opencode event stream ended: ${String((e as Error)?.message ?? e)}`) }
  })()
  return {
    createSession: async () => {
      const r: any = await client.session.create({ body: { title: "kairos" } })
      const id = r?.data?.id ?? r?.id
      if (!id) throw new Error("opencode session.create returned no id")
      return id
    },
    prompt: async ({ sessionID, text, system, model }) => {
      await client.session.prompt({ path: { id: sessionID }, body: { model, parts: [{ type: "text", text }], ...(system ? { system } : {}) } } as any)
      return {}
    },
    abort: async (sessionID) => { try { await client.session.abort({ path: { id: sessionID } } as any) } catch { /* */ } },
    onEvent: (h) => { handler = h },
    respondPermission: async (sessionID, permissionID) => {
      await (client.session as any).postSessionIdPermissionsPermissionId({ path: { id: sessionID, permissionID }, body: { response: "always" } })
    },
    close: () => { try { server.close() } catch { /* */ } },
  }
}
