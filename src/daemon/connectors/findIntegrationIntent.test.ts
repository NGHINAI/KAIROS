// src/daemon/connectors/findIntegrationIntent.test.ts
import { describe, it, expect } from 'bun:test'
import {
  createFindIntegrationIntent,
  registerFindIntegrationIntent,
  findIntegrationIntentDescriptor,
} from './findIntegrationIntent'
import { IntentRegistry } from '../agency/intentRegistry'

function fakeResolver(result: any) {
  return { resolve: async (_phrase: string) => result }
}

describe('findIntegrationIntent', () => {
  it('has expected metadata (id=find_integration, tier=GREEN)', () => {
    const intent = createFindIntegrationIntent({ toolkitResolver: fakeResolver({ matches: [] }) })
    expect(intent.id).toBe('find_integration')
    expect(intent.tier).toBe('GREEN')
    expect(typeof intent.description).toBe('string')
    expect(intent.argSchema).toEqual({ phrase: 'string' })
  })

  it('returns the resolver matches for a fuzzy phrase', async () => {
    const intent = createFindIntegrationIntent({
      toolkitResolver: fakeResolver({
        best: 'googlecalendar',
        matches: [{ slug: 'googlecalendar', name: 'Google Calendar', score: 0.9 }],
      }),
    })
    const res = await intent.handler({ phrase: 'calendar' })
    expect(res.best).toBe('googlecalendar')
    expect(res.matches[0]!.slug).toBe('googlecalendar')
  })

  it('throws when phrase is missing or empty', async () => {
    const intent = createFindIntegrationIntent({ toolkitResolver: fakeResolver({ matches: [] }) })
    await expect(intent.handler({} as any)).rejects.toThrow(/phrase/i)
    await expect(intent.handler({ phrase: '   ' } as any)).rejects.toThrow(/phrase/i)
  })

  it('registers into an IntentRegistry and dispatches a human-readable summary', async () => {
    const reg = new IntentRegistry()
    registerFindIntegrationIntent(reg, {
      toolkitResolver: fakeResolver({
        best: 'linear',
        matches: [
          { slug: 'linear', name: 'Linear', score: 0.8 },
          { slug: 'github', name: 'GitHub', score: 0.5 },
        ],
      }),
    })
    const entry = reg.get('find_integration')
    expect(entry).not.toBeNull()
    const out = await entry!.handler({ phrase: 'tickets' }, {} as any)
    expect(out.status).toBe('success')
    expect(out.details).toContain('linear')
    expect(out.details).toContain('github')
  })

  it('registry handler reports no-match cleanly', async () => {
    const reg = new IntentRegistry()
    registerFindIntegrationIntent(reg, { toolkitResolver: fakeResolver({ matches: [] }) })
    const out = await reg.get('find_integration')!.handler({ phrase: 'zzz' }, {} as any)
    expect(out.status).toBe('success')
    expect(out.details).toMatch(/no matching integration/i)
  })

  it('descriptor is reusable (same id as the object)', () => {
    expect(findIntegrationIntentDescriptor.id).toBe('find_integration')
  })
})
