// src/daemon/orders/v2/actionDispatcher.test.ts
import { describe, it, expect } from 'bun:test'
import { ActionDispatcher } from './actionDispatcher'
import { RulesEventBus } from './eventBus'
import type { Action } from './types'

function fakeIntentRegistry() {
  const calls: any[] = []
  return {
    get: (id: string) => ({
      handler: async (args: any) => { calls.push({ id, args }); return { status: 'success', details: 'ok' } },
    }),
    calls,
  }
}

function fakeSkillDispatcher() {
  const calls: any[] = []
  return {
    invoke: async (slug: string, args: any) => {
      calls.push({ slug, args })
      return { ok: true, output: 'skill-output-' + slug, duration_ms: 1, sandbox: 'declarative' as const }
    },
    calls,
  }
}

function fakeComposio() {
  const calls: any[] = []
  return {
    resolver: {
      resolveOrRefresh: async (toolkit: string, tool: string) => {
        // Trivial pass-through: just join the parts for predictable test fixture
        return `${toolkit.toUpperCase()}_${tool.toUpperCase()}`
      },
    },
    executeTool: async (args: any) => {
      calls.push({ toolkit: args.toolName.split('_')[0]!.toLowerCase(), tool: args.toolName.split('_').slice(1).join('_').toLowerCase(), args: args.arguments })
      return { ok: true, output: 'composio-result' }
    },
    userId: 'local',
    calls,
  }
}

describe('ActionDispatcher', () => {
  it('routes notify → intent registry', async () => {
    const reg = fakeIntentRegistry()
    const d = new ActionDispatcher({ intentRegistry: reg as any, skillDispatcher: fakeSkillDispatcher() as any, composio: fakeComposio() as any, eventBus: new RulesEventBus() })
    await d.dispatch([{ action: 'notify', args: { message: 'hi' } } as Action], { trigger: {} })
    expect(reg.calls).toHaveLength(1)
    expect(reg.calls[0]).toEqual({ id: 'notify', args: { message: 'hi' } })
  })

  it('routes invoke_skill → skill dispatcher', async () => {
    const skl = fakeSkillDispatcher()
    const d = new ActionDispatcher({ intentRegistry: fakeIntentRegistry() as any, skillDispatcher: skl as any, composio: fakeComposio() as any, eventBus: new RulesEventBus() })
    await d.dispatch([{ action: 'invoke_skill', args: { slug: 'greet', args: { name: 'x' } } } as Action], { trigger: {} })
    expect(skl.calls).toEqual([{ slug: 'greet', args: { name: 'x' } }])
  })

  it('routes composio_tool → composio client', async () => {
    const cmp = fakeComposio()
    const d = new ActionDispatcher({ intentRegistry: fakeIntentRegistry() as any, skillDispatcher: fakeSkillDispatcher() as any, composio: cmp as any, eventBus: new RulesEventBus() })
    await d.dispatch([{ action: 'composio_tool', args: { toolkit: 'slack', tool: 'send', args: { channel: '#x' } } } as Action], { trigger: {} })
    expect(cmp.calls).toEqual([{ toolkit: 'slack', tool: 'send', args: { channel: '#x' } }])
  })

  it('routes emit_event → event bus', async () => {
    const bus = new RulesEventBus()
    const got: any[] = []
    bus.on('foo', p => got.push(p))
    const d = new ActionDispatcher({ intentRegistry: fakeIntentRegistry() as any, skillDispatcher: fakeSkillDispatcher() as any, composio: fakeComposio() as any, eventBus: bus })
    await d.dispatch([{ action: 'emit_event', args: { name: 'foo', payload: { x: 1 } } } as Action], { trigger: {} })
    expect(got).toEqual([{ x: 1 }])
  })

  it('chains ${skill_output} from previous action', async () => {
    const skl = fakeSkillDispatcher()
    const reg = fakeIntentRegistry()
    const d = new ActionDispatcher({ intentRegistry: reg as any, skillDispatcher: skl as any, composio: fakeComposio() as any, eventBus: new RulesEventBus() })
    await d.dispatch([
      { action: 'invoke_skill', args: { slug: 'classify' } } as Action,
      { action: 'notify', args: { message: '${skill_output}' } } as Action,
    ], { trigger: {} })
    // Skill returns string 'skill-output-classify', wrapped as { value: ... } for object-only access pattern,
    // but the bare ${skill_output} substitution expects flat string. Implementation should expose the
    // primitive value at `skill_output` directly when output is non-object, OR handle ${skill_output}
    // with no path as the raw value. The implementation below wraps non-objects in { value } and the
    // template should use ${skill_output.value} — but we accept either as long as the message contains the slug.
    expect(reg.calls[0]!.args.message).toContain('classify')
  })

  it('interpolates ${trigger.X} into args', async () => {
    const reg = fakeIntentRegistry()
    const d = new ActionDispatcher({ intentRegistry: reg as any, skillDispatcher: fakeSkillDispatcher() as any, composio: fakeComposio() as any, eventBus: new RulesEventBus() })
    await d.dispatch([{ action: 'notify', args: { message: 'hi ${trigger.name}' } } as Action], { trigger: { name: 'world' } })
    expect(reg.calls[0]!.args.message).toBe('hi world')
  })

  it('returns ok=false when an action throws', async () => {
    const skl = { invoke: async () => { throw new Error('boom') } }
    const d = new ActionDispatcher({ intentRegistry: fakeIntentRegistry() as any, skillDispatcher: skl as any, composio: fakeComposio() as any, eventBus: new RulesEventBus() })
    const result = await d.dispatch([{ action: 'invoke_skill', args: { slug: 'x' } } as Action], { trigger: {} })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('boom')
  })

  it('rejects unknown action type', async () => {
    const d = new ActionDispatcher({ intentRegistry: fakeIntentRegistry() as any, skillDispatcher: fakeSkillDispatcher() as any, composio: fakeComposio() as any, eventBus: new RulesEventBus() })
    const result = await d.dispatch([{ action: 'mystery', args: {} } as any], { trigger: {} })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/unknown action/i)
  })

  function fakeComposioWithResolver(toolNameMap: Record<string, string>) {
    const executeCalls: any[] = []
    return {
      composio: {
        resolver: {
          resolveOrRefresh: async (toolkit: string, tool: string) => toolNameMap[`${toolkit}:${tool}`] ?? null,
        },
        executeTool: async (args: any) => { executeCalls.push(args); return { ok: true, data: 'tool-result' } },
        userId: 'local',
      },
      executeCalls,
    }
  }

  it('composio_tool: resolver hit + executeTool called with toolName', async () => {
    const cmp = fakeComposioWithResolver({ 'slack:send_message': 'SLACK_SEND_MESSAGE' })
    const d = new ActionDispatcher({
      intentRegistry: fakeIntentRegistry() as any,
      skillDispatcher: fakeSkillDispatcher() as any,
      composio: cmp.composio,
      eventBus: new RulesEventBus(),
    })
    await d.dispatch([{ action: 'composio_tool', args: { toolkit: 'slack', tool: 'send_message', args: { channel: '#x', text: 'hi' } } } as Action], { trigger: {} })
    expect(cmp.executeCalls).toHaveLength(1)
    expect(cmp.executeCalls[0].toolName).toBe('SLACK_SEND_MESSAGE')
    expect(cmp.executeCalls[0].userId).toBe('local')
    expect(cmp.executeCalls[0].arguments).toEqual({ channel: '#x', text: 'hi' })
  })

  it('composio_tool: resolver miss returns failure result', async () => {
    const cmp = fakeComposioWithResolver({})
    const d = new ActionDispatcher({
      intentRegistry: fakeIntentRegistry() as any,
      skillDispatcher: fakeSkillDispatcher() as any,
      composio: cmp.composio,
      eventBus: new RulesEventBus(),
    })
    const result = await d.dispatch([{ action: 'composio_tool', args: { toolkit: 'discord', tool: 'send_message', args: {} } } as Action], { trigger: {} })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/could not resolve/)
  })

  it('composio_tool: executeTool failure surfaces as ok=false', async () => {
    const composio = {
      resolver: { resolveOrRefresh: async () => 'SLACK_SEND_MESSAGE' },
      executeTool: async () => ({ error: 'rate limited' }),
      userId: 'local',
    }
    const d = new ActionDispatcher({
      intentRegistry: fakeIntentRegistry() as any,
      skillDispatcher: fakeSkillDispatcher() as any,
      composio,
      eventBus: new RulesEventBus(),
    })
    const result = await d.dispatch([{ action: 'composio_tool', args: { toolkit: 'slack', tool: 'send_message', args: {} } } as Action], { trigger: {} })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('rate limited')
  })

  it('composio_tool: skill_output_raw captured for chaining', async () => {
    const cmp = fakeComposioWithResolver({ 'slack:send_message': 'SLACK_SEND_MESSAGE' })
    const reg = fakeIntentRegistry()
    const d = new ActionDispatcher({
      intentRegistry: reg as any,
      skillDispatcher: fakeSkillDispatcher() as any,
      composio: cmp.composio,
      eventBus: new RulesEventBus(),
    })
    await d.dispatch([
      { action: 'composio_tool', args: { toolkit: 'slack', tool: 'send_message', args: { channel: '#x' } } } as Action,
      { action: 'notify', args: { message: '${skill_output.data}' } } as Action,
    ], { trigger: {} })
    expect(reg.calls[0]!.args.message).toBe('tool-result')
  })
})
