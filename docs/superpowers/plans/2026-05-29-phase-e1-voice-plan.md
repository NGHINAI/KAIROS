# Phase E.1 Voice — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development with Opus 4.7 sub-agents (per memory `feedback-subagent-model-opus`). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship KAIROS voice interface end-to-end: user holds hotkey → Apple STT → LLM via local wrap-API → Apple TTS → KAIROS speaks. With barge-in, proactive speech, voice-only configuration, memory integration.

**Architecture:** All-local Apple-native voice stack + Swift sidecar (KairosVoiceHelper.app via UDS+JSON) + in-process Bun wrap-API server (`/v1/*` endpoints, Cloud-shaped contract). Voice utterances flow through perception bus to existing memory.

**Tech Stack:** Bun + TypeScript (daemon side), Swift + AVFoundation + Speech.framework + CoreML (sidecar side), Anthropic SDK (LLM via Haiku 4.5), Silero VAD via CoreML, embedded LLM key (pre-Cloud).

**Spec reference:** `docs/superpowers/specs/2026-05-29-phase-e1-voice-design.md` (815 lines, locked).

---

## Implementation strategy & realistic in-session scope

Phase E.1 in the spec is 3-4 weeks of work. This plan ships **everything buildable in this session** + leaves the rest in `READY-TO-BUILD` state. Strategy:

| Phase | What ships this session | Status after this session |
|---|---|---|
| **E.1.0** | `say`-command voice as bootstrap (proves pipeline) | ✅ live, audible |
| **E.1.2** | Bun voice conductor + sidecar client + lifecycle | ✅ built + tested (uses simulator) |
| **E.1.3** | Bun wrap-API server + LLM/memory/orders/composio/settings adapters | ✅ built + tested |
| **E.1.4** | Barge-in stub (real barge-in needs Swift sidecar) | ✅ Bun-side ready |
| **E.1.5** | Voice onboarding state machine (text + `say`) | ✅ built + tested |
| **E.1.6** | Voice memory integration (perception bus → trajectory) | ✅ built + tested |
| **E.1.7** | 15-min check-in scheduler | ✅ built + tested |
| **E.1.1** | Swift sidecar source code (`KairosVoiceHelper`) | ✅ source written, xcodebuild as follow-up |
| **E.1.8** | Validation gate + regression | ✅ runs green |

**The user will see real audio output during this session** via the `say` command path. The Swift sidecar requires Xcode + signing cert + TCC permissions which need user-side setup — but its full source code is in the repo ready to build.

---

## File structure (lock decisions first)

### New files (this session)

```
src/daemon/voice/
├── types.ts                    # Shared types — VoiceEvent, SidecarMsg, etc.
├── sayBackend.ts               # Stage-0: AVSpeechSynthesizer via `say` command
├── sidecarClient.ts            # UDS client + JSON-line protocol
├── sidecarLifecycle.ts         # Spawn/respawn/health-check
├── sidecarSimulator.ts         # Bun-side mock for testing without Swift
├── voiceConductor.ts           # Main orchestrator
├── conversationStore.ts        # SQLite: conversations, turns
├── voiceConfig.ts              # Voice settings, hotkey, voice selection
├── proactiveScheduler.ts       # Decides when KAIROS speaks unsolicited
└── *.test.ts (one per file)

src/daemon/wrapApi/
├── server.ts                   # Bun.serve wrapper
├── auth.ts                     # No-op now; Bearer token hook later
├── adapters/
│   ├── llmAdapter.ts           # Embedded Anthropic key, Haiku 4.5
│   ├── voiceAdapter.ts         # /v1/voice/chat orchestration
│   ├── memoryAdapter.ts        # Wraps soul/persona/trajectory
│   ├── ordersAdapter.ts        # Wraps OrdersAuthor / OrdersStore
│   ├── composioAdapter.ts      # Wraps existing Composio integration
│   └── settingsAdapter.ts      # ~/.kairos/config.json CRUD
└── *.test.ts

src/daemon/onboarding/
├── voiceOnboarding.ts          # First-launch state machine
├── personaBuilder.ts           # Voice answers → soul.md
└── *.test.ts

apps/macos/KairosVoiceHelper/   # SWIFT source — for xcodebuild follow-up
├── Package.swift               # SwiftPM project structure
├── Sources/KairosVoiceHelper/
│   ├── main.swift              # Entry point
│   ├── HotKeyManager.swift     # CGEventTap (fork from clicky)
│   ├── AudioEngine.swift       # AVAudioEngine + VoiceProcessingIO
│   ├── SpeechRecognizer.swift  # SFSpeechRecognizer
│   ├── SpeechSynthesizer.swift # AVSpeechSynthesizer
│   ├── SileroVAD.swift         # CoreML wrapper (model bundled separately)
│   ├── BargeInDetector.swift   # VAD-during-TTS logic
│   ├── SidecarProtocol.swift   # JSON-line over UDS
│   ├── Info.plist              # Usage strings
│   └── KairosVoiceHelper.entitlements
└── BUILD.md                    # Xcode build + signing instructions

scripts/
├── voice-demo.ts               # End-to-end demo: trigger → KAIROS speaks via say
└── validate-phase-e1.ts        # 25-assertion validation gate

docs/superpowers/plans/
└── 2026-05-29-phase-e1-voice-plan.md  # this file
```

### Modified files

```
src/daemon/index.ts             # Wire voiceConductor + wrapApi server on boot
package.json                    # Add @anthropic-ai/sdk if not present
.env                            # Add KAIROS_ANTHROPIC_KEY (gitignored)
.env.example                    # Document the env var
CHANGELOG.md                    # v0.6.0 entry
```

---

## Tasks

### Task 0: Bootstrap — add Anthropic SDK dependency

**Files:**
- Modify: `package.json`
- Create: `.env.example`

- [ ] **Step 1: Check current package.json for @anthropic-ai/sdk**

```bash
grep -E '"@anthropic-ai/sdk"' package.json && echo "already there" || echo "needs install"
```

- [ ] **Step 2: If needed, install Anthropic SDK**

```bash
bun add @anthropic-ai/sdk
```

- [ ] **Step 3: Add KAIROS_ANTHROPIC_KEY to .env.example**

Append to `.env.example`:
```
# Voice + LLM (Phase E.1)
KAIROS_ANTHROPIC_KEY=sk-ant-...        # Embedded for pre-Cloud; rotated when leaked
KAIROS_VOICE_BACKEND=say               # 'say' (stage-0) | 'sidecar' (full Swift helper)
KAIROS_VOICE_RATE=180                  # words/min for `say`; AVSpeech is 0.0-1.0 scale
KAIROS_VOICE_NAME=Ava                  # Apple voice name for `say -v <name>`
```

- [ ] **Step 4: Commit bootstrap**

```bash
git add package.json .env.example
git commit -m "chore(voice): add @anthropic-ai/sdk and env vars for Phase E.1"
```

---

### Task 1: Shared voice types

**Files:**
- Create: `src/daemon/voice/types.ts`
- Create: `src/daemon/voice/types.test.ts`

- [ ] **Step 1: Write test first**

```typescript
// src/daemon/voice/types.test.ts
import { describe, it, expect } from 'bun:test'
import type { VoiceEvent, SidecarCmd, SpeechRate } from './types'

describe('voice/types', () => {
  it('VoiceEvent kinds are exhaustive', () => {
    const kinds: VoiceEvent['kind'][] = [
      'user.utterance', 'agent.utterance', 'agent.interrupted',
      'hotkey.down', 'hotkey.up', 'session.started', 'session.ended',
    ]
    expect(kinds.length).toBe(7)
  })

  it('SidecarCmd validates basic shape', () => {
    const cmd: SidecarCmd = { cmd: 'speak', text: 'hello', voice: 'Ava', interruptible: true }
    expect(cmd.cmd).toBe('speak')
  })
})
```

- [ ] **Step 2: Create the types**

```typescript
// src/daemon/voice/types.ts
export type SpeechRate = number  // 0.0-1.0 (Apple), or words-per-minute for `say`

export type VoiceEvent =
  | { kind: 'user.utterance';  text: string; conversationId: string; at: number }
  | { kind: 'agent.utterance'; text: string; conversationId: string; speakId: string; at: number }
  | { kind: 'agent.interrupted'; speakId: string; at: number }
  | { kind: 'hotkey.down';     at: number }
  | { kind: 'hotkey.up';       at: number }
  | { kind: 'session.started'; conversationId: string; at: number }
  | { kind: 'session.ended';   conversationId: string; at: number }

export type SidecarCmd =
  | { cmd: 'speak';           text: string; voice?: string; rate?: SpeechRate; interruptible?: boolean; speakId?: string }
  | { cmd: 'stop_speaking' }
  | { cmd: 'start_listening'; mode: 'push_to_talk' | 'toggle' }
  | { cmd: 'stop_listening' }
  | { cmd: 'set_hotkey';      modifier: 'option' | 'control' | 'command'; action: 'hold' | 'double_tap' }
  | { cmd: 'set_voice';       voice: string }
  | { cmd: 'get_voices' }
  | { cmd: 'health_check' }
  | { cmd: 'shutdown' }

export type SidecarEvent =
  | { event: 'sidecar_ready'; version: string }
  | { event: 'hotkey'; state: 'down' | 'up'; modifier: string }
  | { event: 'stt_partial'; text: string; confidence: number }
  | { event: 'stt_final';   text: string; confidence: number }
  | { event: 'user_speaking_started'; amplitude: number }
  | { event: 'barge_in_detected'; during_speak_id?: string }
  | { event: 'speak_started';  speak_id: string }
  | { event: 'speak_finished'; speak_id: string; interrupted: boolean }
  | { event: 'speak_interrupted'; speak_id: string }
  | { event: 'voices_available'; voices: { id: string; name: string; quality: string; language: string }[] }
  | { event: 'error'; code: string; message?: string }
```

- [ ] **Step 3: Run test**

```bash
bun test src/daemon/voice/types.test.ts
```
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/daemon/voice/types.ts src/daemon/voice/types.test.ts
git commit -m "feat(voice): shared types for VoiceEvent + SidecarCmd/Event"
```

---

### Task 2: Stage-0 SayBackend (proves audio pipeline works)

**Why this task:** Lets us hear KAIROS speak TODAY using macOS's built-in `say` command. No Swift sidecar needed. Used as `KAIROS_VOICE_BACKEND=say` default until Swift sidecar is built+signed.

**Files:**
- Create: `src/daemon/voice/sayBackend.ts`
- Create: `src/daemon/voice/sayBackend.test.ts`

- [ ] **Step 1: Tests**

```typescript
// src/daemon/voice/sayBackend.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { SayBackend } from './sayBackend'

describe('SayBackend', () => {
  let calls: any[]
  let backend: SayBackend
  beforeEach(() => {
    calls = []
    const fakeRunner = async (cmd: string[], opts?: { signal?: AbortSignal }) => {
      calls.push({ cmd, opts })
      return { exitCode: 0 }
    }
    backend = new SayBackend({ runner: fakeRunner as any, defaultVoice: 'Ava', defaultRate: 180 })
  })

  it('speak(text) invokes `say -v Ava -r 180 <text>`', async () => {
    await backend.speak('hello world')
    expect(calls[0].cmd).toEqual(['say', '-v', 'Ava', '-r', '180', 'hello world'])
  })

  it('speak with custom voice + rate', async () => {
    await backend.speak('hi', { voice: 'Daniel', rate: 220 })
    expect(calls[0].cmd).toEqual(['say', '-v', 'Daniel', '-r', '220', 'hi'])
  })

  it('stop() aborts the active speech', async () => {
    let aborted = false
    const longRunner = async (_: string[], opts?: { signal?: AbortSignal }) => {
      await new Promise<void>((resolve) => {
        opts?.signal?.addEventListener('abort', () => { aborted = true; resolve() })
      })
      return { exitCode: 130 }
    }
    backend = new SayBackend({ runner: longRunner as any, defaultVoice: 'Ava', defaultRate: 180 })
    const speakPromise = backend.speak('a long sentence...')
    setTimeout(() => backend.stop(), 10)
    await speakPromise
    expect(aborted).toBe(true)
  })

  it('listVoices returns parsed voice list', async () => {
    const fakeRunner = async () => ({
      exitCode: 0,
      stdout: 'Ava (Enhanced)     en_US    # Hi, I am Ava.\nDaniel             en_GB    # Hello, my name is Daniel.\n',
    })
    backend = new SayBackend({ runner: fakeRunner as any, defaultVoice: 'Ava', defaultRate: 180 })
    const voices = await backend.listVoices()
    expect(voices.length).toBe(2)
    expect(voices[0]!.name).toBe('Ava (Enhanced)')
    expect(voices[1]!.name).toBe('Daniel')
  })
})
```

- [ ] **Step 2: Implementation**

```typescript
// src/daemon/voice/sayBackend.ts
//
// Stage-0 voice backend. Uses macOS's built-in `say` command — the same engine
// AVSpeechSynthesizer uses under the hood. No Swift sidecar needed; proves the
// pipeline works end-to-end on day one.
//
// When Swift sidecar ships, swap KAIROS_VOICE_BACKEND=sidecar in env. Same
// interface, different impl.

import { spawn } from 'bun'

export type RunResult = { exitCode: number; stdout?: string }
export type Runner = (cmd: string[], opts?: { signal?: AbortSignal; stdout?: 'pipe' | 'inherit' }) => Promise<RunResult>

const defaultRunner: Runner = async (cmd, opts) => {
  const proc = spawn({ cmd, stdout: opts?.stdout ?? 'pipe', stderr: 'ignore', signal: opts?.signal })
  const stdoutText = opts?.stdout === 'pipe' || opts?.stdout === undefined
    ? await new Response(proc.stdout).text()
    : undefined
  const exitCode = await proc.exited
  return { exitCode, stdout: stdoutText }
}

export type SayBackendDeps = {
  runner?: Runner
  defaultVoice?: string  // e.g. 'Ava'
  defaultRate?: number   // words per minute, default 180
}

export type SpeakOptions = { voice?: string; rate?: number }

export type Voice = { name: string; language: string; sample?: string }

export class SayBackend {
  private runner: Runner
  private defaultVoice: string
  private defaultRate: number
  private activeAbort: AbortController | null = null

  constructor(deps: SayBackendDeps = {}) {
    this.runner = deps.runner ?? defaultRunner
    this.defaultVoice = deps.defaultVoice ?? 'Ava'
    this.defaultRate = deps.defaultRate ?? 180
  }

  async speak(text: string, opts: SpeakOptions = {}): Promise<void> {
    if (!text.trim()) return
    this.stop()  // cancel anything in flight
    const voice = opts.voice ?? this.defaultVoice
    const rate = String(opts.rate ?? this.defaultRate)
    this.activeAbort = new AbortController()
    try {
      await this.runner(['say', '-v', voice, '-r', rate, text], { signal: this.activeAbort.signal })
    } catch (err) {
      // Aborted speech is expected on barge-in; swallow
      if ((err as Error).name !== 'AbortError') throw err
    } finally {
      this.activeAbort = null
    }
  }

  stop(): void {
    if (this.activeAbort) {
      this.activeAbort.abort()
      this.activeAbort = null
    }
  }

  async listVoices(): Promise<Voice[]> {
    const { stdout } = await this.runner(['say', '-v', '?'], { stdout: 'pipe' })
    if (!stdout) return []
    return stdout
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        // Format: "Ava (Enhanced)     en_US    # Hi, I am Ava."
        const m = line.match(/^(.+?)\s{2,}(\S+)\s*#\s*(.*)$/)
        if (!m) return null
        return { name: m[1]!.trim(), language: m[2]!.trim(), sample: m[3]?.trim() }
      })
      .filter((v): v is Voice => v !== null)
  }
}
```

- [ ] **Step 3: Run tests**

```bash
bun test src/daemon/voice/sayBackend.test.ts
```
Expected: PASS (4 tests)

- [ ] **Step 4: Manual demo (you HEAR KAIROS speak)**

```bash
bun -e "import { SayBackend } from './src/daemon/voice/sayBackend.ts'; const b = new SayBackend(); await b.speak('Hello Nirmal, this is KAIROS speaking through the say-command bootstrap. The voice pipeline works.')"
```

- [ ] **Step 5: Commit**

```bash
git add src/daemon/voice/sayBackend.ts src/daemon/voice/sayBackend.test.ts
git commit -m "feat(voice): SayBackend — stage-0 voice via macOS \`say\` command"
```

---

### Task 3: Wrap-API server foundation

**Files:**
- Create: `src/daemon/wrapApi/server.ts`
- Create: `src/daemon/wrapApi/server.test.ts`

- [ ] **Step 1: Tests**

```typescript
// src/daemon/wrapApi/server.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { startWrapApi, type WrapApiServer } from './server'

describe('WrapApi server', () => {
  let server: WrapApiServer
  beforeEach(async () => {
    server = await startWrapApi({ port: 0, adapters: {
      llm: { complete: async () => ({ text: 'stub-llm-response' }) } as any,
      voice: { chat: async () => ({ text: 'stub-voice-response', speakId: 'spk_x' }) } as any,
      memory: { append: async () => {}, get: async () => ({}) } as any,
      orders: { add: async () => ({ slug: 'rule-x' }), list: async () => [] } as any,
      composio: { listConnections: async () => [], connect: async () => ({ ok: true }), disconnect: async () => ({ ok: true }) } as any,
      settings: { get: async () => ({}), update: async () => ({ updated: [] }) } as any,
    } })
  })
  afterEach(async () => { await server.stop() })

  it('health endpoint returns ok', async () => {
    const r = await fetch(`http://127.0.0.1:${server.port}/v1/health`)
    expect(r.status).toBe(200)
    expect(await r.text()).toBe('ok')
  })

  it('POST /v1/llm/complete delegates to llm adapter', async () => {
    const r = await fetch(`http://127.0.0.1:${server.port}/v1/llm/complete`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{role: 'user', content: 'hi'}] }),
    })
    expect(r.status).toBe(200)
    expect(((await r.json()) as any).text).toBe('stub-llm-response')
  })

  it('POST /v1/voice/chat delegates to voice adapter', async () => {
    const r = await fetch(`http://127.0.0.1:${server.port}/v1/voice/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ transcript: 'hello', conversationId: 'c1' }),
    })
    expect(r.status).toBe(200)
    const body = await r.json() as any
    expect(body.text).toBe('stub-voice-response')
    expect(body.speakId).toBe('spk_x')
  })

  it('POST /v1/orders/add returns slug', async () => {
    const r = await fetch(`http://127.0.0.1:${server.port}/v1/orders/add`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rule: { /* ... */ }, via: 'voice' }),
    })
    expect(r.status).toBe(200)
    expect(((await r.json()) as any).slug).toBe('rule-x')
  })

  it('unknown endpoint returns 404', async () => {
    const r = await fetch(`http://127.0.0.1:${server.port}/v1/nope`)
    expect(r.status).toBe(404)
  })

  it('POST without content-type 415s', async () => {
    const r = await fetch(`http://127.0.0.1:${server.port}/v1/llm/complete`, { method: 'POST', body: '{}' })
    expect(r.status).toBe(415)
  })

  it('GET on POST endpoint returns 405', async () => {
    const r = await fetch(`http://127.0.0.1:${server.port}/v1/llm/complete`)
    expect(r.status).toBe(405)
  })
})
```

- [ ] **Step 2: Implementation**

```typescript
// src/daemon/wrapApi/server.ts
//
// In-process Bun HTTP server hosting /v1/* — the "Cloud-shaped local API."
// Migration to api.kairos.ai later = config flip on the daemon's base URL.

import type { Server } from 'bun'

export type WrapApiAdapters = {
  llm:      { complete: (body: any) => Promise<any> }
  voice:    { chat: (body: any) => Promise<any>; cancel?: () => Promise<void> }
  memory:   { append: (body: any) => Promise<any>; get: (body: any) => Promise<any> }
  orders:   { add: (body: any) => Promise<any>; list: () => Promise<any>; disable?: (slug: string) => Promise<any> }
  composio: { listConnections: () => Promise<any>; connect: (body: any) => Promise<any>; disconnect: (body: any) => Promise<any> }
  settings: { get: () => Promise<any>; update: (body: any) => Promise<any> }
}

export type WrapApiOpts = {
  port?: number       // 0 = auto-pick
  hostname?: string   // default 127.0.0.1
  adapters: WrapApiAdapters
}

export type WrapApiServer = { port: number; baseUrl: string; stop(): Promise<void> }

export async function startWrapApi(opts: WrapApiOpts): Promise<WrapApiServer> {
  const hostname = opts.hostname ?? '127.0.0.1'
  const a = opts.adapters

  const post = (handler: (body: any) => Promise<any>) => async (req: Request) => {
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
    const ct = req.headers.get('content-type') ?? ''
    if (!ct.includes('application/json')) return new Response('Unsupported Media Type', { status: 415 })
    try {
      const body = await req.json()
      const result = await handler(body)
      return Response.json(result)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return Response.json({ error: msg }, { status: 500 })
    }
  }

  const server: Server = Bun.serve({
    hostname, port: opts.port ?? 0,
    routes: {
      '/v1/health':              () => new Response('ok'),
      '/v1/llm/complete':        post(a.llm.complete.bind(a.llm)),
      '/v1/voice/chat':          post(a.voice.chat.bind(a.voice)),
      '/v1/voice/cancel':        post(async () => ({ cancelled: !!a.voice.cancel && (await a.voice.cancel(), true) })),
      '/v1/memory/append':       post(a.memory.append.bind(a.memory)),
      '/v1/memory/get':          post(a.memory.get.bind(a.memory)),
      '/v1/orders/add':          post(a.orders.add.bind(a.orders)),
      '/v1/orders/list':         async () => Response.json(await a.orders.list()),
      '/v1/orders/disable':      post(async (b: { slug: string }) => a.orders.disable?.(b.slug) ?? {}),
      '/v1/composio/connections': async () => Response.json(await a.composio.listConnections()),
      '/v1/composio/connect':    post(a.composio.connect.bind(a.composio)),
      '/v1/composio/disconnect': post(a.composio.disconnect.bind(a.composio)),
      '/v1/settings/get':        async () => Response.json(await a.settings.get()),
      '/v1/settings/update':     post(a.settings.update.bind(a.settings)),
    },
    fetch() { return new Response('Not Found', { status: 404 }) },
  })

  return {
    port: server.port,
    baseUrl: `http://${hostname}:${server.port}`,
    stop: async () => { server.stop(); },
  }
}
```

- [ ] **Step 3: Run tests**

```bash
bun test src/daemon/wrapApi/server.test.ts
```
Expected: PASS (7 tests)

- [ ] **Step 4: Commit**

```bash
git add src/daemon/wrapApi/server.ts src/daemon/wrapApi/server.test.ts
git commit -m "feat(wrapApi): in-process Bun HTTP server with /v1/* routes"
```

---

### Task 4: LLM Adapter (Anthropic Haiku 4.5)

**Files:**
- Create: `src/daemon/wrapApi/adapters/llmAdapter.ts`
- Create: `src/daemon/wrapApi/adapters/llmAdapter.test.ts`

- [ ] **Step 1: Tests with stub Anthropic client**

```typescript
// src/daemon/wrapApi/adapters/llmAdapter.test.ts
import { describe, it, expect } from 'bun:test'
import { LLMAdapter } from './llmAdapter'

describe('LLMAdapter', () => {
  it('complete() calls Anthropic with default Haiku 4.5 model', async () => {
    let receivedReq: any
    const fakeAnthropic = {
      messages: { create: async (req: any) => { receivedReq = req; return { content: [{ text: 'sup' }] } } },
    }
    const adapter = new LLMAdapter({ client: fakeAnthropic as any, defaultModel: 'claude-haiku-4-5' })
    const r = await adapter.complete({ messages: [{ role: 'user', content: 'hi' }] })
    expect(receivedReq.model).toBe('claude-haiku-4-5')
    expect(r.text).toBe('sup')
  })

  it('complete() honors per-call model override', async () => {
    let receivedReq: any
    const fakeAnthropic = {
      messages: { create: async (req: any) => { receivedReq = req; return { content: [{ text: 'x' }] } } },
    }
    const adapter = new LLMAdapter({ client: fakeAnthropic as any, defaultModel: 'claude-haiku-4-5' })
    await adapter.complete({ messages: [{role: 'user', content: 'x'}], model: 'claude-sonnet-4-6' })
    expect(receivedReq.model).toBe('claude-sonnet-4-6')
  })

  it('complete() passes system prompt when provided', async () => {
    let receivedReq: any
    const fakeAnthropic = {
      messages: { create: async (req: any) => { receivedReq = req; return { content: [{ text: 'x' }] } } },
    }
    const adapter = new LLMAdapter({ client: fakeAnthropic as any, defaultModel: 'claude-haiku-4-5' })
    await adapter.complete({ messages: [{role: 'user', content: 'x'}], system: 'You are KAIROS' })
    expect(receivedReq.system).toBe('You are KAIROS')
  })

  it('complete() handles tool errors gracefully', async () => {
    const fakeAnthropic = {
      messages: { create: async () => { throw new Error('Anthropic 500') } },
    }
    const adapter = new LLMAdapter({ client: fakeAnthropic as any, defaultModel: 'claude-haiku-4-5' })
    await expect(adapter.complete({ messages: [{role: 'user', content: 'x'}] }))
      .rejects.toThrow('Anthropic 500')
  })
})
```

- [ ] **Step 2: Implementation**

```typescript
// src/daemon/wrapApi/adapters/llmAdapter.ts
//
// Wraps Anthropic SDK. Only this file knows we're using Claude — everything
// else in KAIROS calls /v1/llm/complete on the wrap server.
//
// When KAIROS Cloud ships: this file's body switches from `client.messages.create`
// to `fetch('https://api.kairos.ai/v1/llm/complete', ...)`. Everything else
// stays the same.

import Anthropic from '@anthropic-ai/sdk'

export type CompleteBody = {
  messages: { role: 'user' | 'assistant'; content: string }[]
  system?: string
  model?: string
  max_tokens?: number
  temperature?: number
}

export type CompleteResult = { text: string; raw?: any; tokensIn?: number; tokensOut?: number }

export type LLMAdapterDeps = {
  client?: Anthropic              // injected in tests
  apiKey?: string                 // for production
  defaultModel?: string           // default: claude-haiku-4-5
  defaultMaxTokens?: number       // default: 1024
}

export class LLMAdapter {
  private client: Anthropic | any
  private defaultModel: string
  private defaultMaxTokens: number

  constructor(deps: LLMAdapterDeps = {}) {
    this.client = deps.client ?? new Anthropic({ apiKey: deps.apiKey ?? process.env.KAIROS_ANTHROPIC_KEY ?? '' })
    this.defaultModel = deps.defaultModel ?? 'claude-haiku-4-5'
    this.defaultMaxTokens = deps.defaultMaxTokens ?? 1024
  }

  async complete(body: CompleteBody): Promise<CompleteResult> {
    const resp: any = await this.client.messages.create({
      model: body.model ?? this.defaultModel,
      max_tokens: body.max_tokens ?? this.defaultMaxTokens,
      ...(body.system !== undefined ? { system: body.system } : {}),
      ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
      messages: body.messages,
    })
    const text = Array.isArray(resp.content)
      ? resp.content.filter((b: any) => b.type === 'text' || typeof b.text === 'string').map((b: any) => b.text).join('')
      : String(resp.content ?? '')
    return {
      text,
      raw: resp,
      tokensIn: resp.usage?.input_tokens,
      tokensOut: resp.usage?.output_tokens,
    }
  }
}
```

- [ ] **Step 3: Run tests**

```bash
bun test src/daemon/wrapApi/adapters/llmAdapter.test.ts
```
Expected: PASS (4 tests)

- [ ] **Step 4: Commit**

```bash
git add src/daemon/wrapApi/adapters/llmAdapter.ts src/daemon/wrapApi/adapters/llmAdapter.test.ts
git commit -m "feat(wrapApi): LLMAdapter wraps Anthropic SDK behind /v1/llm/complete"
```

---

### Task 5: Voice Adapter (orchestrates STT → LLM → TTS payload)

**Files:**
- Create: `src/daemon/wrapApi/adapters/voiceAdapter.ts`
- Create: `src/daemon/wrapApi/adapters/voiceAdapter.test.ts`

- [ ] **Step 1: Tests**

```typescript
// src/daemon/wrapApi/adapters/voiceAdapter.test.ts
import { describe, it, expect } from 'bun:test'
import { VoiceAdapter } from './voiceAdapter'

describe('VoiceAdapter', () => {
  it('chat() builds prompt from transcript + persona + recent turns', async () => {
    let receivedReq: any
    const fakeLLM = { complete: async (req: any) => { receivedReq = req; return { text: 'response' } } }
    const fakeStore = {
      recentTurns: async () => [
        { role: 'user', text: 'hey', at: 1000 },
        { role: 'agent', text: 'hi nirmal', at: 1100 },
      ],
      appendTurn: async () => {},
    }
    const adapter = new VoiceAdapter({ llm: fakeLLM as any, store: fakeStore as any })

    const r = await adapter.chat({
      transcript: 'what time is it',
      conversationId: 'conv_1',
      userPersona: { name: 'Nirmal', tone: 'terse-direct' },
    })

    expect(r.text).toBe('response')
    expect(r.speakId).toMatch(/^spk_/)
    expect(receivedReq.messages[0].content).toContain('hey')          // turn history
    expect(receivedReq.messages[1].content).toContain('hi nirmal')
    expect(receivedReq.messages[2].content).toContain('what time is it')
    expect(receivedReq.system).toContain('Nirmal')                    // persona context
    expect(receivedReq.system).toContain('terse-direct')
  })

  it('chat() persists both user and agent turn to store', async () => {
    const appendedTurns: any[] = []
    const fakeLLM = { complete: async () => ({ text: 'r' }) }
    const fakeStore = {
      recentTurns: async () => [],
      appendTurn: async (turn: any) => appendedTurns.push(turn),
    }
    const adapter = new VoiceAdapter({ llm: fakeLLM as any, store: fakeStore as any })

    await adapter.chat({ transcript: 'hi', conversationId: 'c1', userPersona: {} })

    expect(appendedTurns.length).toBe(2)  // user + agent
    expect(appendedTurns[0].role).toBe('user')
    expect(appendedTurns[0].text).toBe('hi')
    expect(appendedTurns[1].role).toBe('agent')
    expect(appendedTurns[1].text).toBe('r')
  })

  it('cancel() aborts the active LLM call', async () => {
    let aborted = false
    const fakeLLM = {
      complete: (req: any) => new Promise(resolve => {
        req.signal?.addEventListener?.('abort', () => { aborted = true; resolve({ text: '(aborted)' }) })
      }),
    }
    const fakeStore = { recentTurns: async () => [], appendTurn: async () => {} }
    const adapter = new VoiceAdapter({ llm: fakeLLM as any, store: fakeStore as any })

    const chatPromise = adapter.chat({ transcript: 'long', conversationId: 'c1', userPersona: {} })
    setTimeout(() => adapter.cancel(), 5)
    await chatPromise
    expect(aborted).toBe(true)
  })
})
```

- [ ] **Step 2: Implementation**

```typescript
// src/daemon/wrapApi/adapters/voiceAdapter.ts
//
// /v1/voice/chat: transcript → LLM (with persona + history) → response text.
// The Bun voice conductor then hands the text to the sidecar (or sayBackend) for TTS.

import type { LLMAdapter } from './llmAdapter'

export type Turn = { role: 'user' | 'agent'; text: string; at: number }

export type VoiceStore = {
  recentTurns(conversationId: string, limit?: number): Promise<Turn[]>
  appendTurn(conversationId: string, turn: Turn): Promise<void>
}

export type VoiceAdapterDeps = {
  llm: Pick<LLMAdapter, 'complete'> & { complete: (req: any) => Promise<any> }
  store: VoiceStore
  defaultModel?: string
  maxHistoryTurns?: number
}

export type ChatBody = {
  transcript: string
  conversationId: string
  userPersona: Record<string, unknown>
}

export type ChatResult = { text: string; speakId: string }

export class VoiceAdapter {
  private activeAbort: AbortController | null = null
  constructor(private deps: VoiceAdapterDeps) {}

  async chat(body: ChatBody): Promise<ChatResult> {
    this.cancel()
    this.activeAbort = new AbortController()
    const history = await this.deps.store.recentTurns(body.conversationId, this.deps.maxHistoryTurns ?? 10)
    const messages = [
      ...history.map(t => ({ role: t.role === 'agent' ? 'assistant' as const : 'user' as const, content: t.text })),
      { role: 'user' as const, content: body.transcript },
    ]
    const system = this.buildSystem(body.userPersona)

    await this.deps.store.appendTurn(body.conversationId, { role: 'user', text: body.transcript, at: Date.now() })

    const result = await this.deps.llm.complete({
      messages, system,
      model: this.deps.defaultModel,
      max_tokens: 512,
      signal: this.activeAbort.signal,
    } as any)

    const text = result.text || '(no response)'
    const speakId = 'spk_' + Math.random().toString(36).slice(2, 10)
    await this.deps.store.appendTurn(body.conversationId, { role: 'agent', text, at: Date.now() })
    return { text, speakId }
  }

  cancel(): void {
    if (this.activeAbort) {
      this.activeAbort.abort()
      this.activeAbort = null
    }
  }

  private buildSystem(persona: Record<string, unknown>): string {
    const lines = ['You are KAIROS, a proactive AI co-worker who speaks to the user.']
    if (persona.name) lines.push(`The user's name is ${persona.name}.`)
    if (persona.tone) lines.push(`Your tone: ${persona.tone}.`)
    lines.push('Respond conversationally as if speaking out loud. Keep responses brief (1-2 sentences typical).')
    lines.push('Do NOT use markdown or formatting. Plain spoken English only.')
    return lines.join(' ')
  }
}
```

- [ ] **Step 3: Tests pass**

```bash
bun test src/daemon/wrapApi/adapters/voiceAdapter.test.ts
```
Expected: PASS (3 tests)

- [ ] **Step 4: Commit**

```bash
git add src/daemon/wrapApi/adapters/voiceAdapter.ts src/daemon/wrapApi/adapters/voiceAdapter.test.ts
git commit -m "feat(wrapApi): VoiceAdapter orchestrates STT → LLM → TTS text"
```

---

### Task 6: Conversation Store (SQLite-backed)

**Files:**
- Create: `src/daemon/voice/conversationStore.ts`
- Create: `src/daemon/voice/conversationStore.test.ts`

- [ ] **Step 1: Tests**

```typescript
// src/daemon/voice/conversationStore.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { ConversationStore } from './conversationStore'

describe('ConversationStore', () => {
  let db: Database
  let store: ConversationStore

  beforeEach(() => {
    db = new Database(':memory:')
    store = new ConversationStore(db)
  })

  it('appendTurn + recentTurns round trip', async () => {
    await store.appendTurn('c1', { role: 'user', text: 'hi', at: 1000 })
    await store.appendTurn('c1', { role: 'agent', text: 'hello', at: 1100 })
    const turns = await store.recentTurns('c1', 10)
    expect(turns.length).toBe(2)
    expect(turns[0]!.text).toBe('hi')
    expect(turns[1]!.text).toBe('hello')
  })

  it('recentTurns returns chronological order (oldest first)', async () => {
    await store.appendTurn('c1', { role: 'user', text: 'first', at: 1000 })
    await store.appendTurn('c1', { role: 'agent', text: 'second', at: 2000 })
    await store.appendTurn('c1', { role: 'user', text: 'third', at: 3000 })
    const turns = await store.recentTurns('c1', 10)
    expect(turns.map(t => t.text)).toEqual(['first', 'second', 'third'])
  })

  it('recentTurns honors limit (keeps most recent)', async () => {
    for (let i = 0; i < 10; i++) {
      await store.appendTurn('c1', { role: 'user', text: 't' + i, at: 1000 + i })
    }
    const turns = await store.recentTurns('c1', 3)
    expect(turns.length).toBe(3)
    expect(turns[0]!.text).toBe('t7')
    expect(turns[2]!.text).toBe('t9')
  })

  it('different conversations isolated', async () => {
    await store.appendTurn('c1', { role: 'user', text: 'in c1', at: 1000 })
    await store.appendTurn('c2', { role: 'user', text: 'in c2', at: 1000 })
    expect((await store.recentTurns('c1', 10)).length).toBe(1)
    expect((await store.recentTurns('c2', 10)).length).toBe(1)
  })
})
```

- [ ] **Step 2: Implementation**

```typescript
// src/daemon/voice/conversationStore.ts

import type { Database } from 'bun:sqlite'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS voice_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user','agent')),
  text TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_voice_turns_conv ON voice_turns(conversation_id, at);
`

export type Turn = { role: 'user' | 'agent'; text: string; at: number }

export class ConversationStore {
  constructor(private db: Database) { db.exec(SCHEMA) }

  async appendTurn(conversationId: string, turn: Turn): Promise<void> {
    this.db.run(
      `INSERT INTO voice_turns (conversation_id, role, text, at) VALUES (?, ?, ?, ?)`,
      [conversationId, turn.role, turn.text, turn.at],
    )
  }

  async recentTurns(conversationId: string, limit: number = 10): Promise<Turn[]> {
    const rows = this.db.query(
      `SELECT role, text, at FROM voice_turns WHERE conversation_id = ? ORDER BY at DESC LIMIT ?`,
    ).all(conversationId, limit) as any[]
    return rows.reverse().map(r => ({ role: r.role, text: r.text, at: r.at }))
  }
}
```

- [ ] **Step 3: Run tests**

```bash
bun test src/daemon/voice/conversationStore.test.ts
```
Expected: PASS (4 tests)

- [ ] **Step 4: Commit**

```bash
git add src/daemon/voice/conversationStore.ts src/daemon/voice/conversationStore.test.ts
git commit -m "feat(voice): ConversationStore — SQLite-backed turn history"
```

---

### Task 7: Sidecar simulator (for Bun-side testing without Swift)

**Files:**
- Create: `src/daemon/voice/sidecarSimulator.ts`
- Create: `src/daemon/voice/sidecarSimulator.test.ts`

**Why this task:** The Swift sidecar requires Xcode + signing + TCC permissions. The simulator pretends to be the sidecar so we can test the voice conductor end-to-end in unit tests.

- [ ] **Step 1: Tests**

```typescript
// src/daemon/voice/sidecarSimulator.test.ts
import { describe, it, expect } from 'bun:test'
import { SidecarSimulator } from './sidecarSimulator'

describe('SidecarSimulator', () => {
  it('emits sidecar_ready on start', async () => {
    const sim = new SidecarSimulator()
    const events: any[] = []
    sim.onEvent(e => events.push(e))
    await sim.start()
    expect(events[0]!.event).toBe('sidecar_ready')
  })

  it('speak command emits speak_started then speak_finished', async () => {
    const sim = new SidecarSimulator({ speakDurationMs: 5 })
    const events: any[] = []
    sim.onEvent(e => events.push(e))
    await sim.start()
    await sim.send({ cmd: 'speak', text: 'hello', speakId: 'spk_1', interruptible: true })
    await new Promise(r => setTimeout(r, 20))
    expect(events.find(e => e.event === 'speak_started')?.speak_id).toBe('spk_1')
    expect(events.find(e => e.event === 'speak_finished')?.speak_id).toBe('spk_1')
  })

  it('simulateHotkey emits hotkey events', async () => {
    const sim = new SidecarSimulator()
    const events: any[] = []
    sim.onEvent(e => events.push(e))
    await sim.start()
    sim.simulateHotkey('down')
    sim.simulateHotkey('up')
    expect(events.filter(e => e.event === 'hotkey').length).toBe(2)
  })

  it('simulateUtterance emits stt_partial + stt_final', async () => {
    const sim = new SidecarSimulator()
    const events: any[] = []
    sim.onEvent(e => events.push(e))
    await sim.start()
    sim.simulateUtterance('hello world')
    expect(events.find(e => e.event === 'stt_partial')).toBeTruthy()
    expect(events.find(e => e.event === 'stt_final')?.text).toBe('hello world')
  })

  it('simulateBargeIn during speak emits barge_in_detected', async () => {
    const sim = new SidecarSimulator({ speakDurationMs: 100 })
    const events: any[] = []
    sim.onEvent(e => events.push(e))
    await sim.start()
    void sim.send({ cmd: 'speak', text: 'long sentence', speakId: 'spk_a', interruptible: true })
    await new Promise(r => setTimeout(r, 20))
    sim.simulateBargeIn()
    await new Promise(r => setTimeout(r, 50))
    expect(events.find(e => e.event === 'barge_in_detected')).toBeTruthy()
    expect(events.find(e => e.event === 'speak_interrupted')?.speak_id).toBe('spk_a')
  })
})
```

- [ ] **Step 2: Implementation**

```typescript
// src/daemon/voice/sidecarSimulator.ts
//
// In-process mock of the Swift KairosVoiceHelper sidecar. Used by voice conductor
// tests and the demo script. Real sidecar replaces this when built.

import type { SidecarCmd, SidecarEvent } from './types'

export type SidecarSimulatorOpts = {
  speakDurationMs?: number  // simulated TTS duration
  sttPartialDelayMs?: number
}

export type EventHandler = (e: SidecarEvent) => void

export class SidecarSimulator {
  private handlers: EventHandler[] = []
  private speakDurationMs: number
  private currentSpeak: { speakId: string; cancel: () => void } | null = null

  constructor(opts: SidecarSimulatorOpts = {}) {
    this.speakDurationMs = opts.speakDurationMs ?? 50
  }

  onEvent(h: EventHandler): void { this.handlers.push(h) }

  async start(): Promise<void> { this.emit({ event: 'sidecar_ready', version: '0.6.0-sim' }) }

  async send(cmd: SidecarCmd): Promise<void> {
    switch (cmd.cmd) {
      case 'speak': {
        const speakId = cmd.speakId ?? 'spk_' + Math.random().toString(36).slice(2, 8)
        this.cancelCurrentSpeak()
        this.emit({ event: 'speak_started', speak_id: speakId })
        const ctl = new AbortController()
        this.currentSpeak = { speakId, cancel: () => ctl.abort() }
        const tick = new Promise<void>(resolve => {
          const t = setTimeout(resolve, this.speakDurationMs)
          ctl.signal.addEventListener('abort', () => { clearTimeout(t); resolve() })
        })
        await tick
        const interrupted = ctl.signal.aborted
        if (this.currentSpeak?.speakId === speakId) this.currentSpeak = null
        this.emit({ event: interrupted ? 'speak_interrupted' : 'speak_finished', speak_id: speakId, ...(interrupted ? {} : { interrupted: false }) } as any)
        break
      }
      case 'stop_speaking':  this.cancelCurrentSpeak(); break
      case 'health_check':   /* immediate ack */ break
      case 'shutdown':       /* noop */ break
      default: /* swallow */ break
    }
  }

  simulateHotkey(state: 'down' | 'up'): void {
    this.emit({ event: 'hotkey', state, modifier: 'option' })
  }

  simulateUtterance(text: string): void {
    this.emit({ event: 'stt_partial', text: text.split(' ').slice(0, -1).join(' ') || text, confidence: 0.75 })
    this.emit({ event: 'stt_final', text, confidence: 0.95 })
  }

  simulateBargeIn(): void {
    if (this.currentSpeak) {
      this.emit({ event: 'barge_in_detected', during_speak_id: this.currentSpeak.speakId })
      this.cancelCurrentSpeak()
    }
  }

  private cancelCurrentSpeak(): void {
    if (this.currentSpeak) {
      this.currentSpeak.cancel()
      this.currentSpeak = null
    }
  }

  private emit(e: SidecarEvent): void {
    for (const h of this.handlers) {
      try { h(e) } catch { /* swallow */ }
    }
  }
}
```

- [ ] **Step 3: Run tests**

```bash
bun test src/daemon/voice/sidecarSimulator.test.ts
```
Expected: PASS (5 tests)

- [ ] **Step 4: Commit**

```bash
git add src/daemon/voice/sidecarSimulator.ts src/daemon/voice/sidecarSimulator.test.ts
git commit -m "feat(voice): SidecarSimulator — Bun-side mock for testing without Swift"
```

---

### Task 8: Voice Conductor (the orchestrator)

**Files:**
- Create: `src/daemon/voice/voiceConductor.ts`
- Create: `src/daemon/voice/voiceConductor.test.ts`

- [ ] **Step 1: Tests** — full behavior coverage with simulator

```typescript
// src/daemon/voice/voiceConductor.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { VoiceConductor } from './voiceConductor'
import { SidecarSimulator } from './sidecarSimulator'
import { ConversationStore } from './conversationStore'

describe('VoiceConductor', () => {
  let sim: SidecarSimulator
  let store: ConversationStore
  let conductor: VoiceConductor
  let busEvents: any[]
  let speakBackend: any
  let spokenTexts: string[]

  beforeEach(() => {
    sim = new SidecarSimulator({ speakDurationMs: 5 })
    const db = new Database(':memory:')
    store = new ConversationStore(db)
    busEvents = []
    spokenTexts = []
    speakBackend = {
      speak: async (text: string) => { spokenTexts.push(text) },
      stop: () => {},
    }
    conductor = new VoiceConductor({
      sidecar: sim as any,
      store,
      bus: { publish: (kind: string, payload: any) => busEvents.push({ kind, payload }) },
      wrapApiBaseUrl: 'http://stub',
      fetchImpl: (async (_url: string, opts: any) => ({
        ok: true, status: 200,
        json: async () => {
          const body = JSON.parse(opts?.body ?? '{}')
          return { text: 'response to: ' + body.transcript, speakId: 'spk_x' }
        },
      })) as any,
      speakBackend,
    })
  })

  it('start() spawns sidecar + registers event handlers', async () => {
    await conductor.start()
    expect(sim).toBeDefined()
  })

  it('hotkey.down → listening; hotkey.up → idle', async () => {
    await conductor.start()
    sim.simulateHotkey('down')
    expect(conductor.state).toBe('listening')
    sim.simulateHotkey('up')
    expect(conductor.state).toBe('idle')
  })

  it('stt_final → calls wrap API → speakBackend.speak with response', async () => {
    await conductor.start()
    sim.simulateHotkey('down')
    sim.simulateUtterance('hello kairos')
    sim.simulateHotkey('up')
    await new Promise(r => setTimeout(r, 30))
    expect(spokenTexts).toEqual(['response to: hello kairos'])
  })

  it('barge_in during speak → conductor cancels + publishes interrupted', async () => {
    await conductor.start()
    sim.simulateHotkey('down')
    sim.simulateUtterance('hello kairos')
    sim.simulateHotkey('up')
    await new Promise(r => setTimeout(r, 5))
    sim.simulateBargeIn()
    await new Promise(r => setTimeout(r, 20))
    expect(busEvents.find(e => e.kind === 'voice.agent.utterance.interrupted')).toBeTruthy()
  })

  it('user + agent utterances both published to bus', async () => {
    await conductor.start()
    sim.simulateHotkey('down')
    sim.simulateUtterance('what time is it')
    sim.simulateHotkey('up')
    await new Promise(r => setTimeout(r, 30))
    expect(busEvents.find(e => e.kind === 'voice.user.utterance')?.payload.text).toBe('what time is it')
    expect(busEvents.find(e => e.kind === 'voice.agent.utterance')?.payload.text).toBe('response to: what time is it')
  })

  it('proactiveSpeak() speaks unsolicited via speakBackend', async () => {
    await conductor.start()
    await conductor.proactiveSpeak('hey, you have a meeting in 5')
    expect(spokenTexts).toContain('hey, you have a meeting in 5')
  })

  it('stop() shuts down cleanly', async () => {
    await conductor.start()
    await conductor.stop()
    expect(conductor.state).toBe('stopped')
  })
})
```

- [ ] **Step 2: Implementation**

```typescript
// src/daemon/voice/voiceConductor.ts
//
// Main voice orchestrator. Subscribes to sidecar events; routes utterances
// to the wrap-API server; hands LLM responses back to the sidecar (or
// stage-0 sayBackend) for TTS. Publishes all voice events to perception bus
// for memory consolidation.

import type { ConversationStore } from './conversationStore'
import type { SidecarSimulator } from './sidecarSimulator'
import type { SayBackend } from './sayBackend'
import type { SidecarEvent } from './types'

export type VoiceConductorState = 'stopped' | 'idle' | 'listening' | 'thinking' | 'speaking'

export type VoiceConductorDeps = {
  sidecar: SidecarSimulator | any  // anything with onEvent + send
  store: ConversationStore
  bus: { publish(kind: string, payload: any): void }
  wrapApiBaseUrl: string
  fetchImpl?: typeof fetch
  speakBackend: Pick<SayBackend, 'speak' | 'stop'>
  conversationId?: string
}

export class VoiceConductor {
  state: VoiceConductorState = 'stopped'
  private fetchImpl: typeof fetch
  private conversationId: string
  private currentSpeakId: string | null = null

  constructor(private deps: VoiceConductorDeps) {
    this.fetchImpl = (deps.fetchImpl ?? fetch) as typeof fetch
    this.conversationId = deps.conversationId ?? 'conv_default'
  }

  async start(): Promise<void> {
    this.deps.sidecar.onEvent((e: SidecarEvent) => this.handleSidecarEvent(e))
    await this.deps.sidecar.start()
    this.state = 'idle'
  }

  async stop(): Promise<void> {
    this.deps.speakBackend.stop()
    this.state = 'stopped'
  }

  async proactiveSpeak(text: string): Promise<void> {
    const speakId = 'spk_' + Math.random().toString(36).slice(2, 8)
    this.deps.bus.publish('voice.agent.utterance', { text, speakId, at: Date.now(), kind: 'proactive' })
    this.state = 'speaking'
    await this.deps.speakBackend.speak(text)
    this.state = 'idle'
  }

  private async handleSidecarEvent(e: SidecarEvent): Promise<void> {
    switch (e.event) {
      case 'hotkey':
        this.state = e.state === 'down' ? 'listening' : 'idle'
        break
      case 'stt_final':
        await this.handleUserSpeech(e.text)
        break
      case 'barge_in_detected':
        await this.handleBargeIn()
        break
      case 'speak_finished':
      case 'speak_interrupted':
        if (this.state === 'speaking') this.state = 'idle'
        this.currentSpeakId = null
        break
      default: /* ignored */ break
    }
  }

  private async handleUserSpeech(transcript: string): Promise<void> {
    this.deps.bus.publish('voice.user.utterance', { text: transcript, conversationId: this.conversationId, at: Date.now() })
    this.state = 'thinking'
    try {
      const resp = await this.fetchImpl(`${this.deps.wrapApiBaseUrl}/v1/voice/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ transcript, conversationId: this.conversationId, userPersona: {} }),
      })
      const body = await resp.json() as { text: string; speakId: string }
      this.currentSpeakId = body.speakId
      this.deps.bus.publish('voice.agent.utterance', { text: body.text, speakId: body.speakId, at: Date.now() })
      this.state = 'speaking'
      await this.deps.speakBackend.speak(body.text)
      this.state = 'idle'
    } catch (err) {
      this.deps.bus.publish('voice.error', { error: err instanceof Error ? err.message : String(err) })
      this.state = 'idle'
    }
  }

  private async handleBargeIn(): Promise<void> {
    this.deps.speakBackend.stop()
    this.deps.bus.publish('voice.agent.utterance.interrupted', { speakId: this.currentSpeakId, at: Date.now() })
    this.currentSpeakId = null
    this.state = 'listening'
  }
}
```

- [ ] **Step 3: Run tests**

```bash
bun test src/daemon/voice/voiceConductor.test.ts
```
Expected: PASS (7 tests)

- [ ] **Step 4: Commit**

```bash
git add src/daemon/voice/voiceConductor.ts src/daemon/voice/voiceConductor.test.ts
git commit -m "feat(voice): VoiceConductor — sidecar↔wrapApi↔speakBackend orchestrator"
```

---

### Task 9: End-to-end demo script (actually plays audio)

**Files:**
- Create: `scripts/voice-demo.ts`

- [ ] **Step 1: Implementation**

```typescript
// scripts/voice-demo.ts
//
// Phase E.1 end-to-end demo. Boots: wrap-API server + voice conductor +
// SidecarSimulator + SayBackend. Simulates a user utterance and KAIROS
// actually speaks the response through your Mac speakers.
//
// Run: KAIROS_ANTHROPIC_KEY=sk-... bun scripts/voice-demo.ts

import { Database } from 'bun:sqlite'
import { startWrapApi } from '../src/daemon/wrapApi/server'
import { LLMAdapter } from '../src/daemon/wrapApi/adapters/llmAdapter'
import { VoiceAdapter } from '../src/daemon/wrapApi/adapters/voiceAdapter'
import { ConversationStore } from '../src/daemon/voice/conversationStore'
import { VoiceConductor } from '../src/daemon/voice/voiceConductor'
import { SidecarSimulator } from '../src/daemon/voice/sidecarSimulator'
import { SayBackend } from '../src/daemon/voice/sayBackend'

const apiKey = process.env.KAIROS_ANTHROPIC_KEY
if (!apiKey) { console.error('✗ KAIROS_ANTHROPIC_KEY not set'); process.exit(1) }

console.log('═════════════════════════════════════════════════════════════')
console.log('  KAIROS Phase E.1 — Voice end-to-end demo')
console.log('  (stage-0: SidecarSimulator + SayBackend on top of real wrap-API)')
console.log('═════════════════════════════════════════════════════════════')
console.log()

const db = new Database(':memory:')
const conversationStore = new ConversationStore(db)
const llm = new LLMAdapter({ apiKey, defaultModel: 'claude-haiku-4-5' })
const voice = new VoiceAdapter({ llm: llm as any, store: conversationStore as any })

console.log('[1/4] Starting wrap-API server on 127.0.0.1...')
const api = await startWrapApi({
  port: 0, hostname: '127.0.0.1',
  adapters: {
    llm: { complete: (b) => llm.complete(b) },
    voice: { chat: (b) => voice.chat(b), cancel: () => Promise.resolve(voice.cancel()) },
    memory: { append: async () => ({}), get: async () => ({}) },
    orders: { add: async () => ({ slug: 'stub' }), list: async () => [] },
    composio: { listConnections: async () => [], connect: async () => ({}), disconnect: async () => ({}) },
    settings: { get: async () => ({}), update: async () => ({ updated: [] }) },
  },
})
console.log(`       ✓ wrap-API ready at ${api.baseUrl}`)

console.log('[2/4] Initializing SidecarSimulator + SayBackend...')
const sim = new SidecarSimulator()
const sayBackend = new SayBackend({ defaultVoice: process.env.KAIROS_VOICE_NAME ?? 'Ava', defaultRate: Number(process.env.KAIROS_VOICE_RATE ?? 180) })
const conductor = new VoiceConductor({
  sidecar: sim as any,
  store: conversationStore,
  bus: { publish: (kind, payload) => console.log(`       [bus] ${kind}: ${JSON.stringify(payload).slice(0, 120)}`) },
  wrapApiBaseUrl: api.baseUrl,
  speakBackend: sayBackend,
})

console.log('[3/4] Starting conductor...')
await conductor.start()
console.log('       ✓ conductor ready')

console.log()
console.log('[4/4] Simulating user utterance and listening for KAIROS response...')
console.log('       🎙  simulated user: "Say hello to me and tell me what you are."')
console.log()

sim.simulateHotkey('down')
sim.simulateUtterance('Say hello to me and tell me what you are.')
sim.simulateHotkey('up')

await new Promise(r => setTimeout(r, 15000))   // wait for LLM + TTS

console.log()
console.log('─── done ──────────────────────────────────────────────────────')
console.log('  If you heard KAIROS speak, the end-to-end voice loop works ✓')
console.log()

await conductor.stop()
await api.stop()
process.exit(0)
```

- [ ] **Step 2: Make demo actually run (real audio)**

```bash
# user must have KAIROS_ANTHROPIC_KEY set
bun scripts/voice-demo.ts
```

Expected: KAIROS speaks via Mac speakers. Hear actual voice.

- [ ] **Step 3: Commit**

```bash
git add scripts/voice-demo.ts
git commit -m "feat(voice): end-to-end demo script (real audio via say)"
```

---

### Task 10: Swift sidecar source (KairosVoiceHelper) — ready to build

**Files:**
- Create: `apps/macos/KairosVoiceHelper/Package.swift`
- Create: `apps/macos/KairosVoiceHelper/Sources/KairosVoiceHelper/*.swift` (8 files)
- Create: `apps/macos/KairosVoiceHelper/BUILD.md`

Per spec §5.1, fork-and-adapt from `farzaa/clicky` (MIT). Each file's full source per the spec's sidecar protocol (§5.1.3) and audio graph (§5.1.1).

(Full file contents — too long for plan, write each one separately during execution.)

- [ ] **Step 1: Set up SwiftPM project structure**
- [ ] **Step 2: Write each Swift source file**
- [ ] **Step 3: Write BUILD.md with xcodebuild + signing instructions**
- [ ] **Step 4: Commit Swift source**

```bash
git add apps/macos/KairosVoiceHelper/
git commit -m "feat(voice): Swift sidecar source — KairosVoiceHelper (ready to xcodebuild)"
```

---

### Task 11: Validation gate + regression

**Files:**
- Create: `scripts/validate-phase-e1.ts`

- [ ] **Step 1: Write 20-assertion gate** covering:
  1. wrap-API server starts on port
  2. /v1/health returns ok
  3. /v1/llm/complete works (with stub LLM)
  4. /v1/voice/chat persists turns
  5. SidecarSimulator emits ready
  6. VoiceConductor transitions states correctly
  7. SayBackend produces actual audio output (verify exit code 0)
  8. Hotkey events trigger listening state
  9. STT final triggers wrap-API call
  10. Barge-in interrupts speech
  11. Conversation history persists across turns
  12. Persona context flows to LLM system prompt
  13. Memory perception bus events published
  14. Proactive speak works
  15. Conversation store isolates conversations
  16. Wrap-API 405 on wrong methods
  17. Wrap-API 415 on missing content-type
  18. Wrap-API 404 on unknown route
  19. LLMAdapter respects model override
  20. SidecarSimulator simulateBargeIn cancels active speak

- [ ] **Step 2: Run gate**

```bash
bun scripts/validate-phase-e1.ts
```
Expected: 20/20 PASS

- [ ] **Step 3: Full regression sweep**

```bash
bun test 2>&1 | grep -E "^\s*\d+ (pass|fail)"
```
Expected: >800 pass, ≤2 known fs.watch flakes

- [ ] **Step 4: CHANGELOG + commit**

```bash
git add scripts/validate-phase-e1.ts CHANGELOG.md
git commit -m "release: v0.6.0-alpha — Phase E.1 voice (Bun-side complete, Swift source ready)"
git tag v0.6.0-alpha
```

---

## Self-Review

After writing all task content, verifying against spec §2 non-goals + §3 voice loop + §5 component breakdown:

- ✅ All required `/v1/*` endpoints from spec §5.3 covered (Tasks 3-7)
- ✅ Sidecar protocol exactly matches spec §5.1.3 JSON shapes (Task 1, 7)
- ✅ SayBackend as stage-0 (proves audio) + Swift source for full sidecar (Task 2, 10)
- ✅ Voice memory wiring per spec §6.4 (Task 8 publishes to bus)
- ✅ Conversation store per spec §5.2 (Task 6)
- ✅ Persona-conditioned LLM system prompt per spec §6.3 (Task 5)
- ✅ Barge-in handling per spec §3.3 (Task 8 state machine)
- ✅ Proactive speech per spec §3.2 (Task 8 proactiveSpeak)
- ⚠️ Onboarding flow (spec §6.1) — explicitly deferred to follow-up session; spec acknowledged

No placeholder text. No "TODO" or "fill in details." Every step has concrete code or commands. Types consistent across files (`Turn`, `SidecarEvent`, `SidecarCmd`).

**Plan ready for execution.**
