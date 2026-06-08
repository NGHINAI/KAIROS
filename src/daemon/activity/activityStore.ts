// src/daemon/activity/activityStore.ts
//
// The unified, durable, time-queryable record of WHAT KAIROS DID — the backbone of
// "what did you do yesterday?". First-class events (foreground actions + background
// sub-agent runs) are WRITTEN here by ActivityRecorder; the existing autonomous SQLite
// tables (ticks/tasks/messages/schedules) are UNIONED at QUERY time (already durable +
// timestamped, so no double-write). One time-indexed shape feeds the voice tool + HUD.
//
// Buckets by the user's local day (KAIROS_TZ via util/timeRange) so "yesterday" is the
// user's yesterday, not the UTC day. Titles are secret-sanitized. Best-effort + never
// throws to a caller; missing/lazy autonomous tables are caught per-table.

import type { Database } from "bun:sqlite"
import { dayKey, type ResolvedRange } from "../util/timeRange"
import { redactSecrets } from "../util/redact"

const SCHEMA = `
CREATE TABLE IF NOT EXISTS activity_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  lane TEXT NOT NULL,
  conversation_id TEXT,
  run_id TEXT,
  title TEXT NOT NULL,
  detail TEXT,
  tool TEXT,
  status TEXT,
  ref_json TEXT,
  importance REAL NOT NULL DEFAULT 0.5
);
CREATE INDEX IF NOT EXISTS idx_activity_day ON activity_events(day, at);
CREATE INDEX IF NOT EXISTS idx_activity_at ON activity_events(at);
`

export type ActivityLane = "foreground" | "background" | "proactive"

export interface ActivityRecordInput {
  at: number
  kind: string
  lane: ActivityLane
  title: string
  detail?: string
  tool?: string
  status?: string
  importance?: number
  conversationId?: string
  runId?: string
  ref?: Record<string, unknown>
}

export interface ActivityItem {
  at: number
  day: string
  kind: string
  lane: ActivityLane
  title: string
  detail?: string
  tool?: string
  status: string
  importance: number
  ref?: Record<string, unknown>
}

export interface QueryOpts {
  kinds?: string[]
  lanes?: ActivityLane[]
  minImportance?: number
  limit?: number
  includeAutonomous?: boolean // default true
}

export class ActivityStore {
  private tz?: string
  constructor(private db: Database, opts: { tz?: string } = {}) {
    this.tz = opts.tz ?? process.env.KAIROS_TZ?.trim()
    db.exec(SCHEMA)
  }

  /** Persist one activity event. Never throws (recording must not break a turn). */
  record(ev: ActivityRecordInput): void {
    try {
      this.db.run(
        `INSERT INTO activity_events (at, day, kind, lane, conversation_id, run_id, title, detail, tool, status, ref_json, importance)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          ev.at,
          dayKey(ev.at, this.tz),
          ev.kind,
          ev.lane,
          ev.conversationId ?? null,
          ev.runId ?? null,
          redactSecrets(ev.title).slice(0, 400),
          ev.detail ? redactSecrets(ev.detail).slice(0, 1200) : null,
          ev.tool ?? null,
          ev.status ?? "done",
          ev.ref ? JSON.stringify(ev.ref).slice(0, 600) : null,
          ev.importance ?? 0.5,
        ],
      )
    } catch { /* best-effort */ }
  }

  /** Unified, chronological activity for a range — first-class events + autonomous union. */
  query(range: ResolvedRange, opts: QueryOpts = {}): ActivityItem[] {
    const out: ActivityItem[] = []

    // First-class events (filter by the day-key STRING — tz-correct, no boundary math).
    try {
      const rows = this.db
        .query(`SELECT * FROM activity_events WHERE day >= ? AND day <= ? ORDER BY at ASC`)
        .all(range.fromDay, range.toDay) as any[]
      for (const r of rows) {
        out.push({
          at: r.at, day: r.day, kind: r.kind, lane: r.lane, title: r.title,
          detail: r.detail ?? undefined, tool: r.tool ?? undefined,
          status: r.status ?? "done", importance: r.importance ?? 0.5,
          ref: r.ref_json ? safeParse(r.ref_json) : undefined,
        })
      }
    } catch { /* table should always exist; defensive */ }

    // Autonomous union (best-effort, per-table try/catch — tables may be lazy/missing).
    if (opts.includeAutonomous !== false) out.push(...this.autonomous(range))

    let items = out.sort((a, b) => a.at - b.at)
    if (opts.minImportance != null) items = items.filter(i => i.importance >= opts.minImportance!)
    if (opts.kinds) items = items.filter(i => opts.kinds!.includes(i.kind))
    if (opts.lanes) items = items.filter(i => opts.lanes!.includes(i.lane))
    if (opts.limit && items.length > opts.limit) items = items.slice(-opts.limit)
    return items
  }

  private autonomous(range: ResolvedRange): ActivityItem[] {
    const items: ActivityItem[] = []
    const { from, to } = range
    const push = (at: number, kind: string, title: string, status = "info", detail?: string, importance = 0.55) => {
      if (!title) return
      items.push({ at, day: dayKey(at, this.tz), kind, lane: "proactive", title: redactSecrets(title).slice(0, 400), detail: detail ? redactSecrets(detail).slice(0, 1200) : undefined, status, importance })
    }
    // Proactive tick decisions (skip the no-op "sleep"/"noop" wake-ups).
    try {
      const rows = this.db.query(`SELECT fired_at, decision, reasoning FROM ticks WHERE fired_at >= ? AND fired_at < ? AND decision NOT IN ('sleep','noop','none','')`).all(from, to) as any[]
      for (const r of rows) push(r.fired_at, "tick", `Decided to ${String(r.decision).replace(/_/g, " ")}`, "info", r.reasoning ?? undefined)
    } catch { /* no ticks table */ }
    // Completed autonomous tasks.
    try {
      const rows = this.db.query(`SELECT completed_at, description, result_summary, status FROM tasks WHERE completed_at IS NOT NULL AND completed_at >= ? AND completed_at < ?`).all(from, to) as any[]
      for (const r of rows) push(r.completed_at, "task", r.description ?? "Ran a task", r.status === "failed" ? "failed" : "done", r.result_summary ?? undefined, 0.7)
    } catch { /* no tasks table */ }
    // Outbound proactive messages.
    try {
      const rows = this.db.query(`SELECT created_at, kind, body FROM messages WHERE created_at >= ? AND created_at < ?`).all(from, to) as any[]
      for (const r of rows) push(r.created_at, "message", r.body ?? `Sent a ${r.kind ?? "message"}`, "info", undefined, 0.6)
    } catch { /* no messages table */ }
    // Schedules that fired (best-effort: only the last fire is recorded upstream).
    try {
      const rows = this.db.query(`SELECT last_fired_at, description FROM schedules WHERE last_fired_at IS NOT NULL AND last_fired_at >= ? AND last_fired_at < ?`).all(from, to) as any[]
      for (const r of rows) push(r.last_fired_at, "schedule_fired", `Scheduled: ${r.description ?? "task"} fired`, "done", undefined, 0.65)
    } catch { /* no schedules table */ }
    return items
  }

  /** A compact, spoken-friendly + HUD-header rollup of a result set. */
  digest(items: ActivityItem[]): string {
    if (items.length === 0) return "nothing"
    const n = items.length
    const byLane = { foreground: 0, background: 0, proactive: 0 } as Record<ActivityLane, number>
    let failed = 0
    for (const i of items) { byLane[i.lane] = (byLane[i.lane] ?? 0) + 1; if (i.status === "failed") failed++ }
    const parts: string[] = [`${n} thing${n === 1 ? "" : "s"}`]
    if (byLane.foreground) parts.push(`${byLane.foreground} you did directly`)
    if (byLane.background) parts.push(`${byLane.background} background task${byLane.background === 1 ? "" : "s"}`)
    if (byLane.proactive) parts.push(`${byLane.proactive} proactive`)
    if (failed) parts.push(`${failed} didn't complete`)
    return parts.join(" · ")
  }

  /** Retention: drop events older than the cutoff. Returns the count removed. */
  prune(beforeMs: number): number {
    try {
      const before = (this.db.query(`SELECT COUNT(*) AS c FROM activity_events WHERE at < ?`).get(beforeMs) as any).c as number
      this.db.run(`DELETE FROM activity_events WHERE at < ?`, [beforeMs])
      return before
    } catch { return 0 }
  }
}

function safeParse(s: string): any { try { return JSON.parse(s) } catch { return undefined } }
