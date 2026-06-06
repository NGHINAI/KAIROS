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
`

export interface ReplayOpts {
  /** Keep only the most recent N WHOLE turns. Default 8. */
  maxTurns?: number
  /** Drop oldest WHOLE turns until total content is under this many chars. Default 12000. */
  maxChars?: number
}

const DEFAULT_MAX_TURNS = Number(process.env.KAIROS_REPLAY_MAX_TURNS) || 8
const DEFAULT_MAX_CHARS = Number(process.env.KAIROS_REPLAY_MAX_CHARS) || 12000

type Row = {
  turn_id: string
  role: string
  content: string | null
  tool_calls: string | null
  tool_call_id: string | null
  at: number
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

    const out: LoopMsg[] = []
    for (const tid of keptTurns) {
      for (const r of byTurn.get(tid)!) out.push(rowToMsg(r))
    }
    const view = pairSafe(out)

    // Prepend the rolling summary of OLDER turns (those that fell out of the recent
    // window) so the conversation is remembered in full: recent verbatim + older
    // summarized. Injected as a system message ahead of the recent messages.
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

  /** Off-the-hot-path: fold turns that have aged out of the recent `keepRecent`
   *  window into the rolling summary. INCREMENTAL — only turns not already covered are
   *  summarized, with the existing summary carried forward, so cost stays bounded as
   *  the conversation grows. `summarize` is the caller's cheap-model digest fn. */
  async updateRollingSummary(
    conversationId: string,
    summarize: (text: string) => Promise<string>,
    opts: { keepRecent?: number } = {},
  ): Promise<void> {
    const keepRecent = opts.keepRecent ?? DEFAULT_MAX_TURNS
    const turnIds = this.turnIdsInOrder(conversationId)
    const summaryBoundary = turnIds.length - keepRecent  // turns [0, summaryBoundary) belong in the summary
    if (summaryBoundary <= 0) return                     // nothing older than the window yet

    const existing = this.db
      .query(`SELECT summary, covered_turns FROM conversation_summaries WHERE conversation_id = ?`)
      .get(conversationId) as { summary: string; covered_turns: number } | null
    const covered = existing?.covered_turns ?? 0
    if (summaryBoundary <= covered) return               // already summarized up to the boundary

    // Render only the NEWLY-aged-out turns [covered, summaryBoundary).
    const foldTurnIds = new Set(turnIds.slice(covered, summaryBoundary))
    const rows = this.db
      .query(`SELECT turn_id, role, content, tool_calls, tool_call_id, at FROM conversation_messages WHERE conversation_id = ? ORDER BY id ASC`)
      .all(conversationId) as Row[]
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
