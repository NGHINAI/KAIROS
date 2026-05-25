// src/daemon/agency/intents/suspend.ts
import type { Intent } from '../types'
import type { ActionContext } from '../actionExecutor'

export const suspendIntent: Intent = {
  id: 'suspend',
  description: 'Suspend triggers/observers for a duration or condition',
  tier: 'GREEN',
  argSchema: { scope: 'string', duration_seconds: 'number', reason: 'string' },
}

export async function suspendHandler(
  args: { scope: 'all' | 'triggers' | 'observers'; duration_seconds: number; reason?: string },
  ctx: ActionContext,
): Promise<{ status: 'success'; details: string }> {
  const until = Date.now() + args.duration_seconds * 1000
  ctx.db.run(
    `INSERT INTO agency_suspend_state (scope, until_ms, reason) VALUES (?, ?, ?)`,
    [args.scope, until, args.reason ?? null],
  )
  return { status: 'success', details: `suspended ${args.scope} until ${new Date(until).toISOString()}` }
}
