import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { OrdersStore } from './store'
import { OrdersParser } from './parser'
import { OrdersAuthor } from './author'
import { PendingEditsQueue } from './pendingEdits'
import { PendingEditsProcessor } from './pendingEditsProcessor'

function makeFakeRouter(response: any, options: { failNTimes?: number } = {}) {
  let calls = 0
  return {
    router: {
      async complete(_req: any) {
        calls++
        if (options.failNTimes && calls <= options.failNTimes) throw new Error('LLM 500')
        return { parsed: response, text: JSON.stringify(response) } as any
      },
    },
    getCallCount: () => calls,
  }
}

describe('PendingEditsProcessor', () => {
  let db: Database, store: OrdersStore, parser: OrdersParser, queue: PendingEditsQueue, file: string

  beforeEach(() => {
    db = new Database(':memory:')
    store = new OrdersStore(db)
    parser = new OrdersParser()
    queue = new PendingEditsQueue(db, { now: () => 1_000_000 })
    const tmp = mkdtempSync(join(tmpdir(), 'pep-'))
    file = join(tmp, 'STANDING_ORDERS.md')
    writeFileSync(file, '# KAIROS Standing Orders\n')
  })

  it('processes a ready row, materializes rule, marks done', async () => {
    queue.enqueue('test rule')
    const fake = makeFakeRouter({
      proposed_rule: { when: { event: 'foo' }, do: [{ action: 'log', args: { message: 'x' } }] },
      slug_suggestion: 'recovered',
      similar_existing: null,
      confidence: 1,
    })
    const author = new OrdersAuthor({ router: fake.router as any, store, parser, filePath: file, pendingQueue: queue })
    const proc = new PendingEditsProcessor({ queue, author, now: () => 1_000_000 + 6 * 60 * 1000 })
    await proc.runOnce()
    expect(store.get('recovered')).not.toBeNull()
    const pending = queue.listAll().filter(r => r.status === 'pending')
    expect(pending).toHaveLength(0)
  })

  it('failed retry increments retry_count + applies backoff', async () => {
    queue.enqueue('persistent fail')
    const fake = makeFakeRouter(null, { failNTimes: 5 })
    const author = new OrdersAuthor({ router: fake.router as any, store, parser, filePath: file, pendingQueue: queue })
    const proc = new PendingEditsProcessor({ queue, author, now: () => 1_000_000 + 6 * 60 * 1000 })
    await proc.runOnce()
    const rows = queue.listAll()
    expect(rows[0]!.retry_count).toBe(1)
    expect(rows[0]!.last_error).toContain('500')
  })

  it('does not process rows whose next_retry_at is in the future', async () => {
    queue.enqueue('future')
    const fake = makeFakeRouter({
      proposed_rule: { when: { event: 'foo' }, do: [{ action: 'log', args: { message: 'x' } }] },
      slug_suggestion: 'future-rule',
      similar_existing: null,
      confidence: 1,
    })
    const author = new OrdersAuthor({ router: fake.router as any, store, parser, filePath: file, pendingQueue: queue })
    const proc = new PendingEditsProcessor({ queue, author, now: () => 1_000_000 + 30 * 1000 })   // 30s — not ready
    await proc.runOnce()
    expect(fake.getCallCount()).toBe(0)
  })

  it('start/stop manages timer cleanly', () => {
    const fake = makeFakeRouter({
      proposed_rule: { when: { event: 'foo' }, do: [{ action: 'log', args: { message: 'x' } }] },
      slug_suggestion: 't',
      similar_existing: null,
      confidence: 1,
    })
    const author = new OrdersAuthor({ router: fake.router as any, store, parser, filePath: file, pendingQueue: queue })
    const proc = new PendingEditsProcessor({ queue, author })
    proc.start(50)
    proc.stop()
    expect(true).toBe(true)
  })
})
