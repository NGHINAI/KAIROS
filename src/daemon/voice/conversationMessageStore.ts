// src/daemon/voice/conversationMessageStore.ts
//
// Durable, append-only conversation transcript — the "remember everything" backbone.
// Where conversationStore keeps only the spoken {role,text}, THIS store keeps the FULL
// LoopMsg array per turn: user messages, assistant tool_calls, AND tool results (with
// their ids — e.g. a gmail threadId). That is the structured handle a later turn needs
// to "reply to that same email" instead of re-asking the user.
//
// This is the event-log-as-truth pattern every serious agent uses (Claude Code JSONL,
// Codex rollouts, OpenHands EventLog): persist everything durably; feed the model a
// bounded, tool-pair-safe VIEW of it (loadForReplay). Persistence is a single INSERT
// off the hot path, so it never blocks the voice loop.

import type { Database } from "bun:sqlite"
import type { LoopMsg, ToolCallWire } from "../agents/loop/types"

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversation_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT,
  tool_calls TEXT,          -- JSON ToolCallWire[] for an assistant tool-call message
  tool_call_id TEXT,        -- for a tool result message
  tool_name TEXT,           -- convenience (first tool name / result's tool)
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conv_msgs ON conversation_messages(conversation_id, id);
CREATE TABLE IF NOT EXISTS conversation_summaries (
  conversation_id TEXT PRIMARY KEY,
  summary TEXT NOT NULL,
  covered_turns INTEGER NOT NULL,   -- how many of the OLDEST turns this summary already folds in
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS conversation_turn_digests (
  conversation_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  digest TEXT NOT NULL,             -- one deterministic line: ask → reply → tools/handles
  at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, turn_id)
);
`

export interface ReplayOpts {
  /** Keep only the most recent N WHOLE turns. Default 8. */
  maxTurns?: number
  /** Drop oldest WHOLE turns until total content is under this many chars. Default 12000. */
  maxChars?: number
  /** Tool results in turns OLDER than the most recent N keep only their HANDLES (ids/urls/
   *  status) — the bulky body is masked. Old raw results are mostly noise that degrades the
   *  model's attention (observation masking ≈ same quality, ~half the tokens), but the ids
   *  must survive — they're what "reply to that same email" chains on. Default 2. */
  keepRawTurns?: number
}

const DEFAULT_MAX_TURNS = Number(process.env.KAIROS_REPLAY_MAX_TURNS) || 8
const DEFAULT_MAX_CHARS = Number(process.env.KAIROS_REPLAY_MAX_CHARS) || 12000
const DEFAULT_KEEP_RAW_TURNS = Number(process.env.KAIROS_REPLAY_KEEP_RAW_TURNS ?? 2)
// L1 layer: how many RECENT-BUT-OLDER turns keep a per-turn one-line digest before
// dissolving into the L2 rolling summary. The layered pyramid is:
//   L0 raw turns (8) → L1 one-line digests (24) → L2 one rolling summary (everything older)
const DEFAULT_L1_TURNS = Number(process.env.KAIROS_HISTORY_L1_TURNS ?? 24)
const L1_BLOCK_MAX_CHARS = 3000   // the whole injected digest block stays bounded
const MASK_MIN_CHARS = 220   // results smaller than this aren't worth masking

// Key/value pairs whose KEY looks like a stable handle (id / url / key / number / handle).
const HANDLE_PAIR_RE = /"([A-Za-z0-9_]*(?:id|Id|ID|url|Url|link|Link|key|Key|number|handle|Handle)[A-Za-z0-9_]*)"\s*:\s*"([^"]{1,160})"/g

/** Compress an old tool result to its actionable essence: handles + success flag. */
export function maskToolResult(content: string): string {
  if (content.length < MASK_MIN_CHARS) return content
  const handles: string[] = []
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  HANDLE_PAIR_RE.lastIndex = 0
  while ((m = HANDLE_PAIR_RE.exec(content)) !== null && handles.length < 8) {
    const pair = `${m[1]}=${m[2]}`
    if (!seen.has(pair)) { seen.add(pair); handles.push(pair) }
  }
  const ok = /"successful"\s*:\s*true|"success"\s*:\s*true/.test(content) ? " | ok" :
             /"successful"\s*:\s*false|"error"\s*:/.test(content) ? " | FAILED" : ""
  const head = content.slice(0, 120).replace(/\s+/g, " ")
  return `[older result, body elided] ${head}…${ok}${handles.length ? `\nhandles: ${handles.join(", ")}` : ""}`
}

type Row = {
  turn_id: string
  role: string
  content: string | null
  tool_calls: string | null
  tool_call_id: string | null
  at: number
}

function clipLine(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim()
  return t.length > n ? t.slice(0, n - 1) + "…" : t
}

/** Deterministic one-line digest of a whole turn — what the user asked, what KAIROS
 *  answered, which tool did it, and the handles it produced. NO LLM: free, instant,
 *  and incapable of inventing an id. This is the L1 layer of the history pyramid —
 *  per-turn distinctions survive long after the raw turn scrolls out of the window
 *  ("what did I ask you twenty minutes ago?" stays answerable). */
export function buildTurnDigest(rows: Row[]): string {
  const user = rows.find((r) => r.role === "user")?.content ?? ""
  const reply = [...rows].reverse().find((r) => r.role === "assistant" && r.content)?.content ?? ""

  // Effective tool names (execute_tool unwrapped to the real action).
  const toolNames: string[] = []
  for (const r of rows) {
    if (r.role !== "assistant" || !r.tool_calls) continue
    for (const c of safeParse(r.tool_calls) ?? []) {
      let name = c?.function?.name ?? ""
      if (name === "execute_tool") {
        const args = safeParse(c?.function?.arguments ?? "")
        name = args?.tool_name ?? name
      }
      if (name && name !== "update_plan" && !toolNames.includes(name)) toolNames.push(name)
    }
  }

  // Handles from the turn's tool results — the ids a later turn might chain on.
  const handles: string[] = []
  const seen = new Set<string>()
  for (const r of rows) {
    if (r.role !== "tool" || !r.content) continue
    HANDLE_PAIR_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = HANDLE_PAIR_RE.exec(r.content)) !== null && handles.length < 3) {
      const pair = `${m[1]}=${m[2]}`
      if (!seen.has(pair)) { seen.add(pair); handles.push(pair) }
    }
  }

  let line = `user: "${clipLine(user, 90)}"`
  if (reply) line += ` → KAIROS: "${clipLine(reply, 110)}"`
  const via = toolNames.slice(0, 3).map((n) => n.replace(/_/g, " ").toLowerCase()).join(", ")
  const extras = [via ? `via ${via}` : "", handles.join(", ")].filter(Boolean).join("; ")
  if (extras) line += ` (${extras})`
  return line.slice(0, 320)
}

export class ConversationMessageStore {
  constructor(private db: Database) {
    db.exec(SCHEMA)
  }

  /** Persist a whole turn's messages (system messages are skipped — the next turn
   *  rebuilds its own system prefix fresh). Best-effort, never throws to the caller. */
  async appendTurn(conversationId: string, turnId: string, msgs: LoopMsg[]): Promise<void> {
    const insert = this.db.prepare(
      `INSERT INTO conversation_messages
       (conversation_id, turn_id, role, content, tool_calls, tool_call_id, tool_name, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const now = Date.now()
    for (const m of msgs) {
      if (m.role === "system") continue
      const content = (m as any).content ?? null
      const toolCalls = m.role === "assistant" && (m as any).tool_calls
        ? JSON.stringify((m as any).tool_calls)
        : null
      const toolCallId = m.role === "tool" ? (m as any).tool_call_id : null
      const toolName =
        m.role === "assistant" && (m as any).tool_calls?.length
          ? (m as any).tool_calls[0]?.function?.name ?? null
          : null
      insert.run(conversationId, turnId, m.role, content, toolCalls, toolCallId, toolName, now)
    }
  }

  /** Reconstruct a bounded, tool-pair-safe VIEW of the conversation as real LoopMsgs,
   *  for seeding the next turn's loop as [system, …replay, user]. Loads whole turns
   *  (so tool_call/tool_result pairs never split), keeps the most recent maxTurns,
   *  then drops oldest whole turns until under maxChars. */
  async loadForReplay(conversationId: string, opts: ReplayOpts = {}): Promise<LoopMsg[]> {
    const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS
    const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS

    const rows = this.db
      .query(
        `SELECT turn_id, role, content, tool_calls, tool_call_id, at
         FROM conversation_messages WHERE conversation_id = ? ORDER BY id ASC`,
      )
      .all(conversationId) as Row[]
    if (rows.length === 0) return []

    // Group rows into turns, preserving order.
    const turnOrder: string[] = []
    const byTurn = new Map<string, Row[]>()
    for (const r of rows) {
      if (!byTurn.has(r.turn_id)) { byTurn.set(r.turn_id, []); turnOrder.push(r.turn_id) }
      byTurn.get(r.turn_id)!.push(r)
    }

    // Keep the most recent maxTurns whole turns.
    let keptTurns = turnOrder.slice(-maxTurns)

    // Char budget: drop OLDEST whole turns until under maxChars.
    const turnChars = (tid: string) =>
      byTurn.get(tid)!.reduce((n, r) => n + (r.content?.length ?? 0) + (r.tool_calls?.length ?? 0), 0)
    let total = keptTurns.reduce((n, tid) => n + turnChars(tid), 0)
    while (keptTurns.length > 1 && total > maxChars) {
      total -= turnChars(keptTurns[0]!)
      keptTurns = keptTurns.slice(1)
    }

    // Observation masking: in turns older than the most recent keepRawTurns, tool results
    // keep only their handles (ids/urls/status) — old bodies are attention noise.
    const keepRaw = Math.max(0, opts.keepRawTurns ?? DEFAULT_KEEP_RAW_TURNS)
    const rawSet = new Set(keptTurns.slice(keptTurns.length - keepRaw))

    const out: LoopMsg[] = []
    for (const tid of keptTurns) {
      for (const r of byTurn.get(tid)!) {
        const msg = rowToMsg(r)
        if (!rawSet.has(tid) && (msg as any).role === "tool" && typeof (msg as any).content === "string") {
          ;(msg as any).content = maskToolResult((msg as any).content)
        }
        out.push(msg)
      }
    }
    const view = pairSafe(out)

    // L1 — per-turn digests for turns that aged out of the raw window but haven't
    // dissolved into the rolling summary yet (one line each, oldest first). This is
    // the middle of the pyramid: turn-level distinctions + handles, a fraction of
    // the tokens of raw turns.
    const keptSet = new Set(keptTurns)
    const digestRows = this.db
      .query(`SELECT turn_id, digest FROM conversation_turn_digests WHERE conversation_id = ? ORDER BY rowid ASC`)
      .all(conversationId) as Array<{ turn_id: string; digest: string }>
    const digestLines = digestRows.filter((d) => !keptSet.has(d.turn_id)).map((d) => `- ${d.digest}`)
    if (digestLines.length > 0) {
      const block = digestLines.join("\n").slice(0, L1_BLOCK_MAX_CHARS)
      view.unshift({ role: "system", content: `Earlier turns in this conversation (one line each, oldest first):\n${block}` })
    }

    // L2 — the rolling summary of everything older still. Unshifted LAST so the final
    // order reads oldest-context-first: [summary, digests, …recent raw messages].
    const summary = this.getSummary(conversationId)
    if (summary) view.unshift({ role: "system", content: `Earlier in this conversation (summary of older turns):\n${summary}` })
    return view
  }

  private getSummary(conversationId: string): string | null {
    const row = this.db
      .query(`SELECT summary FROM conversation_summaries WHERE conversation_id = ?`)
      .get(conversationId) as { summary: string } | null
    return row?.summary ?? null
  }

  private turnIdsInOrder(conversationId: string): string[] {
    const rows = this.db
      .query(`SELECT turn_id, MIN(id) AS first_id FROM conversation_messages WHERE conversation_id = ? GROUP BY turn_id ORDER BY first_id ASC`)
      .all(conversationId) as Array<{ turn_id: string }>
    return rows.map(r => r.turn_id)
  }

  /** Off-the-hot-path history compaction — maintains the LAYERED pyramid:
   *    L0: the most recent `keepRecent` turns stay raw (loadForReplay's window).
   *    L1: turns aged out of L0 get a deterministic ONE-LINE digest each (no LLM),
   *        kept for the most recent `l1Turns` aged-out turns.
   *    L2: turns older than L0+L1 fold into the single rolling summary (cheap-model),
   *        and their digests are deleted — each fact lives in exactly one layer.
   *  INCREMENTAL — only newly-aged-out turns are processed, with the existing summary
   *  carried forward, so cost stays bounded as the conversation grows. */
  async updateRollingSummary(
    conversationId: string,
    summarize: (text: string) => Promise<string>,
    opts: { keepRecent?: number; l1Turns?: number } = {},
  ): Promise<void> {
    const keepRecent = opts.keepRecent ?? DEFAULT_MAX_TURNS
    const l1Turns = Math.max(0, opts.l1Turns ?? DEFAULT_L1_TURNS)
    const turnIds = this.turnIdsInOrder(conversationId)
    const l0Boundary = turnIds.length - keepRecent       // turns [0, l0Boundary) are out of the raw window
    if (l0Boundary <= 0) return                          // nothing older than the window yet

    const rows = this.db
      .query(`SELECT turn_id, role, content, tool_calls, tool_call_id, at FROM conversation_messages WHERE conversation_id = ? ORDER BY id ASC`)
      .all(conversationId) as Row[]
    const byTurn = new Map<string, Row[]>()
    for (const r of rows) {
      if (!byTurn.has(r.turn_id)) byTurn.set(r.turn_id, [])
      byTurn.get(r.turn_id)!.push(r)
    }

    // ── L1: digest aged-out turns that don't have one yet (bounded per call). ──
    if (l1Turns > 0) {
      const l1Zone = turnIds.slice(Math.max(0, l0Boundary - l1Turns), l0Boundary)
      const have = new Set(
        (this.db.query(`SELECT turn_id FROM conversation_turn_digests WHERE conversation_id = ?`).all(conversationId) as Array<{ turn_id: string }>)
          .map((r) => r.turn_id),
      )
      const ins = this.db.prepare(
        `INSERT OR IGNORE INTO conversation_turn_digests (conversation_id, turn_id, digest, at) VALUES (?, ?, ?, ?)`,
      )
      let made = 0
      for (const tid of l1Zone) {
        if (have.has(tid) || made >= 20) continue        // cap per invocation; the next call catches up
        const turnRows = byTurn.get(tid)
        if (!turnRows?.length) continue
        ins.run(conversationId, tid, buildTurnDigest(turnRows), turnRows[0]!.at)
        made++
      }
    }

    // ── L2: fold turns older than L0+L1 into the rolling summary. ──
    const summaryBoundary = l0Boundary - l1Turns         // turns [0, summaryBoundary) belong in the summary
    if (summaryBoundary <= 0) return

    const existing = this.db
      .query(`SELECT summary, covered_turns FROM conversation_summaries WHERE conversation_id = ?`)
      .get(conversationId) as { summary: string; covered_turns: number } | null
    const covered = existing?.covered_turns ?? 0
    if (summaryBoundary <= covered) return               // already summarized up to the boundary

    // Render only the NEWLY-aged-out turns [covered, summaryBoundary).
    const foldList = turnIds.slice(covered, summaryBoundary)
    const foldTurnIds = new Set(foldList)
    const foldText = rows
      .filter(r => foldTurnIds.has(r.turn_id))
      .map(r => `${r.role}: ${r.content ?? (r.tool_calls ? "[called tools]" : "")}`)
      .join("\n")
      .slice(0, 8000)

    const input = existing?.summary
      ? `Existing summary of the conversation so far:\n${existing.summary}\n\nNewer earlier turns to fold in:\n${foldText}`
      : foldText
    let summary: string
    try { summary = (await summarize(input)).trim() } catch { return }  // best-effort
    if (!summary) return

    this.db.run(
      `INSERT INTO conversation_summaries (conversation_id, summary, covered_turns, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET summary = excluded.summary, covered_turns = excluded.covered_turns, updated_at = excluded.updated_at`,
      [conversationId, summary, summaryBoundary, Date.now()],
    )

    // A fact lives in exactly one layer: digests for folded turns are now redundant.
    const del = this.db.prepare(`DELETE FROM conversation_turn_digests WHERE conversation_id = ? AND turn_id = ?`)
    for (const tid of foldList) del.run(conversationId, tid)
  }
}

function rowToMsg(r: Row): LoopMsg {
  if (r.role === "tool") return { role: "tool", tool_call_id: r.tool_call_id ?? "", content: r.content ?? "" }
  if (r.role === "assistant") {
    const tool_calls: ToolCallWire[] | undefined = r.tool_calls ? safeParse(r.tool_calls) : undefined
    return tool_calls?.length
      ? { role: "assistant", ...(r.content ? { content: r.content } : {}), tool_calls }
      : { role: "assistant", content: r.content ?? "" }
  }
  return { role: "user", content: r.content ?? "" }
}

/** Drop any tool result whose assistant tool_call isn't present, and any assistant
 *  tool_call message whose results aren't all present — an orphaned tool_call_id
 *  makes chat-completions providers 400. (Loading whole turns already keeps pairs
 *  intact; this is a belt-and-suspenders guard against malformed rows.) */
function pairSafe(msgs: LoopMsg[]): LoopMsg[] {
  const resultIds = new Set(msgs.filter(m => m.role === "tool").map(m => (m as any).tool_call_id))
  const keptCallIds = new Set<string>()
  const out: LoopMsg[] = []
  for (const m of msgs) {
    if (m.role === "assistant" && (m as any).tool_calls?.length) {
      const ids: string[] = (m as any).tool_calls.map((c: ToolCallWire) => c.id)
      if (!ids.every(id => resultIds.has(id))) {
        // Drop the orphaned call message; keep its content as a plain assistant note if any.
        if ((m as any).content) out.push({ role: "assistant", content: (m as any).content })
        continue
      }
      ids.forEach(id => keptCallIds.add(id))
    }
    out.push(m)
  }
  // Remove tool results whose call message was dropped.
  return out.filter(m => m.role !== "tool" || keptCallIds.has((m as any).tool_call_id))
}

function safeParse(s: string): any { try { return JSON.parse(s) } catch { return undefined } }
