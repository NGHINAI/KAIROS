// KAIROS Electron renderer — Architecture A WS client.
//
// Connects to ws://127.0.0.1:<daemonPort>/v1/voice/events. The daemon
// (bun scripts/voice-live.ts) does all audio, STT, LLM, and TTS. We just
// render the events and let the user start/stop listening via hotkey or
// click.

import React, { useEffect, useRef, useState } from 'react'

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

type ConnState = 'connecting' | 'open' | 'closed' | 'unreachable'

export function App() {
  const [connState, setConnState] = useState<ConnState>('connecting')
  const [listening, setListening] = useState(false)
  const [partial, setPartial] = useState('')
  const [lastTranscript, setLastTranscript] = useState('')
  const [streamingReply, setStreamingReply] = useState('')
  const [statusMsg, setStatusMsg] = useState('')
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimer = useRef<number | null>(null)

  useEffect(() => {
    let cancelled = false

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

    window.kairos.onHotkey(() => {
      // Push the current listening state across the WS.
      setListening((prev) => {
        const next = !prev
        sendCommand({ cmd: next ? 'start_listening' : 'stop_listening' })
        return next
      })
    })

    return () => {
      cancelled = true
      if (reconnectTimer.current) window.clearTimeout(reconnectTimer.current)
      wsRef.current?.close()
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

      <div style={{ marginTop: 6, fontSize: 11, color: connColor }}>{connLabel}</div>

      <div style={{ marginTop: 16, fontSize: 13 }}>
        <strong>Status:</strong>{' '}
        <span style={{ color: stateColor }}>{stateLabel}</span>
      </div>
      {statusMsg && (
        <div style={{ marginTop: 8, fontSize: 11, color: '#f0883e' }}>
          {statusMsg}
        </div>
      )}

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
        Press <kbd>Option+Space</kbd> to start, again to stop.
        Or hold <kbd>Option</kbd> in the daemon terminal (CGEventTap).
      </p>
    </main>
  )
}
