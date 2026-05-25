// src/daemon/proactive/observers/clipboard.ts
import { Observer } from './base'
import type { EventBus } from '../eventBus'

type Probe = () => Promise<string>

export class ClipboardObserver extends Observer {
  readonly id = 'clipboard'
  private timer: ReturnType<typeof setInterval> | null = null
  private last: string = ''
  private pollMs: number
  private probe: Probe

  constructor(bus: EventBus, opts?: { pollMs?: number; probe?: Probe }) {
    super(bus)
    this.pollMs = opts?.pollMs ?? 5000
    this.probe = opts?.probe ?? defaultProbe
  }

  protected onStart(): void {
    this.tick()
    this.timer = setInterval(() => this.tick(), this.pollMs)
  }

  protected onStop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }

  private async tick(): Promise<void> {
    try {
      const content = await this.probe()
      if (!content || content === this.last) return
      this.last = content
      this.emit('changed', { text: content, length: content.length })
    } catch { /* ignore */ }
  }
}

async function defaultProbe(): Promise<string> {
  const proc = Bun.spawn(['pbpaste'], { stdout: 'pipe' })
  await proc.exited
  return (await new Response(proc.stdout).text())
}
