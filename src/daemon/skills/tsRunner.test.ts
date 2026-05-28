import { describe, it, expect, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { TsRunner } from './tsRunner'

function writeSkill(tmp: string, name: string, source: string): string {
  const path = join(tmp, name + '.ts')
  writeFileSync(path, source)
  return path
}

describe('TsRunner', () => {
  let tmp: string
  let runner: TsRunner
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kairos-tr-'))
    runner = new TsRunner()
  })

  it('executes a trivial TS skill and returns result', async () => {
    const path = writeSkill(tmp, 'hello', `
      export default async function (args) {
        return { greeting: 'hi ' + args.name }
      }
    `)
    const result = await runner.execute(path, { name: 'world' })
    expect(result.ok).toBe(true)
    expect(result.output).toContain('hi world')
    expect(result.sandbox).toBe('ts_worker')
    rmSync(tmp, { recursive: true })
  })

  it('captures errors thrown by the skill', async () => {
    const path = writeSkill(tmp, 'boom', `
      export default async function (args) {
        throw new Error('intentional boom')
      }
    `)
    const result = await runner.execute(path, {})
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/boom/)
    rmSync(tmp, { recursive: true })
  })

  it('times out after timeout_ms', async () => {
    const path = writeSkill(tmp, 'slow', `
      export default async function (args) {
        await new Promise(r => setTimeout(r, 5000))
        return { ok: true }
      }
    `)
    const result = await runner.execute(path, {}, { timeout_ms: 200 })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/timeout/i)
    expect(result.duration_ms).toBeGreaterThanOrEqual(200)
    expect(result.duration_ms).toBeLessThan(2000)   // didn't wait the full 5s
    rmSync(tmp, { recursive: true })
  })

  it('rejects skills with no default export', async () => {
    const path = writeSkill(tmp, 'no-default', `
      export const named = () => {}
    `)
    const result = await runner.execute(path, {})
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/default async function/)
    rmSync(tmp, { recursive: true })
  })

  it('passes args via postMessage', async () => {
    const path = writeSkill(tmp, 'echo-args', `
      export default async function (args) {
        return args
      }
    `)
    const result = await runner.execute(path, { a: 1, b: 'two', c: true })
    expect(result.ok).toBe(true)
    expect(result.output).toContain('"a":1')
    expect(result.output).toContain('"b":"two"')
    rmSync(tmp, { recursive: true })
  })

  it('returns ok:false on syntax errors', async () => {
    const path = writeSkill(tmp, 'syntax-err', 'this is not valid typescript ====')
    const result = await runner.execute(path, {})
    expect(result.ok).toBe(false)
    expect(result.error).toBeDefined()
    rmSync(tmp, { recursive: true })
  })
})
