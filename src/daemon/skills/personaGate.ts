// src/daemon/skills/personaGate.ts
// The gate between SkillCrystallizer and disk. Dedup + tier classification + review-or-promote decision.

import type { SkillFile, PersonaGateVerdict } from './types'
import type { AutonomyTier } from '../agency/types'
import type { SkillStore } from './skillStore'
import type { SkillWriter } from './skillWriter'
import type { ReviewQueue } from './reviewQueue'

const DEDUP_THRESHOLD = 0.85

export interface Embedder {
  warmup(): Promise<void>
  embed(text: string): Promise<Float32Array>
}

export type PersonaGateDeps = {
  skillStore: SkillStore
  skillWriter: SkillWriter
  reviewQueue: ReviewQueue
  embedder: Embedder
  /** Optional override: load body for an existing skill so we can embed it for similarity check.
   *  In production this is a quick filesystem read. */
  loadExistingSkillContent?: (dirPath: string) => string | null
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

export class PersonaGate {
  constructor(private deps: PersonaGateDeps) {}

  /** Evaluate a candidate skill. Either promotes to disk OR enqueues for review. */
  async evaluate(candidate: SkillFile): Promise<PersonaGateVerdict & { review_id?: number; promoted?: boolean }> {
    const tier: AutonomyTier = (candidate.metadata?.['kairos:autonomy_tier'] as AutonomyTier) ?? 'YELLOW'

    // 1. Cosine dedup against existing active skills
    const candText = candidate.description + '\n' + candidate.body
    const candEmb = await this.deps.embedder.embed(candText)

    const existing = this.deps.skillStore.listActive()
    for (const row of existing) {
      const body = this.deps.loadExistingSkillContent
        ? this.deps.loadExistingSkillContent(row.dir_path)
        : null
      if (body == null) continue
      const exText = row.description + '\n' + body
      const exEmb = await this.deps.embedder.embed(exText)
      const sim = cosine(candEmb, exEmb)
      if (sim > DEDUP_THRESHOLD) {
        return {
          approved: false,
          tier,
          is_duplicate: true,
          similar_existing: row.slug,
          needs_human_review: false,
          reason: `duplicate of existing skill '${row.slug}' (cosine ${sim.toFixed(3)} > ${DEDUP_THRESHOLD})`,
        }
      }
    }

    // 2. Tier-based decision
    if (tier === 'GREEN' || tier === 'YELLOW') {
      // Auto-promote
      const dir = this.deps.skillWriter.write(candidate, { force: false })
      this.deps.skillStore.upsert({
        slug: candidate.slug,
        name: candidate.name,
        description: candidate.description,
        state: 'active',
        pinned: false,
        tier,
        last_used_at: 0,
        created_at: Date.now(),
        dir_path: dir,
      })
      return {
        approved: true,
        tier,
        is_duplicate: false,
        needs_human_review: false,
        reason: `auto-promoted (${tier} tier)`,
        promoted: true,
      }
    }

    // ORANGE / RED → enqueue for review
    const verdict: PersonaGateVerdict = {
      approved: false,
      tier,
      is_duplicate: false,
      needs_human_review: true,
      reason: `${tier} tier requires human review`,
    }
    const reviewId = this.deps.reviewQueue.enqueue(candidate, verdict)
    return { ...verdict, review_id: reviewId }
  }

  /** Approve a pending review → promote to disk. */
  async approvePending(id: number): Promise<{ promoted: boolean; slug?: string; error?: string }> {
    const row = this.deps.reviewQueue.get(id)
    if (!row) return { promoted: false, error: 'not found' }
    if (row.status !== 'pending') return { promoted: false, error: `cannot approve in status: ${row.status}` }
    try {
      const dir = this.deps.skillWriter.write(row.skill, { force: false })
      this.deps.skillStore.upsert({
        slug: row.skill.slug,
        name: row.skill.name,
        description: row.skill.description,
        state: 'active',
        pinned: false,
        tier: row.verdict.tier,
        last_used_at: 0,
        created_at: Date.now(),
        dir_path: dir,
      })
      this.deps.reviewQueue.approve(id)
      return { promoted: true, slug: row.skill.slug }
    } catch (err) {
      return { promoted: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  rejectPending(id: number, reason: string): { rejected: boolean } {
    const row = this.deps.reviewQueue.get(id)
    if (!row || row.status !== 'pending') return { rejected: false }
    this.deps.reviewQueue.reject(id, reason)
    return { rejected: true }
  }
}
