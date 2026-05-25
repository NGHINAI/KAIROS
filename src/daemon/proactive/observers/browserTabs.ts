// src/daemon/proactive/observers/browserTabs.ts
import { Observer } from './base'
import type { EventBus } from '../eventBus'

type Probe = () => Promise<{ browser: string; tabs: string[] } | null>

const SCRIPTS: Record<string, string> = {
  Arc: `
    tell application "Arc"
      set urls to {}
      repeat with w in windows
        repeat with t in tabs of w
          set end of urls to URL of t
        end repeat
      end repeat
      set AppleScript's text item delimiters to linefeed
      return urls as text
    end tell
  `,
  'Google Chrome': `
    tell application "Google Chrome"
      set urls to {}
      repeat with w in windows
        repeat with t in tabs of w
          set end of urls to URL of t
        end repeat
      end repeat
      set AppleScript's text item delimiters to linefeed
      return urls as text
    end tell
  `,
  Safari: `
    tell application "Safari"
      set urls to {}
      repeat with w in windows
        repeat with t in tabs of w
          set end of urls to URL of t
        end repeat
      end repeat
      set AppleScript's text item delimiters to linefeed
      return urls as text
    end tell
  `,
}

export class BrowserTabsObserver extends Observer {
  readonly id = 'browser-tabs'
  private timer: ReturnType<typeof setInterval> | null = null
  private lastSig: string = ''
  private pollMs: number
  private probe: Probe

  constructor(bus: EventBus, opts?: { pollMs?: number; probe?: Probe }) {
    super(bus)
    this.pollMs = opts?.pollMs ?? 10_000
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
      const r = await this.probe()
      if (!r) return
      const sig = `${r.browser}|${r.tabs.join('|')}`
      if (sig === this.lastSig) return
      this.lastSig = sig
      this.emit('tabs_changed', { browser: r.browser, tabs: r.tabs })
    } catch { /* ignore */ }
  }
}

async function defaultProbe(): Promise<{ browser: string; tabs: string[] } | null> {
  for (const [browser, script] of Object.entries(SCRIPTS)) {
    try {
      const proc = Bun.spawn(['osascript', '-e', script], { stdout: 'pipe', stderr: 'pipe' })
      const exitCode = await proc.exited
      if (exitCode !== 0) continue
      const out = (await new Response(proc.stdout).text()).trim()
      if (!out) continue
      const tabs = out.split('\n').map(s => s.trim()).filter(Boolean)
      if (tabs.length === 0) continue
      return { browser, tabs }
    } catch { continue }
  }
  return null
}
