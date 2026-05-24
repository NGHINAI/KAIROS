// Simple logger for the KAIROS daemon.
// Writes to state/logs/daemon.log + stdout (in verbose mode).

import { appendFileSync, mkdirSync } from 'fs'
import { join } from 'path'

let logFilePath: string | null = null
let ticksLogPath: string | null = null
let verboseMode = false

export function initLogger(opts: { logDir: string; verbose: boolean }): void {
  mkdirSync(opts.logDir, { recursive: true })
  logFilePath = join(opts.logDir, 'daemon.log')
  ticksLogPath = join(opts.logDir, 'ticks.log')
  verboseMode = opts.verbose
}

function formatTime(): string {
  return new Date().toLocaleTimeString('en-US', { hour12: false })
}

function formatIso(): string {
  return new Date().toISOString()
}

export function log(msg: string, level: 'info' | 'warn' | 'error' = 'info'): void {
  const ts = formatIso()
  const line = `[${ts}] [${level}] ${msg}`

  // Always log errors to stdout; info/warn only in verbose mode
  if (verboseMode || level === 'error') {
    const prefix = level === 'error' ? '✗' : level === 'warn' ? '⚠' : '·'
    console.log(`  [${formatTime()}] ${prefix} ${msg}`)
  }

  if (logFilePath) {
    try {
      appendFileSync(logFilePath, line + '\n')
    } catch {
      // If we can't write to log, don't crash the daemon
    }
  }
}

export function logTick(msg: string): void {
  const ts = formatIso()
  const line = `[${ts}] ${msg}`

  if (verboseMode) {
    console.log(`  [${formatTime()}] ⏱ ${msg}`)
  }

  if (ticksLogPath) {
    try {
      appendFileSync(ticksLogPath, line + '\n')
    } catch {
      // Don't crash
    }
  }
}

export function logError(msg: string, err?: unknown): void {
  const errMsg = err instanceof Error ? err.message : String(err ?? '')
  log(`${msg}${errMsg ? ': ' + errMsg : ''}`, 'error')
}
