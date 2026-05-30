// src/daemon/voice/sayBackend.ts
// Stage-0 voice backend. Uses macOS's built-in `say` command, which under the hood
// drives the same AVSpeechSynthesizer engine the Swift sidecar will use. This lets
// us hear KAIROS speak on day one without Xcode/codesigning/TCC prompts.
//
// When the Swift sidecar ships, KAIROS_VOICE_BACKEND=sidecar swaps the impl. Same
// interface; this file becomes the fallback for users who can't grant TCC.

import { spawn } from 'bun'

export type RunResult = { exitCode: number; stdout?: string }
export type Runner = (cmd: string[], opts?: { signal?: AbortSignal; stdout?: 'pipe' | 'inherit' }) => Promise<RunResult>

const defaultRunner: Runner = async (cmd, opts) => {
  const proc = spawn({ cmd, stdout: opts?.stdout ?? 'pipe', stderr: 'ignore', signal: opts?.signal })
  const stdoutText =
    opts?.stdout === 'pipe' || opts?.stdout === undefined
      ? await new Response(proc.stdout as any).text()
      : undefined
  const exitCode = await proc.exited
  return { exitCode, stdout: stdoutText }
}

export type SayBackendDeps = {
  runner?: Runner
  defaultVoice?: string
  defaultRate?: number
}

export type SpeakOptions = { voice?: string; rate?: number }
export type Voice = { name: string; language: string; sample?: string }

export class SayBackend {
  private runner: Runner
  private defaultVoice: string
  private defaultRate: number
  private activeAbort: AbortController | null = null

  constructor(deps: SayBackendDeps = {}) {
    this.runner = deps.runner ?? defaultRunner
    this.defaultVoice = deps.defaultVoice ?? 'Ava'
    this.defaultRate = deps.defaultRate ?? 180
  }

  async speak(text: string, opts: SpeakOptions = {}): Promise<void> {
    if (!text.trim()) return
    this.stop()
    const voice = opts.voice ?? this.defaultVoice
    const rate = String(opts.rate ?? this.defaultRate)
    this.activeAbort = new AbortController()
    try {
      await this.runner(['say', '-v', voice, '-r', rate, text], { signal: this.activeAbort.signal })
    } catch (err) {
      if ((err as Error).name !== 'AbortError') throw err
    } finally {
      this.activeAbort = null
    }
  }

  stop(): void {
    if (this.activeAbort) {
      this.activeAbort.abort()
      this.activeAbort = null
    }
  }

  async listVoices(): Promise<Voice[]> {
    const { stdout } = await this.runner(['say', '-v', '?'], { stdout: 'pipe' })
    if (!stdout) return []
    return stdout
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        const m = line.match(/^(.+?)\s{2,}(\S+)\s*#\s*(.*)$/)
        if (!m) return null
        return { name: m[1]!.trim(), language: m[2]!.trim(), sample: m[3]?.trim() }
      })
      .filter((v): v is Voice => v !== null)
  }
}
