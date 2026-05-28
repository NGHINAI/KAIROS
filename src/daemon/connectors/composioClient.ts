// src/daemon/connectors/composioClient.ts
// Thin wrapper around @composio/core. Centralizes API key handling,
// typed method surface, and the deprecation guarantee
// (we use connectedAccounts.link, never the deprecated initiate).

import { Composio } from '@composio/core'
import type { ToolkitInfo, ConnectionStatus } from './types'

export type ComposioClientOptions = {
  apiKey: string
  baseUrl?: string
  _sdk?: any  // injection for tests
}

export type LinkConnectionArgs = {
  userId: string
  authConfigId: string
  callbackUrl?: string  // for OAuth toolkits
  config?: any          // for api_key / no_auth toolkits (forwarded as options.config when supported)
}

export type LinkConnectionResult = {
  connection_id: string
  redirect_url?: string  // present for OAuth flows
  status: ConnectionStatus
  /** Raw SDK return value — has .waitForConnection(timeout_ms) method used by ConnectionFlow */
  _raw: any
}

export class ComposioClient {
  public sdk: any

  constructor(opts: ComposioClientOptions) {
    if (!opts.apiKey) throw new Error('ComposioClient: api_key is required')
    this.sdk = opts._sdk ?? new Composio({
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl ?? 'https://backend.composio.dev',
    })
  }

  async listToolkits(opts: { limit?: number; cursor?: string } = {}): Promise<ToolkitInfo[]> {
    const page = await this.sdk.toolkits.get({ limit: opts.limit ?? 100, cursor: opts.cursor })
    const items = (page as any).items ?? page ?? []
    return items.map((t: any) => ({
      slug: t.slug,
      display_name: t.name ?? t.slug,
      description: t.description ?? '',
      auth_type: this.detectAuthType(t),
      managed_auth_supported: t.managed_auth_supported ?? this.guessManagedAuthSupport(t),
      tools_count: t.tools_count ?? 0,
    }))
  }

  async getOrCreateAuthConfig(toolkitSlug: string): Promise<string> {
    // Idempotent: look up existing managed auth config for this toolkit, create if missing
    const existing = await this.sdk.authConfigs.list({ toolkit: toolkitSlug })
    const items = existing?.items ?? []
    const managed = items.find((c: any) => c.type === 'use_composio_managed_auth')
    if (managed) return managed.id
    const created = await this.sdk.authConfigs.create(toolkitSlug, { type: 'use_composio_managed_auth' })
    return created.id
  }

  async linkConnection(args: LinkConnectionArgs): Promise<LinkConnectionResult> {
    // POSITIONAL args (NOT an options object). The `config` field on the deprecated initiate()
    // does NOT belong on link(). Only callbackUrl and alias go in the options bag.
    const result = await this.sdk.connectedAccounts.link(
      args.userId,
      args.authConfigId,
      args.callbackUrl ? { callbackUrl: args.callbackUrl } : undefined,
    )
    return {
      connection_id: result.connection_id ?? result.id,
      redirect_url: result.redirect_url ?? result.redirectUrl,
      status: this.normalizeStatus(result.status ?? 'pending'),
      _raw: result,
    }
  }

  async listConnectedAccounts(opts: { userId?: string; statuses?: string[] } = {}): Promise<Array<{
    id: string; toolkit_slug: string; status: ConnectionStatus; auth_config_id: string
  }>> {
    const page = await this.sdk.connectedAccounts.list({
      userId: opts.userId,
      statuses: opts.statuses,
    })
    const items = page?.items ?? []
    return items.map((c: any) => ({
      id: c.id,
      toolkit_slug: c.toolkit ?? c.toolkit_slug,
      status: this.normalizeStatus(c.status),
      auth_config_id: c.auth_config_id ?? c.authConfigId,
    }))
  }

  async deleteConnection(connectionId: string): Promise<void> {
    await this.sdk.connectedAccounts.delete(connectionId)
  }

  async executeTool(args: { toolName: string; userId: string; arguments: any }): Promise<any> {
    return this.sdk.tools.execute({
      toolName: args.toolName,
      userId: args.userId,
      arguments: args.arguments,
    })
  }

  private detectAuthType(t: any): 'oauth' | 'api_key' | 'no_auth' | 'unknown' {
    const schemes: string[] = t.auth_schemes ?? t.authSchemes ?? []
    if (schemes.some(s => s === 'OAUTH2' || s === 'OAUTH1')) return 'oauth'
    if (schemes.some(s => s === 'API_KEY' || s === 'BEARER_TOKEN')) return 'api_key'
    if (schemes.some(s => s === 'NO_AUTH')) return 'no_auth'
    return 'unknown'
  }

  private guessManagedAuthSupport(t: any): boolean {
    const at = this.detectAuthType(t)
    return at === 'oauth' || at === 'no_auth'
  }

  private normalizeStatus(s: string): ConnectionStatus {
    const norm = (s ?? '').toUpperCase()
    if (norm === 'ACTIVE') return 'active'
    if (norm === 'EXPIRED') return 'expired'
    if (norm === 'REVOKED' || norm === 'DELETED') return 'revoked'
    if (norm === 'PENDING' || norm === 'INITIATED') return 'pending'
    if (norm === 'FAILED' || norm === 'ERROR') return 'failed'
    return 'pending'
  }
}
