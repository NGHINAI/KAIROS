import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SkillStore } from './skillStore'
import { SkillWriter } from './skillWriter'
import { ReviewQueue } from './reviewQueue'
import { PersonaGate, Embedder } from './personaGate'
import type { SkillFile } from './types'

function makeCandidate(slug: string, tier: string = 'YELLOW', desc = 'Test skill that does Y when X.'): SkillFile {
  return {
    name: slug,
    description: desc,
    slug,
    body: 'Body content for ' + slug,
    metadata: { 'kairos:autonomy_tier': tier },
    dir_path: '',
    has_scripts: false,
    has_references: false,
  }
}

/** Deterministic fake embedder — same text → same vector. Different text → different vector. */
function makeFakeEmbedder(): Embedder {
  const cache = new Map<string, Float32Array>()
  let nextId = 0
  return {
    async warmup() {},
    async embed(text: string) {
      if (cache.has(text)) return cache.get(text)!
      const id = nextId++
      const v = new Float32Array(384)
      for (let i = 0; i < 384; i++) v[i] = Math.sin(id * 0.7 + i * 0.01)
      // Normalize
      let norm = 0
      for (let i = 0; i < 384; i++) norm += v[i]! * v[i]!
      norm = Math.sqrt(norm)
      for (let i = 0; i < 384; i++) v[i] = v[i]! / norm
      cache.set(text, v)
      return v
    },
  }
}

describe('PersonaGate', () => {
  let db: Database
  let tmp: string
  let store: SkillStore
  let writer: SkillWriter
  let queue: ReviewQueue
  let embedder: Embedder
  let gate: PersonaGate
  let bodies: Record<string, string>

  beforeEach(() => {
    db = new Database(':memory:')
    tmp = mkdtempSync(join(tmpdir(), 'kairos-pg-'))
    store = new SkillStore(db, { root_dir: tmp })
    writer = new SkillWriter({ root_dir: tmp })
    queue = new ReviewQueue(db)
    embedder = makeFakeEmbedder()
    bodies = {}
    gate = new PersonaGate({
      skillStore: store,
      skillWriter: writer,
      reviewQueue: queue,
      embedder,
      loadExistingSkillContent: (dir: string) => {
        const slug = dir.split('/').pop()!
        return bodies[slug] ?? null
      },
    })
  })

  it('auto-promotes a GREEN-tier skill', async () => {
    const cand = makeCandidate('green-skill', 'GREEN')
    const verdict = await gate.evaluate(cand)
    expect(verdict.approved).toBe(true)
    expect(verdict.promoted).toBe(true)
    expect(store.get('green-skill')).not.toBeNull()
    rmSync(tmp, { recursive: true })
  })

  it('auto-promotes a YELLOW-tier skill', async () => {
    const cand = makeCandidate('yellow-skill', 'YELLOW')
    const verdict = await gate.evaluate(cand)
    expect(verdict.approved).toBe(true)
    expect(verdict.promoted).toBe(true)
    rmSync(tmp, { recursive: true })
  })

  it('queues ORANGE-tier skill for review', async () => {
    const cand = makeCandidate('orange-skill', 'ORANGE')
    const verdict = await gate.evaluate(cand)
    expect(verdict.approved).toBe(false)
    expect(verdict.needs_human_review).toBe(true)
    expect((verdict as any).review_id).toBeDefined()
    expect(store.get('orange-skill')).toBeNull()
    expect(queue.listPending().length).toBe(1)
    rmSync(tmp, { recursive: true })
  })

  it('queues RED-tier skill for review', async () => {
    const cand = makeCandidate('red-skill', 'RED')
    const verdict = await gate.evaluate(cand)
    expect(verdict.needs_human_review).toBe(true)
    expect(queue.listPending().length).toBe(1)
    rmSync(tmp, { recursive: true })
  })

  it('cosine dedup rejects near-duplicate (same description+body)', async () => {
    // First skill auto-promoted
    const first = makeCandidate('first', 'GREEN', 'Send a Slack reminder to a channel.')
    await gate.evaluate(first)
    bodies['first'] = first.body

    // Same description + body — should be detected as duplicate
    const duplicate = makeCandidate('second', 'GREEN', 'Send a Slack reminder to a channel.')
    duplicate.body = 'Body content for first'   // identical text → identical embedding from fake
    const verdict = await gate.evaluate(duplicate)
    expect(verdict.is_duplicate).toBe(true)
    expect(verdict.similar_existing).toBe('first')
    expect(verdict.approved).toBe(false)
    rmSync(tmp, { recursive: true })
  })

  it('does NOT mark non-duplicate as duplicate', async () => {
    const first = makeCandidate('first', 'GREEN', 'Send a Slack reminder.')
    await gate.evaluate(first)
    bodies['first'] = first.body

    const second = makeCandidate('second', 'GREEN', 'Create a Linear issue from a Slack message.')
    second.body = 'Body content for second'   // different text → different embedding
    const verdict = await gate.evaluate(second)
    expect(verdict.is_duplicate).toBe(false)
    expect(verdict.approved).toBe(true)
    rmSync(tmp, { recursive: true })
  })

  it('approvePending promotes a queued review to disk', async () => {
    const cand = makeCandidate('orange-skill', 'ORANGE')
    const verdict = await gate.evaluate(cand)
    const result = await gate.approvePending((verdict as any).review_id)
    expect(result.promoted).toBe(true)
    expect(store.get('orange-skill')).not.toBeNull()
    rmSync(tmp, { recursive: true })
  })

  it('rejectPending discards a queued review', async () => {
    const cand = makeCandidate('red-skill', 'RED')
    const verdict = await gate.evaluate(cand)
    const result = gate.rejectPending((verdict as any).review_id, 'too risky')
    expect(result.rejected).toBe(true)
    expect(queue.get((verdict as any).review_id)?.status).toBe('rejected')
    expect(store.get('red-skill')).toBeNull()
    rmSync(tmp, { recursive: true })
  })

  it('approvePending fails gracefully for non-existent id', async () => {
    const result = await gate.approvePending(99999)
    expect(result.promoted).toBe(false)
    expect(result.error).toMatch(/not found/)
  })

  it('approvePending fails for already-approved item', async () => {
    const cand = makeCandidate('o', 'ORANGE')
    const v = await gate.evaluate(cand)
    await gate.approvePending((v as any).review_id)   // first time
    const second = await gate.approvePending((v as any).review_id)   // second time
    expect(second.promoted).toBe(false)
    rmSync(tmp, { recursive: true })
  })
})
