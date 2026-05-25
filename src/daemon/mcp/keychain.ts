// macOS keychain wrapper using /usr/bin/security CLI. No native binding
// required. Secrets never written to disk by KAIROS — they live in the
// system keychain and are injected as env vars at MCP server spawn time.

import { logError } from '../logger'

type ProbeResult = { ok: boolean; stdout: string; stderr: string }
type Probe = (cmd: string[]) => Promise<ProbeResult>

export type KeychainOptions = {
  probe?: Probe
}

export class Keychain {
  private probe: Probe

  constructor(opts?: KeychainOptions) {
    this.probe = opts?.probe ?? defaultProbe
  }

  async get(service: string, account: string): Promise<string | null> {
    const result = await this.probe(['security', 'find-generic-password', '-s', service, '-a', account, '-w'])
    if (!result.ok) return null
    return result.stdout.trim()
  }

  async set(service: string, account: string, value: string): Promise<void> {
    await this.probe(['security', 'delete-generic-password', '-s', service, '-a', account])
    const result = await this.probe(['security', 'add-generic-password', '-s', service, '-a', account, '-w', value])
    if (!result.ok) {
      throw new Error(`Keychain set failed: ${result.stderr.slice(0, 200)}`)
    }
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
    logError('Keychain probe failed', err)
    return { ok: false, stdout: '', stderr: String(err) }
  }
}
