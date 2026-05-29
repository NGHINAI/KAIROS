// src/daemon/connectors/triggers/connectGuard.ts
// When a new incoming_event rule is materialized, ensures the underlying
// toolkit is connected. If not, surfaces an inbox prompt + native notification
// with the OAuth URL. The user clicks the URL from the inbox/notif when ready.
//
// NOTE: ConnectGuard does NOT auto-open the browser. That was the v0 design but
// auto-open is too aggressive (pulls focus, may surprise the user mid-task) and
// caused real browser windows to launch during unit tests. Inbox + notif is enough.

import { exec } from 'child_process'

export type ConnectGuardDeps = {
  connectionStore: { listActive(userId: string): Array<{ toolkit_slug: string }> }
  connectionFlow: { link(toolkit: string): Promise<{ url?: string }> }
  inbox: { add(item: { kind: string; title: string; body: string; url?: string; actions?: string[] }): void }
  nativeNotifier: { notify(msg: string): Promise<void> }
  onConnectionComplete: (toolkit: string) => void
  userId: string
  /** Optional auto-open hook. Default: no-op (user opens manually).
   *  Daemon can override with an explicit user-consent-aware opener. */
  openUrl?: (url: string) => void
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

    let oauthUrl: string | undefined
    try {
      const link = await this.deps.connectionFlow.link(toolkit)
      oauthUrl = link?.url
    } catch { /* swallow — surface as inbox prompt without URL */ }

    this.deps.inbox.add({
      kind: 'connect_required',
      title: `Connect ${toolkit}`,
      body: `KAIROS needs ${toolkit} access to monitor for rule '${rule_slug}'.${oauthUrl ? ` Open this URL to start the OAuth flow: ${oauthUrl}` : ' Open inbox to retry once the connection issue is resolved.'}`,
      url: oauthUrl,
      actions: ['connect', 'cancel'],
    })

    await this.deps.nativeNotifier.notify(`KAIROS needs ${toolkit} access — open inbox to connect`)

    // Only auto-open if an opener is explicitly provided. Default is NO browser launch.
    if (oauthUrl && this.deps.openUrl) {
      try { this.deps.openUrl(oauthUrl) } catch { /* swallow */ }
    }

    return 'pending'
  }

  notifyComplete(toolkit: string): void {
    this.inFlight.delete(toolkit)
    this.deps.onConnectionComplete(toolkit)
  }
}

/** Convenience: a real macOS opener using `exec('open <url>')`. NOT wired by default. */
export function macosOpener(url: string): void {
  exec(`open ${JSON.stringify(url)}`, () => {})
}
