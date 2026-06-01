// scripts/verify-memory.ts
// End-to-end verification of every KAIROS memory layer against a LIVE daemon.
//
// Usage:
//   1. Start the daemon (any of these works):
//        KAIROS_WITH_VOICE=true bun scripts/voice-live.ts
//        (or ./scripts/voice-electron.sh, then run this in another terminal)
//   2. bun scripts/verify-memory.ts
//
// It drives a scripted conversation via the test_inject_utterance WS command
// (same path a real voice turn takes), then inspects state.db + ~/.kairos files
// to PROVE each memory style works. Prints PASS/FAIL per layer.
//
// Layers checked:
//   L1  conversation memory   — recalls something from 2 turns ago
//   L2  episodic memory       — the exchange is recorded as an observation
//   L3  semantic facts        — durable fact extracted + recalled
//   Contradiction handling    — a corrected name supersedes the old one
//   Persona / preferences     — "from now on…" lands in persona.md
//   File-system view          — ~/.kairos/memory/*.md projection (idle; informational)
//   Daily narrative           — ~/.kairos/daily/*.md (idle; informational)

import { Database } from "bun:sqlite"
import { homedir } from "os"
import { join } from "path"
import { existsSync, readdirSync, readFileSync } from "fs"

const PORT = process.env.KAIROS_DAEMON_PORT ?? "9876"
const WS_URL = `ws://127.0.0.1:${PORT}/v1/voice/events`
const DB_PATH = join(process.cwd(), "state", "state.db")
const KDIR = join(homedir(), ".kairos")
const CID = "verify-" + Date.now()

const GREEN = "\x1b[32m", RED = "\x1b[31m", DIM = "\x1b[2m", YEL = "\x1b[33m", RST = "\x1b[0m"
let pass = 0, fail = 0
function check(label: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`${GREEN}✓ PASS${RST} ${label}${detail ? DIM + " — " + detail + RST : ""}`) }
  else { fail++; console.log(`${RED}✗ FAIL${RST} ${label}${detail ? DIM + " — " + detail + RST : ""}`) }
}
function info(label: string, detail = "") { console.log(`${YEL}• INFO${RST} ${label}${detail ? DIM + " — " + detail + RST : ""}`) }

// ── WS conversation driver ───────────────────────────────────────────────
function driver() {
  const replies: string[] = []
  let ws: WebSocket
  const ready = new Promise<void>((resolve, reject) => {
    ws = new WebSocket(WS_URL)
    ws.onopen = () => resolve()
    ws.onerror = () => reject(new Error(`cannot reach daemon at ${WS_URL} — is it running?`))
    ws.onmessage = (m) => { try { const e = JSON.parse(String(m.data)); if (e.event === "agent_done") replies.push(e.text) } catch {} }
  })
  const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
  async function say(text: string, settleMs = 7000): Promise<string> {
    const before = replies.length
    ws.send(JSON.stringify({ cmd: "test_inject_utterance", text, conversationId: CID }))
    const deadline = Date.now() + settleMs
    while (replies.length === before && Date.now() < deadline) await wait(200)
    await wait(2500) // let fire-and-forget memory writes settle
    return replies[replies.length - 1] ?? "(no reply)"
  }
  return { ready: () => ready, say, close: () => ws.close() }
}

const db = () => new Database(DB_PATH, { readonly: true })
function count(sql: string, ...args: any[]): number {
  try { return (db().query(sql).get(...args) as any)?.c ?? 0 } catch { return 0 }
}
function rows(sql: string, ...args: any[]): any[] {
  try { return db().query(sql).all(...args) } catch { return [] }
}

async function main() {
  console.log(`\n${DIM}KAIROS memory verification — daemon ${WS_URL}, conversation ${CID}${RST}\n`)
  const d = driver()
  try { await d.ready() } catch (e) { console.log(`${RED}${(e as Error).message}${RST}`); process.exit(1) }

  // Baselines (count rows that already exist so we measure DELTA from this run).
  const l2Before = count(`SELECT COUNT(*) c FROM mem_l2_observations WHERE source='voice'`)
  const l3Before = count(`SELECT COUNT(*) c FROM mem_l3_facts`)

  console.log(`${DIM}Driving scripted conversation…${RST}`)
  // Turn 1 — establish facts (name + project + a preference).
  const r1 = await d.say("Hi, my name is Nirmal and my project is called Husk, a browser engine for AI agents.")
  info("turn 1 reply", r1.slice(0, 70))
  // Turn 2 — a correction (tests contradiction handling on an important fact).
  const r2 = await d.say("Actually my name is spelled N-I-R-M-A-L, Nirmal.", 8000)
  info("turn 2 reply", r2.slice(0, 70))
  // Turn 3 — a standing preference (tests persona nudge).
  const r3 = await d.say("From now on, keep your replies short and skip the pleasantries.")
  info("turn 3 reply", r3.slice(0, 70))
  // Turn 4 — recall a fact from earlier (tests L1 + L3 recall reaching the prompt).
  const r4 = await d.say("What is my project called?")
  info("turn 4 reply", r4.slice(0, 70))
  // Turn 5 — recall the name (tests contradiction resolved → consistent answer).
  const r5 = await d.say("And what's my name?")
  info("turn 5 reply", r5.slice(0, 70))

  d.close()
  await new Promise(r => setTimeout(r, 1500))

  console.log(`\n${DIM}── Results ──${RST}`)

  // L1 conversation + L3 recall: did it answer the project question correctly?
  check("L3 semantic recall (project)", /husk/i.test(r4), `reply: "${r4.slice(0,50)}"`)
  // Contradiction handling: name answer should be Nirmal (not a mishearing), consistently.
  check("Contradiction handling (name = Nirmal)", /nirmal/i.test(r5) && !/numa|norma|nirmala\b/i.test(r5), `reply: "${r5.slice(0,50)}"`)

  // L2 episodic: this run's exchanges recorded as observations.
  const l2After = count(`SELECT COUNT(*) c FROM mem_l2_observations WHERE source='voice'`)
  check("L2 episodic memory (observations recorded)", l2After > l2Before, `+${l2After - l2Before} observations`)

  // L3 facts: new durable facts written this run.
  const l3After = count(`SELECT COUNT(*) c FROM mem_l3_facts`)
  check("L3 fact extraction (new facts written)", l3After > l3Before, `+${l3After - l3Before} facts`)

  // L3 has the project + a name fact, and the name fact is Nirmal.
  const nameFacts = rows(`SELECT text, superseded_at FROM mem_l3_facts WHERE lower(text) LIKE '%nirmal%' OR lower(text) LIKE '%name%' ORDER BY ts`)
  const projFacts = rows(`SELECT text FROM mem_l3_facts WHERE lower(text) LIKE '%husk%' AND superseded_at IS NULL`)
  check("L3 fact content (project=Husk stored, live)", projFacts.length > 0,
    projFacts.map(r => r.text).join(" | ").slice(0, 60))
  // If a contradiction was detected, expect either a superseded row OR a pending-confirmation marker.
  const superseded = count(`SELECT COUNT(*) c FROM mem_l3_facts WHERE superseded_at IS NOT NULL`)
  const pending = count(`SELECT COUNT(*) c FROM mem_l3_facts WHERE category='_pending_confirmation' AND superseded_at IS NULL`)
  check("Contradiction machinery engaged (supersede or pending marker)", superseded > 0 || pending > 0,
    `superseded=${superseded}, pending=${pending}`)
  if (pending > 0) info("pending confirmation present (KAIROS will ask which name is right)", "expected for important+uncertain conflicts")

  // Semantic indexing: are vectors being written (hybrid recall active)?
  const vecRows = count(`SELECT COUNT(*) c FROM semantic_vec`)
  check("Semantic vector index populated (hybrid recall)", vecRows > 0, `${vecRows} vectors`)

  // Persona preference: did "from now on…" land in persona.md?
  const personaPath = join(KDIR, "persona.md")
  const persona = existsSync(personaPath) ? readFileSync(personaPath, "utf8") : ""
  check("Persona preference captured (persona.md updated)",
    /short|pleasantr|terse|brief/i.test(persona),
    existsSync(personaPath) ? "persona.md has a style note" : "persona.md missing")

  // ── Idle-only layers (informational — these run on the dream timer, not per-turn) ──
  console.log(`\n${DIM}── Idle-cycle layers (only populate after a dream cycle; informational) ──${RST}`)
  const memDir = join(KDIR, "memory")
  const memFiles = existsSync(memDir) ? readdirSync(memDir).filter(f => f.endsWith(".md")) : []
  info("File-system view (~/.kairos/memory/*.md)", memFiles.length ? memFiles.join(", ") : "none yet — runs on idle dream cycle")
  const dailyDir = join(KDIR, "daily")
  const dailyFiles = existsSync(dailyDir) ? readdirSync(dailyDir).filter(f => f.endsWith(".md")) : []
  info("Daily narrative (~/.kairos/daily/*.md)", dailyFiles.length ? dailyFiles.join(", ") : "none yet — runs on deep dream cycle")

  console.log(`\n${pass + fail > 0 ? "" : ""}${GREEN}${pass} passed${RST}, ${fail > 0 ? RED : DIM}${fail} failed${RST}`)
  console.log(`${DIM}Tip: inspect facts with:  bun -e 'const{Database}=require("bun:sqlite");const db=new Database("state/state.db",{readonly:true});for(const r of db.query("SELECT substr(text,1,60) t,category,superseded_at FROM mem_l3_facts ORDER BY ts DESC LIMIT 10").all())console.log(r.superseded_at?"[X]":"[ ]",r.category||"-",r.t)'${RST}\n`)
  process.exit(fail > 0 ? 1 : 0)
}

main()
