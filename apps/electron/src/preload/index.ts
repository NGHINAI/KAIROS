// Preload: safe bridge between renderer (Web) and main (Node).

import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('kairos', {
  onHotkey: (cb: () => void) => {
    ipcRenderer.on('hotkey:toggle', () => cb())
  },
  onSpeechEvent: (cb: (e: any) => void) => {
    ipcRenderer.on('speech:event', (_e, payload) => cb(payload))
  },
  speak: (text: string, voice?: string) =>
    ipcRenderer.invoke('speech:speak', { text, voice }),
  transcribe: (wavBase64: string) =>
    ipcRenderer.invoke('speech:transcribe', { wavBase64 }),
})
