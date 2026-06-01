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

  it('speak(text) invokes say -v Ava -r 180 <text>', async () => {
    await backend.speak('hello world')
    expect(calls[0]!.cmd).toEqual(['say', '-v', 'Ava', '-r', '180', 'hello world'])
  })

  it('speak honors custom voice + rate', async () => {
    await backend.speak('hi', { voice: 'Daniel', rate: 220 })
    expect(calls[0]!.cmd).toEqual(['say', '-v', 'Daniel', '-r', '220', 'hi'])
  })

  it('speak with empty text is a no-op', async () => {
    await backend.speak('')
    await backend.speak('   ')
    expect(calls.length).toBe(0)
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

  it('listVoices parses say -v ? output', async () => {
    const fakeRunner = async () => ({
      exitCode: 0,
      stdout: 'Ava (Enhanced)     en_US    # Hi, I am Ava.\nDaniel             en_GB    # Hello, my name is Daniel.\n',
    })
    backend = new SayBackend({ runner: fakeRunner as any, defaultVoice: 'Ava', defaultRate: 180 })
    const voices = await backend.listVoices()
    expect(voices.length).toBe(2)
    expect(voices[0]!.name).toBe('Ava (Enhanced)')
    expect(voices[1]!.name).toBe('Daniel')
    expect(voices[0]!.language).toBe('en_US')
  })

  it('listVoices skips malformed lines', async () => {
    const fakeRunner = async () => ({
      exitCode: 0,
      stdout: 'Ava (Enhanced)     en_US    # Hi, I am Ava.\nMALFORMED LINE\nDaniel             en_GB    # Hello.\n',
    })
    backend = new SayBackend({ runner: fakeRunner as any })
    const voices = await backend.listVoices()
    expect(voices.length).toBe(2)
  })
})
