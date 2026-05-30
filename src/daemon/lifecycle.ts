// Daemon lifecycle management: PID lock, port file, ready flag,
// directory creation, signal handling, and clean shutdown.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { log, logError } from './logger'
import type { Config } from './types'

/**
 * Ensure all required directories exist under the sandbox root.
 */
export function ensureDirs(sandboxDir: string): void {
  const dirs = [
    'state',
    'state/inbox',
    'state/pending-approvals',
    'state/approved',
    'state/tasks',
    'state/logs',
    'runtime',
    'bin',
  ]
  for (const dir of dirs) {
    mkdirSync(join(sandboxDir, dir), { recursive: true })
  }
}

/**
 * Check if another daemon is already running. Returns true if one is alive.
 */
export function checkExistingDaemon(sandboxDir: string): boolean {
  const pidFile = join(sandboxDir, 'runtime', 'daemon.pid')
  if (!existsSync(pidFile)) return false

  try {
    const pid = parseInt(readFileSync(pidFile, 'utf8').trim())
    if (isNaN(pid)) {
      unlinkSync(pidFile)
      return false
    }
    // Check if process is alive
    process.kill(pid, 0) // Signal 0 = just check, don't actually kill
    return true // Process is alive
  } catch {
    // Process is dead — stale pidfile
    try { unlinkSync(pidFile) } catch { /* ignore */ }
    return false
  }
}

/**
 * Write the PID file so other processes can find us.
 */
export function writePidFile(sandboxDir: string): void {
  writeFileSync(join(sandboxDir, 'runtime', 'daemon.pid'), process.pid.toString())
}

/**
 * Write the port file so the shim can find us.
 */
export function writePortFile(sandboxDir: string, port: number): void {
  writeFileSync(join(sandboxDir, 'runtime', 'port.txt'), port.toString())
}

/**
 * Touch the ready flag so the shim knows we're fully initialized.
 */
export function writeReadyFlag(sandboxDir: string): void {
  writeFileSync(join(sandboxDir, 'runtime', 'ready.flag'), '')
}

/**
 * Clean up runtime files on shutdown.
 */
export function cleanupRuntime(sandboxDir: string): void {
  const files = ['runtime/daemon.pid', 'runtime/port.txt', 'runtime/ready.flag']
  for (const f of files) {
    try { unlinkSync(join(sandboxDir, f)) } catch { /* ignore */ }
  }
}

/**
 * Pick a port. Random ephemeral in sandbox mode, fixed (default 8765) in production.
 * Port 9876 is reserved for the wrap-API server (Electron WS hardcodes it).
 */
export function pickPort(config: Config): number {
  if (config.port === 'random') {
    return Math.floor(Math.random() * (65535 - 48000)) + 48000
  }
  return config.port
}

/**
 * Set up signal handlers for graceful shutdown.
 */
export function setupSignalHandlers(onShutdown: () => void): void {
  let shuttingDown = false

  const handler = (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    log(`Received ${signal}. Shutting down gracefully.`)
    onShutdown()
  }

  process.on('SIGTERM', () => handler('SIGTERM'))
  process.on('SIGINT', () => handler('SIGINT'))

  // Handle uncaught errors — log but don't crash
  process.on('uncaughtException', (err) => {
    logError('Uncaught exception', err)
    // Don't exit — let the daemon keep running
  })

  process.on('unhandledRejection', (err) => {
    logError('Unhandled rejection', err)
  })
}

/**
 * Perform a graceful shutdown: close DB, stop server, clean up runtime files.
 */
export function gracefulShutdown(opts: {
  sandboxDir: string
  db: import('bun:sqlite').Database
  server: ReturnType<typeof Bun.serve>
}): void {
  log('Cleaning up...')

  try { opts.server.stop() } catch { /* ignore */ }
  try { opts.db.close() } catch { /* ignore */ }
  cleanupRuntime(opts.sandboxDir)

  log('Shutdown complete.')
  process.exit(0)
}
