// src/daemon/voice/integration.test.ts
import { test, expect } from "bun:test"
import { spawn } from "bun"

test("daemon boots with voice subsystem in <10s and serves /v1/health", async () => {
  const proc = spawn({
    cmd: ["bun", "scripts/voice-live.ts"],
    env: { ...process.env, KAIROS_DAEMON_PORT: "9877" },
    stdout: "ignore",
    stderr: "ignore",
  })
  try {
    // Poll /v1/health for up to 10 seconds
    let healthy = false
    for (let i = 0; i < 20; i++) {
      try {
        const resp = await fetch("http://127.0.0.1:9877/v1/health")
        if (resp.ok && (await resp.text()) === "ok") {
          healthy = true
          break
        }
      } catch {
        // not yet listening
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    expect(healthy).toBe(true)
  } finally {
    proc.kill()
    await proc.exited
    // Belt-and-suspenders: kill any leaked sidecar
    try {
      const cleanup = spawn({ cmd: ["pkill", "-f", "KairosVoiceHelper"], stdout: "ignore", stderr: "ignore" })
      await cleanup.exited
    } catch {}
  }
}, 20_000)
