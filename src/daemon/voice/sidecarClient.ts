// src/daemon/voice/sidecarClient.ts
// Real Swift sidecar client over stdin/stdout JSON lines. Spawn → wire → done.
// Implements the same `SidecarLike` interface as `SidecarSimulator`.

import type { Subprocess } from 'bun'
import type { SidecarCmd, SidecarEvent } from './types'

export type EventHandler = (e: SidecarEvent) => void

export type SidecarClientOpts = {
  helperBinary: string
  spawnTimeoutMs?: number
  /** Override of env vars passed to the sidecar process */
  env?: Record<string, string>
}

export class SidecarClient {
  private child: Subprocess | null = null
  private handlers: EventHandler[] = []
  private buffer = ''

  constructor(private opts: SidecarClientOpts) {}

  onEvent(h: EventHandler): void { this.handlers.push(h) }

  async start(): Promise<void> {
    this.child = Bun.spawn({
      cmd: [this.opts.helperBinary],
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'inherit',
      env: { ...process.env, ...this.opts.env },
    })
    void this.runReader()

    // Wait for sidecar_ready (with timeout)
    const timeoutMs = this.opts.spawnTimeoutMs ?? 5000
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('sidecar did not signal ready')), timeoutMs)
      this.handlers.push((e) => {
        if (e.event === 'sidecar_ready') { clearTimeout(t); resolve() }
      })
    })
  }

  async stop(): Promise<void> {
    try { await this.send({ cmd: 'shutdown' } as any) } catch { /* swallow */ }
    if (this.child) {
      try { this.child.kill() } catch { /* swallow */ }
      this.child = null
    }
  }

  async send(cmd: SidecarCmd): Promise<void> {
    if (!this.child) throw new Error('SidecarClient: not started')
    const line = JSON.stringify(cmd) + '\n'
    const stdin = this.child.stdin as any
    if (typeof stdin.write === 'function') {
      stdin.write(line)
      if (typeof stdin.flush === 'function') stdin.flush()
    } else {
      throw new Error('SidecarClient: stdin not writable')
    }
  }

  private async runReader(): Promise<void> {
    if (!this.child) return
    const decoder = new TextDecoder()
    const reader = (this.child.stdout as ReadableStream).getReader()
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        this.buffer += decoder.decode(value, { stream: true })
        let idx: number
        while ((idx = this.buffer.indexOf('\n')) !== -1) {
          const line = this.buffer.slice(0, idx)
          this.buffer = this.buffer.slice(idx + 1)
          if (!line.trim()) continue
          try {
            const event = JSON.parse(line) as SidecarEvent
            for (const h of this.handlers) {
              try { h(event) } catch { /* swallow handler errors */ }
            }
          } catch { /* malformed line — skip */ }
        }
      }
    } catch { /* reader closed */ }
  }
}
