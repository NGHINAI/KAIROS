import { test, expect, beforeEach, afterEach } from "bun:test"
import { Database } from "bun:sqlite"
import { buildIntrospectionTools } from "./introspectionTools"
import { ActivityStore } from "../activity/activityStore"

const DAY = 86_400_000

// Stub the unrelated introspection deps (kairos_activity doesn't touch them).
const stub = {
  soulLoader: { load: async () => "" },
  skillRegistry: { listActive: async () => [] },
  ordersStore: { list: async () => [] },
  semanticMemory: { add: async () => ({ id: "x" }), search: async () => [] },
  episodicMemory: { recent: async () => [{ title: "167 routine events" }], search: async () => [] },
  memoryStore: { read: async () => "" },
  dreamLog: { last: async () => null, search: async () => [] },
  connectionStore: { list: async () => [] },
}

let prevTz: string | undefined
beforeEach(() => { prevTz = process.env.KAIROS_TZ; process.env.KAIROS_TZ = "UTC" })
afterEach(() => { if (prevTz === undefined) delete process.env.KAIROS_TZ; else process.env.KAIROS_TZ = prevTz })

function toolWithStore(store: ActivityStore) {
  const tools = buildIntrospectionTools({
    ...stub,
    activityStore: {
      query: (range, opts) => store.query(range, opts),
      digest: (items) => store.digest(items as any),
    },
  })
  return tools.find((t) => t.name === "kairos_activity")!
}

test("REGRESSION: kairos_activity('yesterday') returns the real actions, not '167 routine events'", async () => {
  const db = new Database(":memory:")
  const store = new ActivityStore(db, { tz: "UTC" })
  const y = Date.now() - DAY
  store.record({ at: y, kind: "action", lane: "foreground", tool: "GMAIL_SEND_EMAIL", title: "Gmail send email", detail: "email Patel", status: "done", importance: 0.8 })
  store.record({ at: y + 1, kind: "subagent", lane: "background", title: "Background: research flights", status: "done", importance: 0.8 })
  store.record({ at: y + 2, kind: "read", lane: "foreground", title: "said hi", status: "info", importance: 0.2 }) // chitchat
  store.record({ at: Date.now() - 3 * DAY, kind: "action", lane: "foreground", title: "Linear create issue", status: "done", importance: 0.8 }) // out of range

  const tool = toolWithStore(store)
  const res: any = await tool.execute({ when: "yesterday" })

  const titles = res.items.map((i: any) => i.what)
  expect(titles).toContain("Gmail send email")
  expect(titles).toContain("Background: research flights")
  expect(titles).not.toContain("said hi")          // chitchat excluded (minImportance)
  expect(titles).not.toContain("Linear create issue") // out of range
  expect(res.count).toBe(2)
  expect(res.period).toBe("yesterday")
  expect(JSON.stringify(res)).not.toContain("167 routine events") // never the perception noise
})

test("kairos_activity gracefully reports when the activity log isn't available", async () => {
  const tools = buildIntrospectionTools({ ...stub }) // no activityStore dep
  const tool = tools.find((t) => t.name === "kairos_activity")!
  const res: any = await tool.execute({ when: "today" })
  expect(res.items).toEqual([])
  expect(res.note).toMatch(/not available/i)
})
