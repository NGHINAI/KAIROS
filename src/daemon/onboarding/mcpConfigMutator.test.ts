import { describe, it, expect, beforeEach } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { McpConfigMutator } from './mcpConfigMutator'

describe('McpConfigMutator', () => {
  let tmp: string
  let configPath: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kairos-mcpcfg-'))
    configPath = join(tmp, 'mcp-servers.json')
    writeFileSync(configPath, JSON.stringify({ servers: [] }))
  })

  it('adds a new server entry', () => {
    const m = new McpConfigMutator(configPath)
    m.addServer({
      id: 'github',
      enabled: true,
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_TOKEN: 'placeholder' },
      tier_policy: { default: 'YELLOW' },
    } as any)
    const content = JSON.parse(readFileSync(configPath, 'utf8'))
    expect(content.servers.length).toBe(1)
    expect(content.servers[0].id).toBe('github')
    rmSync(tmp, { recursive: true })
  })

  it('throws when adding duplicate id', () => {
    const m = new McpConfigMutator(configPath)
    m.addServer({ id: 'a', enabled: true, transport: 'stdio', tier_policy: { default: 'GREEN' } } as any)
    expect(() => m.addServer({ id: 'a', enabled: true, transport: 'stdio', tier_policy: { default: 'GREEN' } } as any))
      .toThrow(/already exists/i)
    rmSync(tmp, { recursive: true })
  })

  it('updateServer modifies an existing entry', () => {
    const m = new McpConfigMutator(configPath)
    m.addServer({ id: 'a', enabled: false, transport: 'stdio', tier_policy: { default: 'GREEN' } } as any)
    m.updateServer('a', s => ({ ...s, enabled: true }))
    const content = JSON.parse(readFileSync(configPath, 'utf8'))
    expect(content.servers[0].enabled).toBe(true)
    rmSync(tmp, { recursive: true })
  })

  it('removeServer drops the entry', () => {
    const m = new McpConfigMutator(configPath)
    m.addServer({ id: 'a', enabled: true, transport: 'stdio', tier_policy: { default: 'GREEN' } } as any)
    m.removeServer('a')
    const content = JSON.parse(readFileSync(configPath, 'utf8'))
    expect(content.servers.length).toBe(0)
    rmSync(tmp, { recursive: true })
  })

  it('snapshot + restore reverts changes', () => {
    const m = new McpConfigMutator(configPath)
    const snap = m.snapshot()
    m.addServer({ id: 'a', enabled: true, transport: 'stdio', tier_policy: { default: 'GREEN' } } as any)
    m.restore(snap)
    const content = JSON.parse(readFileSync(configPath, 'utf8'))
    expect(content.servers.length).toBe(0)
    rmSync(tmp, { recursive: true })
  })
})
