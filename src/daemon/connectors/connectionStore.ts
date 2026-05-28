import type { Database } from 'bun:sqlite'
import type { Connection, ConnectionStatus, ToolkitSlug } from './types'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS composio_connections (
  user_id TEXT NOT NULL,
  toolkit_slug TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  auth_config_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_polled_at INTEGER,
  expired_at INTEGER,
  PRIMARY KEY (user_id, toolkit_slug)
);
CREATE INDEX IF NOT EXISTS idx_composio_conn_status ON composio_connections(status);
`

export class ConnectionStore {
  constructor(private db: Database) { db.exec(SCHEMA) }

  upsert(c: Connection): void {
    this.db.run(
      `INSERT INTO composio_connections (user_id, toolkit_slug, connection_id, auth_config_id, status, created_at, last_polled_at, expired_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, toolkit_slug) DO UPDATE SET
         connection_id = excluded.connection_id,
         auth_config_id = excluded.auth_config_id,
         status = excluded.status,
         created_at = excluded.created_at,
         last_polled_at = excluded.last_polled_at,
         expired_at = excluded.expired_at`,
      [c.user_id, c.toolkit_slug, c.connection_id, c.auth_config_id, c.status, c.created_at,
       c.last_polled_at ?? null, c.expired_at ?? null],
    )
  }

  getByToolkit(userId: string, toolkitSlug: ToolkitSlug): Connection | null {
    const row = this.db.query(
      `SELECT * FROM composio_connections WHERE user_id = ? AND toolkit_slug = ?`,
    ).get(userId, toolkitSlug) as any
    return row ? this.rowToConnection(row) : null
  }

  listByUser(userId: string): Connection[] {
    const rows = this.db.query(
      `SELECT * FROM composio_connections WHERE user_id = ? ORDER BY toolkit_slug`,
    ).all(userId) as any[]
    return rows.map(r => this.rowToConnection(r))
  }

  listActive(userId: string): Connection[] {
    return this.listByUser(userId).filter(c => c.status === 'active')
  }

  markStatus(userId: string, toolkitSlug: ToolkitSlug, status: ConnectionStatus): void {
    const now = Date.now()
    const expiredAt = status === 'expired' || status === 'revoked' ? now : null
    this.db.run(
      `UPDATE composio_connections
       SET status = ?, last_polled_at = ?, expired_at = COALESCE(?, expired_at)
       WHERE user_id = ? AND toolkit_slug = ?`,
      [status, now, expiredAt, userId, toolkitSlug],
    )
  }

  remove(userId: string, toolkitSlug: ToolkitSlug): void {
    this.db.run(`DELETE FROM composio_connections WHERE user_id = ? AND toolkit_slug = ?`, [userId, toolkitSlug])
  }

  private rowToConnection(r: any): Connection {
    return {
      user_id: r.user_id, toolkit_slug: r.toolkit_slug, connection_id: r.connection_id,
      auth_config_id: r.auth_config_id, status: r.status as ConnectionStatus,
      created_at: r.created_at, last_polled_at: r.last_polled_at ?? undefined,
      expired_at: r.expired_at ?? undefined,
    }
  }
}
