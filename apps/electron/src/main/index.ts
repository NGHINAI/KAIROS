// Electron main process — KAIROS UI client (Architecture A).
//
// The daemon (`bun scripts/voice-live.ts`) owns audio, STT, LLM, and TTS.
// This Electron app is just a window into the daemon's state via WebSocket
// at ws://127.0.0.1:<daemonPort>/v1/voice/events. We hand the renderer a
// hotkey event when the user presses Option+Space — the renderer then sends
// start_listening / stop_listening commands over WS.
//
// No audio APIs are touched in this process. The whole TCC/SIGABRT dance is
// avoided by keeping that work in the daemon, which Bun (a clean CLI process)
// spawns the Swift helper from.

import { app, BrowserWindow, globalShortcut, ipcMain } from 'electron'
import path from 'path'

let mainWindow: BrowserWindow | null = null

const DAEMON_PORT = Number(process.env.KAIROS_DAEMON_PORT ?? 9876)

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 520,
    height: 380,
    show: process.env.NODE_ENV === 'development',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [`--kairos-daemon-port=${DAEMON_PORT}`],
    },
  })

  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173')
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', '..', 'renderer', 'index.html'))
  }
}

app.whenReady().then(() => {
  createWindow()

  globalShortcut.register('Alt+Space', () => {
    mainWindow?.webContents.send('hotkey:toggle')
  })

  ipcMain.handle('daemon:port', () => DAEMON_PORT)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
