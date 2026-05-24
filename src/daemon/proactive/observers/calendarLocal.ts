// src/daemon/proactive/observers/calendarLocal.ts
import { Observer } from './base'
import type { EventBus } from '../eventBus'
import type { CalendarItem } from '../stateSnapshot'

type Probe = () => Promise<CalendarItem[]>

export class CalendarLocalObserver extends Observer {
  readonly id = 'calendar-local'
  private timer: ReturnType<typeof setInterval> | null = null
  private lastSig: string = ''
  private pollMs: number
  private probe: Probe

  constructor(bus: EventBus, opts?: { pollMs?: number; probe?: Probe }) {
    super(bus)
    this.pollMs = opts?.pollMs ?? 5 * 60_000
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
      const events = await this.probe()
      const sig = events.map(e => `${e.title}@${e.start}`).join('|')
      if (sig === this.lastSig) return
      this.lastSig = sig
      this.emit('upcoming', { events })
    } catch { /* ignore */ }
  }
}

async function defaultProbe(): Promise<CalendarItem[]> {
  try {
    const ical = Bun.spawn(['icalbuddy', '-nc', '-nrd', '-iep', 'title,datetime', 'eventsToday+1'], {
      stdout: 'pipe', stderr: 'pipe',
    })
    const code = await ical.exited
    if (code === 0) {
      const out = await new Response(ical.stdout).text()
      return parseIcalBuddy(out)
    }
  } catch { /* fall through */ }
  return []
}

function parseIcalBuddy(out: string): CalendarItem[] {
  const items: CalendarItem[] = []
  const blocks = out.split(/\n(?=•)/)
  for (const block of blocks) {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean)
    if (lines.length === 0) continue
    const title = lines[0]!.replace(/^•\s*/, '')
    const datetimeLine = lines[1]
    let start = Date.now()
    if (datetimeLine) {
      const t = Date.parse(datetimeLine)
      if (!Number.isNaN(t)) start = t
    }
    items.push({ title, start })
  }
  return items
}
