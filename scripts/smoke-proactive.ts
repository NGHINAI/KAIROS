// scripts/smoke-proactive.ts
// 5-minute end-to-end test: start observers, wait, query bus, print summary.
// Requires: at least one LLM provider configured in ~/.kairos/providers.json.
//
// Usage: bun run scripts/smoke-proactive.ts

import { Database } from 'bun:sqlite'
import { homedir } from 'os'
import { join } from 'path'
import { buildRouter } from '../src/daemon/llm'
import { EventBus } from '../src/daemon/proactive/eventBus'
import { StateSnapshot } from '../src/daemon/proactive/stateSnapshot'
import { ObserverRegistry } from '../src/daemon/proactive/observerRegistry'
import { Narrator } from '../src/daemon/proactive/narrator'
import { FocusAppObserver } from '../src/daemon/proactive/observers/focusApp'
import { BrowserTabsObserver } from '../src/daemon/proactive/observers/browserTabs'
import { ClipboardObserver } from '../src/daemon/proactive/observers/clipboard'
import { FileEventsObserver } from '../src/daemon/proactive/observers/fileEvents'
import { CalendarLocalObserver } from '../src/daemon/proactive/observers/calendarLocal'

const DURATION_MS = 5 * 60_000

const db = new Database(':memory:')
const router = buildRouter(db, join(homedir(), '.kairos', 'providers.json'))
const bus = new EventBus(db)
const snapshot = new StateSnapshot(bus)
const registry = new ObserverRegistry(bus)

registry.register(new FocusAppObserver(bus))
registry.register(new BrowserTabsObserver(bus))
registry.register(new ClipboardObserver(bus))
registry.register(new FileEventsObserver(bus))
registry.register(new CalendarLocalObserver(bus))

const narrator = new Narrator(bus, snapshot, router, { intervalMs: 90_000 })

console.log(`Starting proactive smoke test for ${DURATION_MS / 1000}s...`)
console.log(`Switch apps / open tabs / copy text to generate events.`)

await registry.startAll()
await narrator.start()

await new Promise(r => setTimeout(r, DURATION_MS))

await narrator.stop()
await registry.stopAll()

const all = bus.recent(1000)
const bySource: Record<string, number> = {}
for (const e of all) bySource[e.source] = (bySource[e.source] ?? 0) + 1

console.log(`\n─── Summary ───`)
console.log(`Total events: ${all.length}`)
for (const [src, n] of Object.entries(bySource)) {
  console.log(`  ${src.padEnd(20)} ${n}`)
}

const narratives = all.filter(e => e.source === 'narrator')
console.log(`\nNarratives generated: ${narratives.length}`)
for (const n of narratives.slice(0, 3)) {
  console.log(`\n[${new Date(n.ts).toISOString()}] ${(n.payload as any).provider}/${(n.payload as any).model}`)
  console.log((n.payload as any).text)
}
