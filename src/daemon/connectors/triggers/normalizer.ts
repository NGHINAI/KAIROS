// src/daemon/connectors/triggers/normalizer.ts
// Pure function: Composio payload → canonical NormalizedEvent envelope.

import { createHash } from 'crypto'
import type { NormalizedEvent } from './types'

export type RawComposioEvent = {
  triggerSlug?: string
  trigger_slug?: string
  toolkitSlug?: string
  toolkit_slug?: string
  id?: string
  eventId?: string
  connectedAccountId?: string
  connected_account_id?: string
  userId?: string
  user_id?: string
  data?: Record<string, unknown>
  payload?: Record<string, unknown>
  [k: string]: unknown
}

export class TriggerNormalizer {
  normalize(raw: RawComposioEvent): NormalizedEvent {
    const trigger_slug = (raw.triggerSlug ?? raw.trigger_slug ?? '') as string
    const toolkit = ((raw.toolkitSlug ?? raw.toolkit_slug ?? '') as string).toLowerCase()
    const event_id_provided = (raw.id ?? raw.eventId) as string | undefined
    const event_id = event_id_provided ?? this.hashEvent(raw)
    const payload = (raw.data ?? raw.payload ?? this.stripMeta(raw)) as Record<string, unknown>

    return {
      trigger_slug,
      toolkit,
      payload,
      raw: raw as Record<string, unknown>,
      received_at: Date.now(),
      event_id,
      connected_account_id: (raw.connectedAccountId ?? raw.connected_account_id) as string | undefined,
      user_id: (raw.userId ?? raw.user_id) as string | undefined,
    }
  }

  private hashEvent(raw: unknown): string {
    return createHash('sha256').update(JSON.stringify(raw)).digest('hex').slice(0, 16)
  }

  private stripMeta(raw: Record<string, unknown>): Record<string, unknown> {
    const meta = new Set(['triggerSlug', 'trigger_slug', 'toolkitSlug', 'toolkit_slug', 'id', 'eventId', 'connectedAccountId', 'connected_account_id', 'userId', 'user_id'])
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(raw)) {
      if (!meta.has(k)) out[k] = v
    }
    return out
  }
}
