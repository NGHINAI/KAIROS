// src/daemon/mcp/toolToIntent.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { IntentRegistry } from '../agency/intentRegistry'
import { registerMcpToolsAsIntents } from './toolToIntent'
import type { McpHost } from './mcpHost'
import type { McpToolDescriptor, McpToolCallResult } from './types'

function fakeHost(tools: McpToolDescriptor[], invokeResult: McpToolCallResult): Pick<McpHost, 'listAllTools' | 'invokeTool'> {
  return {
    listAllTools: () => tools,
    invokeTool: async () => invokeResult,
  }
}

describe('registerMcpToolsAsIntents', () => {
  let registry: IntentRegistry

  beforeEach(() => { registry = new IntentRegistry() })

  it('registers each tool as an intent with id = qualified_id', () => {
    const host = fakeHost([
      { server_id: 'a', tool_name: 'echo', qualified_id: 'a::echo', description: 'echo', input_schema: {}, tier: 'GREEN' },
      { server_id: 'b', tool_name: 'send', qualified_id: 'b::send', description: 'send', input_schema: {}, tier: 'ORANGE' },
    ], { ok: true, output_text: 'done' })
    registerMcpToolsAsIntents(registry, host as McpHost)
    expect(registry.get('a::echo')).toBeTruthy()
    expect(registry.get('b::send')).toBeTruthy()
    expect(registry.get('a::echo')?.tier).toBe('GREEN')
    expect(registry.get('b::send')?.tier).toBe('ORANGE')
  })

  it('handler invokes mcpHost.invokeTool and returns success result', async () => {
    const host = fakeHost([
      { server_id: 'a', tool_name: 'echo', qualified_id: 'a::echo', description: 'echo', input_schema: {}, tier: 'GREEN' },
    ], { ok: true, output_text: 'echoed!' })
    registerMcpToolsAsIntents(registry, host as McpHost)
    const entry = registry.get('a::echo')!
    const result = await entry.handler({ msg: 'x' }, {} as any)
    expect(result.status).toBe('success')
    expect(result.details).toContain('echoed!')
  })

  it('handler returns failure on tool error', async () => {
    const host = fakeHost([
      { server_id: 'a', tool_name: 'broken', qualified_id: 'a::broken', description: '', input_schema: {}, tier: 'GREEN' },
    ], { ok: false, error: 'kaboom' })
    registerMcpToolsAsIntents(registry, host as McpHost)
    const entry = registry.get('a::broken')!
    const result = await entry.handler({}, {} as any)
    expect(result.status).toBe('failure')
    expect(result.details).toContain('kaboom')
  })

  it('skips re-registration when called twice (idempotent)', () => {
    const host = fakeHost([
      { server_id: 'a', tool_name: 'echo', qualified_id: 'a::echo', description: '', input_schema: {}, tier: 'GREEN' },
    ], { ok: true })
    registerMcpToolsAsIntents(registry, host as McpHost)
    expect(() => registerMcpToolsAsIntents(registry, host as McpHost)).not.toThrow()
    expect(registry.list().filter(e => e.id === 'a::echo').length).toBe(1)
  })

  it('extracts simple type schema from MCP JSON Schema', async () => {
    const host = fakeHost([
      {
        server_id: 'srv', tool_name: 'tool', qualified_id: 'srv::tool', description: '',
        input_schema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            count: { type: 'number' },
            opts: { type: 'array' },
          },
        },
        tier: 'GREEN',
      },
    ], { ok: true })
    registerMcpToolsAsIntents(registry, host as McpHost)
    const entry = registry.get('srv::tool')!
    expect(entry.intent.argSchema.name).toBe('string')
    expect(entry.intent.argSchema.count).toBe('number')
    expect(entry.intent.argSchema.opts).toBe('object')   // array → opaque object
  })
})
