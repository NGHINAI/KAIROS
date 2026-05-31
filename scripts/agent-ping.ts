// scripts/agent-ping.ts
//
// End-to-end smoke test for the voice AGENT (not just the daemon boot).
//
// Usage:
//   bun scripts/agent-ping.ts "What skills do you have?"
//
// Spawns the daemon, opens a WebSocket to /v1/voice/events, simulates an
// `stt_final` event for the given utterance via the daemon's WS-command
// channel, then waits for `agent_done`. Exits 0 on success, 1 on failure or
// timeout. Use this to catch silent classifier failures BEFORE you find them
// during a live voice test.

import { spawn } from "bun"

const utterance = Bun.argv[2] ?? "Hello"
const PORT = process.env.KAIROS_DAEMON_PORT ?? "9878"
const BOOT_TIMEOUT_MS = 15_000
const AGENT_TIMEOUT_MS = 30_000

console.log(`[agent-ping] starting daemon on port ${PORT}...`)
const proc = spawn({
  cmd: ["bun", "scripts/voice-live.ts"],
  env: { ...process.env, KAIROS_DAEMON_PORT: PORT },
  stdout: "ignore",
  stderr: "ignore",
})

async function waitForHealth(): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < BOOT_TIMEOUT_MS) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/v1/health`)
      if (r.ok) return true
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

async function pingAgent(): Promise<{ ok: boolean; note: string }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/v1/voice/events`)
    let timer: ReturnType<typeof setTimeout> | null = null
    let agentResponded = false
    let classifierTier: string | undefined

    timer = setTimeout(() => {
      if (!agentResponded) {
        try { ws.close() } catch {}
        resolve({ ok: false, note: `timeout after ${AGENT_TIMEOUT_MS / 1000}s without agent_done` })
      }
    }, AGENT_TIMEOUT_MS)

    ws.onopen = () => {
      // Push a synthetic stt_final via the WS command channel. The daemon's
      // bus.publish for 'voice.user.utterance' routes to the agent conductor.
      ws.send(JSON.stringify({ cmd: "test_inject_utterance", text: utterance, conversationId: "agent-ping-test" }))
    }

    ws.onmessage = (m) => {
      try {
        const ev = JSON.parse(m.data.toString())
        if (ev.event === "agent_intent") classifierTier = ev.tier
        if (ev.event === "agent_error") {
          if (timer) clearTimeout(timer)
          ws.close()
          resolve({ ok: false, note: `agent_error: ${ev.message}` })
        }
        if (ev.event === "agent_done") {
          agentResponded = true
          if (timer) clearTimeout(timer)
          ws.close()
          resolve({ ok: true, note: `tier=${classifierTier ?? "?"} reply="${(ev.text ?? "").slice(0, 80)}"` })
        }
      } catch {}
    }

    ws.onerror = () => {
      if (timer) clearTimeout(timer)
      resolve({ ok: false, note: "WebSocket error" })
    }
  })
}

try {
  const healthy = await waitForHealth()
  if (!healthy) {
    console.error(`[agent-ping] daemon did not become healthy within ${BOOT_TIMEOUT_MS / 1000}s`)
    process.exit(1)
  }
  console.log(`[agent-ping] daemon healthy — pinging agent with: "${utterance}"`)

  const result = await pingAgent()
  if (result.ok) {
    console.log(`[agent-ping] ✓ ${result.note}`)
  } else {
    console.error(`[agent-ping] ✗ ${result.note}`)
  }
  process.exitCode = result.ok ? 0 : 1
} finally {
  try { proc.kill() } catch {}
  await proc.exited
  // Clean any orphaned sidecar
  try {
    const cleanup = spawn({ cmd: ["pkill", "-f", "KairosVoiceHelper"], stdout: "ignore", stderr: "ignore" })
    await cleanup.exited
  } catch {}
  process.exit(process.exitCode ?? 1)
}
