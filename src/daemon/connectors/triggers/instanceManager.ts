// src/daemon/connectors/triggers/instanceManager.ts
// Refcounted Composio trigger instances. Many rules can share one instance
// (when slug + config + connected account match). Reconciles with Composio
// at boot to clean up orphans.

import { createHash } from 'crypto'
import type { Database } from 'bun:sqlite'
import type { TriggerInstanceRow } from './types'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS trigger_instances (
  trigger_id TEXT PRIMARY KEY,
  trigger_slug TEXT NOT NULL,
  connected_account_id TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  rule_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_trigger_instances_slug_config ON trigger_instances(trigger_slug, config_hash, connected_account_id);

CREATE TABLE IF NOT EXISTS rule_trigger_links (
  rule_slug TEXT NOT NULL,
  trigger_id TEXT NOT NULL,
  PRIMARY KEY (rule_slug, trigger_id),
  FOREIGN KEY (trigger_id) REFERENCES trigger_instances(trigger_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_rule_trigger_links_trigger ON rule_trigger_links(trigger_id);
`

export type TriggerInstanceManagerDeps = {
  db: Database
  composio: {
    triggers: {
      create(slug: string, opts: { user_id?: string; connected_account_id?: string; trigger_config?: Record<string, unknown> }): Promise<{ triggerId: string }>
      list_active(): Promise<{ items: any[] }>
      delete(triggerId: string): Promise<void>
    }
  }
  userId: string
}

export type ReconcileReport = {
  orphaned_local: string[]
  orphaned_remote: string[]
  recreated: string[]
}

export class TriggerInstanceManager {
  constructor(private deps: TriggerInstanceManagerDeps) {
    deps.db.exec(SCHEMA)
  }

  async acquireForRule(rule_slug: string, trigger_slug: string, config: Record<string, unknown>, connected_account_id: string): Promise<string> {
    const config_hash = this.hashConfig(config)
    const existing = this.deps.db.query(
      `SELECT trigger_id FROM trigger_instances WHERE trigger_slug = ? AND config_hash = ? AND connected_account_id = ?`,
    ).get(trigger_slug, config_hash, connected_account_id) as { trigger_id: string } | null

    let trigger_id: string
    if (existing) {
      trigger_id = existing.trigger_id
    } else {
      const result = await this.deps.composio.triggers.create(trigger_slug, {
        user_id: this.deps.userId,
        connected_account_id,
        trigger_config: config,
      })
      trigger_id = result.triggerId
      this.deps.db.run(
        `INSERT INTO trigger_instances (trigger_id, trigger_slug, connected_account_id, config_hash, created_at, rule_count)
         VALUES (?, ?, ?, ?, ?, 0)`,
        [trigger_id, trigger_slug, connected_account_id, config_hash, Date.now()],
      )
    }

    try {
      this.deps.db.run(`INSERT INTO rule_trigger_links (rule_slug, trigger_id) VALUES (?, ?)`, [rule_slug, trigger_id])
      this.deps.db.run(`UPDATE trigger_instances SET rule_count = rule_count + 1 WHERE trigger_id = ?`, [trigger_id])
    } catch (err) {
      if (!String(err).includes('UNIQUE') && !String(err).includes('PRIMARY')) throw err
    }
    return trigger_id
  }

  async releaseForRule(rule_slug: string, trigger_id: string): Promise<void> {
    const r = this.deps.db.run(`DELETE FROM rule_trigger_links WHERE rule_slug = ? AND trigger_id = ?`, [rule_slug, trigger_id])
    if ((r.changes ?? 0) > 0) {
      this.deps.db.run(`UPDATE trigger_instances SET rule_count = rule_count - 1 WHERE trigger_id = ?`, [trigger_id])
      const row = this.deps.db.query(`SELECT rule_count FROM trigger_instances WHERE trigger_id = ?`).get(trigger_id) as { rule_count: number } | null
      if (row && row.rule_count <= 0) {
        try { await this.deps.composio.triggers.delete(trigger_id) } catch { /* swallow */ }
        this.deps.db.run(`DELETE FROM trigger_instances WHERE trigger_id = ?`, [trigger_id])
      }
    }
  }

  async reconcile(): Promise<ReconcileReport> {
    const local = this.listInstances().map(r => r.trigger_id)
    let remoteList: any[] = []
    try {
      const { items } = await this.deps.composio.triggers.list_active()
      remoteList = items
    } catch { return { orphaned_local: [], orphaned_remote: [], recreated: [] } }

    const remote = new Set(remoteList.map(r => r.triggerId ?? r.trigger_id))
    const localSet = new Set(local)

    const orphaned_local = local.filter(id => !remote.has(id))
    const orphaned_remote = Array.from(remote).filter(id => !localSet.has(id))

    for (const id of orphaned_remote) {
      try { await this.deps.composio.triggers.delete(id as string) } catch { /* swallow */ }
    }

    for (const id of orphaned_local) {
      this.deps.db.run(`DELETE FROM trigger_instances WHERE trigger_id = ?`, [id])
    }

    return { orphaned_local, orphaned_remote: orphaned_remote as string[], recreated: [] }
  }

  listInstances(): TriggerInstanceRow[] {
    return this.deps.db.query(`SELECT * FROM trigger_instances ORDER BY created_at`).all() as TriggerInstanceRow[]
  }

  listRulesForInstance(trigger_id: string): string[] {
    const rows = this.deps.db.query(`SELECT rule_slug FROM rule_trigger_links WHERE trigger_id = ?`).all(trigger_id) as Array<{ rule_slug: string }>
    return rows.map(r => r.rule_slug)
  }

  private hashConfig(config: Record<string, unknown>): string {
    const keys = Object.keys(config).sort()
    const stable = keys.map(k => [k, config[k]])
    return createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 16)
  }
}
