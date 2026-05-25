// src/daemon/agency/intents/notify.ts
import type { Intent } from '../types'
import type { ActionContext } from '../actionExecutor'

export const notifyIntent: Intent = {
  id: 'notify',
  description: 'Surface a notification to the user (macOS native + inbox)',
  tier: 'GREEN',
  argSchema: { title: 'string', body: 'string', urgency: 'string' },
}

export async function notifyHandler(
  args: { title: string; body: string; urgency?: 'low' | 'normal' | 'high' },
  ctx: ActionContext,
): Promise<{ status: 'success'; details: string }> {
  await ctx.notifier.notify({
    title: args.title,
    body: args.body,
    urgency: args.urgency ?? 'normal',
  })
  return { status: 'success', details: `notified: ${args.title}` }
}
