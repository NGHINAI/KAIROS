// src/daemon/agents/loop/toolExecutor.ts
// Executes one tool call and ALWAYS returns a tool result — never throws to the
// loop. Codex's RespondToModel discipline: malformed args, unknown tools, and
// runtime errors all come back as a `role:'tool'` result so the model can
// self-correct or route around the failure on the next turn. Every tool_call_id
// gets a matching result (even on abort), or chat-completions 400s on an
// orphaned tool call.
//
// The MODEL never sees raw API JSON. `shapeObservation` (below) distills any tool
// result — list, single object, scalar, text, or error — into a compact, high-signal
// observation: a natural-language headline (so a weak/fast model reasons over words,
// not JSON) + a compact structured tail (ids/handles + the few salient fields, so the
// agent can still act precisely). The RAW result is kept on `ToolResult.result` for the
// system (verify gate, follow-up tool calls, replay) — it is NOT what the model reads.
// This is "extractive before abstractive": deterministic field extraction owns every
// number/id/status; an (optional) cheap-LLM distill only ever *phrases*, never selects,
// and only for over-budget unstructured prose — validated so it can't invent an id.

import type { ToolDef } from "../types"
import type { ToolCall } from "./types"

export interface ToolResult {
  tool_call_id: string
  content: string
  ok: boolean
  /** Raw result on success — for narration/verification/replay (NOT sent to the model). */
  result?: any
}

// Cap the model-facing observation so one payload can't blow the window. ~6k chars ≈ 1.5k
// tokens; shaping usually lands well under this, clampMiddle is the final safety net.
const MAX_CONTENT = Number(process.env.KAIROS_MAX_TOOL_CHARS) || 6000
const ROW_STR = 200            // max chars per surfaced string field
const LIST_TOPK = 25           // max list rows surfaced

/** Middle-elision: keep the HEAD and the TAIL with an explicit marker. A plain
 *  head-cut would drop ids that live near the end of a list result; keeping both ends
 *  preserves far more usable structure than a tail-truncate. */
export function clampMiddle(content: string, max: number): string {
  if (content.length <= max) return content
  const head = Math.floor(max * 0.6)
  const tail = Math.max(0, max - head - 60)
  return content.slice(0, head) + `\n…(${content.length - head - tail} chars elided)…\n` + content.slice(content.length - tail)
}

// Priority HINTS — fields surfaced first when present (ordering only, not a gate; any
// other small scalar is still kept). Mix of human-meaningful bits + handles/ids.
const PRIORITY_FIELDS = [
  "title", "name", "subject", "summary", "snippet", "preview", "from", "sender", "to",
  "status", "state", "date", "timestamp", "start", "end", "due", "amount", "total", "price",
  "id", "threadId", "messageId", "uid", "key", "number", "url", "permalink", "link",
]
// Back-compat export (older callers/tests referenced this name).
export const KEEP_FIELDS = PRIORITY_FIELDS

// Noise: verbose/binary/markup fields that bury signal and bloat tokens — always dropped
// from the model-facing observation (still in the raw result for the system).
const NOISE_KEYS = new Set([
  "body", "payload", "raw", "_raw", "html", "htmlbody", "textbody", "mimetype", "labelids",
  "attachmentlist", "attachments", "headers", "rawcontent", "content_base64", "base64",
  "data_uri", "thread", "parts", "messages_html", "embedding", "vector",
])

/** JSON.stringify that never throws — circular refs become "[circular]" so partial structure
 *  (ids/titles) still survives instead of collapsing the whole result to a sentinel. */
function safeStringify(v: any): string {
  try { return JSON.stringify(v) ?? "" } catch { /* fall through to circular-safe path */ }
  try {
    const seen = new WeakSet()
    return JSON.stringify(v, (_k, val) => {
      if (val && typeof val === "object") { if (seen.has(val)) return "[circular]"; seen.add(val) }
      return typeof val === "bigint" ? String(val) : val
    }) ?? ""
  } catch { return "[unserializable]" }
}

// Fields whose VALUE is an actionable handle (id/url/token) the agent must use next — never
// dropped as "noise" for being long, and kept at a generous length (signed URLs are long).
function isHandleKey(k: string): boolean {
  return /(^|_)(id|url|uri|link|permalink|href|token|key|handle)$/i.test(k) || /(Id|Url|Uri|Link|Href|Token|Key)$/.test(k)
}
const HANDLE_MAX = 1000

// Content fields whose long string IS the point on a single-object read (an email/doc body).
const CONTENT_KEYS = ["body", "text", "content", "textbody", "description", "message"]

/** The human/diagnostic message of an error envelope, or null if there's NO real error.
 *  Falsy non-strings (0, false) and empty strings are NOT failures (they're "no error"). */
function errorMessage(e: any): string | null {
  if (e == null) return null
  if (typeof e === "string") return e.trim() || null
  if (typeof e === "number" || typeof e === "boolean") return null            // 0 / false = no error
  if (typeof e === "object") {
    const m = (e as any).message ?? (e as any).error ?? (e as any).detail
    if (typeof m === "string" && m.trim()) return m.trim()
    const s = safeStringify(e)
    return s && s !== "{}" && s !== "[]" ? s.slice(0, 300) : null
  }
  return null
}

function isScalar(v: any): boolean {
  return v == null || typeof v === "string" || typeof v === "number" || typeof v === "boolean"
}
function isNoise(key: string, v: any): boolean {
  if (NOISE_KEYS.has(key.toLowerCase())) return true
  if (isHandleKey(key)) return false                                         // never drop a handle/url/id
  if (typeof v === "string" && v.length > 600) return true                   // big blob
  if (typeof v === "string" && /^[A-Za-z0-9+/=\r\n]{300,}$/.test(v)) return true  // base64/blob
  return false
}

/** Pull the salient, blob-free scalar fields out of one object, priority-ordered. Keeps
 *  ids/handles so the agent can act on the object later; drops bodies/payloads/markup. */
function compactScalars(obj: any, maxFields: number): Record<string, any> {
  const out: Record<string, any> = {}
  const take = (k: string) => {
    if (k in out || Object.keys(out).length >= maxFields) return
    const v = obj[k]
    if (!isScalar(v) || isNoise(k, v)) return
    out[k] = typeof v === "string" ? v.slice(0, isHandleKey(k) ? HANDLE_MAX : ROW_STR) : v
  }
  for (const k of PRIORITY_FIELDS) if (obj[k] !== undefined) take(k)        // priority hints first
  for (const k of Object.keys(obj)) take(k)                                 // then any other small scalar
  return out
}

function renderList(noun: string, arr: any[], verbosity: Verbosity): string {
  const k = verbosity === "detailed" ? 50 : LIST_TOPK
  const rows = arr.slice(0, k).map((it) =>
    it && typeof it === "object" ? compactScalars(it, verbosity === "detailed" ? 12 : 8)
    : isScalar(it) ? it : "[object]",
  )
  const more = arr.length - rows.length
  const headline = `Found ${arr.length} ${noun}${more > 0 ? ` (showing ${rows.length})` : ""}.`
  const tail = safeStringify(rows) + (more > 0 ? ` …(${more} more in the full result)` : "")
  return `${headline}\n${tail}`
}

function renderObject(obj: any, successful: boolean | undefined, verbosity: Verbosity): string {
  const scalars = compactScalars(obj, verbosity === "detailed" ? 40 : 24)   // keep ALL scalars; only blobs/nesting are dropped

  // If the object carries no surfaced scalars but DOES wrap a single nested object/array
  // (e.g. an unrecognized wrapper), recurse into it rather than emitting a bare "{}".
  if (Object.keys(scalars).length === 0) {
    const nestedArr = Object.values(obj).find((v) => Array.isArray(v)) as any[] | undefined
    if (nestedArr) return renderList("results", nestedArr, verbosity)
    const nestedObj = Object.values(obj).find((v) => v && typeof v === "object") as any
    if (nestedObj) return renderObject(nestedObj, successful, verbosity)
  }

  const titleKey = ["title", "name", "subject", "summary", "goal"].find((kk) => typeof scalars[kk] === "string")
  const statusKey = ["status", "state"].find((kk) => scalars[kk] !== undefined)
  let headline = titleKey ? `"${scalars[titleKey]}"` : ""
  if (statusKey) headline += (headline ? " — " : "") + String(scalars[statusKey])
  if (!headline && successful === true) headline = "Done."

  // Keep a clamped, markup-free excerpt of the dominant CONTENT field (an email/doc body the
  // read tool was asked for) — dropped from `scalars` as noise, but the point of a single read.
  let excerpt = ""
  const ck = CONTENT_KEYS.find((kk) => typeof obj[kk] === "string" && obj[kk].length > ROW_STR)
  if (ck) {
    const body = String(obj[ck]).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
    const cap = verbosity === "detailed" ? 2000 : 800
    excerpt = `\n${ck}: ${body.slice(0, cap)}${body.length > cap ? "…" : ""}`
  }

  const tail = safeStringify(scalars)
  return (headline ? headline + "\n" : "") + tail + excerpt
}

/** If the envelope represents a FAILURE, return its best human guidance text; else null.
 *  Failure = successful===false, or a REAL error present (truthy string / object with a message).
 *  The guidance is hunted across error → data.message → data.error → string data, because APIs
 *  (Composio especially) put the instructive part wherever they feel like. Exported so the
 *  dispatch layer can detect failures and ENRICH them (e.g. append the tool's expected args). */
export function envelopeFailureText(env: Record<string, any>): string | null {
  const errMsg = errorMessage(env.error)
  const failed = env.successful === false || (env.successful !== true && errMsg != null)
  if (!failed) return null
  return errMsg
    ?? errorMessage((env.data as any)?.message != null ? { message: (env.data as any).message } : null)
    ?? errorMessage((env.data as any)?.error)
    ?? errorMessage(typeof env.data === "string" ? env.data : null)
    ?? "the tool reported a failure (no message provided)"
}

const LIST_KEYS = ["messages", "items", "results", "issues", "threads", "events", "records", "files", "rows", "value", "data"]
type Verbosity = "concise" | "detailed"
// Results that stringify under this are SMALL — passed through losslessly. Shaping is
// compression for OVERSIZED results; a small result needs none, and stripping it would
// lose signal (a 3-field object isn't the "raw JSON dump" problem — a 16KB inbox is).
const PASSTHROUGH_CHARS = 1200

/** Turn ANY tool result into the model-facing observation. Small/clean results pass through
 *  as compact JSON (lossless); oversized ones are shaped into an NL headline + compact tail.
 *  Deterministic, sync, no LLM — owns every number/id/status. Unwraps the Composio
 *  `{data, successful, error}` envelope and surfaces failures plainly. */
export function shapeObservation(toolName: string, result: any, opts?: { verbosity?: Verbosity }): string {
  const verbosity = opts?.verbosity ?? "concise"
  if (result == null) return "(no result)"
  if (typeof result === "string") return result               // already text; budget-clamped by caller
  if (typeof result !== "object") return String(result)        // scalar

  const env = result as Record<string, any>
  const hasEnvelope = "data" in env || "successful" in env || "error" in env
  // Failure ONLY when successful===false, or a REAL error is present (truthy string / object with a
  // message). A falsy error (0, false, "") is "no error" — not a failure that should drop the data.
  // PRESERVE THE GUIDANCE: APIs often put the instructive part of a failure in data.message
  // ("Missing required field 'start_datetime'. REQUIRED: …") rather than the error field.
  // That text is exactly what lets the model fix its next call — losing it strands the loop.
  const failureText = envelopeFailureText(env)
  if (failureText != null) {
    // keep schema guidance intact (300 was too tight)
    return `Failed: ${failureText.slice(0, 900)}\nFix the call and retry — do not give up after one failure.`
  }

  let data = hasEnvelope && "data" in env ? env.data : result
  // Collapse redundant single-key { data: … } wrappers (Composio double-wraps payloads) — else a
  // {data:{data:{messages:[…]}}} inbox classifies as an empty object and reports as "Done." (bounded).
  for (let i = 0; i < 4 && data && typeof data === "object" && !Array.isArray(data)
       && Object.keys(data).length === 1 && "data" in data; i++) {
    data = (data as any).data
  }
  const successful = env.successful === true ? true : undefined

  if (data == null) return successful ? "Done." : "(no result)"
  if (typeof data !== "object") return String(data)

  // Pass small/clean results through intact (lossless compact JSON). Shape only oversized ones.
  // We only stringify BOUNDED payloads for the size check — never a huge list (slice in renderList).
  const SMALL_LIST = 30
  if (Array.isArray(data)) {
    if (data.length <= SMALL_LIST) { const j = safeStringify(data); if (j.length <= PASSTHROUGH_CHARS) return j }
    return renderList("results", data, verbosity)
  }

  // Prefer a known list key; fall back to ANY array-valued field so a list under an odd key still shapes.
  const listKey = LIST_KEYS.find((kk) => Array.isArray((data as any)[kk]))
    ?? Object.keys(data as any).find((kk) => Array.isArray((data as any)[kk]))
  if (listKey) {
    const arr = (data as any)[listKey] as any[]
    if (arr.length <= SMALL_LIST) { const j = safeStringify(data); if (j.length <= PASSTHROUGH_CHARS) return j }
    const parent = compactScalars(data, 6)                    // keep the object's OWN scalar fields (count, etc.)
    delete (parent as any)[listKey]
    const list = renderList(listKey, arr, verbosity)
    return Object.keys(parent).length ? `${list}\ncontext: ${safeStringify(parent)}` : list
  }

  const json = safeStringify(data)                             // single object — bounded by its own size
  if (json.length <= PASSTHROUGH_CHARS) return json
  return renderObject(data, successful, verbosity)
}

// ── Optional cheap-LLM distill (extractive, validated) for OVER-BUDGET UNSTRUCTURED PROSE ──
// Deterministic shaping handles structured data (the vast majority). Only when a result is
// still over budget AND it's prose (a web page, a long doc) do we optionally hand it to a
// cheap model to *phrase down* — never to select facts. Wired by the caller; off by default.
function looksLikeProse(result: any): boolean {
  if (typeof result === "string") return true
  const d = result?.data ?? result
  return typeof d === "string"
}

const DISTILL_PROMPT =
  "Compress this tool result for a voice assistant. Rephrase ONLY the facts present below into 1–3 short plain sentences. " +
  "Do NOT add, infer, or invent anything. Do NOT output any number, id, amount, date, or code that is not already in the input. " +
  "No markdown. Output only the summary.\n\nTOOL RESULT:\n"

/** Build the optional cheap-LLM prose distiller from any cheap completer. Extractive by prompt;
 *  the executor additionally VALIDATES the output (no invented numbers/ids) before using it. The
 *  signal lets a barge-in/abort cancel an in-flight distill so the loop never blocks on it. */
export function buildProseDistiller(
  complete: (prompt: string, signal?: AbortSignal) => Promise<string>,
): (text: string, signal?: AbortSignal) => Promise<string> {
  return async (text, signal) => {
    try { return (await complete(DISTILL_PROMPT + text, signal)) ?? "" } catch { return "" }
  }
}
/** Faithfulness guard for a distilled summary. ID-like tokens (letters+digits) must appear as WHOLE
 *  tokens in the source (so "ABC12345" can't pass off a truncated "ABC12345XYZ"); multi-digit NUMBERS
 *  must appear in the source's digit stream after stripping separators (so "1234" is faithful to
 *  "$1,234.56", but an invented "99999" is rejected). Plain words the LLM may phrase freely. */
function distillIsFaithful(distilled: string, source: string): boolean {
  const srcTokens = new Set(source.match(/[A-Za-z0-9_-]{2,}/g) ?? [])
  for (const t of distilled.match(/[A-Za-z0-9_-]{4,}/g) ?? []) {
    if (/[A-Za-z]/.test(t) && /\d/.test(t) && !srcTokens.has(t)) return false   // id-like → exact token
  }
  const srcDigits = (source.match(/\d/g) ?? []).join("")
  for (const n of distilled.match(/\d[\d.,]*/g) ?? []) {
    const d = n.replace(/[^\d]/g, "")
    if (d.length >= 2 && !srcDigits.includes(d)) return false                   // invented multi-digit number
  }
  return true
}

/** Race a promise against a timeout — a hung/slow distill must never block the loop (esp. voice). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))])
}

export async function executeToolCall(
  call: ToolCall,
  tools: ToolDef[],
  opts?: {
    signal?: AbortSignal
    maxChars?: number
    verbosity?: Verbosity
    /** Optional cheap-model distiller for over-budget prose. Must EXTRACT, not invent. Gets the
     *  abort signal so a barge-in can cancel it. */
    distill?: (text: string, signal?: AbortSignal) => Promise<string>
  },
): Promise<ToolResult> {
  if (opts?.signal?.aborted) {
    return { tool_call_id: call.id, content: "Tool call aborted by the user.", ok: false }
  }

  let args: any = {}
  if (call.argsJson && call.argsJson.trim()) {
    try {
      args = JSON.parse(call.argsJson)
    } catch (e) {
      return {
        tool_call_id: call.id,
        content: `Error: could not parse your arguments as JSON (${(e as Error).message}). Retry the call with valid JSON arguments.`,
        ok: false,
      }
    }
  }

  let tool = tools.find((t) => t.name === call.name)
  // AUTO-BRIDGE: models routinely call a DISCOVERED tool directly by its slug
  // ("GOOGLECALENDAR_CREATE_EVENT") instead of wrapping it in execute_tool — a calling-convention
  // mistake that used to fail the whole step (and the old error message taught the wrong fix).
  // Route it transparently: same execution path, same approval/verify semantics (those unwrap
  // execute_tool's tool_name), zero wasted round-trips.
  if (!tool && /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(call.name)) {
    const exec = tools.find((t) => t.name === "execute_tool")
    if (exec) {
      tool = exec
      args = { tool_name: call.name, args }
    }
  }
  if (!tool) {
    return {
      tool_call_id: call.id,
      content: `Error: no tool named "${call.name}". Use search_tools to find the right tool, then invoke it with execute_tool({"tool_name": "<exact name>", "args": {...}}) — discovered tools are run through execute_tool, not called directly.`,
      ok: false,
    }
  }

  try {
    const result = await tool.execute(args)
    const max = opts?.maxChars ?? MAX_CONTENT
    // Distill to a clean observation for the MODEL; keep the raw `result` for the system.
    let content = shapeObservation(call.name, result, { verbosity: opts?.verbosity })
    if (content.length > max) {
      if (opts?.distill && looksLikeProse(result)) {
        // Over-budget PROSE → optional cheap-LLM phrasing, validated (extract-not-invent), cancellable
        // and time-boxed so a slow/hung distill never blocks the turn (critical on the voice path).
        try {
          const distilled = (await withTimeout(opts.distill(content, opts.signal), 2500)).trim()
          content = distilled && distilled.length <= max && distillIsFaithful(distilled, content)
            ? distilled
            : clampMiddle(content, max)
        } catch {
          content = clampMiddle(content, max)
        }
      } else {
        content = clampMiddle(content, max)   // structured data: deterministic truncation only
      }
    }
    return { tool_call_id: call.id, content, ok: true, result }
  } catch (e) {
    const msg = (e as Error).message
    // A guessed/nonexistent tool slug is recoverable — but only if the model is told HOW.
    // Without this nudge it gives up after one failure ("NOTION_GET_PAGE_CONTENT" doesn't
    // exist; NOTION_FETCH_* does — search_tools knows the real names).
    const badSlug = /unable to retrieve tool|tool with slug|no such tool|tool .{0,40}not found/i.test(msg)
    const hint = badSlug
      ? "That tool name does not exist — do NOT guess names. Call search_tools with a plain description of what you need, then retry with the EXACT name it returns."
      : "Try a different approach or tell the user plainly."
    return {
      tool_call_id: call.id,
      content: `Error running ${call.name}: ${msg}. ${hint}`,
      ok: false,
    }
  }
}
