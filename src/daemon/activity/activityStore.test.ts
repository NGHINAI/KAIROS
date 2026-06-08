import { test, expect, beforeEach } from "bun:test"
import { Database } from "bun:sqlite"
import { ActivityStore } from "./activityStore"
import { resolveWhen } from "../util/timeRange"

const NOW = Date.parse("2026-06-07T12:00:00Z")
const DAY = 86_400_000
const yesterday = NOW - DAY

let db: Database
let store: ActivityStore
beforeEach(() => { db = new Database(":memory:"); store = new ActivityStore(db, { tz: "UTC" }) })

function recordSamples() {
  // an ACTION yesterday (a real "did" thing)
  store.record({ at: yesterday + 3_600_000, kind: "action", lane: "foreground", tool: "GMAIL_SEND_EMAIL", title: "Sent an email to pateln062@gmail.com", detail: "user asked to email Patel", status: "done", importance: 0.8, ref: { threadId: "19e99" } })
  // a BACKGROUND sub-agent run yesterday
  store.record({ at: yesterday + 7_200_000, kind: "subagent", lane: "background", title: "Researched flight options", detail: "found 3 under $400", status: "done", importance: 0.8, runId: "bg1" })
  // chitchat yesterday (low importance — should be excluded from the digest)
  store.record({ at: yesterday + 9_000_000, kind: "read", lane: "foreground", title: "said hi", status: "info", importance: 0.2 })
  // an action 3 days ago (out of yesterday's range)
  store.record({ at: NOW - 3 * DAY, kind: "action", lane: "foreground", tool: "LINEAR_CREATE_ISSUE", title: "Created a Linear issue", status: "done", importance: 0.8 })
}

test("records and queries actions for a day range; buckets by the user's tz day", () => {
  recordSamples()
  const items = store.query(resolveWhen("yesterday", { tz: "UTC", now: NOW }))
  const titles = items.map(i => i.title)
  expect(titles).toContain("Sent an email to pateln062@gmail.com")
  expect(titles).toContain("Researched flight options")
  expect(titles).not.toContain("Created a Linear issue") // 3 days ago — out of range
})

test("minImportance filters out chitchat (the digest is about what you DID)", () => {
  recordSamples()
  const items = store.query(resolveWhen("yesterday", { tz: "UTC", now: NOW }), { minImportance: 0.5 })
  expect(items.map(i => i.title)).not.toContain("said hi")
  expect(items.length).toBe(2)
})

test("digest summarizes counts in a spoken-friendly line", () => {
  recordSamples()
  const items = store.query(resolveWhen("yesterday", { tz: "UTC", now: NOW }), { minImportance: 0.5 })
  const d = store.digest(items)
  expect(d).toMatch(/2/)            // 2 things
  expect(d.toLowerCase()).toMatch(/email|action|sent|task|thing/)
})

test("titles are secret-sanitized on the way in", () => {
  store.record({ at: yesterday, kind: "action", lane: "foreground", title: "connected with key sk-abcdef0123456789ABCDEFGHIJ", status: "done", importance: 0.8 })
  const items = store.query(resolveWhen("yesterday", { tz: "UTC", now: NOW }))
  expect(JSON.stringify(items)).toContain("<REDACTED>")
  expect(JSON.stringify(items)).not.toContain("sk-abcdef")
})

test("unions autonomous tables (ticks) at query time, mapped to the activity shape", () => {
  // Simulate the proactive scheduler's tick log existing in the same db.
  db.run(`CREATE TABLE ticks (tick_id INTEGER PRIMARY KEY, fired_at INTEGER, decision TEXT, reasoning TEXT, model TEXT)`)
  db.run(`INSERT INTO ticks (fired_at, decision, reasoning) VALUES (?, ?, ?)`, [yesterday + 1_000_000, "send_message", "user has a standup at 10"])
  db.run(`INSERT INTO ticks (fired_at, decision, reasoning) VALUES (?, ?, ?)`, [yesterday + 2_000_000, "sleep", "nothing to do"]) // should be excluded
  recordSamples()
  const items = store.query(resolveWhen("yesterday", { tz: "UTC", now: NOW }))
  const proactive = items.filter(i => i.lane === "proactive")
  expect(proactive.length).toBe(1)                       // the 'sleep' tick is filtered out
  expect(proactive[0]!.kind).toBe("tick")
})

test("missing autonomous tables never break recall (lazy/uncreated tables)", () => {
  recordSamples() // no ticks/tasks/messages tables created at all
  expect(() => store.query(resolveWhen("yesterday", { tz: "UTC", now: NOW }))).not.toThrow()
  expect(store.query(resolveWhen("yesterday", { tz: "UTC", now: NOW })).length).toBeGreaterThan(0)
})

test("prune drops events older than the retention window", () => {
  store.record({ at: NOW - 100 * DAY, kind: "action", lane: "foreground", title: "ancient", status: "done", importance: 0.8 })
  store.record({ at: NOW - DAY, kind: "action", lane: "foreground", title: "recent", status: "done", importance: 0.8 })
  const removed = store.prune(NOW - 90 * DAY)
  expect(removed).toBe(1)
  const all = store.query(resolveWhen("last 30 days", { tz: "UTC", now: NOW }))
  expect(all.map(i => i.title)).toContain("recent")
  expect(all.map(i => i.title)).not.toContain("ancient")
})

test("results are sorted chronologically", () => {
  recordSamples()
  const items = store.query(resolveWhen("yesterday", { tz: "UTC", now: NOW }))
  for (let i = 1; i < items.length; i++) expect(items[i]!.at).toBeGreaterThanOrEqual(items[i - 1]!.at)
})
