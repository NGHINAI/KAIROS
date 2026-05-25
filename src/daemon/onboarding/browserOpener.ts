// Safe wrapper around macOS `open URL`. Allowlist: only http(s) schemes.
// Used by SetupFlowRuntime to open OAuth pages, token-creation pages, etc.

import { logError } from '../logger'

type ProbeResult = { ok: boolean; stdout: string; stderr: string }
type Probe = (cmd: string[]) => Promise<ProbeResult>

export type BrowserOpenerOptions = {
  probe?: Probe
}

export class BrowserOpener {
  private probe: Probe

  constructor(opts?: BrowserOpenerOptions) {
    this.probe = opts?.probe ?? defaultProbe
  }

  async open(url: string): Promise<void> {
    if (!/^https?:\/\//i.test(url)) {
      throw new Error(`BrowserOpener: disallowed URL scheme: ${url.slice(0, 100)}`)
    }
    const result = await this.probe(['open', url])
    if (!result.ok) {
      throw new Error(`BrowserOpener: open failed: ${result.stderr.slice(0, 200)}`)
    }
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
    logError('BrowserOpener probe failed', err)
    return { ok: false, stdout: '', stderr: String(err) }
  }
}
