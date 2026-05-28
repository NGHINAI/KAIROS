// src/daemon/connectors/composioSessionManager.ts
// Lifecycle for a Composio ToolRouter session.
//
// On daemon boot: either resume cached session (composio.use(sessionId))
// or create a fresh one with the currently-connected toolkits.
//
// When user connects a new toolkit, call addToolkit() to update the live session.
// McpHost queries getMcpUrl/getMcpHeaders to wire the HttpMcpClient.

import type { ToolkitSlug } from './types'

export type ComposioSessionManagerOptions = {
  sdk: any                       // @composio/core Composio instance
  userId: string
  toolkits: ToolkitSlug[]        // initial set
  cachedSessionId?: string       // resume from disk if present
  /** CRITICAL: keep manageConnections: true so Composio's in-chat auth meta-tool stays active.
   *  When the agent calls a tool for an unconnected toolkit, Composio returns a Connect URL
   *  instead of an error — the agent surfaces it in voice, user clicks, connection completes. */
  manageConnections?: boolean    // default true
}

export class ComposioSessionManager {
  private session: any = null
  private currentToolkits: Set<ToolkitSlug>

  constructor(private opts: ComposioSessionManagerOptions) {
    this.currentToolkits = new Set(opts.toolkits)
  }

  async init(): Promise<void> {
    if (this.opts.cachedSessionId) {
      try {
        this.session = await this.opts.sdk.use(this.opts.cachedSessionId)
        // Trust the cached session — toolkits set was already configured when created.
        return
      } catch {
        // resume failed (session might have expired) — fall through to fresh create
      }
    }
    this.session = await this.opts.sdk.create(this.opts.userId, this.buildCreateOpts())
  }

  /** Always returns the exact opts shape we pass to composio.create(). */
  private buildCreateOpts(): any {
    return {
      toolkits: [...this.currentToolkits],
      // CRITICAL: keep manageConnections: true (default) for in-chat auth
      manageConnections: this.opts.manageConnections ?? true,
      // CRITICAL: disable workbench. Default-on exposes COMPOSIO_REMOTE_BASH_TOOL +
      // COMPOSIO_REMOTE_WORKBENCH — shell-exec tools KAIROS does NOT want.
      // Spike verified: enable:false drops tool count from 6 to 4.
      workbench: { enable: false },
    }
  }

  getSessionId(): string {
    this.assertInited()
    return this.session.id ?? this.session.session_id ?? ''
  }

  getMcpUrl(): string {
    this.assertInited()
    return this.session.mcp.url
  }

  getMcpHeaders(): Record<string, string> {
    this.assertInited()
    return this.session.mcp.headers ?? {}
  }

  getToolkits(): ToolkitSlug[] {
    return [...this.currentToolkits]
  }

  async addToolkit(slug: ToolkitSlug): Promise<void> {
    this.assertInited()
    if (this.currentToolkits.has(slug)) return
    this.currentToolkits.add(slug)
    // ONLY session.update({ toolkits: [...] }) exists in the SDK.
    // session.toolkits() is a read-only query — has NO .add() method.
    // session.update() replaces the toolkit list, so we always pass the FULL desired set.
    if (typeof this.session.update === 'function') {
      await this.session.update({ toolkits: [...this.currentToolkits] })
    } else {
      // Last-resort fallback: re-create session with the new toolkit set
      this.session = await this.opts.sdk.create(this.opts.userId, this.buildCreateOpts())
    }
  }

  async removeToolkit(slug: ToolkitSlug): Promise<void> {
    this.assertInited()
    if (!this.currentToolkits.has(slug)) return
    this.currentToolkits.delete(slug)
    if (typeof this.session.update === 'function') {
      await this.session.update({ toolkits: [...this.currentToolkits] })
    } else {
      this.session = await this.opts.sdk.create(this.opts.userId, this.buildCreateOpts())
    }
  }

  private assertInited(): void {
    if (!this.session) throw new Error('ComposioSessionManager: must call init() before use')
  }
}
