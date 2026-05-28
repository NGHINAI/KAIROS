import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { OrdersStore } from './store'
import { OrdersParser } from './parser'
import { OrdersAuthor } from './author'

function makeFakeRouter(response: any) {
  const calls: any[] = []
  return {
    router: {
      async complete(req: any) {
        calls.push(req)
        return { parsed: response, text: JSON.stringify(response) } as any
      },
    },
    calls,
  }
}

describe('OrdersAuthor', () => {
  let db: Database, store: OrdersStore, parser: OrdersParser, dir: string, file: string

  beforeEach(() => {
    db = new Database(':memory:')
    store = new OrdersStore(db)
    parser = new OrdersParser()
    dir = mkdtempSync(join(tmpdir(), 'orders-author-'))
    file = join(dir, 'STANDING_ORDERS.md')
    writeFileSync(file, '# KAIROS Standing Orders\n')
  })

  it('compose appends a new rule block to the file', async () => {
    const fake = makeFakeRouter({
      proposed_rule: {
        when: { cron: '0 9 * * 1' },
        do: [{ action: 'notify', args: { message: 'send standup' } }],
      },
      slug_suggestion: 'monday-standup',
      similar_existing: null,
      confidence: 0.9,
    })
    const author = new OrdersAuthor({ router: fake.router as any, store, parser, filePath: file })
    const result = await author.handleSpeech('remind me every Monday at 9 to send standup')
    expect(result.created_slug).toBe('monday-standup')
    const content = readFileSync(file, 'utf8')
    expect(content).toContain('## monday-standup')
    expect(content).toMatch(/cron:\s*["']?0 9 \* \* 1/)
    expect(content).toContain('state: dry_run')
  })

  it('sets dry_run_until = now + 24h by default', async () => {
    const fake = makeFakeRouter({
      proposed_rule: { when: { event: 'foo' }, do: [{ action: 'log', args: { message: 'x' } }] },
      slug_suggestion: 'test-rule',
      similar_existing: null,
      confidence: 1,
    })
    const author = new OrdersAuthor({ router: fake.router as any, store, parser, filePath: file })
    const before = Date.now()
    await author.handleSpeech('test')
    const after = Date.now()
    const content = readFileSync(file, 'utf8')
    const m = content.match(/dry_run_until:\s*(\S+)/)
    expect(m).not.toBeNull()
    const ts = new Date(m![1]!).getTime()
    expect(ts).toBeGreaterThanOrEqual(before + 23 * 60 * 60 * 1000)
    expect(ts).toBeLessThanOrEqual(after + 25 * 60 * 60 * 1000)
  })

  it('returns similar_existing without writing when LLM finds duplicate', async () => {
    const fake = makeFakeRouter({
      proposed_rule: { when: { event: 'foo' }, do: [{ action: 'log', args: { message: 'x' } }] },
      slug_suggestion: 'new-thing',
      similar_existing: 'existing-thing',
      confidence: 0.95,
    })
    const author = new OrdersAuthor({ router: fake.router as any, store, parser, filePath: file })
    const result = await author.handleSpeech('test')
    expect(result.created_slug).toBeNull()
    expect(result.similar_existing).toBe('existing-thing')
    expect(readFileSync(file, 'utf8')).not.toContain('## new-thing')
  })

  it('appends description body showing the user speech', async () => {
    const fake = makeFakeRouter({
      proposed_rule: { when: { event: 'foo' }, do: [{ action: 'log', args: { message: 'x' } }] },
      slug_suggestion: 'r',
      similar_existing: null,
      confidence: 1,
    })
    const author = new OrdersAuthor({ router: fake.router as any, store, parser, filePath: file })
    await author.handleSpeech('hello world test phrase')
    expect(readFileSync(file, 'utf8')).toContain('hello world test phrase')
  })

  it('returns error when LLM omits proposed_rule', async () => {
    const fake = makeFakeRouter({ slug_suggestion: 'x' })
    const author = new OrdersAuthor({ router: fake.router as any, store, parser, filePath: file })
    const result = await author.handleSpeech('test')
    expect(result.created_slug).toBeNull()
    expect(result.error).toBeDefined()
  })

  it('slug collision: appends -2 suffix', async () => {
    const fake = makeFakeRouter({
      proposed_rule: { when: { event: 'foo' }, do: [{ action: 'log', args: { message: 'x' } }] },
      slug_suggestion: 'dup',
      similar_existing: null,
      confidence: 1,
    })
    store.upsert({ schema_version: 1, slug: 'dup', when: { event: 'foo' }, do: [{ action: 'log', args: {} }], state: 'active', created_by: 'manual', created_at: Date.now() })
    const author = new OrdersAuthor({ router: fake.router as any, store, parser, filePath: file })
    const result = await author.handleSpeech('test')
    expect(result.created_slug).toBe('dup-2')
  })
})
