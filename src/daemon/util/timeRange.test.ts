import { test, expect } from "bun:test"
import { dayKey, resolveWhen } from "./timeRange"

// A fixed anchor: 2026-06-07 12:00:00 UTC (a Sunday).
const NOW = Date.parse("2026-06-07T12:00:00Z")
const DAY = 86_400_000

test("dayKey formats the user's local day (YYYY-MM-DD) for a timezone", () => {
  // 2026-06-07T12:00Z is the 7th in UTC and in New York (08:00 EDT).
  expect(dayKey(NOW, "UTC")).toBe("2026-06-07")
  expect(dayKey(NOW, "America/New_York")).toBe("2026-06-07")
})

test("dayKey respects the timezone at a day boundary", () => {
  // 2026-06-07T02:00Z = still the 6th in New York (22:00 EDT on the 6th), the 7th in UTC.
  const boundary = Date.parse("2026-06-07T02:00:00Z")
  expect(dayKey(boundary, "UTC")).toBe("2026-06-07")
  expect(dayKey(boundary, "America/New_York")).toBe("2026-06-06")
})

test("resolveWhen('today') is the current day", () => {
  const r = resolveWhen("today", { tz: "UTC", now: NOW })
  expect(r.fromDay).toBe("2026-06-07")
  expect(r.toDay).toBe("2026-06-07")
  expect(r.label.toLowerCase()).toContain("today")
})

test("resolveWhen('yesterday') is the prior day, single-day range", () => {
  const r = resolveWhen("yesterday", { tz: "UTC", now: NOW })
  expect(r.fromDay).toBe("2026-06-06")
  expect(r.toDay).toBe("2026-06-06")
  expect(r.label.toLowerCase()).toContain("yesterday")
})

test("resolveWhen('this week' / 'last 7 days') spans the trailing week ending today", () => {
  for (const phrase of ["this week", "last 7 days", "past week"]) {
    const r = resolveWhen(phrase, { tz: "UTC", now: NOW })
    expect(r.toDay).toBe("2026-06-07")
    expect(r.fromDay).toBe("2026-06-01")  // 6 days back, inclusive
  }
})

test("resolveWhen accepts an explicit YYYY-MM-DD date", () => {
  const r = resolveWhen("2026-06-04", { tz: "UTC", now: NOW })
  expect(r.fromDay).toBe("2026-06-04")
  expect(r.toDay).toBe("2026-06-04")
})

test("resolveWhen defaults to today on empty/garbage input", () => {
  expect(resolveWhen("", { tz: "UTC", now: NOW }).fromDay).toBe("2026-06-07")
  expect(resolveWhen("blah blah", { tz: "UTC", now: NOW }).fromDay).toBe("2026-06-07")
})

test("resolveWhen returns ms boundaries covering the range (for the autonomous-table union)", () => {
  const r = resolveWhen("yesterday", { tz: "UTC", now: NOW })
  // 2026-06-06 in UTC: [00:00, next-00:00)
  expect(r.from).toBe(Date.parse("2026-06-06T00:00:00Z"))
  expect(r.to).toBeGreaterThanOrEqual(Date.parse("2026-06-06T23:59:59Z"))
  expect(r.to).toBeLessThanOrEqual(Date.parse("2026-06-07T00:00:01Z"))
  expect(r.to - r.from).toBeGreaterThanOrEqual(DAY - 1000)
})
