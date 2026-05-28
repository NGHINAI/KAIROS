import { describe, it, expect, beforeEach } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PythonRunner } from './pythonRunner'

function fakeComposioClient(behavior: any = {}) {
  let lastCreateOpts: any = null
  return {
    sdk: {
      create: async (userId: string, opts: any) => {
        lastCreateOpts = opts
        const id = behavior.session_id ?? 'sess_test_xyz'
        return {
          id, session_id: id,
          execute: behavior.execute ?? (async (req: any) => ({
            data: { echo: req.arguments?.code?.length ?? 0 },
          })),
        }
      },
      use: async (sessionId: string) => {
        if (behavior.use_fails) throw new Error('session not found')
        return {
          id: sessionId, session_id: sessionId,
          execute: behavior.execute ?? (async (req: any) => ({
            data: { echo: req.arguments?.code?.length ?? 0 },
          })),
        }
      },
    },
    get lastCreateOpts() { return lastCreateOpts },
  }
}

describe('PythonRunner', () => {
  let tmp: string
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'kairos-pr-')) })

  it('creates a workbench-enabled session on first call', async () => {
    const fake = fakeComposioClient()
    const runner = new PythonRunner(
      { composio: fake as any },
      { session_cache_path: join(tmp, 'session.json') },
    )
    const sid = await runner.ensureSession()
    expect(sid).toBe('sess_test_xyz')
    expect(fake.lastCreateOpts.workbench).toEqual({ enable: true })
    rmSync(tmp, { recursive: true })
  })

  it('persists sessionId to cache file', async () => {
    const fake = fakeComposioClient()
    const cachePath = join(tmp, 'session.json')
    const runner = new PythonRunner({ composio: fake as any }, { session_cache_path: cachePath })
    await runner.ensureSession()
    expect(existsSync(cachePath)).toBe(true)
    const cached = JSON.parse(readFileSync(cachePath, 'utf8'))
    expect(cached.sessionId).toBe('sess_test_xyz')
    rmSync(tmp, { recursive: true })
  })

  it('resumes existing session from cache', async () => {
    const cachePath = join(tmp, 'session.json')
    writeFileSync(cachePath, JSON.stringify({ sessionId: 'cached_id_999', created_at: Date.now() }))
    const fake = fakeComposioClient()
    const runner = new PythonRunner({ composio: fake as any }, { session_cache_path: cachePath })
    const sid = await runner.ensureSession()
    expect(sid).toBe('cached_id_999')
    expect(fake.lastCreateOpts).toBeNull()   // didn't call create
    rmSync(tmp, { recursive: true })
  })

  it('falls back to creating fresh session if cached session is invalid', async () => {
    const cachePath = join(tmp, 'session.json')
    writeFileSync(cachePath, JSON.stringify({ sessionId: 'expired_id', created_at: 0 }))
    const fake = fakeComposioClient({ use_fails: true })
    const runner = new PythonRunner({ composio: fake as any }, { session_cache_path: cachePath })
    const sid = await runner.ensureSession()
    expect(sid).toBe('sess_test_xyz')
    rmSync(tmp, { recursive: true })
  })

  it('executes a Python script + captures the `output` variable', async () => {
    const scriptPath = join(tmp, 'main.py')
    writeFileSync(scriptPath, 'output = {"hello": args.get("name", "world")}\n')

    let capturedCode = ''
    const fake = fakeComposioClient({
      execute: async (req: any) => {
        capturedCode = req.arguments?.code ?? ''
        // Simulate workbench capturing the `output` variable
        return { data: { hello: 'kairos' } }
      },
    })
    const runner = new PythonRunner(
      { composio: fake as any },
      { session_cache_path: join(tmp, 'session.json') },
    )
    const result = await runner.execute(scriptPath, { name: 'kairos' })
    expect(result.ok).toBe(true)
    expect(result.output).toContain('"hello":"kairos"')
    expect(result.sandbox).toBe('composio_workbench')
    // Code was wrapped with args injection + output capture
    expect(capturedCode).toContain('args = json.loads(')
    expect(capturedCode).toContain('output = {"hello"')
    expect(capturedCode).toMatch(/if 'output' not in dir/)
    rmSync(tmp, { recursive: true })
  })
})
