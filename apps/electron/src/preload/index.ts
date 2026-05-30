// Preload: minimal bridge — main only signals hotkey + provides daemon port.
// The renderer opens its own WebSocket to the Bun daemon for voice events.

import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('kairos', {
  onHotkey: (cb: () => void) => {
    ipcRenderer.on('hotkey:toggle', () => cb())
  },
  daemonPort: () => ipcRenderer.invoke('daemon:port') as Promise<number>,
})
