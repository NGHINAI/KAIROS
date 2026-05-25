// src/daemon/restraint/deliveryRouter.test.ts
import { describe, it, expect } from 'bun:test'
import { DeliveryRouter } from './deliveryRouter'

describe('DeliveryRouter', () => {
  const router = new DeliveryRouter({
    interrupt_threshold: 0.9, surface_threshold: 0.7, digest_threshold: 0.4,
  } as any)

  function score(total: number) {
    return { total, components: {} as any, explanation: '' }
  }

  it('routes >0.9 to interrupt', () => {
    expect(router.route(score(0.95)).mode).toBe('interrupt')
  })
  it('routes 0.7-0.9 to surface', () => {
    expect(router.route(score(0.8)).mode).toBe('surface')
  })
  it('routes 0.4-0.7 to digest', () => {
    expect(router.route(score(0.5)).mode).toBe('digest')
  })
  it('routes <0.4 to log_only', () => {
    expect(router.route(score(0.2)).mode).toBe('log_only')
  })
  it('chooses digest slot based on time of day', () => {
    const morning = router.route(score(0.5), new Date('2026-05-25T07:00:00').getTime())
    expect(morning.queue_for_digest).toBe('morning')
    const lunch = router.route(score(0.5), new Date('2026-05-25T11:00:00').getTime())
    expect(lunch.queue_for_digest).toBe('lunch')
    const evening = router.route(score(0.5), new Date('2026-05-25T15:00:00').getTime())
    expect(evening.queue_for_digest).toBe('evening')
    const nextMorning = router.route(score(0.5), new Date('2026-05-25T19:00:00').getTime())
    expect(nextMorning.queue_for_digest).toBe('morning')
  })
})
