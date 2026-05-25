// src/daemon/agency/trajectoryLog.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { TrajectoryLog, TRAJECTORY_SCHEMA } from './trajectoryLog'

describe('TrajectoryLog', () => {
  let db: Database
  let log: TrajectoryLog

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(TRAJECTORY_SCHEMA)
    log = new TrajectoryLog(db)
  })

  it('writes a trajectory and assigns a trajectory_id', () => {
    const id = log.start('Draft a Slack reply to John')
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)
  })

  it('appends steps with the UFO2 structure', () => {
    const id = log.start('Test goal')
    log.appendStep(id, {
      observation: 'Slack DM from John arrived',
      reasoning: 'Standing order says draft replies to John',
      action: { intent_id: 'notify', args: { title: 'New DM', body: 'from John' } },
      result: 'notified',
      result_status: 'success',
      duration_ms: 42,
    })
    const traj = log.get(id)
    expect(traj?.steps.length).toBe(1)
    expect(traj?.steps[0]?.observation).toBe('Slack DM from John arrived')
    expect(traj?.steps[0]?.action.intent_id).toBe('notify')
  })

  it('finalises with outcome + override_reason', () => {
    const id = log.start('Test')
    log.appendStep(id, {
      observation: 'x', reasoning: 'y',
      action: { intent_id: 'log', args: {} },
      result: 'logged', result_status: 'success', duration_ms: 1,
    })
    log.finalize(id, 'user_override', 'user dismissed')
    const traj = log.get(id)
    expect(traj?.outcome).toBe('user_override')
    expect(traj?.override_reason).toBe('user dismissed')
    expect(traj?.ended_at).toBeGreaterThanOrEqual(traj?.started_at ?? 0)
  })

  it('recent() returns latest trajectories newest-first', () => {
    const id1 = log.start('a'); log.finalize(id1, 'success')
    const id2 = log.start('b'); log.finalize(id2, 'success')
    const recent = log.recent(5)
    expect(recent.length).toBe(2)
    expect(recent[0]?.task_goal).toBe('b')
  })

  it('byOutcome filters correctly', () => {
    const id1 = log.start('a'); log.finalize(id1, 'success')
    const id2 = log.start('b'); log.finalize(id2, 'failure')
    expect(log.byOutcome('success', 10).length).toBe(1)
    expect(log.byOutcome('failure', 10).length).toBe(1)
  })
})
