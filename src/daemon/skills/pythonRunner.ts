// src/daemon/skills/pythonRunner.ts
// Execute a Python skill in Composio's Workbench sandbox.
//
// Uses a SEPARATE Composio session from KAIROS's main one (which has workbench disabled).
// Sandbox captures the `output` variable (NOT stdout). Persistent session — sessionId cached.

import { homedir } from 'os'
import { join } from 'path'
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs'
import type { SkillExecutionResult } from './types'
import type { ComposioClient } from '../connectors/composioClient'

const DEFAULT_TIMEOUT_MS = 60_000

export type PythonRunnerOptions = {
  /** Path to a JSON file that caches the persistent skills-session sessionId. */
  session_cache_path?: string
  /** Default timeout for skill execution in ms. */
  timeout_ms?: number
}

export type PythonRunDeps = {
  composio: ComposioClient
  userId?: string                          // defaults to 'local'
}

type CachedSession = { sessionId: string; created_at: number }

export class PythonRunner {
  private sessionId: string | null = null
  private cachePath: string
  private timeoutMs: number

  constructor(
    private deps: PythonRunDeps,
    opts: PythonRunnerOptions = {},
  ) {
    this.cachePath = opts.session_cache_path
      ?? join(homedir(), '.kairos', 'skills', '.python-session.json')
    this.timeoutMs = opts.timeout_ms ?? DEFAULT_TIMEOUT_MS
  }

  /** Ensure a workbench-enabled session exists, resuming from cache if possible. */
  async ensureSession(): Promise<string> {
    if (this.sessionId) return this.sessionId

    // Try to resume cached sessionId
    if (existsSync(this.cachePath)) {
      try {
        const cached = JSON.parse(readFileSync(this.cachePath, 'utf8')) as CachedSession
        if (cached.sessionId) {
          try {
            const session = await (this.deps.composio.sdk as any).use(cached.sessionId)
            if (session) {
              this.sessionId = cached.sessionId
              return this.sessionId
            }
          } catch {
            // session expired or otherwise invalid — fall through to create
          }
        }
      } catch {
        // corrupted cache — ignore
      }
    }

    // Create new session with workbench enabled
    const userId = this.deps.userId ?? 'local'
    const session = await (this.deps.composio.sdk as any).create(userId, {
      toolkits: [],
      manageConnections: true,
      workbench: { enable: true },
    })

    const newId = (session as any).id ?? (session as any).session_id
    if (!newId) throw new Error('PythonRunner: composio.create did not return a sessionId')
    this.sessionId = newId

    // Persist to disk
    const dir = this.cachePath.substring(0, this.cachePath.lastIndexOf('/'))
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(this.cachePath, JSON.stringify({ sessionId: newId, created_at: Date.now() }, null, 2))

    return newId
  }

  /** Execute a Python skill. */
  async execute(
    scriptPath: string,
    args: Record<string, unknown>,
  ): Promise<SkillExecutionResult> {
    const startedAt = Date.now()
    try {
      const sessionId = await this.ensureSession()

      if (!existsSync(scriptPath)) {
        return {
          ok: false,
          error: `Python skill script not found: ${scriptPath}`,
          duration_ms: Date.now() - startedAt,
          sandbox: 'composio_workbench',
        }
      }

      const userScript = readFileSync(scriptPath, 'utf8')
      // Inject args + ensure `output` capture pattern
      const code = `import json
args = json.loads(${JSON.stringify(JSON.stringify(args))})

# ── user skill ────────────────────────────────────────────────
${userScript}
# ── /user skill ───────────────────────────────────────────────

# Composio Workbench captures the variable named \`output\`.
if 'output' not in dir():
    output = None
`

      // Use the persistent session to execute Python via the workbench bash/python tool
      const session = await (this.deps.composio.sdk as any).use(sessionId)

      // The session provides workbench tool execution. Call COMPOSIO_REMOTE_WORKBENCH
      // or whichever tool name exposes the Python sandbox.
      const result = await (session as any).execute({
        tool: 'COMPOSIO_REMOTE_WORKBENCH',
        arguments: { code },
        timeout_ms: this.timeoutMs,
      })

      // Result.data is the captured `output` variable. result.error / result.stderr if execution failed.
      if (result?.error) {
        return {
          ok: false,
          error: typeof result.error === 'string' ? result.error : JSON.stringify(result.error),
          duration_ms: Date.now() - startedAt,
          sandbox: 'composio_workbench',
        }
      }
      const output = result?.data
      return {
        ok: true,
        output: typeof output === 'string' ? output : JSON.stringify(output ?? null),
        duration_ms: Date.now() - startedAt,
        sandbox: 'composio_workbench',
      }
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        duration_ms: Date.now() - startedAt,
        sandbox: 'composio_workbench',
      }
    }
  }

  /** For debugging — returns the current sessionId. */
  getSessionId(): string | null { return this.sessionId }
}
