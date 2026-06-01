// src/daemon/connectors/triggers/listener.ts
// Subscribes to Composio's Pusher channel for real-time trigger events.
//
// Why we do this ourselves instead of calling composio.triggers.subscribe():
//   1. Composio's SDK internally does `const { default: Pusher } = await import("pusher-js")`,
//      which under Bun runtime resolves to `{ Pusher: class }` not the class itself —
//      `new Pusher(...)` then throws "Object is not a constructor". Their canonical
//      pattern works under Node but breaks under Bun. We fix the import shape locally
//      with `PusherDefault.Pusher ?? PusherDefault`.
//   2. We use the same Pusher channel + same auth endpoint + same event shape Composio
//      uses internally. This is NOT a different transport — it's identical wire protocol,
//      just our own client.
//
// Composio's docs note triggers.subscribe() is "development-only" and recommends
// triggers.listenToTriggers() (webhook-based) for production. That requires a public URL.
// KAIROS pre-Cloud is a local laptop daemon with no public URL — subscribe() is the
// canonical path for our deployment shape. Phase F (KAIROS Cloud) will swap this
// implementation for listenToTriggers() while keeping the same TriggerListener interface
// — consumer code (ReactiveEvaluator etc.) won't change.

import type { TriggerEventLog } from './eventLog'
import type { TriggerNormalizer } from './normalizer'
import type { TriggerMetrics } from './metrics'
import type { ListenerHealth } from './types'

const COMPOSIO_BASE_URL = 'https://backend.composio.dev'
const REALTIME_CREDENTIALS_PATH = '/api/v3/internal/sdk/realtime/credentials'
const REALTIME_AUTH_PATH = '/api/v3/internal/sdk/realtime/auth'

/** What the credentials endpoint returns (snake_case from REST, normalized to camelCase here). */
type RealtimeCredentials = {
  pusherKey: string
  pusherCluster: string
  projectId: string
}

/** Pusher client interface — minimal surface we need; lets us inject a fake in tests. */
export type PusherLike = {
  subscribe(channelName: string): PusherChannelLike
  disconnect(): void
  connection: {
    bind(event: string, handler: (data?: any) => void): void
    state: string
  }
}

export type PusherChannelLike = {
  bind(event: string, handler: (data?: any) => void): void
  unbind?: (event: string) => void
}

/** Factory for the Pusher client — defaults to real pusher-js with Bun-safe unwrap. */
export type PusherFactory = (creds: RealtimeCredentials, apiKey: string) => Promise<PusherLike>

export type TriggerListenerDeps = {
  /** Composio API key — used both for credentials fetch and Pusher channel-auth header. */
  apiKey: string
  eventLog: TriggerEventLog
  normalizer: TriggerNormalizer
  perceptionBus: { publish(kind: string, payload: any): void }
  metrics: TriggerMetrics
  onHealthChange?: (health: ListenerHealth) => void

  /** Optional: override credentials fetch (for tests). */
  fetchCredentials?: (apiKey: string) => Promise<RealtimeCredentials>
  /** Optional: override Pusher client factory (for tests). */
  pusherFactory?: PusherFactory
  /** Optional: base URL override (for tests / non-prod environments). */
  baseUrl?: string
}

/** Default Pusher factory: pusher-js with Bun-compatible default-import unwrap. */
const defaultPusherFactory: PusherFactory = async (creds, apiKey) => {
  const PusherImported = (await import('pusher-js' as string)) as any
  // Under Node, default IS the class. Under Bun, default is { Pusher: class, ... }.
  // Handle both shapes.
  const PusherDefault = PusherImported.default ?? PusherImported
  const Pusher = PusherDefault.Pusher ?? PusherDefault
  return new Pusher(creds.pusherKey, {
    cluster: creds.pusherCluster,
    forceTLS: true,
    channelAuthorization: {
      endpoint: `${COMPOSIO_BASE_URL}${REALTIME_AUTH_PATH}`,
      headers: { 'x-api-key': apiKey },
      transport: 'ajax',
    },
  }) as PusherLike
}

/** Default credentials fetch: hits Composio's documented internal endpoint. */
const defaultFetchCredentials = async (apiKey: string): Promise<RealtimeCredentials> => {
  const resp = await fetch(`${COMPOSIO_BASE_URL}${REALTIME_CREDENTIALS_PATH}`, {
    headers: { 'x-api-key': apiKey },
  })
  if (!resp.ok) {
    throw new Error(`Composio credentials fetch failed: HTTP ${resp.status} ${resp.statusText}`)
  }
  const raw = await resp.json() as { pusher_key: string; pusher_cluster: string; project_id: string }
  return {
    pusherKey: raw.pusher_key,
    pusherCluster: raw.pusher_cluster,
    projectId: raw.project_id,
  }
}

export class TriggerListener {
  private pusher: PusherLike | null = null
  private health: ListenerHealth = 'healthy'

  constructor(private deps: TriggerListenerDeps) {}

  async start(): Promise<void> {
    const fetchCreds = this.deps.fetchCredentials ?? defaultFetchCredentials
    const pusherFactory = this.deps.pusherFactory ?? defaultPusherFactory

    const creds = await fetchCreds(this.deps.apiKey)
    this.pusher = await pusherFactory(creds, this.deps.apiKey)

    // Hook health to Pusher connection events
    this.pusher.connection.bind('connected', () => this.setHealth('healthy'))
    this.pusher.connection.bind('unavailable', () => this.setHealth('degraded'))
    this.pusher.connection.bind('failed', () => this.setHealth('offline'))
    this.pusher.connection.bind('disconnected', () => this.setHealth('offline'))

    const channelName = `private-${creds.projectId}_triggers`
    const channel = this.pusher.subscribe(channelName)

    await new Promise<void>((resolve, reject) => {
      channel.bind('pusher:subscription_succeeded', () => resolve())
      channel.bind('pusher:subscription_error', (data: any) => {
        const detail = data?.error ? String(data.error) : JSON.stringify(data ?? {})
        reject(new Error(`Pusher subscription_error on ${channelName}: ${detail}`))
      })
      // Safety timeout — Pusher should always callback within seconds
      setTimeout(() => reject(new Error(`Pusher subscription timeout (15s) on ${channelName}`)), 15000)
    })

    // Composio emits events in TWO forms (verified from their SDK source: bindWithChunking):
    //   1. 'trigger_to_client' — small events arrive whole
    //   2. 'chunked-trigger_to_client' — large events split across multiple Pusher messages,
    //      reassembled by id. Calendar/email/PR events with attendees + bodies are
    //      typically chunked. WITHOUT reassembly, we silently drop these.
    channel.bind('trigger_to_client', (data: any) => {
      void this.handleEvent(data)
    })
    channel.bind('chunked-trigger_to_client', (data: any) => {
      this.handleChunk(data)
    })
  }

  private chunkBuffer: Record<string, { chunks: string[]; receivedFinal: boolean }> = {}

  private handleChunk(data: any): void {
    if (!data || typeof data.id !== 'string' || typeof data.index !== 'number') return
    const id: string = data.id
    if (!this.chunkBuffer[id]) {
      this.chunkBuffer[id] = { chunks: [], receivedFinal: false }
    }
    const ev = this.chunkBuffer[id]
    ev.chunks[data.index] = data.chunk
    if (data.final) ev.receivedFinal = true
    // Reassemble when we have the final marker AND no holes in the chunk array
    if (ev.receivedFinal) {
      const expectedCount = ev.chunks.length
      const actualCount = Object.keys(ev.chunks).length
      if (expectedCount === actualCount) {
        try {
          const reassembled = JSON.parse(ev.chunks.join(''))
          void this.handleEvent(reassembled)
        } catch { /* malformed — drop */ }
        delete this.chunkBuffer[id]
      }
    }
  }

  async stop(): Promise<void> {
    if (this.pusher) {
      try { this.pusher.disconnect() } catch { /* swallow */ }
      this.pusher = null
    }
  }

  getHealth(): ListenerHealth {
    return this.health
  }

  private setHealth(next: ListenerHealth): void {
    if (this.health === next) return
    this.health = next
    this.deps.onHealthChange?.(next)
  }

  private async handleEvent(raw: any): Promise<void> {
    const t0 = Date.now()
    let envelope
    try {
      envelope = this.deps.normalizer.normalize(raw)
    } catch (err) {
      this.deps.metrics.record('unknown', null, 'failed', 1)
      return
    }
    const inserted = this.deps.eventLog.record(envelope)
    if (!inserted) return   // duplicate — suppress

    try {
      this.deps.perceptionBus.publish('incoming_event', envelope)
      this.deps.eventLog.markProcessed(envelope.toolkit, envelope.event_id)
      this.deps.metrics.record(envelope.toolkit, null, 'received', 1)
      this.deps.metrics.record(envelope.toolkit, null, 'latency_ms', Date.now() - t0)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.deps.eventLog.markFailed(envelope.toolkit, envelope.event_id, msg)
      this.deps.metrics.record(envelope.toolkit, null, 'failed', 1)
    }
  }
}
