// Pure cron parsing and next-fire computation.
// Zero external dependencies. Handles natural language → standard 5-field cron
// and computes next fire times from cron expressions.

/**
 * Attempt to parse natural language into a standard 5-field cron expression.
 * Returns null if the input can't be parsed by regex (caller should use LLM fallback).
 */
export function parseSimpleCron(text: string): string | null {
  const t = text.toLowerCase().trim()

  // Direct cron expression: "0 9 * * 1-5"
  if (/^[\d\*\-\,\/]+(\s+[\d\*\-\,\/]+){4}$/.test(t)) {
    return t
  }

  // "every N minutes"
  let m = t.match(/every\s+(\d+)\s+min/)
  if (m) return `*/${m[1]} * * * *`

  // "every minute"
  if (/every\s+minute/.test(t)) return '* * * * *'

  // "every N hours"
  m = t.match(/every\s+(\d+)\s+hour/)
  if (m) return `0 */${m[1]} * * *`

  // "every hour"
  if (/every\s+hour/.test(t)) return '0 * * * *'

  // "every day at HH:MM" or "daily at HH:MM"
  m = t.match(/(?:every\s+day|daily)\s+at\s+(\d{1,2}):?(\d{2})?\s*(am|pm)?/)
  if (m) {
    const { hour, minute } = parseTime(m[1]!, m[2], m[3])
    return `${minute} ${hour} * * *`
  }

  // "at HH:MM am/pm"
  m = t.match(/^at\s+(\d{1,2}):?(\d{2})?\s*(am|pm)?$/)
  if (m) {
    const { hour, minute } = parseTime(m[1]!, m[2], m[3])
    return `${minute} ${hour} * * *`
  }

  // "every weekday at HH:MM"
  m = t.match(/every\s+weekday\s+at\s+(\d{1,2}):?(\d{2})?\s*(am|pm)?/)
  if (m) {
    const { hour, minute } = parseTime(m[1]!, m[2], m[3])
    return `${minute} ${hour} * * 1-5`
  }

  // "every monday/tuesday/..." optionally "at HH:MM"
  const dayMap: Record<string, string> = {
    sunday: '0', monday: '1', tuesday: '2', wednesday: '3',
    thursday: '4', friday: '5', saturday: '6',
    sun: '0', mon: '1', tue: '2', wed: '3', thu: '4', fri: '5', sat: '6',
  }
  m = t.match(/every\s+((?:sun|mon|tue|wed|thu|fri|sat)\w*)\s*(?:at\s+(\d{1,2}):?(\d{2})?\s*(am|pm)?)?/)
  if (m && dayMap[m[1]!]) {
    const { hour, minute } = m[2] ? parseTime(m[2], m[3], m[4]) : { hour: 0, minute: 0 }
    return `${minute} ${hour} * * ${dayMap[m[1]!]}`
  }

  // "every N days"
  m = t.match(/every\s+(\d+)\s+day/)
  if (m) return `0 0 */${m[1]} * *`

  // "every week"
  if (/every\s+week/.test(t)) return '0 0 * * 1'

  // Can't parse — caller should use LLM fallback
  return null
}

/**
 * Parse a relative time expression like "in 2 hours" into epoch ms.
 * Returns null if not a relative expression.
 */
export function parseRelativeTime(text: string): number | null {
  const t = text.toLowerCase().trim()
  const now = Date.now()

  let m = t.match(/in\s+(\d+)\s+second/)
  if (m) return now + parseInt(m[1]!) * 1_000

  m = t.match(/in\s+(\d+)\s+min/)
  if (m) return now + parseInt(m[1]!) * 60_000

  m = t.match(/in\s+(\d+)\s+hour/)
  if (m) return now + parseInt(m[1]!) * 3_600_000

  m = t.match(/in\s+(\d+)\s+day/)
  if (m) return now + parseInt(m[1]!) * 86_400_000

  return null
}

/**
 * Compute the next fire time from a 5-field cron expression.
 * Fields: minute hour day-of-month month day-of-week
 */
export function nextCronFire(cronExpr: string, from?: Date): Date {
  const fields = cronExpr.trim().split(/\s+/)
  if (fields.length !== 5) throw new Error(`Invalid cron: ${cronExpr}`)

  const [minField, hourField, domField, monField, dowField] = fields as [string, string, string, string, string]
  const start = from ? new Date(from) : new Date()
  // Start from next minute
  start.setSeconds(0, 0)
  start.setMinutes(start.getMinutes() + 1)

  // Iterate up to 366 days to find next match
  const limit = 366 * 24 * 60
  for (let i = 0; i < limit; i++) {
    const d = new Date(start.getTime() + i * 60_000)
    if (
      matchField(minField, d.getMinutes()) &&
      matchField(hourField, d.getHours()) &&
      matchField(domField, d.getDate()) &&
      matchField(monField, d.getMonth() + 1) &&
      matchField(dowField, d.getDay())
    ) {
      return d
    }
  }

  // Fallback: 24 hours from now
  return new Date(Date.now() + 86_400_000)
}

/**
 * Validate a 5-field cron expression.
 */
export function isValidCronExpr(expr: string): boolean {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return false
  return fields.every(f => /^[\d\*\-\,\/]+$/.test(f!))
}

// ─── Helpers ────────────────────────────────────────────────────────

function parseTime(hourStr: string, minStr?: string, ampm?: string): { hour: number; minute: number } {
  let hour = parseInt(hourStr)
  const minute = minStr ? parseInt(minStr) : 0
  if (ampm === 'pm' && hour < 12) hour += 12
  if (ampm === 'am' && hour === 12) hour = 0
  return { hour, minute }
}

function matchField(field: string, value: number): boolean {
  if (field === '*') return true

  // Step: */N
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2))
    return step > 0 && value % step === 0
  }

  // List: 1,3,5
  const parts = field.split(',')
  for (const part of parts) {
    // Range: 1-5
    if (part.includes('-')) {
      const [lo, hi] = part.split('-').map(Number)
      if (lo !== undefined && hi !== undefined && value >= lo && value <= hi) return true
    } else {
      if (parseInt(part) === value) return true
    }
  }

  return false
}
