// src/daemon/agency/trajectoryLog.ts
// UFO2-format structured trajectory log (arXiv:2504.14603).
// Every action attempt writes a step. AWM crystallization (C.3) reads
// these to induce reusable workflows.
//
// Two-table split: action_trajectories (header — goal + outcome) +
// action_trajectory_steps (steps, appended incrementally).

import { randomUUID } from 'crypto'
import type { Database } from 'bun:sqlite'
import type { Trajectory, TrajectoryStep } from './types'

export const TRAJECTORY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS action_trajectories (
    trajectory_id   TEXT PRIMARY KEY,
    task_goal       TEXT    NOT NULL,
    outcome         TEXT,
    override_reason TEXT,
    started_at      INTEGER NOT NULL,
    ended_at        INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_traj_started ON action_trajectories(started_at);
  CREATE INDEX IF NOT EXISTS idx_traj_outcome ON action_trajectories(outcome, started_at);

  CREATE TABLE IF NOT EXISTS action_trajectory_steps (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    trajectory_id  TEXT NOT NULL REFERENCES action_trajectories(trajectory_id) ON DELETE CASCADE,
    step_index     INTEGER NOT NULL,
    observation    TEXT NOT NULL,
    reasoning      TEXT NOT NULL,
    intent_id      TEXT NOT NULL,
    args_json      TEXT NOT NULL,
    result         TEXT NOT NULL,
    result_status  TEXT NOT NULL,
    duration_ms    INTEGER NOT NULL,
    ts             INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_traj_step ON action_trajectory_steps(trajectory_id, step_index);
`

export class TrajectoryLog {
  constructor(private db: Database) {}

  start(taskGoal: string): string {
    const id = randomUUID()
    this.db.run(
      'INSERT INTO action_trajectories (trajectory_id, task_goal, started_at) VALUES (?, ?, ?)',
      [id, taskGoal, Date.now()],
    )
    return id
  }

  appendStep(trajectoryId: string, step: TrajectoryStep): void {
    const nextIndex = (this.db
      .query('SELECT COUNT(*) as n FROM action_trajectory_steps WHERE trajectory_id = ?')
      .get(trajectoryId) as { n: number }).n
    this.db.run(
      `INSERT INTO action_trajectory_steps
         (trajectory_id, step_index, observation, reasoning, intent_id, args_json,
          result, result_status, duration_ms, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        trajectoryId, nextIndex, step.observation, step.reasoning,
        step.action.intent_id, JSON.stringify(step.action.args),
        step.result, step.result_status, step.duration_ms, Date.now(),
      ],
    )
  }

  finalize(trajectoryId: string, outcome: Trajectory['outcome'], overrideReason?: string): void {
    this.db.run(
      'UPDATE action_trajectories SET outcome = ?, override_reason = ?, ended_at = ? WHERE trajectory_id = ?',
      [outcome, overrideReason ?? null, Date.now(), trajectoryId],
    )
  }

  get(trajectoryId: string): Trajectory | null {
    const header = this.db.query(
      'SELECT * FROM action_trajectories WHERE trajectory_id = ?',
    ).get(trajectoryId) as Omit<Trajectory, 'steps'> | null
    if (!header) return null
    const steps = this.db.query(
      `SELECT observation, reasoning, intent_id, args_json, result, result_status, duration_ms
       FROM action_trajectory_steps WHERE trajectory_id = ? ORDER BY step_index ASC`,
    ).all(trajectoryId) as Array<{
      observation: string; reasoning: string; intent_id: string;
      args_json: string; result: string; result_status: TrajectoryStep['result_status']; duration_ms: number;
    }>
    return {
      ...header,
      steps: steps.map(s => ({
        observation: s.observation,
        reasoning: s.reasoning,
        action: { intent_id: s.intent_id, args: JSON.parse(s.args_json) },
        result: s.result,
        result_status: s.result_status,
        duration_ms: s.duration_ms,
      })),
    }
  }

  recent(limit: number = 20): Trajectory[] {
    const rows = this.db.query(
      'SELECT * FROM action_trajectories ORDER BY started_at DESC LIMIT ?',
    ).all(limit) as Array<{ trajectory_id: string }>
    return rows.map(h => this.get(h.trajectory_id)!).filter(Boolean)
  }

  byOutcome(outcome: Trajectory['outcome'], limit: number = 20): Trajectory[] {
    const rows = this.db.query(
      'SELECT * FROM action_trajectories WHERE outcome = ? ORDER BY started_at DESC LIMIT ?',
    ).all(outcome, limit) as Array<{ trajectory_id: string }>
    return rows.map(h => this.get(h.trajectory_id)!).filter(Boolean)
  }
}
