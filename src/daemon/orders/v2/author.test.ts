import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { PendingEditsQueue } from './pendingEdits'
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

  // ── C.4.2 new tests ────────────────────────────────────────────────────────

  function makeFailingRouter(errorMsg: string) {
    return {
      router: {
        async complete(_req: any) { throw new Error(errorMsg) },
      },
    }
  }

  it('LLM ok + queue present → file path (no queue interaction)', async () => {
    const queueDb = new Database(':memory:')
    const queue = new PendingEditsQueue(queueDb)
    const fake = makeFakeRouter({
      proposed_rule: { when: { event: 'foo' }, do: [{ action: 'log', args: { message: 'x' } }] },
      slug_suggestion: 'r-ok',
      similar_existing: null,
      confidence: 1,
    })
    const author = new OrdersAuthor({ router: fake.router as any, store, parser, filePath: file, pendingQueue: queue })
    const result = await author.handleSpeech('do x')
    expect(result.created_slug).toBe('r-ok')
    expect(queue.listAll()).toHaveLength(0)
  })

  it('LLM fails + queue present → enqueued, returns queued_for_retry=true', async () => {
    const queueDb = new Database(':memory:')
    const queue = new PendingEditsQueue(queueDb)
    const failing = makeFailingRouter('LLM 500')
    const author = new OrdersAuthor({ router: failing.router as any, store, parser, filePath: file, pendingQueue: queue })
    const result = await author.handleSpeech('please save this')
    expect(result.created_slug).toBeNull()
    expect(result.queued_for_retry).toBe(true)
    expect(queue.listAll()).toHaveLength(1)
    expect(queue.listAll()[0]!.speech).toBe('please save this')
  })

  it('LLM missing proposed_rule + queue present → enqueued (treated as transient)', async () => {
    const queueDb = new Database(':memory:')
    const queue = new PendingEditsQueue(queueDb)
    const broken = makeFakeRouter({ slug_suggestion: 'x' })   // proposed_rule missing
    const author = new OrdersAuthor({ router: broken.router as any, store, parser, filePath: file, pendingQueue: queue })
    const result = await author.handleSpeech('xx')
    expect(result.queued_for_retry).toBe(true)
    expect(queue.listAll()).toHaveLength(1)
  })

  it('handleSpeechDirect bypasses queue — throws on failure', async () => {
    const queueDb = new Database(':memory:')
    const queue = new PendingEditsQueue(queueDb)
    const failing = makeFailingRouter('LLM 500')
    const author = new OrdersAuthor({ router: failing.router as any, store, parser, filePath: file, pendingQueue: queue })
    await expect(author.handleSpeechDirect('xx')).rejects.toThrow(/500/)
    expect(queue.listAll()).toHaveLength(0)
  })

  it('queue absent + LLM fails → original error-return behavior preserved', async () => {
    const failing = makeFailingRouter('LLM 500')
    const author = new OrdersAuthor({ router: failing.router as any, store, parser, filePath: file })
    const result = await author.handleSpeech('xx')
    expect(result.created_slug).toBeNull()
    expect(result.queued_for_retry).toBeUndefined()
    expect(result.error).toContain('500')
  })

  // ── Phase D tests ────────────────────────────────────────────────────────────

  function fakeSchemaCache(types: Record<string, any>) {
    return {
      map: new Map(Object.entries(types)),
      getType: (slug: string) => types[slug] ?? null,
      resolveOrRefresh: async (slug: string) => types[slug] ?? null,
    } as any
  }

  function fakeInstanceManager() {
    const calls: any[] = []
    return {
      acquireForRule: async (rule_slug: string, slug: string, config: any, ca: string) => {
        calls.push({ rule_slug, slug, config, ca })
        return 'ti_x'
      },
      releaseForRule: async () => {},
      calls,
    } as any
  }

  function fakeConnectGuard(result: 'ready' | 'pending') {
    const calls: any[] = []
    return {
      ensureConnected: async (tk: string, rs: string) => { calls.push({ tk, rs }); return result },
      notifyComplete: () => {},
      calls,
    } as any
  }

  it('incoming_event rule with connected toolkit: acquires instance + activates', async () => {
    const fake = makeFakeRouter({
      proposed_rule: {
        when: { state: { incoming_event: { trigger: 'GMAIL_NEW_GMAIL_MESSAGE' } } },
        do: [{ action: 'notify', args: { message: 'x' } }],
      },
      slug_suggestion: 'mc',
      similar_existing: null,
      confidence: 0.95,
    })
    const schemaCache = fakeSchemaCache({ GMAIL_NEW_GMAIL_MESSAGE: { slug: 'GMAIL_NEW_GMAIL_MESSAGE', toolkit: 'gmail', config_schema: {}, payload_schema: {}, description: 'New email' } })
    const instMgr = fakeInstanceManager()
    const guard = fakeConnectGuard('ready')
    const author = new OrdersAuthor({
      router: fake.router as any, store, parser, filePath: file,
      schemaCache, instanceManager: instMgr, connectGuard: guard,
    })
    const result = await author.handleSpeech('notify me about emails')
    expect(result.created_slug).toBe('mc')
    expect(guard.calls).toHaveLength(1)
    expect(instMgr.calls).toHaveLength(1)
  })

  it('incoming_event rule with unconnected toolkit: state=pending_connection, no instance acquired', async () => {
    const fake = makeFakeRouter({
      proposed_rule: {
        when: { state: { incoming_event: { trigger: 'GMAIL_NEW_GMAIL_MESSAGE' } } },
        do: [{ action: 'notify', args: { message: 'x' } }],
      },
      slug_suggestion: 'pc',
      similar_existing: null,
      confidence: 0.95,
    })
    const schemaCache = fakeSchemaCache({ GMAIL_NEW_GMAIL_MESSAGE: { slug: 'GMAIL_NEW_GMAIL_MESSAGE', toolkit: 'gmail', config_schema: {}, payload_schema: {}, description: '' } })
    const instMgr = fakeInstanceManager()
    const guard = fakeConnectGuard('pending')
    const author = new OrdersAuthor({
      router: fake.router as any, store, parser, filePath: file,
      schemaCache, instanceManager: instMgr, connectGuard: guard,
    })
    await author.handleSpeech('notify me')
    const stored = store.get('pc')
    expect(stored?.state).toBe('pending_connection')
    expect(instMgr.calls).toHaveLength(0)
  })

  it('system prompt includes available triggers from schemaCache', async () => {
    let capturedSystemBlocks: any = null
    const fake = {
      complete: async (req: any) => {
        capturedSystemBlocks = req.system_blocks
        return { parsed: { proposed_rule: { when: { event: 'foo' }, do: [{ action: 'log', args: {} }] }, slug_suggestion: 'x', similar_existing: null, confidence: 1 } }
      },
    }
    const schemaCache = fakeSchemaCache({
      GMAIL_NEW_GMAIL_MESSAGE: { slug: 'GMAIL_NEW_GMAIL_MESSAGE', toolkit: 'gmail', config_schema: {}, payload_schema: {}, description: 'new email' },
      GITHUB_COMMIT_EVENT: { slug: 'GITHUB_COMMIT_EVENT', toolkit: 'github', config_schema: {}, payload_schema: {}, description: 'commit' },
    })
    const author = new OrdersAuthor({
      router: fake as any, store, parser, filePath: file,
      schemaCache,
    })
    await author.handleSpeech('hi')
    expect(capturedSystemBlocks).not.toBeNull()
    const text = capturedSystemBlocks[0].text
    expect(text).toContain('GMAIL_NEW_GMAIL_MESSAGE')
    expect(text).toContain('GITHUB_COMMIT_EVENT')
  })

  it('incoming_event compilation works without optional deps (backward compatible)', async () => {
    const fake = makeFakeRouter({
      proposed_rule: { when: { state: { incoming_event: { trigger: 'X_Y' } } }, do: [{ action: 'log', args: {} }] },
      slug_suggestion: 'bc', similar_existing: null, confidence: 1,
    })
    const author = new OrdersAuthor({ router: fake.router as any, store, parser, filePath: file })
    const result = await author.handleSpeech('test')
    expect(result.created_slug).toBe('bc')
  })
})
