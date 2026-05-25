// src/daemon/proactive/eventBus.ts
// SQLite-backed pub/sub bus. Observers publish, aggregators subscribe.
// Persistence lets us survive restarts and query history for the narrator.

import type { Database } from 'bun:sqlite'
import { log, logError } from '../logger'

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS world_state_events (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        INTEGER NOT NULL,
    source    TEXT    NOT NULL,
    kind      TEXT    NOT NULL,
    payload   TEXT    NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_wse_ts ON world_state_events(ts);
  CREATE INDEX IF NOT EXISTS idx_wse_source_ts ON world_state_events(source, ts);
`

export type WorldEventInput = {
  source: string
  kind: string
  payload: Record<string, unknown>
}

export type WorldEvent = WorldEventInput & {
  id: number
  ts: number
}

export type Subscriber = (e: WorldEvent) => void | Promise<void>

export class EventBus {
  private subs: Map<string, Subscriber[]> = new Map()

  constructor(private db: Database) {
    db.exec(SCHEMA)
  }

  publish(input: WorldEventInput): WorldEvent {
    const ts = Date.now()
    const info = this.db.run(
      'INSERT INTO world_state_events (ts, source, kind, payload) VALUES (?, ?, ?, ?)',
      [ts, input.source, input.kind, JSON.stringify(input.payload)],
    )
    const event: WorldEvent = { ...input, ts, id: Number(info.lastInsertRowid) }
    this.dispatch(event)
    return event
  }

  subscribe(source: string, handler: Subscriber): () => void {
    const list = this.subs.get(source) ?? []
    list.push(handler)
    this.subs.set(source, list)
    return () => {
      const cur = this.subs.get(source) ?? []
      this.subs.set(source, cur.filter(h => h !== handler))
    }
  }

  recent(limit: number = 50): WorldEvent[] {
    const rows = this.db
      .query('SELECT id, ts, source, kind, payload FROM world_state_events ORDER BY id DESC LIMIT ?')
      .all(limit) as Array<{ id: number; ts: number; source: string; kind: string; payload: string }>
    return rows.map(r => ({ ...r, payload: JSON.parse(r.payload) }))
  }

  since(tsMs: number): WorldEvent[] {
    const rows = this.db
      .query('SELECT id, ts, source, kind, payload FROM world_state_events WHERE ts > ? ORDER BY id ASC')
      .all(tsMs) as Array<{ id: number; ts: number; source: string; kind: string; payload: string }>
    return rows.map(r => ({ ...r, payload: JSON.parse(r.payload) }))
  }

  private dispatch(e: WorldEvent): void {
    const targeted = this.subs.get(e.source) ?? []
    const wildcard = this.subs.get('*') ?? []
    for (const h of [...targeted, ...wildcard]) {
      try {
        const r = h(e)
        if (r instanceof Promise) r.catch(err => logError(`subscriber error for ${e.source}`, err))
      } catch (err) {
        logError(`subscriber error for ${e.source}`, err)
      }
    }
  }
}
