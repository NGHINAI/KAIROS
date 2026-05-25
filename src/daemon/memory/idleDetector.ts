// src/daemon/memory/idleDetector.ts
// macOS idle + power source detection. Consolidation (dreaming) only runs
// when the user has been idle long enough AND the laptop is on AC.

type ProbeResult = { idleMs: number; onAC: boolean }
type Probe = () => Promise<ProbeResult>

export type IdleDetectorOptions = {
  idleThresholdMs?: number
  probe?: Probe
}

export class IdleDetector {
  private idleThresholdMs: number
  private probe: Probe

  constructor(opts?: IdleDetectorOptions) {
    this.idleThresholdMs = opts?.idleThresholdMs ?? 20 * 60_000
    this.probe = opts?.probe ?? defaultProbe
  }

  async idleMs(): Promise<number> {
    return (await this.probe()).idleMs
  }

  async onACPower(): Promise<boolean> {
    return (await this.probe()).onAC
  }

  async shouldDream(): Promise<boolean> {
    const { idleMs, onAC } = await this.probe()
    return idleMs >= this.idleThresholdMs && onAC
  }
}

async function defaultProbe(): Promise<ProbeResult> {
  const [idleMs, onAC] = await Promise.all([readIdleMs(), readOnAC()])
  return { idleMs, onAC }
}

async function readIdleMs(): Promise<number> {
  try {
    const proc = Bun.spawn(
      ['sh', '-c', "ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print $NF/1000000; exit}'"],
      { stdout: 'pipe' },
    )
    await proc.exited
    const out = (await new Response(proc.stdout).text()).trim()
    const sec = parseFloat(out)
    return Number.isFinite(sec) ? Math.round(sec * 1000) : 0
  } catch {
    return 0
  }
}

async function readOnAC(): Promise<boolean> {
  try {
    const proc = Bun.spawn(['pmset', '-g', 'batt'], { stdout: 'pipe' })
    await proc.exited
    const out = await new Response(proc.stdout).text()
    return /AC Power/i.test(out)
  } catch {
    return false
  }
}
