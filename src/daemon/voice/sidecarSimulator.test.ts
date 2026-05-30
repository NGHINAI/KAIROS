// src/daemon/voice/sidecarSimulator.test.ts
import { describe, it, expect } from 'bun:test'
import { SidecarSimulator } from './sidecarSimulator'
import type { SidecarEvent } from './types'

describe('SidecarSimulator', () => {
  it('emits sidecar_ready on start', async () => {
    const sim = new SidecarSimulator()
    const events: SidecarEvent[] = []
    sim.onEvent(e => events.push(e))
    await sim.start()
    expect(events[0]!.event).toBe('sidecar_ready')
  })

  it('speak command emits speak_started then speak_finished', async () => {
    const sim = new SidecarSimulator({ speakDurationMs: 5 })
    const events: SidecarEvent[] = []
    sim.onEvent(e => events.push(e))
    await sim.start()
    await sim.send({ cmd: 'speak', text: 'hello', speakId: 'spk_1', interruptible: true })
    expect(events.find(e => e.event === 'speak_started')).toBeTruthy()
    expect(events.find(e => e.event === 'speak_finished')).toBeTruthy()
  })

  it('simulateHotkey emits hotkey events', async () => {
    const sim = new SidecarSimulator()
    const events: SidecarEvent[] = []
    sim.onEvent(e => events.push(e))
    await sim.start()
    sim.simulateHotkey('down')
    sim.simulateHotkey('up')
    const hotkeys = events.filter(e => e.event === 'hotkey')
    expect(hotkeys.length).toBe(2)
  })

  it('simulateUtterance emits stt_partial + stt_final', async () => {
    const sim = new SidecarSimulator()
    const events: SidecarEvent[] = []
    sim.onEvent(e => events.push(e))
    await sim.start()
    sim.simulateUtterance('hello world')
    expect(events.find(e => e.event === 'stt_partial')).toBeTruthy()
    const final = events.find(e => e.event === 'stt_final') as any
    expect(final?.text).toBe('hello world')
  })

  it('simulateBargeIn during speak emits barge_in_detected + speak_interrupted', async () => {
    const sim = new SidecarSimulator({ speakDurationMs: 100 })
    const events: SidecarEvent[] = []
    sim.onEvent(e => events.push(e))
    await sim.start()
    void sim.send({ cmd: 'speak', text: 'long sentence', speakId: 'spk_a', interruptible: true })
    await new Promise(r => setTimeout(r, 20))
    sim.simulateBargeIn()
    await new Promise(r => setTimeout(r, 50))
    expect(events.find(e => e.event === 'barge_in_detected')).toBeTruthy()
    expect(events.find(e => e.event === 'speak_interrupted')).toBeTruthy()
  })

  it('stop_speaking cancels current speak', async () => {
    const sim = new SidecarSimulator({ speakDurationMs: 100 })
    const events: SidecarEvent[] = []
    sim.onEvent(e => events.push(e))
    await sim.start()
    void sim.send({ cmd: 'speak', text: 'long', speakId: 'spk_x' })
    await new Promise(r => setTimeout(r, 10))
    await sim.send({ cmd: 'stop_speaking' })
    await new Promise(r => setTimeout(r, 20))
    expect(events.find(e => e.event === 'speak_interrupted')).toBeTruthy()
  })

  it('multiple handlers all called', async () => {
    const sim = new SidecarSimulator()
    let countA = 0, countB = 0
    sim.onEvent(() => { countA++ })
    sim.onEvent(() => { countB++ })
    await sim.start()
    sim.simulateHotkey('down')
    expect(countA).toBeGreaterThan(0)
    expect(countA).toBe(countB)
  })

  it('handler that throws does not break emit', async () => {
    const sim = new SidecarSimulator()
    sim.onEvent(() => { throw new Error('handler crashed') })
    let received = 0
    sim.onEvent(() => { received++ })
    await sim.start()
    sim.simulateHotkey('down')
    expect(received).toBeGreaterThan(0)
  })
})
