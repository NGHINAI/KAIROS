// src/daemon/restraint/coalescer.test.ts
import { describe, it, expect } from 'bun:test'
import { Coalescer } from './coalescer'

describe('Coalescer', () => {
  it('collapses events from same source within window', async () => {
    const c = new Coalescer({ windowMs: 100 })
    const flushed: any[] = []
    c.onFlush(batch => flushed.push(batch))
    c.add({ source: 'file-events', kind: 'modified', payload: { path: '/a' } } as any)
    c.add({ source: 'file-events', kind: 'modified', payload: { path: '/b' } } as any)
    c.add({ source: 'file-events', kind: 'modified', payload: { path: '/c' } } as any)
    await new Promise(r => setTimeout(r, 150))
    expect(flushed.length).toBe(1)
    expect(flushed[0].count).toBe(3)
    expect(flushed[0].source).toBe('file-events')
  })

  it('keeps separate batches for separate sources', async () => {
    const c = new Coalescer({ windowMs: 100 })
    const flushed: any[] = []
    c.onFlush(batch => flushed.push(batch))
    c.add({ source: 'file-events', kind: 'modified', payload: {} } as any)
    c.add({ source: 'clipboard', kind: 'changed', payload: {} } as any)
    await new Promise(r => setTimeout(r, 150))
    expect(flushed.length).toBe(2)
  })

  it('flushes when window expires', async () => {
    const c = new Coalescer({ windowMs: 30 })
    const flushed: any[] = []
    c.onFlush(batch => flushed.push(batch))
    c.add({ source: 'a', kind: 'k', payload: {} } as any)
    await new Promise(r => setTimeout(r, 80))
    expect(flushed.length).toBe(1)
  })

  it('summarizes payloads into composite description', async () => {
    const c = new Coalescer({ windowMs: 50 })
    const flushed: any[] = []
    c.onFlush(batch => flushed.push(batch))
    c.add({ source: 'file-events', kind: 'modified', payload: { path: '/Users/x/repo/.git/index' } } as any)
    c.add({ source: 'file-events', kind: 'modified', payload: { path: '/Users/x/repo/.git/HEAD' } } as any)
    await new Promise(r => setTimeout(r, 100))
    expect(flushed[0].summary).toContain('file-events')
    expect(flushed[0].summary).toMatch(/2 events/)
    expect(flushed[0].common_prefix).toContain('.git')
  })
})
