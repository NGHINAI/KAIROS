// src/daemon/agents/controlTools.test.ts
import { test, expect } from "bun:test"
import { buildControlTools } from "./controlTools"

function fakeExec(impl?: (argv: string[]) => { stdout?: string; stderr?: string; code?: number }) {
  const calls: string[][] = []
  const exec = async (argv: string[]) => {
    calls.push(argv)
    const r = impl?.(argv) ?? {}
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.code ?? 0 }
  }
  return { exec, calls }
}

function tools(impl?: Parameters<typeof fakeExec>[0]) {
  const { exec, calls } = fakeExec(impl)
  const [applescript, shell] = buildControlTools({ exec })
  return { applescript: applescript!, shell: shell!, calls }
}

// ── run_applescript ──

test("run_applescript runs via osascript -e and reports the result", async () => {
  const { applescript, calls } = tools(() => ({ stdout: "30" }))
  const out = await applescript.execute({ script: "output volume of (get volume settings)" })
  expect(calls[0]).toEqual(["osascript", "-e", "output volume of (get volume settings)"])
  expect(out).toContain("30")
})

test("run_applescript drives Spotify volume", async () => {
  const { applescript, calls } = tools(() => ({}))
  const out = await applescript.execute({ script: 'tell application "Spotify" to set sound volume to 30' })
  expect(calls[0][2]).toContain("Spotify")
  expect(out).toBe("Done.")
})

test("run_applescript refuses a script that shells out to rm -rf", async () => {
  const { applescript, calls } = tools()
  const out = await applescript.execute({ script: 'do shell script "rm -rf ~/Documents"' })
  expect(out).toContain("Refused")
  expect(calls.length).toBe(0)   // never executed
})

test("run_applescript surfaces osascript errors actionably", async () => {
  const { applescript } = tools(() => ({ code: 1, stderr: "execution error: app isn't running (-600)" }))
  const out = await applescript.execute({ script: 'tell application "Nope" to quit' })
  expect(out).toContain("AppleScript error")
  expect(out).toContain("-600")
})

test("run_applescript rejects an empty script", async () => {
  const { applescript, calls } = tools()
  expect(await applescript.execute({ script: "  " })).toContain("Give run_applescript")
  expect(calls.length).toBe(0)
})

// ── run_shell ──

test("run_shell runs under bash -lc and returns stdout", async () => {
  const { shell, calls } = tools(() => ({ stdout: "Spotify\n" }))
  const out = await shell.execute({ command: "pgrep -x Spotify >/dev/null && echo Spotify" })
  expect(calls[0][0]).toBe("bash")
  expect(calls[0][1]).toBe("-lc")
  expect(out).toContain("Spotify")
})

test("run_shell hard-refuses destructive commands and never executes them", async () => {
  for (const cmd of ["rm -rf ~/Desktop", "sudo rm -rf /", "dd if=/dev/zero of=/dev/disk0", "shutdown -h now", "echo x > /dev/sda"]) {
    const { shell, calls } = tools()
    const out = await shell.execute({ command: cmd })
    expect(out).toContain("Refused")
    expect(calls.length).toBe(0)
  }
})

test("run_shell reports a non-zero exit with stderr for self-correction", async () => {
  const { shell } = tools(() => ({ code: 2, stderr: "no such file" }))
  const out = await shell.execute({ command: "cat /nope" })
  expect(out).toContain("exited 2")
  expect(out).toContain("no such file")
})

test("run_shell clips very long output", async () => {
  const { shell } = tools(() => ({ stdout: "x".repeat(9000) }))
  const out = await shell.execute({ command: "yes | head -9000" })
  expect(out.length).toBeLessThan(4100)
  expect(out).toContain("truncated")
})

test("both control tools are exposed and are write-class (not concurrencySafe)", () => {
  const [a, s] = buildControlTools({ exec: async () => ({ stdout: "", stderr: "", code: 0 }) })
  expect(a!.name).toBe("run_applescript")
  expect(s!.name).toBe("run_shell")
  expect(a!.concurrencySafe).toBe(false)
  expect(s!.concurrencySafe).toBe(false)
})
