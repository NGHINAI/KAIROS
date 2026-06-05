// scripts/drive-stream.ts — like drive-once, but logs TTS frame timing so we can
// SEE the answer being spoken AS IT GENERATES (tts_chunk frames interleaved with
// tool calls), not dumped at the end. Usage: KAIROS_DAEMON_PORT=NNNN bun scripts/drive-stream.ts "..."
const utterance = Bun.argv[2] ?? "Hello"
const PORT = process.env.KAIROS_DAEMON_PORT ?? "9876"
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/v1/voice/events`)
const t0 = () => Date.now()
let start = 0
let ttsChunks = 0
let firstAudioMs = -1
let done = false
ws.onopen = () => { start = t0(); console.log(`[drive] sending: "${utterance}"`); ws.send(JSON.stringify({ cmd: "test_inject_utterance", text: utterance, conversationId: "stream-test" })) }
ws.onmessage = (m) => {
  let ev: any; try { ev = JSON.parse(m.data.toString()) } catch { return }
  const ms = start ? t0() - start : 0
  const e = ev.event
  if (e === "tts_begin") console.log(`+${ms}ms  tts_begin`)
  else if (e === "tts_chunk") { ttsChunks++; if (firstAudioMs < 0) { firstAudioMs = ms; console.log(`+${ms}ms  FIRST AUDIO (tts_chunk)`) } }
  else if (e === "tts_end") console.log(`+${ms}ms  tts_end (${ttsChunks} chunks so far)`)
  else if (e === "agent_tool_call") console.log(`+${ms}ms  tool_call: ${ev.name}(${JSON.stringify(ev.args).slice(0, 60)})`)
  else if (e === "agent_tool_done") console.log(`+${ms}ms  tool_done: ${ev.name}`)
  else if (e === "agent_done") { console.log(`+${ms}ms  agent_done: "${(ev.text ?? "").slice(0, 90)}"`); done = true; setTimeout(() => { console.log(`\nSUMMARY: firstAudio=+${firstAudioMs}ms, totalChunks=${ttsChunks}, total=+${ms}ms`); ws.close(); process.exit(0) }, 800) }
}
setTimeout(() => { if (!done) { console.log("[drive] timeout"); process.exit(1) } }, 90_000)
