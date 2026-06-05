// src/daemon/agents/toolUsageTracker.test.ts
import { test, expect } from "bun:test"
import { ToolUsageTracker } from "./toolUsageTracker"

test("counts tool usage and returns the most-used names", () => {
  const store: Record<string, number> = {}
  const t = new ToolUsageTracker({ load: () => ({ ...store }), save: (c) => { Object.assign(store, c) } })
  t.record("GMAIL_SEND_EMAIL"); t.record("GMAIL_SEND_EMAIL"); t.record("GMAIL_SEND_EMAIL")
  t.record("LINEAR_LIST_ISSUES"); t.record("LINEAR_LIST_ISSUES")
  t.record("SLACK_SEND_MESSAGE")
  expect(t.topNames(2)).toEqual(["GMAIL_SEND_EMAIL", "LINEAR_LIST_ISSUES"])
})

test("topNames returns at most n, fewer if fewer tools seen", () => {
  const t = new ToolUsageTracker({ load: () => ({}), save: () => {} })
  t.record("A")
  expect(t.topNames(5)).toEqual(["A"])
})

test("persists counts via save and reloads via load", () => {
  let saved: Record<string, number> = {}
  const t1 = new ToolUsageTracker({ load: () => ({}), save: (c) => { saved = c } })
  t1.record("X"); t1.record("X")
  expect(saved.X).toBe(2)
  // a fresh tracker that loads the saved counts continues from there
  const t2 = new ToolUsageTracker({ load: () => ({ ...saved }), save: () => {} })
  t2.record("X")
  expect(t2.topNames(1)).toEqual(["X"])
})

test("ignores empty/blank tool names", () => {
  const t = new ToolUsageTracker({ load: () => ({}), save: () => {} })
  t.record("")
  t.record("   ")
  expect(t.topNames(5)).toEqual([])
})
