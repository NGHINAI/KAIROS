// src/daemon/skills/reviewQueue.ts
import type { Database } from 'bun:sqlite'
import type { SkillFile, PersonaGateVerdict } from './types'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS skill_review_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  enqueued_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  skill_json TEXT NOT NULL,
  verdict_json TEXT NOT NULL,
  rejected_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_review_queue_status ON skill_review_queue(status);
`

export type ReviewQueueRow = {
  id: number
  enqueued_at: number
  status: 'pending' | 'approved' | 'rejected'
  skill: SkillFile
  verdict: PersonaGateVerdict
  rejected_reason?: string
}

export class ReviewQueue {
  constructor(private db: Database) {
    db.exec(SCHEMA)
  }

  enqueue(skill: SkillFile, verdict: PersonaGateVerdict): number {
    const r = this.db.run(
      `INSERT INTO skill_review_queue (enqueued_at, status, skill_json, verdict_json) VALUES (?, ?, ?, ?)`,
      [Date.now(), 'pending', JSON.stringify(skill), JSON.stringify(verdict)],
    )
    return Number(r.lastInsertRowid)
  }

  listPending(): ReviewQueueRow[] {
    const rows = this.db.query(`SELECT * FROM skill_review_queue WHERE status = 'pending' ORDER BY enqueued_at`).all() as any[]
    return rows.map(r => this.rowFromDb(r))
  }

  get(id: number): ReviewQueueRow | null {
    const r = this.db.query(`SELECT * FROM skill_review_queue WHERE id = ?`).get(id) as any
    return r ? this.rowFromDb(r) : null
  }

  /** Mark as approved. Caller is responsible for actually writing to disk via SkillWriter. */
  approve(id: number): ReviewQueueRow | null {
    this.db.run(`UPDATE skill_review_queue SET status = 'approved' WHERE id = ?`, [id])
    return this.get(id)
  }

  reject(id: number, reason: string): ReviewQueueRow | null {
    this.db.run(`UPDATE skill_review_queue SET status = 'rejected', rejected_reason = ? WHERE id = ?`, [reason, id])
    return this.get(id)
  }

  private rowFromDb(r: any): ReviewQueueRow {
    return {
      id: r.id,
      enqueued_at: r.enqueued_at,
      status: r.status,
      skill: JSON.parse(r.skill_json),
      verdict: JSON.parse(r.verdict_json),
      rejected_reason: r.rejected_reason ?? undefined,
    }
  }
}
