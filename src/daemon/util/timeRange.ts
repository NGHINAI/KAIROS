// src/daemon/util/timeRange.ts
//
// One place for day-bucketing + relative-time ("yesterday"/"this week") resolution,
// timezone-aware. KAIROS stores all timestamps as ms epoch, but the user's "yesterday"
// is their LOCAL day (KAIROS_TZ) — not the UTC day the old `toISOString().slice(0,10)`
// idiom (copy-pasted in 4 places) assumed. Activity recall buckets by the user's day so
// "what did you do yesterday" reads the right window even on a UTC/cloud daemon.

const DAY_MS = 86_400_000

/** The user's local calendar day for a timestamp, as 'YYYY-MM-DD'. tz defaults to
 *  KAIROS_TZ (unset → host local). en-CA formats as YYYY-MM-DD. */
export function dayKey(ts: number, tz?: string): string {
  const zone = tz ?? process.env.KAIROS_TZ?.trim()
  try {
    return new Date(ts).toLocaleDateString("en-CA", zone ? { timeZone: zone } : {})
  } catch {
    return new Date(ts).toISOString().slice(0, 10) // bad tz → UTC day, still a real day
  }
}

/** ms of local midnight that begins the given dayKey in tz. Uses the standard
 *  wall-clock-diff offset trick so it's correct for any tz (not just the host). */
function startOfDayMs(day: string, tz?: string): number {
  const zone = tz ?? process.env.KAIROS_TZ?.trim()
  if (!zone) return new Date(`${day}T00:00:00`).getTime() // host-local midnight
  const utcMidnight = Date.parse(`${day}T00:00:00Z`)
  try {
    const d = new Date(utcMidnight)
    const asUtc = new Date(d.toLocaleString("en-US", { timeZone: "UTC" })).getTime()
    const asZone = new Date(d.toLocaleString("en-US", { timeZone: zone })).getTime()
    return utcMidnight - (asZone - asUtc) // local midnight expressed in UTC ms
  } catch {
    return utcMidnight
  }
}

export interface ResolvedRange {
  fromDay: string  // 'YYYY-MM-DD' inclusive (query activity_events by day string)
  toDay: string    // 'YYYY-MM-DD' inclusive
  from: number     // ms, start of fromDay (for the autonomous-table union)
  to: number       // ms, end of toDay (exclusive-ish)
  label: string    // human, for the spoken lead-in + HUD header
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** Resolve a phrase ("yesterday", "today", "this week", "last 7 days", a date) to a
 *  bucketed range. Defaults to today. now/tz injectable for tests. */
export function resolveWhen(phrase: string, opts: { tz?: string; now?: number } = {}): ResolvedRange {
  const tz = opts.tz ?? process.env.KAIROS_TZ?.trim()
  const now = opts.now ?? Date.now()
  const p = (phrase ?? "").trim().toLowerCase()
  const today = dayKey(now, tz)

  const range = (fromDay: string, toDay: string, label: string): ResolvedRange => ({
    fromDay,
    toDay,
    from: startOfDayMs(fromDay, tz),
    to: startOfDayMs(toDay, tz) + DAY_MS,
    label,
  })

  if (ISO_DATE.test(p)) return range(p, p, p)
  if (/\byesterday\b/.test(p)) { const d = dayKey(now - DAY_MS, tz); return range(d, d, "yesterday") }
  if (/\b(this week|last (7|seven) days|past week|last week)\b/.test(p)) {
    return range(dayKey(now - 6 * DAY_MS, tz), today, p.includes("last week") ? "the last week" : "this week")
  }
  if (/\b(last (30|thirty) days|this month|past month)\b/.test(p)) {
    return range(dayKey(now - 29 * DAY_MS, tz), today, "the last 30 days")
  }
  // default: today (covers "today", empty, and anything unrecognized)
  return range(today, today, "today")
}
