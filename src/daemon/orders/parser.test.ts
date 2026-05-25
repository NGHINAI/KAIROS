import { describe, it, expect, beforeEach } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { OrdersParser } from './parser'

describe('OrdersParser', () => {
  let tmp: string

  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'kairos-orders-')) })

  it('reads the raw file content', () => {
    const path = join(tmp, 'STANDING_ORDERS.md')
    writeFileSync(path, '# Orders\n- Do X\n- Do Y\n')
    const p = new OrdersParser(path)
    expect(p.read()).toContain('Do X')
    rmSync(tmp, { recursive: true })
  })

  it('returns empty string when file missing', () => {
    const p = new OrdersParser(join(tmp, 'missing.md'))
    expect(p.read()).toBe('')
  })

  it('detects content changes via hash', () => {
    const path = join(tmp, 'STANDING_ORDERS.md')
    writeFileSync(path, 'first content')
    const p = new OrdersParser(path)
    const h1 = p.hash()
    writeFileSync(path, 'second content')
    const h2 = p.hash()
    expect(h1).not.toBe(h2)
    rmSync(tmp, { recursive: true })
  })

  it('extracts only the bullet lines (skips headers, blank lines, comments)', () => {
    const path = join(tmp, 'STANDING_ORDERS.md')
    writeFileSync(path, `# Header\n\n- First order\n- Second order\n# Comment line not bullet\n  - Indented bullet\n`)
    const p = new OrdersParser(path)
    const rules = p.bullets()
    expect(rules).toEqual(['First order', 'Second order', 'Indented bullet'])
    rmSync(tmp, { recursive: true })
  })
})
