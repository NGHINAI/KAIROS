import { test, expect } from "bun:test"
import { estimateCostCents } from "./pricing"

// Regression for the 2026-06-07 diagnosis #1: a classify call (5304 in / 4 out on
// gpt-4o-mini) really costs ~0.08¢ — the old Math.ceil recorded it as 1¢ (~12× over).
test("estimateCostCents keeps sub-cent precision (the ~12x over-count bug)", () => {
  const c = estimateCostCents("openai/gpt-4o-mini", 5304, 4)
  expect(c).toBeGreaterThan(0)
  expect(c).toBeLessThan(0.1)              // well under 1¢ — NOT ceiled to 1
  expect(c).toBeCloseTo((5304 / 1e6) * 0.15 * 100 + (4 / 1e6) * 0.6 * 100, 6)
})

test("estimateCostCents prices input + output correctly", () => {
  // 1M in + 1M out on gpt-4o-mini = $0.15 + $0.60 = $0.75 = 75¢
  expect(estimateCostCents("openai/gpt-4o-mini", 1_000_000, 1_000_000)).toBeCloseTo(75, 6)
})

test("estimateCostCents falls back for unknown models (never throws / zero)", () => {
  expect(estimateCostCents("some/unknown-model", 1_000_000, 0)).toBeCloseTo(100, 6) // fallback $1/1M in
})

test("zero tokens cost zero", () => {
  expect(estimateCostCents("openai/gpt-4o-mini", 0, 0)).toBe(0)
})
