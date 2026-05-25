// src/daemon/memory/episodicMemory.ts
// L2 — episodic memory. Each row is one "episode" — a meaningful sequence
// of events grouped together (a work session, a conversation, etc).

import type { Database } from 'bun:sqlite'

export type EpisodeInput = {
  started_at: number
  ended_at: number
  episode_type: string
  title: string
  summary: string
  event_ids: number[]
  importance: number
}

export type Episode = EpisodeInput & {
  id: number
  promoted_l3: number
  created_at: number
}

export class EpisodicMemory {
  constructor(private db: Database) {}

  writeEpisode(e: EpisodeInput): number {
    const info = this.db.run(
      `INSERT INTO mem_l2_episodes
         (started_at, ended_at, episode_type, title, summary, event_ids, importance, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [e.started_at, e.ended_at, e.episode_type, e.title, e.summary,
       JSON.stringify(e.event_ids), e.importance, Date.now()],
    )
    return Number(info.lastInsertRowid)
  }

  recent(limit: number = 20): Episode[] {
    const rows = this.db.query(
      'SELECT * FROM mem_l2_episodes ORDER BY started_at DESC LIMIT ?',
    ).all(limit) as Array<Episode & { event_ids: string }>
    return rows.map(r => ({ ...r, event_ids: JSON.parse(r.event_ids) }))
  }

  byType(type: string, limit: number = 20): Episode[] {
    const rows = this.db.query(
      'SELECT * FROM mem_l2_episodes WHERE episode_type = ? ORDER BY started_at DESC LIMIT ?',
    ).all(type, limit) as Array<Episode & { event_ids: string }>
    return rows.map(r => ({ ...r, event_ids: JSON.parse(r.event_ids) }))
  }

  unpromoted(limit: number = 50): Episode[] {
    const rows = this.db.query(
      `SELECT * FROM mem_l2_episodes
       WHERE promoted_l3 = 0
       ORDER BY importance DESC, started_at DESC
       LIMIT ?`,
    ).all(limit) as Array<Episode & { event_ids: string }>
    return rows.map(r => ({ ...r, event_ids: JSON.parse(r.event_ids) }))
  }

  markPromoted(id: number): void {
    this.db.run('UPDATE mem_l2_episodes SET promoted_l3 = 1 WHERE id = ?', [id])
  }
}
