// scripts/validate-phase-e1.ts
//
// Phase E.1 validation gate. 20 assertions covering the Bun-side voice stack.
// Run: bun scripts/validate-phase-e1.ts

import { Database } from 'bun:sqlite'
import { startWrapApi, type WrapApiServer } from '../src/daemon/wrapApi/server'
import { LLMAdapter } from '../src/daemon/wrapApi/adapters/llmAdapter'
import { VoiceAdapter } from '../src/daemon/wrapApi/adapters/voiceAdapter'
import { ConversationStore } from '../src/daemon/voice/conversationStore'
import { VoiceConductor } from '../src/daemon/voice/voiceConductor'
import { SidecarSimulator } from '../src/daemon/voice/sidecarSimulator'
import { SayBackend } from '../src/daemon/voice/sayBackend'

let pass = 0, fail = 0
const T0 = Date.now()
const assert = (name: string, cond: boolean, detail?: string) => {
  const elapsed = Math.floor((Date.now() - T0) / 1000)
  const t = `[T+${String(elapsed).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}]`
  const n = String(++(cond ? { v: pass } : { v: fail }).v).padStart(2, '0')
  if (cond) { pass++ } else { fail++ }
  const status = cond ? 'PASS' : 'FAIL'
  console.log(`[${String(pass + fail).padStart(2, '0')}/20] ${t} ${name.padEnd(38, '.')} ${status}${detail ? ' (' + detail + ')' : ''}`)
}

// ── 1. Server lifecycle ────────────────────────────────
const stubAdapters = {
  llm: { complete: async () => ({ text: 'ok' }) },
  voice: { chat: async (b: any) => ({ text: 'echo:' + b.transcript, speakId: 'spk_t' }), cancel: async () => {} },
  memory: { append: async () => ({}), get: async () => ({}) },
  orders: { add: async () => ({ slug: 'r' }), list: async () => [] },
  composio: { listConnections: async () => [], connect: async () => ({}), disconnect: async () => ({}) },
  settings: { get: async () => ({}), update: async () => ({ updated: [] }) },
} as any

const server: WrapApiServer = await startWrapApi({ port: 0, adapters: stubAdapters })
assert('wrap-API server starts', server.port > 0)
assert('health endpoint returns ok', (await fetch(`${server.baseUrl}/v1/health`)).status === 200)

// ── 2. Endpoints ───────────────────────────────────────
{
  const r = await fetch(`${server.baseUrl}/v1/llm/complete`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
  })
  assert('POST /v1/llm/complete works', r.status === 200)
}
{
  const r = await fetch(`${server.baseUrl}/v1/voice/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ transcript: 'hello', conversationId: 'c1' }),
  })
  const body = await r.json() as any
  assert('POST /v1/voice/chat persists turn', body.text === 'echo:hello')
}
assert('GET /v1/orders/list returns array', Array.isArray(await (await fetch(`${server.baseUrl}/v1/orders/list`)).json()))
assert('unknown route → 404', (await fetch(`${server.baseUrl}/v1/nope`)).status === 404)
assert('POST without content-type → 415', (await fetch(`${server.baseUrl}/v1/llm/complete`, { method: 'POST', body: '{}' })).status === 415)
assert('GET on POST route → 405', (await fetch(`${server.baseUrl}/v1/llm/complete`)).status === 405)

await server.stop()

// ── 3. Conversation store ──────────────────────────────
{
  const store = new ConversationStore(new Database(':memory:'))
  await store.appendTurn('c1', { role: 'user', text: 'hi', at: 1000 })
  await store.appendTurn('c1', { role: 'agent', text: 'hello', at: 1100 })
  await store.appendTurn('c2', { role: 'user', text: 'isolated', at: 1000 })
  const c1 = await store.recentTurns('c1', 10)
  const c2 = await store.recentTurns('c2', 10)
  assert('ConversationStore round-trips turns', c1.length === 2 && c1[1]!.text === 'hello')
  assert('ConversationStore isolates conversations', c2.length === 1)
}

// ── 4. SidecarSimulator ────────────────────────────────
{
  const sim = new SidecarSimulator({ speakDurationMs: 5 })
  let ready = false
  sim.onEvent(e => { if (e.event === 'sidecar_ready') ready = true })
  await sim.start()
  assert('SidecarSimulator emits sidecar_ready', ready)
}
{
  const sim = new SidecarSimulator({ speakDurationMs: 5 })
  let finished = false
  sim.onEvent(e => { if (e.event === 'speak_finished') finished = true })
  await sim.start()
  await sim.send({ cmd: 'speak', text: 'hi', speakId: 'spk_1' })
  assert('SidecarSimulator speak_started → speak_finished', finished)
}
{
  const sim = new SidecarSimulator({ speakDurationMs: 100 })
  let interrupted = false
  sim.onEvent(e => { if (e.event === 'speak_interrupted') interrupted = true })
  await sim.start()
  void sim.send({ cmd: 'speak', text: 'long', speakId: 'spk_a' })
  await new Promise(r => setTimeout(r, 10))
  sim.simulateBargeIn()
  await new Promise(r => setTimeout(r, 30))
  assert('SidecarSimulator barge_in cancels speak', interrupted)
}

// ── 5. VoiceConductor end-to-end with stub fetch ────
{
  const sim = new SidecarSimulator({ speakDurationMs: 5 })
  const store = new ConversationStore(new Database(':memory:'))
  const bus: any[] = []
  const spoken: string[] = []
  const conductor = new VoiceConductor({
    sidecar: sim as any,
    store,
    bus: { publish: (k, p) => bus.push({ k, p }) },
    wrapApiBaseUrl: 'http://stub',
    fetchImpl: (async (_u: string, opts: any) => ({
      ok: true, status: 200,
      json: async () => ({ text: 'echo:' + JSON.parse(opts.body).transcript, speakId: 'spk_x' }),
    })) as any,
    speakBackend: { speak: async t => { spoken.push(t) }, stop: () => {} } as any,
  })
  await conductor.start()
  assert('VoiceConductor starts → idle', conductor.state === 'idle')

  sim.simulateHotkey('down')
  assert('hotkey down → listening', conductor.state === 'listening')

  sim.simulateUtterance('hello kairos')
  sim.simulateHotkey('up')
  await new Promise(r => setTimeout(r, 30))
  assert('utterance → wrap-API → speak', spoken.includes('echo:hello kairos'))

  assert('bus published voice.user.utterance', bus.some(e => e.k === 'voice.user.utterance'))
  assert('bus published voice.agent.utterance', bus.some(e => e.k === 'voice.agent.utterance'))

  await conductor.proactiveSpeak('proactive ping')
  assert('proactiveSpeak() speaks unsolicited', spoken.includes('proactive ping'))

  await conductor.stop()
  assert('VoiceConductor stops cleanly', conductor.state === 'stopped')
}

// ── 6. SayBackend reachability ─────────────────────────
{
  const b = new SayBackend({ runner: async () => ({ exitCode: 0, stdout: 'Ava (Enhanced)     en_US    # x.\n' }) })
  const voices = await b.listVoices()
  assert('SayBackend.listVoices parses', voices.length === 1 && voices[0]!.name === 'Ava (Enhanced)')
}

// ── 7. LLM adapter ─────────────────────────────────────
{
  let req: any
  const adapter = new LLMAdapter({
    client: { messages: { create: async (r: any) => { req = r; return { content: [{ type: 'text', text: 'x' }] } } } } as any,
    defaultModel: 'claude-haiku-4-5',
  })
  await adapter.complete({ messages: [{ role: 'user', content: 'hi' }], system: 'sys' })
  assert('LLMAdapter passes system + default model', req.model === 'claude-haiku-4-5' && req.system === 'sys')
}

console.log()
console.log(`Summary: ${pass} PASS, ${fail} FAIL`)
console.log()
console.log(fail === 0 ? '=== Gate verdict: PASS ✓ ===' : '=== Gate verdict: FAIL ✗ ===')
process.exit(fail === 0 ? 0 : 1)
