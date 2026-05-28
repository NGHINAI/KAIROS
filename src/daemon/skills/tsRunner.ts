// src/daemon/skills/tsRunner.ts
// Execute a TS skill in a Bun Worker with a hard timeout.
//
// SECURITY NOTE: Bun Workers are NOT a security sandbox. They share the OS process —
// full filesystem, network, and env access. This is acceptable for KAIROS because
// crystallized skills pass through Persona Gate review before being persisted to disk.

import type { SkillExecutionResult } from './types'

export type TsRunOptions = {
  /** Hard timeout in ms. Default 30000. */
  timeout_ms?: number
}

const DEFAULT_TIMEOUT_MS = 30_000

/** Embedded worker bootstrap (no separate file — Bun supports inline workers via blob URL or data URI). */
const WORKER_SCRIPT = `
self.onmessage = async (e) => {
  const { scriptPath, args } = e.data
  try {
    const mod = await import(scriptPath)
    if (typeof mod.default !== 'function') {
      self.postMessage({ ok: false, error: 'Skill script must export a default async function' })
      return
    }
    const result = await mod.default(args)
    self.postMessage({ ok: true, output: typeof result === 'string' ? result : JSON.stringify(result) })
  } catch (err) {
    self.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}
`

export class TsRunner {
  async execute(
    scriptPath: string,
    args: Record<string, unknown>,
    opts: TsRunOptions = {},
  ): Promise<SkillExecutionResult> {
    const timeoutMs = opts.timeout_ms ?? DEFAULT_TIMEOUT_MS
    const startedAt = Date.now()

    let worker: Worker | undefined
    let workerUrl: string | undefined

    try {
      // Use a Blob URL to host the worker script inline (no temp file needed)
      const blob = new Blob([WORKER_SCRIPT], { type: 'application/javascript' })
      workerUrl = URL.createObjectURL(blob)
      worker = new Worker(workerUrl, { type: 'module' })
    } catch (err) {
      return {
        ok: false,
        error: 'TsRunner: failed to create worker — ' + (err instanceof Error ? err.message : String(err)),
        duration_ms: Date.now() - startedAt,
        sandbox: 'ts_worker',
      }
    }

    const capturedWorker = worker
    const capturedWorkerUrl = workerUrl

    let settled = false
    return new Promise<SkillExecutionResult>((resolve) => {
      const finish = (result: SkillExecutionResult) => {
        if (settled) return
        settled = true
        try { capturedWorker.terminate() } catch { /* ignore */ }
        if (capturedWorkerUrl) {
          try { URL.revokeObjectURL(capturedWorkerUrl) } catch { /* ignore */ }
        }
        resolve(result)
      }

      const timer = setTimeout(() => {
        finish({
          ok: false,
          error: `TsRunner: timeout after ${timeoutMs}ms`,
          duration_ms: Date.now() - startedAt,
          sandbox: 'ts_worker',
        })
      }, timeoutMs)

      capturedWorker.onmessage = (e: MessageEvent) => {
        clearTimeout(timer)
        const data = (e.data ?? {}) as { ok: boolean; output?: string; error?: string }
        finish({
          ok: !!data.ok,
          output: data.output,
          error: data.error,
          duration_ms: Date.now() - startedAt,
          sandbox: 'ts_worker',
        })
      }

      capturedWorker.onerror = (e: ErrorEvent) => {
        clearTimeout(timer)
        finish({
          ok: false,
          error: 'TsRunner: ' + (e.message ?? 'worker error'),
          duration_ms: Date.now() - startedAt,
          sandbox: 'ts_worker',
        })
      }

      capturedWorker.postMessage({ scriptPath, args })
    })
  }
}
