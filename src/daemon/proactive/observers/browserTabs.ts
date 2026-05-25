// src/daemon/proactive/observers/browserTabs.ts
//
// IMPORTANT — `tell application "Foo"` will LAUNCH the application if it's
// not already running (the cause of "Chrome opened by itself" reports).
// Each script must first check `application "Foo" is running` via
// System Events, and only `tell` if true. The wrapper template handles this.

import { Observer } from './base'
import type { EventBus } from '../eventBus'

type Probe = () => Promise<{ browser: string; tabs: string[] } | null>

/**
 * Wrap a browser-specific tabs script so it only runs if the browser is
 * already running — never launch it as a side effect of polling.
 */
function guardedScript(appName: string, tabsBody: string): string {
  return `
    tell application "System Events"
      if not (exists (processes whose name is "${appName}")) then
        return ""
      end if
    end tell
    tell application "${appName}"
      ${tabsBody}
    end tell
  `
}

const TABS_BODY = `
  set urls to {}
  repeat with w in windows
    repeat with t in tabs of w
      set end of urls to URL of t
    end repeat
  end repeat
  set AppleScript's text item delimiters to linefeed
  return urls as text
`

const SCRIPTS: Record<string, string> = {
  Arc: guardedScript('Arc', TABS_BODY),
  'Google Chrome': guardedScript('Google Chrome', TABS_BODY),
  Safari: guardedScript('Safari', TABS_BODY),
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
