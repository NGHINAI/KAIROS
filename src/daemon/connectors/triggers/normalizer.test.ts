// src/daemon/connectors/triggers/normalizer.test.ts
import { describe, it, expect } from 'bun:test'
import { TriggerNormalizer } from './normalizer'

describe('TriggerNormalizer', () => {
  const n = new TriggerNormalizer()

  // ── V3 envelope (current Composio production format, what we get from live test) ─

  it('V3: extracts trigger_slug + toolkit from metadata', () => {
    const raw = {
      id: 'msg_871a74f5-f820-4ca9-ae4d-6ac63148a361',
      timestamp: '2026-05-29T17:50:00Z',
      type: 'composio.trigger.message',
      metadata: {
        log_id: 'log_xxx',
        trigger_slug: 'GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_CREATED_TRIGGER',
        trigger_id: 'ti_xxx',
        connected_account_id: 'ca_xxx',
        auth_config_id: 'ac_xxx',
        user_id: 'local',
      },
      data: {
        calendar_id: 'primary',
        event_id: '4ihtr54prdusnod4bmg8neitqf',
        organizer_email: 'nghinaiya81@gmail.com',
        end_time: '2026-05-29T17:15:00-05:00',
      },
    }
    const env = n.normalize(raw)
    expect(env.trigger_slug).toBe('GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_CREATED_TRIGGER')
    expect(env.toolkit).toBe('googlecalendar')
    expect(env.event_id).toBe('msg_871a74f5-f820-4ca9-ae4d-6ac63148a361')
    expect(env.connected_account_id).toBe('ca_xxx')
    expect(env.user_id).toBe('local')
    expect(env.payload.calendar_id).toBe('primary')
    expect(env.payload.event_id).toBe('4ihtr54prdusnod4bmg8neitqf')
  })

  it('V3: payload only contains data fields, not metadata', () => {
    const raw = {
      id: 'msg_1',
      timestamp: '2026-05-29T00:00:00Z',
      type: 'composio.trigger.message',
      metadata: { trigger_slug: 'GMAIL_NEW_GMAIL_MESSAGE', trigger_id: 'ti_1', connected_account_id: 'ca_1', auth_config_id: 'ac_1', user_id: 'u_1', log_id: 'l_1' },
      data: { from: 'a@b.c', subject: 'hi' },
    }
    const env = n.normalize(raw)
    expect(env.payload).toEqual({ from: 'a@b.c', subject: 'hi' })
    expect((env.payload as any).trigger_slug).toBeUndefined()
  })

  // ── V2 envelope ───────────────────────────────────────────────

  it('V2: extracts trigger_slug from type, strips data metadata', () => {
    const raw = {
      type: 'gmail_new_gmail_message',
      timestamp: '2026-05-29T00:00:00Z',
      log_id: 'log_xxx',
      data: {
        connection_id: 'ca_xxx',
        connection_nano_id: 'cna_xxx',
        trigger_nano_id: 'tna_xxx',
        trigger_id: 'ti_xxx',
        user_id: 'u_1',
        from: 'a@b.c',
        subject: 'V2 event',
      },
    }
    const env = n.normalize(raw)
    expect(env.trigger_slug).toBe('GMAIL_NEW_GMAIL_MESSAGE')
    expect(env.toolkit).toBe('gmail')
    expect(env.user_id).toBe('u_1')
    expect(env.connected_account_id).toBe('cna_xxx')
    expect(env.payload).toEqual({ from: 'a@b.c', subject: 'V2 event' })
    expect((env.payload as any).trigger_id).toBeUndefined()
  })

  // ── V1 envelope (legacy) ──────────────────────────────────────

  it('V1: extracts trigger_name + flat payload', () => {
    const raw = {
      trigger_name: 'SLACK_RECEIVE_MESSAGE',
      connection_id: 'ca_xxx',
      trigger_id: 'ti_xxx',
      log_id: 'log_xxx',
      payload: { channel: '#general', text: 'hi' },
    }
    const env = n.normalize(raw)
    expect(env.trigger_slug).toBe('SLACK_RECEIVE_MESSAGE')
    expect(env.toolkit).toBe('slack')
    expect(env.connected_account_id).toBe('ca_xxx')
    expect(env.event_id).toBe('ti_xxx')
    expect(env.payload).toEqual({ channel: '#general', text: 'hi' })
  })

  // ── Legacy/fallback for backward compat with our own test fixtures ──

  it('legacy: uses triggerSlug/toolkitSlug naive fields when present', () => {
    const raw = { triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE', toolkitSlug: 'gmail', id: 'evt-1', data: { from: 'x' } }
    const env = n.normalize(raw)
    expect(env.trigger_slug).toBe('GMAIL_NEW_GMAIL_MESSAGE')
    expect(env.toolkit).toBe('gmail')
    expect(env.event_id).toBe('evt-1')
  })

  it('legacy: derives toolkit from slug when toolkitSlug missing', () => {
    const raw = { triggerSlug: 'NOTION_NEW_PAGE', data: { foo: 'bar' } }
    const env = n.normalize(raw)
    expect(env.toolkit).toBe('notion')
  })

  it('hashes event_id when none provided', () => {
    const env = n.normalize({ triggerSlug: 'X', data: { random: Math.random() } })
    expect(env.event_id).toBeDefined()
    expect(env.event_id.length).toBeGreaterThan(0)
  })

  it('toolkit derivation handles compound names like GOOGLECALENDAR', () => {
    const env = n.normalize({
      id: 'm1', timestamp: '2026-05-29T00:00:00Z', type: 'composio.trigger.message',
      metadata: { trigger_slug: 'GOOGLECALENDAR_EVENT_STARTING_SOON_TRIGGER', trigger_id: 'ti', connected_account_id: 'ca', auth_config_id: 'ac', user_id: 'u', log_id: 'l' },
      data: { event_id: 'g1' },
    })
    expect(env.toolkit).toBe('googlecalendar')
  })

  it('preserves the original raw envelope for debug', () => {
    const raw = { triggerSlug: 'X', toolkitSlug: 'x', id: 'i', data: { a: 1 } }
    const env = n.normalize(raw)
    expect(env.raw).toEqual(raw)
  })

  it('sets received_at to now', () => {
    const before = Date.now()
    const env = n.normalize({ triggerSlug: 'X', toolkitSlug: 'x', data: {} })
    const after = Date.now()
    expect(env.received_at).toBeGreaterThanOrEqual(before)
    expect(env.received_at).toBeLessThanOrEqual(after)
  })

  // ── Multi-token toolkit slug via schemaCache lookup ──────────

  it('toolkit lookup overrides split heuristic for multi-token toolkits', () => {
    // Composio toolkits like MICROSOFT_TEAMS, GOOGLE_CHAT, GOOGLE_MEET have
    // multi-token slugs. The split heuristic would resolve 'MICROSOFT_TEAMS_NEW_MESSAGE'
    // to 'microsoft' (wrong). With an authoritative cache, we get the correct value.
    const nWithLookup = new TriggerNormalizer()
    nWithLookup.setToolkitLookup((slug: string) => {
      if (slug === 'MICROSOFT_TEAMS_NEW_MESSAGE') return 'microsoft_teams'
      if (slug === 'GOOGLE_CHAT_NEW_MESSAGE') return 'google_chat'
      return null
    })

    const teamsEvent = nWithLookup.normalize({
      id: 'm1', timestamp: '2026-05-29T00:00:00Z', type: 'composio.trigger.message',
      metadata: { trigger_slug: 'MICROSOFT_TEAMS_NEW_MESSAGE', trigger_id: 'ti', connected_account_id: 'ca', auth_config_id: 'ac', user_id: 'u', log_id: 'l' },
      data: { message: 'hi' },
    })
    expect(teamsEvent.toolkit).toBe('microsoft_teams')

    const chatEvent = nWithLookup.normalize({
      id: 'm2', timestamp: '2026-05-29T00:00:00Z', type: 'composio.trigger.message',
      metadata: { trigger_slug: 'GOOGLE_CHAT_NEW_MESSAGE', trigger_id: 'ti', connected_account_id: 'ca', auth_config_id: 'ac', user_id: 'u', log_id: 'l' },
      data: { message: 'hi' },
    })
    expect(chatEvent.toolkit).toBe('google_chat')
  })

  it('toolkit lookup falls back to split when cache misses', () => {
    const nWithLookup = new TriggerNormalizer()
    nWithLookup.setToolkitLookup(() => null) // cache miss for everything
    const env = nWithLookup.normalize({
      id: 'm1', timestamp: '2026-05-29T00:00:00Z', type: 'composio.trigger.message',
      metadata: { trigger_slug: 'GMAIL_NEW_GMAIL_MESSAGE', trigger_id: 'ti', connected_account_id: 'ca', auth_config_id: 'ac', user_id: 'u', log_id: 'l' },
      data: { from: 'a@b.c' },
    })
    expect(env.toolkit).toBe('gmail') // split heuristic still works
  })

  it('toolkit lookup lowercases the resolved value', () => {
    const nWithLookup = new TriggerNormalizer()
    nWithLookup.setToolkitLookup(() => 'Microsoft_Teams') // mixed-case
    const env = nWithLookup.normalize({
      id: 'm1', timestamp: '2026-05-29T00:00:00Z', type: 'composio.trigger.message',
      metadata: { trigger_slug: 'MICROSOFT_TEAMS_NEW_MESSAGE', trigger_id: 'ti', connected_account_id: 'ca', auth_config_id: 'ac', user_id: 'u', log_id: 'l' },
      data: { message: 'hi' },
    })
    expect(env.toolkit).toBe('microsoft_teams')
  })

  it('V3 takes precedence over legacy fields', () => {
    // If both V3 markers AND legacy fields exist, V3 wins because it's the
    // authoritative format from Composio.
    const raw = {
      // legacy fields:
      triggerSlug: 'LEGACY_SLUG', toolkitSlug: 'legacy',
      // V3 envelope:
      id: 'm1', timestamp: '2026-05-29T00:00:00Z', type: 'composio.trigger.message',
      metadata: { trigger_slug: 'GMAIL_NEW_GMAIL_MESSAGE', trigger_id: 'ti', connected_account_id: 'ca', auth_config_id: 'ac', user_id: 'u', log_id: 'l' },
      data: { from: 'a' },
    }
    const env = n.normalize(raw)
    expect(env.trigger_slug).toBe('GMAIL_NEW_GMAIL_MESSAGE')
    expect(env.toolkit).toBe('gmail')
  })
})
