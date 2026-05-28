import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SkillStore } from './skillStore'
import { UsageTracker } from './usageTracker'
import { SkillRegistry } from './skillRegistry'
import { SkillDispatcher } from './skillDispatcher'

function makeSkillOnDisk(rootDir: string, slug: string, scriptKind?: 'ts' | 'python', scriptContent?: string): string {
  const dir = join(rootDir, slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'),
    `---\nname: ${slug}\ndescription: a skill named ${slug} for dispatch tests\n---\n\nBody.\n`)
  if (scriptKind === 'ts') {
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    writeFileSync(join(dir, 'scripts', 'main.ts'), scriptContent ?? 'export default async () => ({ ok: 1 })')
  } else if (scriptKind === 'python') {
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    writeFileSync(join(dir, 'scripts', 'main.py'), scriptContent ?? 'output = "py-result"')
  }
  return dir
}

function makeStack(tmp: string) {
  const db = new Database(':memory:')
  const store = new SkillStore(db, { root_dir: tmp })
  const tracker = new UsageTracker({ root_dir: tmp })
  const registry = new SkillRegistry({ skillStore: store, usageTracker: tracker, rootDir: tmp })
  // Fake runners — track calls + return canned results
  const tsCalls: any[] = []
  const pyCalls: any[] = []
  const tsRunner: any = {
    execute: async (scriptPath: string, args: any) => {
      tsCalls.push({ scriptPath, args })
      return { ok: true, output: 'ts-out', duration_ms: 10, sandbox: 'ts_worker' }
    },
  }
  const pythonRunner: any = {
    execute: async (scriptPath: string, args: any) => {
      pyCalls.push({ scriptPath, args })
      return { ok: true, output: 'py-out', duration_ms: 20, sandbox: 'composio_workbench' }
    },
  }
  registry.initialize()
  const dispatcher = new SkillDispatcher({ skillRegistry: registry, usageTracker: tracker, tsRunner, pythonRunner })
  return { dispatcher, tracker, store, tsCalls, pyCalls }
}

describe('SkillDispatcher', () => {
  let tmp: string
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'kairos-disp-')) })

  it('routes .ts to TsRunner', async () => {
    makeSkillOnDisk(tmp, 'ts-skill', 'ts')
    const { dispatcher, tsCalls, pyCalls } = makeStack(tmp)
    const result = await dispatcher.invoke('ts-skill', { a: 1 })
    expect(result.ok).toBe(true)
    expect(result.output).toBe('ts-out')
    expect(tsCalls.length).toBe(1)
    expect(pyCalls.length).toBe(0)
    rmSync(tmp, { recursive: true })
  })

  it('routes .py to PythonRunner', async () => {
    makeSkillOnDisk(tmp, 'py-skill', 'python')
    const { dispatcher, tsCalls, pyCalls } = makeStack(tmp)
    const result = await dispatcher.invoke('py-skill', {})
    expect(result.ok).toBe(true)
    expect(result.output).toBe('py-out')
    expect(pyCalls.length).toBe(1)
    expect(tsCalls.length).toBe(0)
    rmSync(tmp, { recursive: true })
  })

  it('falls through to declarative when no scripts', async () => {
    makeSkillOnDisk(tmp, 'declarative')
    const { dispatcher, tsCalls, pyCalls } = makeStack(tmp)
    const result = await dispatcher.invoke('declarative', {})
    expect(result.ok).toBe(true)
    expect(result.sandbox).toBe('declarative')
    expect(result.output).toContain('Body.')
    expect(tsCalls.length).toBe(0)
    expect(pyCalls.length).toBe(0)
    rmSync(tmp, { recursive: true })
  })

  it('records use on every dispatch', async () => {
    makeSkillOnDisk(tmp, 'tracked', 'ts')
    const { dispatcher, tracker } = makeStack(tmp)
    await dispatcher.invoke('tracked', {})
    await dispatcher.invoke('tracked', {})
    const usage = tracker.read('tracked')
    expect(usage?.use_count).toBe(2)
    rmSync(tmp, { recursive: true })
  })

  it('sets curator_review_flag on failure', async () => {
    makeSkillOnDisk(tmp, 'failing', 'ts')
    const db = new Database(':memory:')
    const store = new SkillStore(db, { root_dir: tmp })
    const tracker = new UsageTracker({ root_dir: tmp })
    const registry = new SkillRegistry({ skillStore: store, usageTracker: tracker, rootDir: tmp })
    const failingTs: any = {
      execute: async () => ({ ok: false, error: 'boom', duration_ms: 5, sandbox: 'ts_worker' }),
    }
    registry.initialize()
    const dispatcher = new SkillDispatcher({
      skillRegistry: registry, usageTracker: tracker,
      tsRunner: failingTs, pythonRunner: {} as any,
    })
    const result = await dispatcher.invoke('failing', {})
    expect(result.ok).toBe(false)
    const usage = tracker.read('failing')
    expect(usage?.curator_review_flag).toBe(true)
    expect(usage?.failure_history?.[0]?.error).toBe('boom')
    rmSync(tmp, { recursive: true })
  })
})
