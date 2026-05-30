// KAIROS Electron renderer — Phase E.1 Electron-shell prototype.
//
// Responsibilities:
//   - Capture mic via getUserMedia (clean TCC prompt via standard Web API)
//   - On hotkey toggle: start/stop MediaRecorder
//   - On stop: encode to WAV base64 + send to Swift helper for transcription
//   - Receive transcript via speech events
//   - Call LLM (Bun daemon's wrap-API)
//   - Send response text to Swift helper for TTS

import React, { useEffect, useRef, useState } from 'react'

declare global {
  interface Window {
    kairos: {
      onHotkey: (cb: () => void) => void
      onSpeechEvent: (cb: (e: any) => void) => void
      speak: (text: string, voice?: string) => Promise<void>
      transcribe: (wavBase64: string) => Promise<void>
    }
  }
}

export function App() {
  const [listening, setListening] = useState(false)
  const [lastTranscript, setLastTranscript] = useState('')
  const [lastReply, setLastReply] = useState('')
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])

  useEffect(() => {
    window.kairos.onHotkey(() => {
      setListening((prev) => {
        const next = !prev
        if (next) startRecording()
        else stopRecording()
        return next
      })
    })

    window.kairos.onSpeechEvent((event) => {
      if (event.event === 'stt_final') {
        setLastTranscript(event.text)
        void handleTranscript(event.text)
      } else if (event.event === 'error') {
        console.error('Speech helper error:', event)
      }
    })
  }, [])

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' })
      chunksRef.current = []
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data) }
      recorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop())
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
        const buf = await blob.arrayBuffer()
        const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)))
        await window.kairos.transcribe(base64)
      }
      recorder.start()
      recorderRef.current = recorder
    } catch (err) {
      console.error('mic error:', err)
    }
  }

  function stopRecording() {
    recorderRef.current?.stop()
    recorderRef.current = null
  }

  async function handleTranscript(text: string): Promise<void> {
    // Phase F: hit Bun daemon wrap-API for LLM. Placeholder echo for now:
    const reply = `You said: ${text}`
    setLastReply(reply)
    await window.kairos.speak(reply)
  }

  return (
    <main style={{ fontFamily: 'system-ui', padding: 24 }}>
      <h1>KAIROS</h1>
      <div style={{ marginTop: 16 }}>
        <strong>Status:</strong> {listening ? '● Listening...' : '○ Idle'}
      </div>
      <div style={{ marginTop: 8 }}>
        <strong>You said:</strong> {lastTranscript || '—'}
      </div>
      <div style={{ marginTop: 8 }}>
        <strong>KAIROS said:</strong> {lastReply || '—'}
      </div>
      <p style={{ marginTop: 24, opacity: 0.6, fontSize: 12 }}>
        Press Option+Space to toggle listen. Speak. Release shortcut to stop.
      </p>
    </main>
  )
}
