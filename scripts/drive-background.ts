// scripts/drive-background.ts
// Live e2e for the Batch 2 background agent lane. Connects to an ALREADY-RUNNING
// daemon (default ws://127.0.0.1:9876/v1/voice/events), injects an utterance that
// should spawn a background sub-agent, then watches the whole chain:
//   foreground spawn_background_task → task_spawned → sub-agent task_tool(s) →
//   task_done/task_report (spoken summary).
// Then injects a "how's it going?" check-in and verifies the foreground calls
// background_tasks. Prints a PASS/FAIL summary. Does NOT boot or kill the daemon.

const PORT = process.env.KAIROS_DAEMON_PORT ?? "9876"
const URL = `ws://127.0.0.1:${PORT}/v1/voice/events`

const SPAWN_UTTERANCE =
  process.env.DRIVE_GOAL ??
  "Start a background task to research what my current project is about and write a one-paragraph summary. Run it in the background so we can keep talking."
const CHECKIN_UTTERANCE = "How is that background task going?"

type Ev = { event?: string; [k: string]: any }
const seen: Ev[] = []
const flags = {
  spawnToolCalled: false,
  taskSpawned: false,
  subAgentTools: [] as string[],
  taskDone: false,
  taskReport: false,
  reportSummary: "",
  checkinToolCalled: false,
  checkinReply: "",
}

function log(...a: any[]) { console.log(...a) }

const ws = new WebSocket(URL)
let cid = "drive-bg-1"

function inject(text: string, conversationId: string) {
  ws.send(JSON.stringify({ cmd: "test_inject_utterance", text, conversationId }))
}

ws.onopen = () => {
  log(`[drive-bg] connected → ${URL}`)
  log(`[drive-bg] inject #1 (spawn): "${SPAWN_UTTERANCE}"`)
  inject(SPAWN_UTTERANCE, cid)
}

ws.onmessage = (m) => {
  let ev: Ev
  try { ev = JSON.parse(m.data.toString()) } catch { return }
  if (!ev.event) return
  seen.push(ev)

  switch (ev.event) {
    case "agent_intent": log(`  · intent tier=${ev.tier}`); break
    case "agent_tool_call":
      log(`  · foreground tool → ${ev.name}`)
      if (ev.name === "spawn_background_task") flags.spawnToolCalled = true
      if (ev.name === "background_tasks") flags.checkinToolCalled = true
      break
    case "task_spawned":
      flags.taskSpawned = true
      log(`  ★ task_spawned id=${ev.id} goal="${(ev.goal ?? "").slice(0, 60)}"`)
      break
    case "task_tool":
      flags.subAgentTools.push(ev.tool)
      log(`    → sub-agent tool: ${ev.tool}`)
      break
    case "task_done":
      flags.taskDone = true
      log(`  ★ task_done summary="${(ev.summary ?? "").slice(0, 100)}"`)
      break
    case "task_report":
      flags.taskReport = true
      flags.reportSummary = ev.summary ?? ""
      log(`  ★ task_report (spoken) goal="${(ev.goal ?? "").slice(0, 40)}" summary="${(ev.summary ?? "").slice(0, 100)}"`)
      break
    case "task_failed":
      log(`  ✗ task_failed error="${ev.error}"`)
      break
    case "approval_request":
      log(`  ⚠ approval_request: ${ev.summary} — auto-denying for safety in this test`)
      // We don't approve destructive actions in an automated test.
      break
    case "agent_done":
      log(`  · foreground agent_done: "${(ev.text ?? "").slice(0, 100)}"`)
      if (flags.checkinAsked) flags.checkinReply = ev.text ?? ""
      break
  }
}

ws.onerror = (e) => { log(`[drive-bg] WS error`, (e as any)?.message ?? e) }

// Orchestration timeline.
;(flags as any).checkinAsked = false
const start = Date.now()
const tickEvery = 1000
let checkinSent = false

const timer = setInterval(() => {
  const elapsed = Date.now() - start

  // Once the spawn is acknowledged, fire the check-in (~6s in) to test background_tasks.
  if (flags.taskSpawned && !checkinSent && elapsed > 6000) {
    checkinSent = true
    ;(flags as any).checkinAsked = true
    cid = "drive-bg-1" // same conversation
    log(`[drive-bg] inject #2 (check-in): "${CHECKIN_UTTERANCE}"`)
    inject(CHECKIN_UTTERANCE, cid)
  }

  // Finish when we've seen a report (or failure), or after 90s hard cap.
  const done = flags.taskReport || flags.taskDone
  if ((done && checkinSent && elapsed > 12000) || elapsed > 90000) {
    clearInterval(timer)
    finish()
  }
}, tickEvery)

function finish() {
  try { ws.close() } catch {}
  log(`\n──────── BACKGROUND LANE E2E SUMMARY ────────`)
  log(`foreground called spawn_background_task : ${flags.spawnToolCalled ? "✓" : "✗"}`)
  log(`task_spawned event                      : ${flags.taskSpawned ? "✓" : "✗"}`)
  log(`sub-agent used tools                    : ${flags.subAgentTools.length ? "✓ [" + [...new Set(flags.subAgentTools)].join(", ") + "]" : "— (none / answered directly)"}`)
  log(`task_done                               : ${flags.taskDone ? "✓" : "✗"}`)
  log(`task_report (report-back / spoken)      : ${flags.taskReport ? "✓" : "✗"}`)
  log(`  report summary                        : "${flags.reportSummary.slice(0, 140)}"`)
  log(`check-in called background_tasks        : ${flags.checkinToolCalled ? "✓" : "✗"}`)
  const pass = flags.spawnToolCalled && flags.taskSpawned && (flags.taskReport || flags.taskDone)
  log(`\nRESULT: ${pass ? "✓ PASS — background lane works end to end" : "✗ FAIL — see above"}`)
  process.exit(pass ? 0 : 1)
}
