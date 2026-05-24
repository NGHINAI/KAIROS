// src/daemon/proactive/observers/focusApp.ts
import { Observer } from './base'
import type { EventBus } from '../eventBus'

type Probe = () => Promise<{ app: string; title?: string } | null>

const SCRIPT = `
  tell application "System Events"
    set frontApp to first application process whose frontmost is true
    set appName to name of frontApp
    try
      set winTitle to name of front window of frontApp
    on error
      set winTitle to ""
    end try
    return appName & "||" & winTitle
  end tell
`

export class FocusAppObserver extends Observer {
  readonly id = 'focus-app'
  private timer: ReturnType<typeof setInterval> | null = null
  private last: string | null = null
  private pollMs: number
  private probe: Probe

  constructor(bus: EventBus, opts?: { pollMs?: number; probe?: Probe }) {
    super(bus)
    this.pollMs = opts?.pollMs ?? 2000
    this.probe = opts?.probe ?? defaultProbe
  }

  protected onStart(): void {
    this.tick()
    this.timer = setInterval(() => this.tick(), this.pollMs)
  }

  protected onStop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private async tick(): Promise<void> {
    try {
      const r = await this.probe()
      if (!r) return
      const sig = `${r.app}||${r.title ?? ''}`
      if (sig === this.last) return
      this.last = sig
      this.emit('app_changed', { app: r.app, title: r.title })
    } catch { /* ignore poll error */ }
  }
}

async function defaultProbe(): Promise<{ app: string; title?: string } | null> {
  try {
    const proc = Bun.spawn(['osascript', '-e', SCRIPT], { stdout: 'pipe', stderr: 'pipe' })
    const exitCode = await proc.exited
    if (exitCode !== 0) return null
    const out = (await new Response(proc.stdout).text()).trim()
    const [app, title] = out.split('||')
    if (!app) return null
    return { app, title: title || undefined }
  } catch {
    return null
  }
}
