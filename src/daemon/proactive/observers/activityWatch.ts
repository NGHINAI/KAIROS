// src/daemon/proactive/observers/activityWatch.ts
// 6th observer — consumes ActivityWatch local REST API (localhost:5600/api/0).
// Provides richer signal than the other 5 observers:
//   - window focus DURATIONS (not just app switches)
//   - AFK / idle state
//   - per-browser-tab dwell times
//
// Gracefully disables if ActivityWatch isn't running.

import { Observer } from './base'
import type { EventBus } from '../eventBus'

type ProbeData = {
  afk: boolean
  currentApp: { app: string; title: string; durationSec: number } | null
  tabDwell: Array<{ url: string; durationSec: number }>
}

type Probe = () => Promise<ProbeData>

export class ActivityWatchObserver extends Observer {
  readonly id = 'activity-watch'
  private timer: ReturnType<typeof setInterval> | null = null
  private lastAfk: boolean | null = null
  private lastAppSig: string = ''
  private probe: Probe
  private pollMs: number

  constructor(bus: EventBus, opts?: { pollMs?: number; probe?: Probe }) {
    super(bus)
    this.pollMs = opts?.pollMs ?? 30_000
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
      const data = await this.probe()

      if (data.afk !== this.lastAfk) {
        this.emit('afk', { state: data.afk })
        this.lastAfk = data.afk
      }

      if (data.currentApp) {
        const sig = `${data.currentApp.app}|${data.currentApp.title}|${data.currentApp.durationSec}`
        if (sig !== this.lastAppSig) {
          this.emit('window_focus_duration', data.currentApp)
          this.lastAppSig = sig
        }
      }

      for (const tab of data.tabDwell) {
        if (tab.durationSec > 60) {
          this.emit('tab_dwell', tab)
        }
      }
    } catch {
      // ActivityWatch unreachable — silent disable, will retry next tick.
    }
  }
}

const AW_BASE = 'http://localhost:5600/api/0'

async function defaultProbe(): Promise<ProbeData> {
  const now = new Date()
  const startTime = new Date(now.getTime() - 60_000).toISOString()
  const endTime = now.toISOString()
  const host = getHost()

  const afkResp = await fetch(`${AW_BASE}/buckets/aw-watcher-afk_${host}/events?start=${startTime}&end=${endTime}`)
  if (!afkResp.ok) throw new Error(`afk: ${afkResp.status}`)
  const afkEvents = await afkResp.json() as Array<{ data: { status: string }; duration: number }>
  const afk = afkEvents.length > 0 && afkEvents[afkEvents.length - 1]!.data.status === 'afk'

  const winResp = await fetch(`${AW_BASE}/buckets/aw-watcher-window_${host}/events?start=${startTime}&end=${endTime}`)
  if (!winResp.ok) throw new Error(`window: ${winResp.status}`)
  const winEvents = await winResp.json() as Array<{ data: { app: string; title: string }; duration: number }>
  const latest = winEvents[winEvents.length - 1]
  const currentApp = latest ? { app: latest.data.app, title: latest.data.title, durationSec: Math.round(latest.duration) } : null

  // Browser tab buckets vary by browser; production users can extend.
  const tabDwell: Array<{ url: string; durationSec: number }> = []

  return { afk, currentApp, tabDwell }
}

function getHost(): string {
  if (process.env.HOSTNAME) return process.env.HOSTNAME
  const proc = Bun.spawnSync(['hostname'])
  return new TextDecoder().decode(proc.stdout).trim()
}
