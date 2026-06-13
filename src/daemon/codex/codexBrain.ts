// codexBrain.ts — the warm `codex app-server` child as a KAIROS PlannerRunner.
// This is THE brain-swap seam: the conductor injects `deps.runPlanner = brain.run`
// (conductor.ts:663); CodexBrain emits the SAME LoopEvent shapes as the in-house
// `defaultPlannerRunner`, so the conductor's onEvent→controller→activity wiring,
// persistence, and trajectory hooks are untouched (doc 01 §4).
//
// Pipeline per turn: initialize (once) → thread/start (once per conversation, reuse)
// → [inject_items for per-turn delta] → turn/start { input, effort, model } →
// translate the notification stream into LoopEvents + a verifier ledger (codexEvents)
// → POST-TURN verifier gate (verifier.ts, ported verbatim) → corrective retry as a
// NEW turn/start (A2: steer is mid-turn-only) gated by the C12 write-guard.
//
// Security invariants baked in: B6 minimal allowlisted env (never {...process.env});
// approvalPolicy:never + sandbox workspace-write (server→client approval prompts are
// suppressed); A3 namespace strip happens in codexEvents before the ledger.

import { createCodexRpc, type CodexRpc } from "./codexJsonRpc"
import { createTurnAccumulator, type CodexToolCall } from "./codexEvents"
import { isDestructiveCall } from "../agents/loop/verifier"
import type { LoopEvent, LoopMsg } from "../agents/loop/types"
import type { ReasoningEffort } from "./proto/ReasoningEffort"

// ── pure helpers (unit-tested directly) ───────────────────────────────────────

/** B6 — the EXPLICIT minimal allowlisted env for the codex child. NEVER spread the
 *  daemon's env: that would hand the agent OPENROUTER_API_KEY / Composio secrets and
 *  defeat the whole proxy-hiding premise. codex reads its API key as OPENAI_API_KEY
 *  → we set that to the proxy TOKEN (KAIROS_BRAIN_KEY), never a real provider key. */
export function buildCodexChildEnv(o: {
  brainKey: string
  mcpToken: string
  codexHome: string
  home: string
  /** vendored runtime dir (bundled rg) — the ONLY PATH the child gets. */
  pathDir: string
  /** the daemon env, passed explicitly so the allowlist is testable (defaults to process.env). */
  processEnv?: Record<string, string | undefined>
}): Record<string, string> {
  return {
    KAIROS_BRAIN_KEY: o.brainKey,
    KAIROS_MCP_TOKEN: o.mcpToken,
    OPENAI_API_KEY: o.brainKey, // codex's provider key slot ← the proxy token (not a provider key)
    CODEX_HOME: o.codexHome,
    PATH: o.pathDir,
    HOME: o.home,
  }
}

/** turn/start.input — the UserInput "text" shape (text_elements required by codex). */
export function buildTurnInput(text: string): Array<{ type: "text"; text: string; text_elements: [] }> {
  return [{ type: "text", text, text_elements: [] }]
}

/** A Responses-API message item for thread/inject_items (per-turn volatile delta). */
function messageItem(role: "user" | "assistant", text: string) {
  return { type: "message", role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text }] }
}

// ── process handle (injected for tests; default = Bun.spawn) ───────────────────

export interface CodexProcessHandle {
  rpc: CodexRpc
  kill(): void
  exited: Promise<unknown>
}

/** The DEFAULT connect: spawn `codex app-server --listen stdio://` with the B6
 *  minimal env, wire newline-JSON over stdin/stdout into a CodexRpc. Not unit-tested
 *  (needs the real binary) — validated by the live E2E (A4.4). Returns synchronously;
 *  the stdout pump runs in the background. */
export function spawnCodexAppServer(o: {
  binaryPath: string
  workspaceDir: string
  env: Record<string, string>
  defaultTimeoutMs?: number
  log?: (m: string) => void
}): CodexProcessHandle {
  const log = o.log ?? (() => {})
  const proc = Bun.spawn(
    [o.binaryPath, "app-server", "--listen", "stdio://", "-c", "approval_policy=never", "-c", "sandbox_mode=workspace-write"],
    { cwd: o.workspaceDir, env: o.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  )
  const rpc = createCodexRpc({
    send: (line) => { try { proc.stdin.write(line); proc.stdin.flush() } catch (e) { log(`codex stdin write failed: ${String((e as Error)?.message ?? e)}`) } },
    defaultTimeoutMs: o.defaultTimeoutMs,
    log,
  })
  // Pump stdout (newline-JSON) → rpc.receive.
  void (async () => {
    const dec = new TextDecoder()
    try { for await (const chunk of proc.stdout as any) rpc.receive(dec.decode(chunk as Uint8Array, { stream: true })) }
    catch (e) { log(`codex stdout pump ended: ${String((e as Error)?.message ?? e)}`) }
  })()
  // Surface stderr for debugging (codex logs warnings/errors there).
  void (async () => {
    const dec = new TextDecoder()
    try { for await (const chunk of proc.stderr as any) { const s = dec.decode(chunk as Uint8Array).trim(); if (s) log(`codex stderr: ${s}`) } }
    catch { /* */ }
  })()
  return { rpc, kill: () => { try { proc.kill() } catch { /* */ } }, exited: proc.exited }
}

export interface CodexVerifier {
  verify(o: { utterance: string; finalText: string; toolCalls: CodexToolCall[] }): Promise<{
    ok: boolean
    concern?: string
    correction?: string
    severity: "read" | "write"
    retryable?: boolean
  }>
}

export interface CodexBrainDeps {
  /** Establish a connection to a codex app-server. Tests inject a fake; production
   *  uses spawnCodexAppServer (Bun.spawn with the B6 minimal env). */
  connect: () => CodexProcessHandle
  /** The single model alias the proxy resolves server-side. */
  modelAlias: string
  /** Durable doctrine/persona → thread/start.baseInstructions (set once per thread).
   *  Used when a turn provides no per-turn instructions. */
  baseInstructions: string
  /** Per-turn reasoning effort (task=low / think=high). */
  effort: ReasoningEffort
  /** Pre-trusted git workspace (cwd for the thread). */
  workspaceDir: string
  /** Post-turn grounded-verify gate (buildDestructiveVerifier). Optional (tests/bg). */
  verifier?: CodexVerifier
  log?: (m: string) => void
  initTimeoutMs?: number
  threadStartTimeoutMs?: number
  turnTimeoutMs?: number
}

export interface CodexRunOpts {
  tools: any[]
  instructions: string
  signal?: AbortSignal
  onEvent?: (e: LoopEvent) => void
  history?: LoopMsg[]
  conversationId?: string
}

export interface CodexRunResult {
  finalOutput: string
  streamedText?: string
  corrected?: boolean
  toolCalls: CodexToolCall[]
}

interface ThreadRec { id: string; baseInstructions: string }
interface ActiveTurn {
  acc: ReturnType<typeof createTurnAccumulator>
  onDone: () => void
  turnId?: string
}

const DEFAULTS = { initTimeoutMs: 30_000, threadStartTimeoutMs: 30_000, turnTimeoutMs: 90_000 }

export function createCodexBrain(deps: CodexBrainDeps) {
  const log = deps.log ?? (() => {})
  const t = { ...DEFAULTS, initTimeoutMs: deps.initTimeoutMs ?? DEFAULTS.initTimeoutMs, threadStartTimeoutMs: deps.threadStartTimeoutMs ?? DEFAULTS.threadStartTimeoutMs, turnTimeoutMs: deps.turnTimeoutMs ?? DEFAULTS.turnTimeoutMs }

  let handle: CodexProcessHandle | null = null
  let initPromise: Promise<void> | null = null
  const threads = new Map<string, Promise<ThreadRec>>()
  let active: ActiveTurn | null = null

  function ensureProcess(): CodexProcessHandle {
    if (handle) return handle
    handle = deps.connect()
    // ONE notification router for the whole process — routes to the CURRENT serial
    // turn. (Turns are serial: barge-in aborts the prior one. Routing by "active
    // turn" avoids a turnId race — the turnId isn't known until turn/start returns,
    // but notifications can arrive in the same microtask.)
    handle.rpc.onNotification((method, params) => {
      if (!active) return
      try { active.acc.handle(method, params) } catch (e) { log(`codexBrain: accumulator error: ${String((e as Error)?.message ?? e)}`) }
      if (method === "turn/started") active.turnId = params?.turn?.id ?? active.turnId
      if (method === "turn/completed") active.onDone()
    })
    // approvalPolicy:never should suppress server→client approval requests; if one
    // arrives anyway, never block on it (the design replaces these with our gates).
    handle.rpc.onServerRequest((req) => log(`codexBrain: ignoring server request ${req.method} (suppressed by approvalPolicy:never)`))
    // On child exit: fail in-flight work + reset so the next run reconnects (stale-exit guard).
    void handle.exited.then(() => {
      log("codexBrain: app-server exited — resetting session")
      try { handle?.rpc.rejectAll(new Error("codex app-server exited")) } catch { /* */ }
      handle = null; initPromise = null; threads.clear(); active = null
    }).catch(() => {})
    return handle
  }

  function ensureInitialized(h: CodexProcessHandle): Promise<void> {
    if (!initPromise) {
      initPromise = (async () => {
        await h.rpc.request("initialize", {
          clientInfo: { name: "kairos", title: "KAIROS", version: "0.1.0" },
          capabilities: { experimentalApi: true, requestAttestation: false },
        }, { timeoutMs: t.initTimeoutMs })
        h.rpc.notify("initialized")
      })().catch((e) => { initPromise = null; throw e })
    }
    return initPromise
  }

  function ensureThread(h: CodexProcessHandle, convId: string, baseInstructions: string): Promise<ThreadRec> {
    let p = threads.get(convId)
    if (!p) {
      p = (async () => {
        const res: any = await h.rpc.request("thread/start", {
          model: deps.modelAlias,
          modelProvider: "kairos",
          cwd: deps.workspaceDir,
          approvalPolicy: "never",
          sandbox: "workspace-write",
          baseInstructions,
          serviceName: "kairos",
          personality: "friendly",
          ephemeral: false,
        }, { timeoutMs: t.threadStartTimeoutMs })
        const id = res?.thread?.id
        if (!id) throw new Error("thread/start returned no thread id")
        return { id, baseInstructions }
      })().catch((e) => { threads.delete(convId); throw e })
      threads.set(convId, p)
    }
    return p
  }

  /** Drive ONE turn to completion (or abort). Sets up the active-turn router BEFORE
   *  sending turn/start (the microtask race), then awaits turn/completed. */
  async function runOneTurn(h: CodexProcessHandle, threadId: string, text: string, opts: CodexRunOpts): Promise<{ finalText: string; streamedText: string; toolCalls: CodexToolCall[]; aborted: boolean }> {
    const acc = createTurnAccumulator((e) => opts.onEvent?.(e))
    let onDone!: () => void
    const done = new Promise<void>((res) => { onDone = res })
    const turn: ActiveTurn = { acc, onDone }
    active = turn

    let aborted = false
    const onAbort = () => {
      aborted = true
      if (turn.turnId) { try { h.rpc.request("turn/interrupt", { threadId, turnId: turn.turnId }).catch(() => {}) } catch { /* */ } }
      onDone()
    }
    if (opts.signal?.aborted) { onAbort() }
    else opts.signal?.addEventListener?.("abort", onAbort, { once: true })

    try {
      const resp: any = await h.rpc.request("turn/start", {
        threadId,
        input: buildTurnInput(text),
        model: deps.modelAlias,
        effort: deps.effort,
      }, { timeoutMs: t.turnTimeoutMs })
      turn.turnId = resp?.turn?.id ?? turn.turnId
      await done
    } finally {
      try { opts.signal?.removeEventListener?.("abort", onAbort) } catch { /* */ }
      if (active === turn) active = null
    }
    const s = acc.state()
    return { finalText: s.finalText || s.streamedText, streamedText: s.streamedText, toolCalls: s.toolCalls, aborted }
  }

  /** The C12 write-guard: a destructive tool already SUCCEEDED this turn → do NOT run
   *  a corrective retry (a new turn could double-send the irreversible action). */
  function destructiveAlreadySucceeded(ledger: CodexToolCall[]): boolean {
    return ledger.some((c) => isDestructiveCall(c as any) && !c.error)
  }

  async function run(input: string, opts: CodexRunOpts): Promise<CodexRunResult> {
    const h = ensureProcess()
    try {
      await ensureInitialized(h)
      const convId = opts.conversationId ?? "default"
      const base = opts.instructions && opts.instructions.length ? opts.instructions : deps.baseInstructions
      const thread = await ensureThread(h, convId, base)

      // Per-turn VOLATILE delta (A1): a later turn whose instructions differ from the
      // thread's durable base (e.g. lessonContext) is injected as items BEFORE the
      // turn — best-effort (a reject must not sink the turn). v1 injects the
      // instruction delta; full history replay is a follow-up.
      if (opts.instructions && opts.instructions !== thread.baseInstructions) {
        try {
          await h.rpc.request("thread/inject_items", { threadId: thread.id, items: [messageItem("user", opts.instructions)] }, { timeoutMs: t.threadStartTimeoutMs })
        } catch (e) { log(`codexBrain: inject_items failed (continuing): ${String((e as Error)?.message ?? e)}`) }
      }

      const turn = await runOneTurn(h, thread.id, input, opts)
      let finalOutput = turn.finalText
      let corrected = false
      let ledger = turn.toolCalls

      // Quiet-abort: a superseded turn ends WITHOUT a verifier pass or extra speech.
      if (turn.aborted || opts.signal?.aborted) {
        return { finalOutput, streamedText: turn.streamedText, corrected: false, toolCalls: ledger }
      }

      // POST-TURN verifier gate (doc 01 §D) — ported verbatim; runs on the tuple the
      // Codex stream reconstructed. On a retryable flag (and the write-guard clear),
      // run ONE corrective turn as a NEW turn/start (A2: not steer).
      if (deps.verifier) {
        try {
          const v = await deps.verifier.verify({ utterance: input, finalText: finalOutput, toolCalls: ledger })
          if (!v.ok && v.retryable && !destructiveAlreadySucceeded(ledger)) {
            opts.onEvent?.({ kind: "self_correct", concern: v.concern ?? "" })
            const followUp = `[automatic check] ${v.concern ?? "re-check your last answer against what the tools actually returned and correct it."}`
            const corr = await runOneTurn(h, thread.id, followUp, opts)
            if (corr.finalText) finalOutput = corr.finalText
            ledger = ledger.concat(corr.toolCalls)
            corrected = true
          } else if (!v.ok && v.correction && !v.retryable) {
            // A grounded fact-correction the gate derived from the ledger alone.
            finalOutput = v.correction
            corrected = true
          }
        } catch (e) { log(`codexBrain: verifier error (not blocking): ${String((e as Error)?.message ?? e)}`) }
      }

      return { finalOutput, streamedText: turn.streamedText, corrected, toolCalls: ledger }
    } catch (e) {
      log(`codexBrain: run failed: ${String((e as Error)?.message ?? e)}`)
      return { finalOutput: "", streamedText: "", corrected: false, toolCalls: [] }
    }
  }

  function shutdown(): void {
    try { handle?.kill() } catch { /* */ }
    handle = null; initPromise = null; threads.clear(); active = null
  }

  return { run, shutdown }
}
