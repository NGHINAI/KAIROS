import type { ConnectionStore } from './connectionStore'
import type { Connection } from './types'

type ListedAccount = { id: string; toolkit_slug: string; status: string; auth_config_id: string }

export type TokenExpiryPollerDeps = {
  composio: { listConnectedAccounts(opts: { userId: string; statuses?: string[] }): Promise<ListedAccount[]> }
  connectionStore: ConnectionStore
  onConnectionExpired: (c: Connection) => void
  userId: string
  intervalMs?: number   // default 5 min
}

export class TokenExpiryPoller {
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false

  constructor(private deps: TokenExpiryPollerDeps) {}

  async runOnce(): Promise<void> {
    const remote = await this.deps.composio.listConnectedAccounts({ userId: this.deps.userId })
    const remoteById = new Map(remote.map(r => [r.id, r]))
    const local = this.deps.connectionStore.listByUser(this.deps.userId)
    const now = Date.now()
    for (const lc of local) {
      const r = remoteById.get(lc.connection_id)
      if (!r) {
        if (lc.status === 'active') {
          this.deps.connectionStore.markStatus(this.deps.userId, lc.toolkit_slug, 'expired')
          this.deps.onConnectionExpired({ ...lc, status: 'expired', expired_at: now })
        }
        continue
      }
      const normalized = (r.status ?? '').toString().toUpperCase()
      if (normalized === 'ACTIVE') {
        this.deps.connectionStore.markStatus(this.deps.userId, lc.toolkit_slug, 'active')
      } else if (normalized === 'EXPIRED' || normalized === 'REVOKED') {
        if (lc.status === 'active') {
          this.deps.connectionStore.markStatus(this.deps.userId, lc.toolkit_slug, normalized === 'REVOKED' ? 'revoked' : 'expired')
          this.deps.onConnectionExpired({ ...lc, status: normalized.toLowerCase() as any, expired_at: now })
        }
      }
    }
  }

  start(): void {
    if (this.running) return
    this.running = true
    const interval = this.deps.intervalMs ?? 5 * 60 * 1000
    // Fire one immediately on start, then on the interval
    this.runOnce().catch(() => {})
    this.timer = setInterval(() => {
      this.runOnce().catch(() => {})
    }, interval)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.running = false
  }
}
