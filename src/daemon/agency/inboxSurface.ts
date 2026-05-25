// ~/.kairos/inbox.md — tail-able markdown showing pending approvals.
// DB is source of truth; file regenerates after every change.
// Items sorted by tier severity (RED first), then created_at desc.

import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { randomUUID } from 'crypto'
import type { Database } from 'bun:sqlite'
import type { AutonomyTier, InboxItem } from './types'
import { tierEmoji, tierRank } from './autonomyTier'

export const INBOX_SCHEMA = `
  CREATE TABLE IF NOT EXISTS agency_inbox_items (
    item_id        TEXT PRIMARY KEY,
    created_at     INTEGER NOT NULL,
    tier           TEXT NOT NULL,
    intent_id      TEXT NOT NULL,
    description    TEXT NOT NULL,
    args_preview   TEXT NOT NULL,
    expires_at     INTEGER,
    resolved_at    INTEGER,
    resolution     TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_inbox_pending ON agency_inbox_items(resolved_at, tier);
`

export type AddInboxInput = {
  tier: AutonomyTier
  intent_id: string
  description: string
  args_preview: string
  expires_at?: number
}

export class InboxSurface {
  constructor(private db: Database, private filePath: string) {
    db.exec(INBOX_SCHEMA)
  }

  add(input: AddInboxInput): string {
    const id = randomUUID()
    this.db.run(
      `INSERT INTO agency_inbox_items
         (item_id, created_at, tier, intent_id, description, args_preview, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, Date.now(), input.tier, input.intent_id, input.description, input.args_preview, input.expires_at ?? null],
    )
    this.regenerate()
    return id
  }

  resolve(itemId: string, resolution: 'approved' | 'dismissed' | 'expired'): void {
    this.db.run(
      'UPDATE agency_inbox_items SET resolved_at = ?, resolution = ? WHERE item_id = ?',
      [Date.now(), resolution, itemId],
    )
    this.regenerate()
  }

  pending(): InboxItem[] {
    const rows = this.db.query(
      `SELECT * FROM agency_inbox_items WHERE resolved_at IS NULL ORDER BY tier DESC, created_at DESC`,
    ).all() as Array<{
      item_id: string; created_at: number; tier: AutonomyTier; intent_id: string;
      description: string; args_preview: string; expires_at: number | null;
    }>
    return rows
      .sort((a, b) => tierRank(b.tier) - tierRank(a.tier) || b.created_at - a.created_at)
      .map(r => ({
        item_id: r.item_id,
        created_at: r.created_at,
        tier: r.tier,
        intent_id: r.intent_id,
        description: r.description,
        args_preview: r.args_preview,
        approve_command: `kairos approve ${r.item_id}`,
        dismiss_command: `kairos dismiss ${r.item_id}`,
        expires_at: r.expires_at ?? undefined,
      }))
  }

  private regenerate(): void {
    const dir = dirname(this.filePath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    const items = this.pending()
    const now = new Date().toISOString()
    const header = `# KAIROS Pending Approvals

_${items.length} pending — last update ${now}_

Approve or dismiss any item by running the suggested command. The daemon will detect the change and act accordingly.

---
`
    const body = items.map(it => `
## ${tierEmoji(it.tier)} ${it.description}

- **id**: \`${it.item_id}\`
- **intent**: \`${it.intent_id}\`
- **args**: ${it.args_preview}
- **created**: ${new Date(it.created_at).toISOString()}
${it.expires_at ? `- **expires**: ${new Date(it.expires_at).toISOString()}\n` : ''}
\`\`\`
${it.approve_command}    # run this action
${it.dismiss_command}    # drop without running
\`\`\`
`).join('\n---\n')

    writeFileSync(this.filePath, header + body, 'utf8')
  }
}
