import { describe, it, expect } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { watchOrdersFile } from './watcher'

describe('watchOrdersFile', () => {
  it('calls callback after a write (with debounce)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orders-watch-'))
    const file = join(dir, 'S.md')
    writeFileSync(file, 'a')
    let fired = 0
    const stop = watchOrdersFile(file, () => fired++, 50)
    await new Promise(r => setTimeout(r, 100))
    writeFileSync(file, 'b')
    await new Promise(r => setTimeout(r, 200))
    expect(fired).toBeGreaterThanOrEqual(1)
    stop()
  })

  it('coalesces multiple rapid writes into one callback', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orders-watch-2-'))
    const file = join(dir, 'S.md')
    writeFileSync(file, 'a')
    let fired = 0
    const stop = watchOrdersFile(file, () => fired++, 100)
    await new Promise(r => setTimeout(r, 50))
    writeFileSync(file, 'b')
    writeFileSync(file, 'c')
    writeFileSync(file, 'd')
    await new Promise(r => setTimeout(r, 250))
    expect(fired).toBeLessThanOrEqual(2)
    stop()
  })

  it('stop() halts further callbacks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orders-watch-3-'))
    const file = join(dir, 'S.md')
    writeFileSync(file, 'a')
    let fired = 0
    const stop = watchOrdersFile(file, () => fired++, 50)
    stop()
    writeFileSync(file, 'b')
    await new Promise(r => setTimeout(r, 200))
    expect(fired).toBe(0)
  })
})
