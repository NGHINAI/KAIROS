import { describe, it, expect } from 'bun:test'
import { rrfFuse } from './hybridRetriever'

describe('rrfFuse', () => {
  it('combines ranks from two sources', () => {
    const fts = [{ id: 'a', score: 0 }, { id: 'b', score: 0 }, { id: 'c', score: 0 }]
    const vec = [{ id: 'b', score: 0 }, { id: 'd', score: 0 }, { id: 'a', score: 0 }]
    const fused = rrfFuse([fts, vec], 5)
    expect(fused.map(h => h.id)).toContain('a')
    expect(fused.map(h => h.id)).toContain('b')
  })

  it('respects k constant (default 60)', () => {
    const a = [{ id: 'x', score: 0 }]
    const b = [{ id: 'x', score: 0 }]
    const fused = rrfFuse([a, b], 5, 60)
    expect(fused[0].id).toBe('x')
    // RRF score = 1/(60+1) + 1/(60+1) = 2/61
    expect(fused[0].score).toBeCloseTo(2 / 61, 4)
  })

  it('handles disjoint result sets', () => {
    const a = [{ id: 'only-a', score: 0 }]
    const b = [{ id: 'only-b', score: 0 }]
    const fused = rrfFuse([a, b], 2)
    expect(fused.length).toBe(2)
  })

  it('caps to limit', () => {
    const a = Array.from({ length: 10 }, (_, i) => ({ id: 'a' + i, score: 0 }))
    const b = Array.from({ length: 10 }, (_, i) => ({ id: 'b' + i, score: 0 }))
    const fused = rrfFuse([a, b], 5)
    expect(fused.length).toBe(5)
  })
})
