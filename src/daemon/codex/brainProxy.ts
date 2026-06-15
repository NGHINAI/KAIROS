// brainProxy.ts — the hidden inference proxy (A1, docs 02 + 14 §C13/§D15).
// Codex (wire_api="responses") points its model_provider base_url here; the proxy
// forwards to OpenRouter's /v1/responses (which natively supports the Responses
// API — verified 2026-06-13, so this is a PASS-THROUGH, not a translator). It:
//   • validates the incoming bearer (the token codex sends),
//   • rewrites the model ALIAS (kairos-smart/kairos-deep/kairos → the real slug)
//     so nothing on the wire or in the app bundle names the provider/model,
//   • forwards with our SERVER-SIDE upstream key (ship: the real key never leaves
//     the proxy; dev: same key),
//   • streams SSE passthrough untouched (codex consumes deltas live),
//   • retries 429/5xx with backoff (honoring Retry-After) + circuit-breaks.
// LOCAL now (Bun on loopback) → HOSTED later (same handler as a Cloudflare Worker);
// only the base_url in the generated config.toml changes.

import { timingSafeEqual } from "node:crypto"

export interface BrainProxyOptions {
  /** Real upstream key used to call OpenRouter (server-side secret). */
  upstreamKey: string
  /** Bearer the incoming request MUST present (the token codex sends). Dev: same
   *  as upstreamKey; ship: a per-install token mapped to the key server-side. */
  expectedBearer: string
  /** Upstream API root. Default OpenRouter. codex appends /responses etc. */
  upstreamBase?: string
  /** alias → real model slug. Unknown models pass through unchanged. */
  aliasMap?: Record<string, string>
  /** Per-turn REASONING effort, keyed by the INCOMING alias (the task-type signal:
   *  kairos-smart vs kairos-deep). Returns the value to set as the request's
   *  `reasoning` field (e.g. {effort:'low'} or {enabled:false}), or undefined to
   *  leave it to the provider default. An explicit `reasoning` in the request is
   *  never overridden. Defaults to defaultReasoningFor(). */
  reasoningFor?: (alias: string) => unknown | undefined
  /** Max retries on 429/5xx (default 2). */
  maxRetries?: number
  /** Per-attempt connect/non-stream timeout ms (default 120000). Streaming bodies
   *  are not aborted once flowing — codex owns the turn deadline. */
  timeoutMs?: number
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** Injected sleep for tests (backoff). */
  sleep?: (ms: number) => Promise<void>
  log?: (msg: string) => void
}

const DEFAULT_UPSTREAM = "https://openrouter.ai/api"

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  try { return timingSafeEqual(ab, bb) } catch { return false }
}

/** Build the alias map from env defaults. One model, per-turn effort, so all
 *  aliases resolve to the same slug unless overridden. */
export function defaultAliasMap(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const smart = env.KAIROS_BRAIN_MODEL_SMART || env.KAIROS_BRAIN_MODEL || "minimax/minimax-m3"
  const deep = env.KAIROS_BRAIN_MODEL_DEEP || env.KAIROS_BRAIN_MODEL || smart
  return {
    kairos: smart, "kairos-smart": smart, "kairos-deep": deep,
    // Per-turn EXPLICIT-effort aliases the conductor selects dynamically. All run on
    // the same capable smart model; only the reasoning budget differs (set in
    // defaultReasoningFor). This is how per-task effort reaches the proxy through
    // opencode (which only lets the model field vary per turn).
    "kairos-low": smart, "kairos-medium": smart, "kairos-high": smart, "kairos-none": smart,
  }
}

/** Build the per-task-type reasoning-effort resolver from env. The opencode brain
 *  sends one alias per turn (kairos-smart for routine agentic turns, kairos-deep for
 *  hard planning) — that alias IS the task type, so we map each to an effort:
 *    KAIROS_BRAIN_REASONING_EFFORT       (smart lane, default 'low')
 *    KAIROS_BRAIN_REASONING_EFFORT_DEEP  (deep  lane, default 'high')
 *  Values: 'low'|'medium'|'high' → {effort}; 'none'|'minimal'|'disabled' →
 *  {enabled:false} (thinking off, fastest); 'off'|'default' → undefined (no
 *  injection, provider decides). Keeping a capable model but bounding its thinking
 *  on routine turns is the latency lever (vs downgrading the model on every turn). */
export function defaultReasoningFor(
  env: Record<string, string | undefined> = process.env,
): (alias: string) => unknown | undefined {
  const map = (level: string | undefined): unknown | undefined => {
    const l = (level ?? "").toLowerCase().trim()
    if (l === "" || l === "off" || l === "default" || l === "provider") return undefined
    if (l === "none" || l === "minimal" || l === "disabled" || l === "false" || l === "0") return { enabled: false }
    if (l === "low" || l === "medium" || l === "high") return { effort: l }
    return undefined
  }
  const smart = map(env.KAIROS_BRAIN_REASONING_EFFORT ?? "low")
  const deep = map(env.KAIROS_BRAIN_REASONING_EFFORT_DEEP ?? "high")
  return (alias: string) => {
    // EXPLICIT per-turn effort aliases (the conductor's dynamic decision) — these
    // ALWAYS resolve to their own effort, ignoring env. This is the per-task knob.
    if (alias === "kairos-low") return map("low")
    if (alias === "kairos-medium") return map("medium")
    if (alias === "kairos-high") return map("high")
    if (alias === "kairos-none") return map("none")
    // Generic lanes — env-defaulted fallback (used when no per-turn effort was chosen).
    if (alias === "kairos-deep") return deep
    if (alias === "kairos" || alias === "kairos-smart") return smart
    return undefined // unknown / explicitly-named model → don't touch
  }
}

export interface BrainProxy {
  /** Route a /brain/* (or root) request here. `subpath` is the path AFTER the
   *  mount prefix, e.g. "/v1/responses". */
  handleRequest: (req: Request, subpath: string) => Promise<Response>
}

export function createBrainProxy(opts: BrainProxyOptions): BrainProxy {
  const log = opts.log ?? (() => {})
  const upstreamBase = (opts.upstreamBase ?? DEFAULT_UPSTREAM).replace(/\/$/, "")
  const aliasMap = opts.aliasMap ?? {}
  const reasoningFor = opts.reasoningFor   // undefined → no injection (back-compat)
  const maxRetries = opts.maxRetries ?? 2
  const timeoutMs = opts.timeoutMs ?? 120_000
  const doFetch = opts.fetchImpl ?? fetch
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))

  async function handleRequest(req: Request, subpath: string): Promise<Response> {
    // ── bearer auth (the token codex sends) ──
    const got = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "")
    if (!got || !safeEqual(got, opts.expectedBearer)) {
      return new Response(JSON.stringify({ error: { message: "unauthorized" } }), { status: 401, headers: { "content-type": "application/json" } })
    }

    // ── body: rewrite the model alias, detect streaming ──
    let bodyText = ""
    let streaming = false
    let modelBefore = ""
    if (req.method === "POST") {
      bodyText = await req.text()
      if (bodyText) {
        try {
          const parsed = JSON.parse(bodyText)
          modelBefore = parsed.model
          // Per-task-type reasoning effort, keyed by the INCOMING alias — BEFORE the
          // alias is rewritten away. Never override a reasoning the caller set itself.
          if (reasoningFor && parsed.reasoning === undefined) {
            const r = reasoningFor(parsed.model)
            if (r !== undefined) parsed.reasoning = r
          }
          if (parsed.model && aliasMap[parsed.model]) parsed.model = aliasMap[parsed.model]
          streaming = parsed.stream === true
          bodyText = JSON.stringify(parsed)
        } catch { /* non-JSON body — forward as-is */ }
      }
    }

    const url = `${upstreamBase}${subpath}`
    const headers: Record<string, string> = {
      authorization: `Bearer ${opts.upstreamKey}`,
      "content-type": req.headers.get("content-type") ?? "application/json",
      // OpenRouter etiquette (optional but polite; never reveals the user).
      "http-referer": "https://kairos.local",
      "x-title": "KAIROS",
    }

    // ── forward with retry/backoff on 429/5xx ──
    let lastErr = ""
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Don't abort a streaming body once it's flowing; cap non-stream + connect.
      const ctrl = new AbortController()
      const timer = streaming ? null : setTimeout(() => ctrl.abort(), timeoutMs)
      let upstream: Response
      try {
        upstream = await doFetch(url, { method: req.method, headers, body: req.method === "POST" ? bodyText : undefined, signal: ctrl.signal })
      } catch (e) {
        if (timer) clearTimeout(timer)
        lastErr = String((e as Error)?.message ?? e)
        log(`[brain-proxy] upstream fetch error (attempt ${attempt}): ${lastErr}`)
        if (attempt < maxRetries) { await sleep(backoff(attempt)); continue }
        return new Response(JSON.stringify({ error: { message: `upstream unreachable: ${lastErr}` } }), { status: 502, headers: { "content-type": "application/json" } })
      }

      // Retryable upstream status?
      if ((upstream.status === 429 || upstream.status >= 500) && attempt < maxRetries) {
        if (timer) clearTimeout(timer)
        const ra = Number(upstream.headers.get("retry-after"))
        const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : backoff(attempt)
        log(`[brain-proxy] upstream ${upstream.status}; retry ${attempt + 1}/${maxRetries} in ${wait}ms`)
        await sleep(wait)
        continue
      }

      const ms = modelBefore ? `${modelBefore}→${(aliasMap[modelBefore] ?? modelBefore)}` : "(no model)"
      log(`[brain-proxy] ${req.method} ${subpath} model=${ms} → ${upstream.status}${streaming ? " (stream)" : ""}`)

      // Pass the upstream response straight back (streaming body included). Copy
      // status + content-type; drop hop-by-hop/transfer-encoding headers.
      const respHeaders = new Headers()
      const ct = upstream.headers.get("content-type"); if (ct) respHeaders.set("content-type", ct)
      if (timer) {
        // non-stream: buffer so the abort timer can be cleared deterministically
        const buf = await upstream.text()
        clearTimeout(timer)
        return new Response(buf, { status: upstream.status, headers: respHeaders })
      }
      return new Response(upstream.body, { status: upstream.status, headers: respHeaders })
    }
    // exhausted retries on retryable statuses
    return new Response(JSON.stringify({ error: { message: `upstream failed after ${maxRetries} retries: ${lastErr || "5xx/429"}` } }), { status: 503, headers: { "content-type": "application/json" } })
  }

  return { handleRequest }
}

/** Exponential backoff with jitter: 250ms, 500ms, 1s, … (capped). */
function backoff(attempt: number): number {
  const base = Math.min(250 * 2 ** attempt, 4000)
  return base + Math.floor((base / 4) * ((attempt * 1103515245 + 12345) % 100) / 100) // deterministic pseudo-jitter (no Math.random for test stability)
}
