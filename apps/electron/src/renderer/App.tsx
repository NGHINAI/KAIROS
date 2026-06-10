// KAIROS Electron renderer — Architecture A WS client.
//
// Connects to ws://127.0.0.1:<daemonPort>/v1/voice/events. The daemon
// (bun scripts/voice-live.ts) does all audio, STT, LLM, and TTS. We just
// render the events and let the user start/stop listening via hotkey or
// click.

import React, { useEffect, useRef, useState } from 'react'
import { PcmPlayer } from './pcmPlayer'
import type { MicVad } from './micVad'
import { float32ToWavBase64 } from './wav'

declare global {
  interface Window {
    kairos: {
      onHotkey: (cb: () => void) => void
      daemonPort: () => Promise<number>
    }
  }
}

type DaemonEvent =
  | { event: 'subscribed'; clients: number }
  | { event: 'listening_started' }
  | { event: 'listening_stopped' }
  | { event: 'stt_partial'; text: string }
  | { event: 'stt_final'; text: string }
  | { event: 'agent_delta'; text: string }
  | { event: 'agent_done'; text: string }
  | { event: 'agent_error'; message: string }
  | { event: 'agent_interrupted' }
  | { event: 'sidecar_error'; code: string; message?: string }
  | { event: 'error'; message: string }
  | { event: 'tts_begin'; speakId: string; sampleRate: number }
  | { event: 'tts_chunk'; speakId: string; pcm: string }
  | { event: 'tts_end'; speakId: string }
  | { event: 'tts_abort'; speakId: string }

type ConnState = 'connecting' | 'open' | 'closed' | 'unreachable'

// ~0.2s at 16kHz — below this a clip is a misclick, not speech.
const MIN_SEND_SAMPLES = 3200

export function App() {
  const [connState, setConnState] = useState<ConnState>('connecting')
  const [listening, setListening] = useState(false)
  const [partial, setPartial] = useState('')
  const [lastTranscript, setLastTranscript] = useState('')
  const [streamingReply, setStreamingReply] = useState('')
  const [statusMsg, setStatusMsg] = useState('')
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimer = useRef<number | null>(null)
  const playerRef = useRef<PcmPlayer | null>(null)
  if (!playerRef.current) playerRef.current = new PcmPlayer()
  const micRef = useRef<MicVad | null>(null)
  // speakingRef: KAIROS currently emitting audio (drives VAD barge-in).
  // pttActiveRef: Option/Talk held → mic audio is being buffered for send.
  const speakingRef = useRef(false)
  const pttActiveRef = useRef(false)
  // playbackRef: last PLAYBACK state reported to the daemon (`tts_playback`).
  // This is the GROUND TRUTH the HUD orb's speaking state rides on — tts_end only
  // means "chunks finished downloading"; Web Audio keeps playing for seconds after.
  const playbackRef = useRef(false)
  const playbackKeepaliveRef = useRef(0)
  const [micReady, setMicReady] = useState(false)
  // Live VAD diagnostics surfaced in the UI (no devtools needed): speech
  // probability of the latest frame + a running frame count to prove audio flows.
  const [vadProb, setVadProb] = useState(0)
  const [vadFrames, setVadFrames] = useState(0)

  useEffect(() => {
    let cancelled = false
    let hotkeyCleanup: (() => void) | null = null

    async function connect() {
      const port = await window.kairos.daemonPort()
      if (cancelled) return
      try {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/voice/events`)
        wsRef.current = ws
        ws.onopen = () => {
          setConnState('open')
          setStatusMsg('')
        }
        ws.onclose = () => {
          setConnState('closed')
          wsRef.current = null
          // Reconnect after a short delay
          if (!cancelled) {
            reconnectTimer.current = window.setTimeout(connect, 1500) as unknown as number
          }
        }
        ws.onerror = () => {
          setConnState('unreachable')
          setStatusMsg(`daemon not reachable on port ${port} — run \`bun scripts/voice-live.ts\``)
        }
        ws.onmessage = (m) => handleEvent(JSON.parse(m.data) as DaemonEvent)
      } catch (err) {
        setConnState('unreachable')
        setStatusMsg(`connect error: ${(err as Error).message}`)
      }
    }
    connect()

    // Playback reporter: tell the daemon when audio is ACTUALLY playing (change-
    // triggered + ~2s keepalive while playing, so the daemon's freshness window
    // never lapses mid-reply). Quiet sender — never surfaces status messages.
    const reportPlayback = () => {
      const ws = wsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      const playing = !!playerRef.current?.isPlaying()
      const now = Date.now()
      const changed = playing !== playbackRef.current
      const keepaliveDue = playing && now - playbackKeepaliveRef.current >= 2000
      if (changed || keepaliveDue) {
        playbackRef.current = playing
        playbackKeepaliveRef.current = now
        try { ws.send(JSON.stringify({ cmd: 'tts_playback', playing })) } catch { /* quiet */ }
      }
    }
    const playbackTimer = window.setInterval(reportPlayback, 150)

    // Live voice level → the orb's lobes. ~15Hz while audio is audible, one final 0
    // on silence. (Chunk-arrival RMS was wrong: chunks download in a burst seconds
    // before playback finishes, so the orb sat static mid-speech.)
    let lastLevelSent = -1
    const reportLevel = () => {
      const ws = wsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      const level = playerRef.current?.level() ?? 0
      if (level === 0 && lastLevelSent === 0) return        // stay quiet while idle
      lastLevelSent = level
      try { ws.send(JSON.stringify({ cmd: 'tts_level', level: Number(level.toFixed(3)) })) } catch { /* quiet */ }
    }
    const levelTimer = window.setInterval(reportLevel, 66)

    // Renderer-owned mic + Silero VAD. Loaded via dynamic import() so that any
    // failure in the heavy ORT/VAD module (wasm compile, CSP, etc.) degrades to
    // "no VAD" instead of throwing during App module-eval and blanking the window.
    // One always-on MicVAD; PTT gating decides which finished segments we send.
    // onSpeechStart doubles as voice barge-in while KAIROS is speaking.
    let frameTick = 0
    void (async () => {
      try {
        const { MicVad } = await import('./micVad')
        if (cancelled) return
        const mic = new MicVad({
          onSpeechStart: () => {
            // VAD is used for BARGE-IN ONLY now. If KAIROS's audio is actually
            // still playing, the user talking over it cuts it off. Capture of what
            // the user says is handled separately by the Option key (startCapture).
            const isAudible = playerRef.current?.isPlaying() || speakingRef.current
            if (isAudible) {
              playerRef.current?.stop()
              speakingRef.current = false
              sendCommand({ cmd: 'barge_in' })
              setStatusMsg('interrupted — go ahead')
              window.setTimeout(() => setStatusMsg(''), 1200)
            }
          },
          onFrame: (p: number) => {
            frameTick++
            if (frameTick % 3 === 0) { setVadProb(p); setVadFrames(frameTick) }
          },
        })
        micRef.current = mic
        await mic.start()
        if (!cancelled) setMicReady(true)
      } catch (err) {
        if (!cancelled) setStatusMsg(`mic/VAD init failed: ${(err as Error).message}`)
      }
    })()

    // Option+Space global toggle (from main-process globalShortcut).
    window.kairos.onHotkey(() => toggleListening())

    // Option-HOLD push-to-talk, handled in the renderer via DOM key events.
    // This needs NO macOS Accessibility permission (unlike the Swift CGEventTap)
    // — it only fires while the KAIROS window has focus, which is the right
    // scope for hold-to-talk. Hold Option → start; release Option → stop.
    let optionHeld = false
    const onKeyDown = (e: KeyboardEvent) => {
      // e.altKey is the Option key on macOS. Ignore auto-repeat.
      if ((e.key === 'Alt' || e.altKey) && !optionHeld) {
        optionHeld = true
        startListening()
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Alt' && optionHeld) {
        optionHeld = false
        stopListening()
      }
    }
    // If focus is lost mid-hold, don't get stuck "listening".
    const onBlur = () => {
      if (optionHeld) { optionHeld = false; stopListening() }
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    hotkeyCleanup = () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }

    return () => {
      cancelled = true
      window.clearInterval(playbackTimer)
      window.clearInterval(levelTimer)
      if (reconnectTimer.current) window.clearTimeout(reconnectTimer.current)
      hotkeyCleanup?.()
      wsRef.current?.close()
      playerRef.current?.dispose()
      playerRef.current = null
      void micRef.current?.destroy()
      micRef.current = null
    }
  }, [])

  function sendCommand(cmd: object) {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setStatusMsg('daemon not connected')
      return
    }
    ws.send(JSON.stringify(cmd))
  }

  // PUSH-TO-TALK: the Option key (or Talk button) deterministically bounds the
  // recording. start → begin buffering raw mic audio; stop → flush exactly that
  // audio to the daemon. No VAD segmentation, no latch races — what you record
  // between press and release is exactly what gets sent.
  function startListening() {
    if (pttActiveRef.current) return // already capturing (key-repeat safe)
    pttActiveRef.current = true
    micRef.current?.startCapture()
    setListening(true)
    setPartial('🎤 recording… (release to send)')
    setStreamingReply('')
  }
  function stopListening() {
    if (!pttActiveRef.current) return
    pttActiveRef.current = false
    setListening(false)
    const audio = micRef.current?.stopCapture()
    if (!audio || audio.length < MIN_SEND_SAMPLES) {
      setPartial('(too short — hold Option and speak)')
      return
    }
    const wavBase64 = float32ToWavBase64(audio)
    sendCommand({ cmd: 'utterance_audio', wavBase64, conversationId: 'conv_default' })
    setPartial('')
  }
  // Toggle for the on-screen button and Option+Space global shortcut.
  function toggleListening() {
    if (pttActiveRef.current) stopListening()
    else startListening()
  }

  function handleEvent(ev: DaemonEvent) {
    switch (ev.event) {
      case 'subscribed': break
      case 'listening_started':
        setListening(true)
        setPartial('')
        setStreamingReply('')
        break
      case 'listening_stopped':
        setListening(false)
        break
      case 'stt_partial':
        setPartial(ev.text)
        break
      case 'stt_final':
        setPartial('')
        setLastTranscript(ev.text)
        setStreamingReply('')
        break
      case 'agent_delta':
        setStreamingReply((prev) => prev + ev.text)
        break
      case 'agent_done':
        if (ev.text) setStreamingReply(ev.text)
        break
      case 'agent_interrupted':
        // Barge-in: stop any audio currently playing.
        playerRef.current?.stop()
        speakingRef.current = false
        setStatusMsg('reply interrupted')
        window.setTimeout(() => setStatusMsg(''), 1500)
        break
      case 'agent_error':
        setStatusMsg(`LLM error: ${ev.message}`)
        break
      case 'sidecar_error':
        setStatusMsg(`sidecar: ${ev.code}${ev.message ? ` — ${ev.message}` : ''}`)
        break
      case 'error':
        setStatusMsg(`error: ${ev.message}`)
        break
      // Canonical TTS audio streamed from the daemon → Web Audio playback.
      // speakingRef gates VAD barge-in: only interrupt while audio is playing.
      case 'tts_begin':
        speakingRef.current = true
        playerRef.current?.begin(ev.speakId, ev.sampleRate)
        break
      case 'tts_chunk':
        playerRef.current?.push(ev.speakId, ev.pcm)
        break
      case 'tts_end':
        speakingRef.current = false
        playerRef.current?.end(ev.speakId)
        break
      case 'tts_abort':
        speakingRef.current = false
        playerRef.current?.abort(ev.speakId)
        break
    }
  }

  const connLabel =
    connState === 'open' ? '◉ connected'
    : connState === 'connecting' ? '◌ connecting'
    : connState === 'closed' ? '⊘ disconnected'
    : '⚠ daemon unreachable'
  const connColor =
    connState === 'open' ? '#7ee787'
    : connState === 'connecting' ? '#888'
    : '#f0883e'

  const stateLabel = listening ? '● Listening' : '○ Idle'
  const stateColor = listening ? '#7ee787' : '#888'

  return (
    <main style={{ fontFamily: 'system-ui', padding: 24, color: '#f0f0f0' }}>
      <h1 style={{ margin: 0, fontSize: 20 }}>KAIROS</h1>

      <div style={{ marginTop: 6, fontSize: 11, color: connColor }}>
        {connLabel}
        <span style={{ marginLeft: 10, color: micReady ? '#7ee787' : '#888' }}>
          {micReady ? '🎙 mic+VAD ready' : '🎙 mic starting…'}
        </span>
      </div>

      <div style={{ marginTop: 16, fontSize: 13, display: 'flex', alignItems: 'center', gap: 12 }}>
        <button
          onClick={toggleListening}
          disabled={connState !== 'open'}
          style={{
            cursor: connState === 'open' ? 'pointer' : 'not-allowed',
            border: 'none',
            borderRadius: 999,
            padding: '8px 18px',
            fontSize: 13,
            fontWeight: 600,
            color: listening ? '#0b0b0b' : '#f0f0f0',
            background: listening ? '#7ee787' : '#2a2a2a',
            opacity: connState === 'open' ? 1 : 0.5,
          }}
        >
          {listening ? '■ Stop' : '● Talk'}
        </button>
        <span style={{ color: stateColor }}>{stateLabel}</span>
      </div>
      {statusMsg && (
        <div style={{ marginTop: 8, fontSize: 11, color: '#f0883e' }}>
          {statusMsg}
        </div>
      )}

      {/* Live VAD meter — proves mic audio is flowing + shows speech detection.
          If frames stay 0, no audio reaches VAD. If the bar moves when you talk,
          VAD hears you. Green past ~0.5 = speech detected. */}
      <div style={{ marginTop: 12, fontSize: 10, color: '#888' }}>
        VAD frames: {vadFrames} · p(speech): {vadProb.toFixed(2)}
        <div style={{ marginTop: 4, height: 6, width: 240, background: '#2a2a2a', borderRadius: 3, overflow: 'hidden' }}>
          <div style={{
            height: '100%',
            width: `${Math.round(vadProb * 100)}%`,
            background: vadProb > 0.5 ? '#7ee787' : '#5a9',
            transition: 'width 60ms linear',
          }} />
        </div>
      </div>

      <div style={{ marginTop: 16, opacity: 0.85, fontSize: 13, minHeight: 36 }}>
        <strong>You:</strong>{' '}
        <span style={{ opacity: partial ? 0.7 : 1 }}>
          {partial || lastTranscript || '—'}
        </span>
      </div>
      <div style={{ marginTop: 8, opacity: 0.95, fontSize: 13, minHeight: 40 }}>
        <strong>KAIROS:</strong> {streamingReply || '—'}
      </div>

      <p style={{ marginTop: 24, opacity: 0.5, fontSize: 11 }}>
        <strong>Hold Option</strong> to talk (release to send), or click <strong>Talk</strong> /
        press <kbd>Option+Space</kbd> to toggle.
      </p>
    </main>
  )
}
