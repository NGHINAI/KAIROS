// Shim lifecycle: spawn daemon if not running, wait for ready, register/unregister.

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const READY_POLL_INTERVAL = 200  // ms
const READY_TIMEOUT = 15_000      // ms

/**
 * Ensure the daemon is running. If not, spawn it as a detached child.
 * Returns the daemon's port number.
 */
export async function ensureDaemonRunning(sandboxDir: string): Promise<number> {
  // Check if daemon is already running by looking for port.txt + health check
  const port = readPort(sandboxDir)
  if (port !== null) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(2000),
      })
      if (res.ok) return port // Already running
    } catch {
      // Not responding — need to spawn
    }
  }

  // Spawn daemon as detached process
  const bunPath = findBun()
  const daemonEntry = join(sandboxDir, 'src', 'daemon', 'index.ts')
  const proc = Bun.spawn(
    [bunPath, 'run', daemonEntry, '--sandbox', '--sandbox-dir', sandboxDir],
    {
      cwd: sandboxDir,
      stdout: 'ignore',
      stderr: 'ignore',
      stdin: 'ignore',
    },
  )
  proc.unref() // Don't wait for daemon to exit

  // Wait for ready flag
  const readyPath = join(sandboxDir, 'runtime', 'ready.flag')
  const start = Date.now()
  while (Date.now() - start < READY_TIMEOUT) {
    if (existsSync(readyPath)) {
      const newPort = readPort(sandboxDir)
      if (newPort !== null) return newPort
    }
    await Bun.sleep(READY_POLL_INTERVAL)
  }

  throw new Error(`KAIROS daemon failed to start within ${READY_TIMEOUT}ms`)
}

/**
 * Register this shim session with the daemon.
 */
export async function registerSession(
  port: number,
  info: { pid: number; cwd: string },
): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pid: info.pid,
      cwd: info.cwd,
      client_version: '0.1.0',
    }),
    signal: AbortSignal.timeout(5000),
  })

  if (!res.ok) throw new Error(`Failed to register: HTTP ${res.status}`)
  const data = (await res.json()) as { session_id: string }
  return data.session_id
}

/**
 * Unregister this shim session on shutdown.
 */
export async function unregisterSession(
  port: number,
  sessionId: string,
): Promise<void> {
  try {
    await fetch(`http://127.0.0.1:${port}/unregister`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId }),
      signal: AbortSignal.timeout(3000),
    })
  } catch {
    // Best-effort — if daemon is already gone, that's fine
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

function readPort(sandboxDir: string): number | null {
  const portPath = join(sandboxDir, 'runtime', 'port.txt')
  if (!existsSync(portPath)) return null
  try {
    const raw = readFileSync(portPath, 'utf8').trim()
    const port = parseInt(raw, 10)
    return isNaN(port) ? null : port
  } catch {
    return null
  }
}

function findBun(): string {
  // Try standard locations
  const candidates = [
    'bun',                                    // on PATH
    join(process.env.HOME ?? '~', '.bun', 'bin', 'bun'), // default install
    Bun.argv[0]!,                             // the bun that started us
  ]
  for (const c of candidates) {
    try {
      const which = Bun.spawnSync(['which', c])
      if (which.exitCode === 0) return c
    } catch { /* try next */ }
  }
  // Fallback: just use "bun" and hope it's on PATH
  return 'bun'
}
