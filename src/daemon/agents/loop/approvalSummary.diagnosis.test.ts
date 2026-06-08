import { test, expect, afterEach } from "bun:test"
import { humanSummary } from "./approvalWrap"
import { isDestructiveCall, setToolNature } from "./verifier"

afterEach(() => setToolNature(null))

// ── Bug 4 — approval summary must NEVER speak a raw snake_case tool id ───────────
test("humanSummary never emits a raw snake_case id (the 'spoke internal messages' bug)", () => {
  for (const [name, eff] of [
    ["execute_tool", "kairos_composio_status"],
    ["execute_tool", "GMAIL_SEND_EMAIL"],
    ["execute_tool", "SLACK_SEND_MESSAGE"],
    ["some_weird_unmapped_tool", "some_weird_unmapped_tool"],
  ] as const) {
    const s = humanSummary(name, eff, {})
    expect(s).not.toMatch(/[a-z]+_[a-z]+/i) // no snake_case survives
    expect(s).not.toContain("kairos_")
    expect(s.toLowerCase()).not.toContain("_")
  }
})

test("humanSummary reads naturally for a Gmail send", () => {
  const s = humanSummary("execute_tool", "GMAIL_SEND_EMAIL", { args: { to: "patel@x.com" } })
  expect(s).toContain("via gmail")
  expect(s).toContain("send email")
  expect(s).toContain("patel@x.com")
})

test("humanSummary keeps the friendly cases (shell, connect)", () => {
  expect(humanSummary("run_shell", "run_shell", { command: "ls -la" })).toContain("shell command")
  expect(humanSummary("connect_service", "connect_service", { toolkit_slug: "linear" })).toContain("connect a service")
})

// ── Bug 3 — read-only kairos_* introspection tools must NOT be approval-gated ────
test("kairos_* introspection tools are never destructive (no spurious approval)", () => {
  for (const name of ["kairos_composio_status", "kairos_help", "kairos_memory_overview", "kairos_activity", "kairos_dreams_last"]) {
    expect(isDestructiveCall({ name, args: {} }, { unmappedDefault: "write" })).toBe(false)
  }
})

test("a real external write is still gated (we didn't over-fix)", () => {
  setToolNature(new Map([["GMAIL_SEND_EMAIL", "write"]]))
  expect(isDestructiveCall({ name: "execute_tool", args: { tool_name: "GMAIL_SEND_EMAIL" } })).toBe(true)
})
