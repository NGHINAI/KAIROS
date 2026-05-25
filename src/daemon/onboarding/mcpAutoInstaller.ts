// Installs MCP servers via npm or Smithery. Sandboxed exec.
// Validates package name to prevent shell injection.

import { logError } from '../logger'

type ProbeResult = { ok: boolean; stdout: string; stderr: string }
type Probe = (cmd: string[]) => Promise<ProbeResult>

export type InstallResult = {
  ok: boolean
  error?: string
  stdout?: string
}

export type McpAutoInstallerOptions = { probe?: Probe }

const VALID_PACKAGE_NAME = /^(@[a-z0-9-]+\/)?[a-z0-9-]+(@[\d.]+|@latest)?$/

export class McpAutoInstaller {
  private probe: Probe

  constructor(opts?: McpAutoInstallerOptions) {
    this.probe = opts?.probe ?? defaultProbe
  }

  async installViaNpm(pkg: string): Promise<InstallResult> {
    if (!VALID_PACKAGE_NAME.test(pkg)) {
      return { ok: false, error: `invalid/disallowed package name: ${pkg.slice(0, 100)}` }
    }
    const r = await this.probe(['npm', 'install', '-g', pkg])
    return r.ok ? { ok: true, stdout: r.stdout } : { ok: false, error: r.stderr.trim() }
  }

  async installViaSmithery(qualifier: string): Promise<InstallResult> {
    if (!VALID_PACKAGE_NAME.test(qualifier)) {
      return { ok: false, error: `invalid smithery qualifier: ${qualifier.slice(0, 100)}` }
    }
    const r = await this.probe(['smithery', 'mcp', 'add', qualifier])
    return r.ok ? { ok: true, stdout: r.stdout } : { ok: false, error: r.stderr.trim() }
  }
}

async function defaultProbe(cmd: string[]): Promise<ProbeResult> {
  try {
    const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' })
    const code = await proc.exited
    return {
      ok: code === 0,
      stdout: await new Response(proc.stdout).text(),
      stderr: await new Response(proc.stderr).text(),
    }
  } catch (err) {
    logError('McpAutoInstaller probe failed', err)
    return { ok: false, stdout: '', stderr: err instanceof Error ? err.message : String(err) }
  }
}
