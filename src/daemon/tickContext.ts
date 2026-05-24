// Assembles the <tick> XML context that gets injected into the
// Haiku decision prompt on every tick.

import type { Database } from 'bun:sqlite'
import * as queries from './db'
import type { BudgetSnapshot } from './budgets'
import type { TickSource } from './types'

export function buildTickContext(opts: {
  db: Database
  triggerSource: TickSource
  triggerReason: string
  budget: BudgetSnapshot
  uptime: number
}): string {
  const { db, triggerSource, triggerReason, budget, uptime } = opts

  const queued = queries.getQueuedTasks(db)
  const running = queries.getRunningTasks(db)
  const recentTicks = queries.getRecentTicks(db, 5)
  const pendingApprovals = queries.getPendingApprovalCount(db)

  // Time since last user action (last task created by a session)
  const lastAction = db.query(`
    SELECT MAX(created_at) as ts FROM tasks WHERE session_id IS NOT NULL
  `).get() as { ts: number | null }
  const idleSeconds = lastAction.ts
    ? Math.floor((Date.now() - lastAction.ts) / 1000)
    : 99999

  // Unread message count
  const unreadCount = (db.query(
    'SELECT COUNT(*) as n FROM messages WHERE read_at IS NULL',
  ).get() as { n: number }).n

  // Memory candidates waiting for consolidation
  const candidateCount = (db.query(
    'SELECT COUNT(*) as n FROM memory_candidates WHERE promoted_to_memory = 0',
  ).get() as { n: number }).n

  // Last dream
  const lastDream = db.query(
    'SELECT completed_at FROM dreams ORDER BY completed_at DESC LIMIT 1',
  ).get() as { completed_at: number | null } | null
  const minutesSinceDream = lastDream?.completed_at
    ? Math.floor((Date.now() - lastDream.completed_at) / 60_000)
    : 999

  // Format uptime
  const uptimeMin = Math.floor(uptime / 60_000)
  const uptimeStr = uptimeMin < 60
    ? `${uptimeMin}m`
    : `${Math.floor(uptimeMin / 60)}h${uptimeMin % 60}m`

  // Format recent ticks
  const tickLines = recentTicks.map(t => {
    const time = new Date(t.fired_at).toLocaleTimeString('en-US', { hour12: false })
    return `    [${time}] ${t.decision}${t.sleep_seconds ? ' ' + t.sleep_seconds : ''} — ${t.reasoning ?? '(no reason)'}`
  }).join('\n')

  // Format queued tasks
  const queueBlock = queued.length === 0 ? '    (none)' : queued.map(t => {
    const ageSec = Math.floor((Date.now() - t.created_at) / 1000)
    const age = ageSec < 60 ? `${ageSec}s` : `${Math.floor(ageSec / 60)}m`
    return `    <task id="${t.task_id}" priority="${t.priority}" age="${age}">${t.description}</task>`
  }).join('\n')

  // Format running tasks
  const runBlock = running.length === 0 ? '    (none)' : running.map(t =>
    `    <task id="${t.task_id}" ticks="${t.tick_count}">${t.description}</task>`,
  ).join('\n')

  return `<tick>
  <time iso="${new Date().toISOString()}" local="${new Date().toLocaleTimeString()}" />
  <trigger source="${triggerSource}" reason="${triggerReason}" />
  <uptime>${uptimeStr}</uptime>

  <user>
    <last_user_action_seconds_ago>${idleSeconds}</last_user_action_seconds_ago>
    <connected_sessions>${queries.getActiveSessionCount(db)}</connected_sessions>
  </user>

  <queue depth="${queued.length}">
${queueBlock}
  </queue>

  <running depth="${running.length}">
${runBlock}
  </running>

  <inbox unread="${unreadCount}" />
  <approvals pending="${pendingApprovals}" />

  <budget>
    <subprocess_calls>${budget.subprocessCalls}/${budget.subprocessBudget}</subprocess_calls>
    <proactive_msgs>${budget.proactiveMsgs}/${budget.proactiveBudget}</proactive_msgs>
    <cost_cents>${budget.costCents}/${budget.costBudget}</cost_cents>
    <percent_used>${budget.percentUsed}%</percent_used>
  </budget>

  <recent_ticks>
${tickLines || '    (none yet)'}
  </recent_ticks>

  <memory candidates_waiting="${candidateCount}" minutes_since_dream="${minutesSinceDream}" />
</tick>`
}
