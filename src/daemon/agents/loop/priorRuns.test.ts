// src/daemon/agents/loop/priorRuns.test.ts
import { test, expect } from "bun:test"
import { parsePriorRuns, buildPriorRunsHint } from "./priorRuns"

const jsonl = [
  JSON.stringify({ goal: "research my current project and write a summary", finalText: "Project is the Gmail skill.", toolCalls: [{ name: "kairos_memory_overview" }, { name: "update_plan" }], stopped: "final" }),
  JSON.stringify({ goal: "organize my inbox by archiving old newsletters", finalText: "Archived 40 emails.", toolCalls: [{ name: "GMAIL_FETCH_EMAILS" }, { name: "GMAIL_DELETE_MESSAGE" }], stopped: "max_turns" }),
  "  ", // blank
  "{not json", // malformed
  JSON.stringify({ goal: "do a thing", finalText: "", stopped: "final" }), // no result → not a success
].join("\n")

test("parsePriorRuns skips blank + malformed lines", () => {
  const runs = parsePriorRuns(jsonl)
  expect(runs.length).toBe(3)
  expect(runs[0]!.goal).toContain("research")
})

test("buildPriorRunsHint surfaces a similar SUCCESSFUL run", () => {
  const runs = parsePriorRuns(jsonl)
  const hint = buildPriorRunsHint("research the current project and summarize it", runs)
  expect(hint).toContain("Similar tasks")
  expect(hint).toContain("Gmail skill")             // the matching run's outcome
  expect(hint).toContain("kairos_memory_overview")  // tools used (update_plan filtered out)
  expect(hint).not.toContain("update_plan")
})

test("no similar run (or all below threshold) → empty hint", () => {
  const runs = parsePriorRuns(jsonl)
  expect(buildPriorRunsHint("book me a flight to tokyo next week", runs)).toBe("")
})

test("excludes runs with no result (not a success) and the exact same goal", () => {
  const runs = parsePriorRuns(jsonl)
  // exact same goal as an existing run → should NOT echo it back
  const hint = buildPriorRunsHint("organize my inbox by archiving old newsletters", runs)
  expect(hint).not.toContain("Archived 40") // that's the same goal, excluded
})

test("empty/no runs → empty hint, never throws", () => {
  expect(buildPriorRunsHint("anything", [])).toBe("")
  expect(buildPriorRunsHint("anything", parsePriorRuns(null))).toBe("")
})
