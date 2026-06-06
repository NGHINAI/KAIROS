import { describe, it, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { IntentRegistry } from '../agency/intentRegistry'
import { registerInvokeSkillIntent, invokeSkillIntentDescriptor } from './invokeSkillIntent'
import type { SkillExecutionResult } from './types'

function fakeCtx() {
  return {
    db: new Database(':memory:'),
    notifier: { notify: async () => {} } as any,
    embedder: { embed: async () => [] },
    semantic: { reinforceOrWrite: () => 0 },
  }
}

function fakeDispatcher(impl: (slug: string, args: Record<string, unknown>) => Promise<SkillExecutionResult>) {
  // The real SkillDispatcher.invoke returns DispatchResult (= SkillExecutionResult &
  // { slug }); inject the slug so the fake matches the contract without touching the
  // call sites' return literals.
  return { invoke: async (slug: string, args: Record<string, unknown>) => ({ slug, ...(await impl(slug, args)) }) }
}

describe('invoke_skill intent', () => {
  it('registers under id "invoke_skill" at GREEN tier', () => {
    const reg = new IntentRegistry()
    registerInvokeSkillIntent(reg, { dispatcher: fakeDispatcher(async () => ({ ok: true, output: 'x', duration_ms: 1, sandbox: 'declarative' })) })
    const entry = reg.get('invoke_skill')
    expect(entry).not.toBeNull()
    expect(entry!.tier).toBe('GREEN')
    expect(invokeSkillIntentDescriptor.id).toBe('invoke_skill')
  })

  it('dispatches successfully when skill returns ok', async () => {
    const reg = new IntentRegistry()
    let captured: { slug: string; args: Record<string, unknown> } | null = null
    registerInvokeSkillIntent(reg, {
      dispatcher: fakeDispatcher(async (slug, args) => {
        captured = { slug, args }
        return { ok: true, output: 'hello world', duration_ms: 42, sandbox: 'ts_worker' }
      }),
    })
    const entry = reg.get('invoke_skill')!
    const result = await entry.handler({ slug: 'greet', args: { name: 'nirmal' } }, fakeCtx() as any)
    expect(result.status).toBe('success')
    expect(result.details).toContain('Invoked')
    expect(result.details).toContain('ts_worker')
    expect(result.details).toContain('hello world')
    expect(captured as any).toEqual({ slug: 'greet', args: { name: 'nirmal' } })
  })

  it('returns failure when skill returns ok=false', async () => {
    const reg = new IntentRegistry()
    registerInvokeSkillIntent(reg, {
      dispatcher: fakeDispatcher(async () => ({ ok: false, error: 'boom', duration_ms: 5, sandbox: 'composio_workbench' })),
    })
    const entry = reg.get('invoke_skill')!
    const result = await entry.handler({ slug: 'broken-skill', args: {} }, fakeCtx() as any)
    expect(result.status).toBe('failure')
    expect(result.details).toContain('boom')
  })

  it('rejects missing slug', async () => {
    const reg = new IntentRegistry()
    registerInvokeSkillIntent(reg, { dispatcher: fakeDispatcher(async () => ({ ok: true, duration_ms: 1, sandbox: 'declarative' })) })
    const entry = reg.get('invoke_skill')!
    const result = await entry.handler({}, fakeCtx() as any)
    expect(result.status).toBe('failure')
    expect(result.details).toContain('slug is required')
  })

  it('defaults args to {} when omitted', async () => {
    const reg = new IntentRegistry()
    let receivedArgs: Record<string, unknown> | null = null
    registerInvokeSkillIntent(reg, {
      dispatcher: fakeDispatcher(async (_slug, args) => {
        receivedArgs = args
        return { ok: true, duration_ms: 1, sandbox: 'declarative' }
      }),
    })
    const entry = reg.get('invoke_skill')!
    await entry.handler({ slug: 'no-args-skill' }, fakeCtx() as any)
    expect(receivedArgs as any).toEqual({})
  })

  it('catches thrown errors from dispatcher and returns failure', async () => {
    const reg = new IntentRegistry()
    registerInvokeSkillIntent(reg, {
      dispatcher: fakeDispatcher(async () => { throw new Error('catastrophic') }),
    })
    const entry = reg.get('invoke_skill')!
    const result = await entry.handler({ slug: 'unstable', args: {} }, fakeCtx() as any)
    expect(result.status).toBe('failure')
    expect(result.details).toContain('catastrophic')
  })
})
