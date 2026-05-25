// src/daemon/mcp/smithery.ts
// Shell wrapper for @smithery/cli. Used for dynamic MCP server
// discovery + install. Gracefully degrades if smithery is not on PATH.

import { logError } from '../logger'
import type { SmitherySearchHit } from './types'

type ProbeResult = { ok: boolean; stdout: string; stderr: string }
type Probe = (cmd: string[]) => Promise<ProbeResult>

export type SmitheryCliOptions = {
  probe?: Probe
}

export class SmitheryCli {
  private probe: Probe

  constructor(opts?: SmitheryCliOptions) {
    this.probe = opts?.probe ?? defaultProbe
  }

  async isAvailable(): Promise<boolean> {
    const r = await this.probe(['smithery', '--version'])
    return r.ok
  }

  async search(query: string): Promise<SmitherySearchHit[]> {
    const r = await this.probe(['smithery', 'mcp', 'search', query, '--json'])
    if (!r.ok) return []
    try {
      const items = JSON.parse(r.stdout) as Array<{
        qualifiedName?: string; name?: string; description?: string;
        installCount?: number; url?: string
      }>
      return items.map(i => ({
        name: i.name ?? '',
        qualified_name: i.qualifiedName ?? i.name ?? '',
        description: i.description ?? '',
        install_count: i.installCount,
        url: i.url ?? '',
      }))
    } catch (err) {
      logError('SmitheryCli: search parse failed', err)
      return []
    }
  }

  async add(target: string): Promise<{ ok: boolean; error?: string }> {
    const r = await this.probe(['smithery', 'mcp', 'add', target])
    if (!r.ok) return { ok: false, error: r.stderr.trim() || 'unknown' }
    return { ok: true }
  }
}

async function defaultProbe(cmd: string[]): Promise<ProbeResult> {
  try {
    const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' })
    const code = await proc.exited
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    return { ok: code === 0, stdout, stderr }
  } catch (err) {
    return { ok: false, stdout: '', stderr: err instanceof Error ? err.message : String(err) }
  }
}
