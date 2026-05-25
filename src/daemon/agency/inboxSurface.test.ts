import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { InboxSurface, INBOX_SCHEMA } from './inboxSurface'

describe('InboxSurface', () => {
  let db: Database
  let tmp: string
  let inboxPath: string
  let inbox: InboxSurface

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(INBOX_SCHEMA)
    tmp = mkdtempSync(join(tmpdir(), 'kairos-inbox-'))
    inboxPath = join(tmp, 'inbox.md')
    inbox = new InboxSurface(db, inboxPath)
  })

  it('adds an item and rewrites the file with that item present', () => {
    inbox.add({
      tier: 'ORANGE',
      intent_id: 'notify',
      description: 'Reply to John in Slack',
      args_preview: 'title=New DM, body=…',
    })
    const content = readFileSync(inboxPath, 'utf8')
    expect(content).toContain('🟠')
    expect(content).toContain('Reply to John in Slack')
    expect(content).toContain('approve')
    expect(content).toContain('dismiss')
    rmSync(tmp, { recursive: true })
  })

  it('resolves an item by id and removes it from the file', () => {
    const id = inbox.add({
      tier: 'ORANGE', intent_id: 'log', description: 'x', args_preview: 'y',
    })
    inbox.resolve(id, 'approved')
    const content = readFileSync(inboxPath, 'utf8')
    expect(content).not.toContain('x')
    expect(inbox.pending().length).toBe(0)
    rmSync(tmp, { recursive: true })
  })

  it('pending() lists only items not yet resolved', () => {
    const id1 = inbox.add({ tier: 'YELLOW', intent_id: 'notify', description: 'a', args_preview: '' })
    const id2 = inbox.add({ tier: 'ORANGE', intent_id: 'log', description: 'b', args_preview: '' })
    inbox.resolve(id1, 'approved')
    const pending = inbox.pending()
    expect(pending.length).toBe(1)
    expect(pending[0]?.item_id).toBe(id2)
    rmSync(tmp, { recursive: true })
  })

  it('creates the inbox file (and parent dir) on first write', () => {
    const deeper = join(tmp, 'sub', 'inbox.md')
    const inboxDeep = new InboxSurface(db, deeper)
    inboxDeep.add({ tier: 'GREEN', intent_id: 'log', description: 'z', args_preview: '' })
    expect(existsSync(deeper)).toBe(true)
    rmSync(tmp, { recursive: true })
  })

  it('header text reflects pending count', () => {
    inbox.add({ tier: 'YELLOW', intent_id: 'notify', description: 'm', args_preview: '' })
    inbox.add({ tier: 'ORANGE', intent_id: 'log', description: 'n', args_preview: '' })
    const content = readFileSync(inboxPath, 'utf8')
    expect(content).toMatch(/2 pending/i)
    rmSync(tmp, { recursive: true })
  })
})
