// scripts/drive-once.ts — connect to a RUNNING daemon, inject one utterance,
// print EVERY event verbatim (so we can see agent_tool_call names + results).
// Usage: KAIROS_DAEMON_PORT=9880 bun scripts/drive-once.ts "your utterance"
const utterance = Bun.argv[2] ?? "Hello"
const PORT = process.env.KAIROS_DAEMON_PORT ?? "9876"
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/v1/voice/events`)
let done = false
ws.onopen = () => {
  console.log(`[drive] sending: "${utterance}"`)
  ws.send(JSON.stringify({ cmd: "test_inject_utterance", text: utterance, conversationId: "drive-test" }))
}
ws.onmessage = (m) => {
  try {
    const ev = JSON.parse(m.data.toString())
    if (["agent_intent", "agent_tool_call", "agent_tool_done", "agent_tool_failed", "agent_done", "agent_error"].includes(ev.event)) {
      console.log(`[event] ${ev.event}: ${JSON.stringify({ tier: ev.tier, name: ev.name, args: ev.args, result_summary: ev.result_summary, error: ev.error, text: ev.text }).slice(0, 400)}`)
    }
    if (ev.event === "agent_done" || ev.event === "agent_error") { done = true; setTimeout(() => { ws.close(); process.exit(0) }, 500) }
  } catch {}
}
setTimeout(() => { if (!done) { console.log("[drive] timeout"); ws.close(); process.exit(1) } }, 90_000)
