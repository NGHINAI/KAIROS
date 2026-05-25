// src/daemon/agency/intents/remindIn.ts
import type { Intent } from '../types'
import type { ActionContext } from '../actionExecutor'

export const remindInIntent: Intent = {
  id: 'remind_in',
  description: 'Schedule a notify action to fire after a delay',
  tier: 'GREEN',
  argSchema: { delay_seconds: 'number', title: 'string', body: 'string' },
}

export async function remindInHandler(
  args: { delay_seconds: number; title: string; body: string },
  ctx: ActionContext,
): Promise<{ status: 'success'; details: string }> {
  const fire_at = Date.now() + args.delay_seconds * 1000
  ctx.db.run(
    `INSERT INTO agency_scheduled_reminders (title, body, fire_at, fired) VALUES (?, ?, ?, 0)`,
    [args.title, args.body, fire_at],
  )
  setTimeout(() => {
    void ctx.notifier.notify({ title: args.title, body: args.body, urgency: 'normal' })
    ctx.db.run('UPDATE agency_scheduled_reminders SET fired = 1 WHERE fire_at = ?', [fire_at])
  }, args.delay_seconds * 1000)
  return { status: 'success', details: `scheduled reminder for ${new Date(fire_at).toISOString()}` }
}
