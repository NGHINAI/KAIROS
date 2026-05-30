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
  let busEvents: { kind: string; payload: any }[]
  let spokenTexts: string[]
  let speakBackend: any

  beforeEach(() => {
    sim = new SidecarSimulator({ speakDurationMs: 5 })
    store = new ConversationStore(new Database(':memory:'))
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
        ok: true,
        status: 200,
        json: async () => {
          const body = JSON.parse(opts?.body ?? '{}')
          return { text: 'response to: ' + body.transcript, speakId: 'spk_x' }
        },
      })) as any,
      speakBackend,
    })
  })

  it('start() puts conductor in idle state', async () => {
    expect(conductor.state).toBe('stopped')
    await conductor.start()
    expect(conductor.state).toBe('idle')
  })

  it('hotkey down → listening; hotkey up → idle', async () => {
    await conductor.start()
    sim.simulateHotkey('down')
    expect(conductor.state).toBe('listening')
    sim.simulateHotkey('up')
    expect(conductor.state).toBe('idle')
  })

  it('hotkey events published to bus', async () => {
    await conductor.start()
    sim.simulateHotkey('down')
    sim.simulateHotkey('up')
    expect(busEvents.some(e => e.kind === 'voice.hotkey.down')).toBe(true)
    expect(busEvents.some(e => e.kind === 'voice.hotkey.up')).toBe(true)
  })

  it('stt_final → calls wrap API → speakBackend.speak with response', async () => {
    await conductor.start()
    sim.simulateHotkey('down')
    sim.simulateUtterance('hello kairos')
    sim.simulateHotkey('up')
    await new Promise(r => setTimeout(r, 30))
    expect(spokenTexts).toEqual(['response to: hello kairos'])
  })

  it('user + agent utterances both published to bus', async () => {
    await conductor.start()
    sim.simulateHotkey('down')
    sim.simulateUtterance('what time is it')
    sim.simulateHotkey('up')
    await new Promise(r => setTimeout(r, 30))
    const userU = busEvents.find(e => e.kind === 'voice.user.utterance')
    const agentU = busEvents.find(e => e.kind === 'voice.agent.utterance')
    expect(userU?.payload.text).toBe('what time is it')
    expect(agentU?.payload.text).toBe('response to: what time is it')
  })

  it('barge_in during speak → conductor stops + publishes interrupted', async () => {
    await conductor.start()

    let speakResolve: () => void = () => {}
    speakBackend.speak = (text: string) =>
      new Promise<void>(resolve => { spokenTexts.push(text); speakResolve = resolve })
    speakBackend.stop = () => { speakResolve() }

    sim.simulateHotkey('down')
    sim.simulateUtterance('hello kairos')
    sim.simulateHotkey('up')
    await new Promise(r => setTimeout(r, 10))   // wait for fetch + speak start
    sim.simulateBargeIn()
    await new Promise(r => setTimeout(r, 20))

    expect(busEvents.some(e => e.kind === 'voice.agent.utterance.interrupted')).toBe(true)
  })

  it('proactiveSpeak() speaks unsolicited + publishes proactive utterance', async () => {
    await conductor.start()
    await conductor.proactiveSpeak('hey, you have a meeting in 5')
    expect(spokenTexts).toContain('hey, you have a meeting in 5')
    const proactive = busEvents.find(e => e.kind === 'voice.agent.utterance' && e.payload.proactive === true)
    expect(proactive).toBeTruthy()
  })

  it('LLM fetch error → publishes voice.error', async () => {
    conductor = new VoiceConductor({
      sidecar: sim as any,
      store,
      bus: { publish: (kind: string, payload: any) => busEvents.push({ kind, payload }) },
      wrapApiBaseUrl: 'http://stub',
      fetchImpl: (async () => { throw new Error('network down') }) as any,
      speakBackend,
    })
    await conductor.start()
    sim.simulateHotkey('down')
    sim.simulateUtterance('hi')
    sim.simulateHotkey('up')
    await new Promise(r => setTimeout(r, 20))
    const errEvent = busEvents.find(e => e.kind === 'voice.error')
    expect(errEvent?.payload.error).toBe('network down')
    expect(conductor.state).toBe('idle')   // recovered
  })

  it('stop() shuts down cleanly', async () => {
    await conductor.start()
    await conductor.stop()
    expect(conductor.state).toBe('stopped')
  })
})
