import { describe, it, expect } from 'bun:test'
import { McpAutoInstaller } from './mcpAutoInstaller'

describe('McpAutoInstaller', () => {
  it('installs via npm with success', async () => {
    const calls: string[][] = []
    const installer = new McpAutoInstaller({
      probe: async (cmd) => { calls.push(cmd); return { ok: true, stdout: 'added 1 package', stderr: '' } },
    })
    const result = await installer.installViaNpm('@modelcontextprotocol/server-filesystem')
    expect(result.ok).toBe(true)
    expect(calls[0]).toContain('npm')
    expect(calls[0]).toContain('install')
    expect(calls[0]).toContain('-g')
    expect(calls[0]).toContain('@modelcontextprotocol/server-filesystem')
  })

  it('returns failure with error message on install failure', async () => {
    const installer = new McpAutoInstaller({
      probe: async () => ({ ok: false, stdout: '', stderr: 'EACCES' }),
    })
    const result = await installer.installViaNpm('bogus')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('EACCES')
  })

  it('installs via smithery when chosen', async () => {
    const calls: string[][] = []
    const installer = new McpAutoInstaller({
      probe: async (cmd) => { calls.push(cmd); return { ok: true, stdout: '', stderr: '' } },
    })
    await installer.installViaSmithery('github')
    expect(calls[0]).toContain('smithery')
    expect(calls[0]).toContain('add')
  })

  it('rejects suspicious package names', async () => {
    const installer = new McpAutoInstaller()
    const result = await installer.installViaNpm('rm -rf /')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/invalid|disallowed/i)
  })
})
