// src/daemon/connectors/triggers/normalizer.ts
// Maps Composio's variable webhook payload shapes to KAIROS's canonical
// NormalizedEvent envelope.
//
// Composio supports THREE webhook formats (V1 legacy, V2, V3). Their own SDK
// detects the shape and normalizes to a common form. We do the same here,
// using the exact same fields they extract — see node_modules/@composio/core/
// dist/index.mjs → normalizeV1Payload / normalizeV2Payload / normalizeV3Payload
// for the upstream logic. This guards against silent event-drop when Composio
// rolls out V4 in the future: we still fall back to permissive extraction.

import { createHash } from 'crypto'
import type { NormalizedEvent } from './types'

/** Raw event from Composio — could be any of V1/V2/V3 or legacy. */
export type RawComposioEvent = Record<string, any>

/** Detected envelope version. */
export type EnvelopeVersion = 'V1' | 'V2' | 'V3' | 'legacy'

type Detected = {
  version: EnvelopeVersion
  trigger_slug: string
  toolkit: string
  payload: Record<string, unknown>
  event_id: string
  connected_account_id?: string
  user_id?: string
}

export class TriggerNormalizer {
  normalize(raw: RawComposioEvent): NormalizedEvent {
    const d = this.detect(raw)
    return {
      trigger_slug: d.trigger_slug,
      toolkit: d.toolkit,
      payload: d.payload,
      raw,
      received_at: Date.now(),
      event_id: d.event_id,
      connected_account_id: d.connected_account_id,
      user_id: d.user_id,
    }
  }

  /** Detect the envelope version and extract canonical fields. */
  private detect(raw: RawComposioEvent): Detected {
    // ── V3: composio.* type + nested metadata.trigger_slug ──────────
    if (
      typeof raw?.type === 'string' &&
      raw.type.startsWith('composio.') &&
      raw?.metadata?.trigger_slug
    ) {
      const md = raw.metadata as Record<string, any>
      const slug = String(md.trigger_slug)
      return {
        version: 'V3',
        trigger_slug: slug,
        toolkit: this.toolkitFromSlug(slug),
        payload: (raw.data ?? {}) as Record<string, unknown>,
        event_id: String(raw.id ?? md.trigger_id ?? this.hash(raw)),
        connected_account_id: md.connected_account_id ? String(md.connected_account_id) : undefined,
        user_id: md.user_id ? String(md.user_id) : undefined,
      }
    }

    // ── V2: type + data.{trigger_id, connection_id, user_id, ...} ─
    if (
      typeof raw?.type === 'string' &&
      raw?.data &&
      typeof raw.data === 'object' &&
      (raw.data.trigger_id || raw.data.trigger_nano_id)
    ) {
      const slug = String(raw.type).toUpperCase()
      const data = raw.data as Record<string, any>
      const { connection_id, connection_nano_id, trigger_nano_id, trigger_id, user_id, ...rest } = data
      return {
        version: 'V2',
        trigger_slug: slug,
        toolkit: this.toolkitFromSlug(slug),
        payload: rest,
        event_id: String(trigger_nano_id ?? trigger_id ?? raw.log_id ?? this.hash(raw)),
        connected_account_id: connection_nano_id ?? connection_id,
        user_id: user_id,
      }
    }

    // ── V1: flat trigger_name + payload ──────────────────────────
    if (
      typeof raw?.trigger_name === 'string' &&
      raw?.payload &&
      typeof raw.payload === 'object'
    ) {
      const slug = String(raw.trigger_name)
      return {
        version: 'V1',
        trigger_slug: slug,
        toolkit: this.toolkitFromSlug(slug),
        payload: raw.payload as Record<string, unknown>,
        event_id: String(raw.trigger_id ?? raw.log_id ?? this.hash(raw)),
        connected_account_id: raw.connection_id ? String(raw.connection_id) : undefined,
        user_id: undefined,
      }
    }

    // ── Legacy / fallback: permissive field-grab.
    // Backward compat with our Phase D test fixtures and any unknown future shape —
    // never silently drop, but mark with empty slug if we can't identify one.
    const triggerSlug =
      raw?.triggerSlug ??
      raw?.trigger_slug ??
      raw?.metadata?.triggerSlug ??
      raw?.metadata?.nanoId ??
      ''
    const toolkitRaw =
      raw?.toolkitSlug ??
      raw?.toolkit_slug ??
      raw?.appName ??
      raw?.metadata?.appName ??
      ''
    const payload = (raw?.data ?? raw?.payload ?? this.stripMeta(raw)) as Record<string, unknown>
    const slug = String(triggerSlug)
    return {
      version: 'legacy',
      trigger_slug: slug,
      toolkit: toolkitRaw ? String(toolkitRaw).toLowerCase() : this.toolkitFromSlug(slug),
      payload,
      event_id: String(raw?.id ?? raw?.eventId ?? this.hash(raw)),
      connected_account_id: raw?.connectedAccountId ?? raw?.connected_account_id,
      user_id: raw?.userId ?? raw?.user_id,
    }
  }

  /** Convention: toolkit = first segment of slug, lowercased.
   *  'GMAIL_NEW_GMAIL_MESSAGE' → 'gmail'
   *  'GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_CREATED_TRIGGER' → 'googlecalendar' */
  private toolkitFromSlug(slug: string): string {
    if (!slug) return ''
    return slug.split('_')[0]?.toLowerCase() ?? ''
  }

  private hash(raw: unknown): string {
    return createHash('sha256').update(JSON.stringify(raw)).digest('hex').slice(0, 16)
  }

  private stripMeta(raw: Record<string, unknown>): Record<string, unknown> {
    const meta = new Set([
      'triggerSlug', 'trigger_slug', 'toolkitSlug', 'toolkit_slug', 'id', 'eventId',
      'connectedAccountId', 'connected_account_id', 'userId', 'user_id',
      'type', 'timestamp', 'log_id', 'metadata', 'appName', 'trigger_name', 'trigger_id', 'connection_id',
    ])
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(raw)) {
      if (!meta.has(k)) out[k] = v
    }
    return out
  }
}
