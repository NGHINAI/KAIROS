import type { ComposioClient } from './composioClient'
import type { ConnectionStore } from './connectionStore'
import type { ConnectFlowResult, ToolkitSlug } from './types'

export interface BrowserOpener { open(url: string): Promise<void> }
export interface OAuthCallbackHandler {
  listen(opts: { path: string; timeout_sec: number }): Promise<{
    port: number
    callbackUrl: string
    capturePromise: Promise<{ callback_path: string; query_params: Record<string, string>; raw_url: string; captured_at: number }>
  }>
}

/** V2: rich post-connection announcement surface. Caller provides; routes to voice in production. */
export interface ConnectionAnnouncer {
  announce(text: string, opts?: { toolkit_slug?: string }): Promise<void> | void
}

export type ConnectionFlowDeps = {
  composio: Pick<ComposioClient,
    'getOrCreateAuthConfig' | 'linkConnection' | 'listConnectedAccounts'> & {
    /** Optional: fetch toolkit details for the announcement. */
    sdk?: any
  }
  browserOpener: BrowserOpener
  oauthCallbackHandler: OAuthCallbackHandler
  connectionStore: ConnectionStore
  announcer?: ConnectionAnnouncer   // V2
}

export class ConnectionFlow {
  constructor(private deps: ConnectionFlowDeps) {}

  async connect(opts: { userId: string; toolkitSlug: ToolkitSlug }): Promise<ConnectFlowResult> {
    const startedAt = Date.now()
    let authConfigId = ''
    try {
      // 1. Resolve auth config (idempotent — looks up existing managed config or creates one)
      authConfigId = await this.deps.composio.getOrCreateAuthConfig(opts.toolkitSlug)

      // 2. Pre-arm the localhost callback BEFORE calling Composio so we know the URL
      const cb = await this.deps.oauthCallbackHandler.listen({ path: '/composio-cb', timeout_sec: 300 })

      // 3. Initiate the link
      const linkResult = await this.deps.composio.linkConnection({
        userId: opts.userId,
        authConfigId,
        callbackUrl: cb.callbackUrl,
      })

      // 4. If a redirect URL came back (OAuth flow), open the browser and await the callback
      if (linkResult.redirect_url) {
        await this.deps.browserOpener.open(linkResult.redirect_url)
        await cb.capturePromise   // resolves on redirect, rejects on timeout
      }

      // 5. Confirm via the SDK's built-in waitForConnection() — replaces manual polling
      let confirmedStatus = 'ACTIVE'
      let connectionId = linkResult.connection_id
      try {
        const confirmed = await linkResult._raw.waitForConnection(30_000)
        confirmedStatus = ((confirmed as any)?.status ?? 'ACTIVE').toString().toUpperCase()
        connectionId = (confirmed as any)?.id ?? (confirmed as any)?.connection_id ?? linkResult.connection_id
      } catch (err) {
        return {
          status: 'failed',
          toolkit_slug: opts.toolkitSlug,
          duration_ms: Date.now() - startedAt,
          error: `connection did not become active within 30s: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
      if (confirmedStatus !== 'ACTIVE') {
        return {
          status: 'failed',
          toolkit_slug: opts.toolkitSlug,
          duration_ms: Date.now() - startedAt,
          error: `connection settled in non-active status: ${confirmedStatus}`,
        }
      }

      // 6. Persist
      this.deps.connectionStore.upsert({
        user_id: opts.userId,
        toolkit_slug: opts.toolkitSlug,
        connection_id: connectionId,
        auth_config_id: authConfigId,
        status: 'active',
        created_at: Date.now(),
      })

      // 7. V2 — post-connection announcement
      if (this.deps.announcer) {
        try {
          const message = await this.buildAnnouncement(opts.toolkitSlug)
          await this.deps.announcer.announce(message, { toolkit_slug: opts.toolkitSlug })
        } catch (err) {
          // Announcement failure is non-fatal — connection is still success
        }
      }

      return {
        status: 'success',
        toolkit_slug: opts.toolkitSlug,
        connection_id: connectionId,
        duration_ms: Date.now() - startedAt,
      }
    } catch (err) {
      return {
        status: 'failed',
        toolkit_slug: opts.toolkitSlug,
        duration_ms: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  /** V2: pick 3 representative tools + build a voice-friendly intro. */
  private async buildAnnouncement(toolkitSlug: ToolkitSlug): Promise<string> {
    const displayName = this.titleCase(toolkitSlug)
    const verbs = await this.fetchRepresentativeVerbs(toolkitSlug)
    if (verbs.length === 0) {
      return `${displayName} connected.`
    }
    if (verbs.length === 1) {
      return `${displayName} connected. I can now ${verbs[0]}.`
    }
    if (verbs.length === 2) {
      return `${displayName} connected. I can now ${verbs[0]} and ${verbs[1]}.`
    }
    return `${displayName} connected. I can now ${verbs[0]}, ${verbs[1]}, and ${verbs[2]}.`
  }

  private async fetchRepresentativeVerbs(toolkitSlug: ToolkitSlug): Promise<string[]> {
    // Try via SDK first if available
    try {
      const sdk = (this.deps.composio as any).sdk
      if (sdk?.toolkits?.get) {
        const detail = await sdk.toolkits.get(toolkitSlug)
        const tools = detail?.tools ?? detail?.actions ?? []
        return this.pickRepresentativeVerbs(tools)
      }
    } catch {
      // fall through
    }
    return []
  }

  private pickRepresentativeVerbs(tools: any[]): string[] {
    if (!Array.isArray(tools) || tools.length === 0) return []
    const priorityVerbs = ['send', 'create', 'list', 'search', 'read', 'get', 'post', 'add']
    const score = (toolName: string): number => {
      const lower = toolName.toLowerCase()
      for (let i = 0; i < priorityVerbs.length; i++) {
        if (lower.includes(priorityVerbs[i]!)) return priorityVerbs.length - i
      }
      return 0
    }
    const sorted = [...tools].sort((a, b) => score(b.name ?? b.slug ?? '') - score(a.name ?? a.slug ?? ''))
    const picked: string[] = []
    for (const t of sorted) {
      const name = (t.name ?? t.slug ?? '').toString()
      const verb = this.extractVerb(name)
      if (verb && !picked.includes(verb)) picked.push(verb)
      if (picked.length >= 3) break
    }
    return picked
  }

  private extractVerb(toolName: string): string | null {
    if (!toolName) return null
    // Strip toolkit prefix (e.g., SLACK_SEND_MESSAGE → send message; slack.send_message → send message)
    const stripped = toolName.replace(/^[A-Z]+_/i, '').replace(/^[a-z_]+\./i, '')
    const words = stripped.toLowerCase().replace(/_/g, ' ').split(/\s+/).filter(Boolean)
    if (words.length === 0) return null
    return words.slice(0, 3).join(' ').trim()
  }

  private titleCase(s: string): string {
    return s.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
  }
}
