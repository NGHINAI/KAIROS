// src/daemon/connectors/triggers/connectGuard.ts
// When a new incoming_event rule is materialized, ensures the underlying
// toolkit is connected. If not, surfaces inbox prompt + native notification
// and opens the Composio OAuth URL.

import { exec } from 'child_process'

export type ConnectGuardDeps = {
  connectionStore: { listActive(userId: string): Array<{ toolkit_slug: string }> }
  connectionFlow: { link(toolkit: string): Promise<{ url?: string }> }
  inbox: { add(item: { kind: string; title: string; body: string; actions?: string[] }): void }
  nativeNotifier: { notify(msg: string): Promise<void> }
  onConnectionComplete: (toolkit: string) => void
  userId: string
}

export class ConnectGuard {
  private inFlight = new Set<string>()

  constructor(private deps: ConnectGuardDeps) {}

  async ensureConnected(toolkit: string, rule_slug: string): Promise<'ready' | 'pending' | 'timeout'> {
    const active = this.deps.connectionStore.listActive(this.deps.userId)
    if (active.some(a => a.toolkit_slug.toLowerCase() === toolkit.toLowerCase())) {
      return 'ready'
    }

    if (this.inFlight.has(toolkit)) {
      return 'pending'
    }
    this.inFlight.add(toolkit)

    this.deps.inbox.add({
      kind: 'connect_required',
      title: `Connect ${toolkit}`,
      body: `KAIROS needs ${toolkit} access to monitor for rule '${rule_slug}'. Open inbox to start the OAuth flow.`,
      actions: ['connect', 'cancel'],
    })

    await this.deps.nativeNotifier.notify(`KAIROS needs ${toolkit} access — open inbox to connect`)

    try {
      const link = await this.deps.connectionFlow.link(toolkit)
      if (link?.url) {
        exec(`open ${JSON.stringify(link.url)}`, () => {})
      }
    } catch { /* swallow — pending state remains */ }

    return 'pending'
  }

  notifyComplete(toolkit: string): void {
    this.inFlight.delete(toolkit)
    this.deps.onConnectionComplete(toolkit)
  }
}
