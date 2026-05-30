// Electron main process — KAIROS shell.
// Responsibilities:
//   - Register the global hotkey (Option key) via Electron's globalShortcut
//   - Spawn the Bun daemon (LLM + memory) and the Swift speech helper (STT + TTS)
//   - Pipe transcripts/audio between them
//   - Render the UI (when Phase F HUD lands — for now a hidden window)

import { app, BrowserWindow, globalShortcut, ipcMain } from 'electron'
import { spawn, ChildProcess } from 'child_process'
import path from 'path'

let mainWindow: BrowserWindow | null = null
let speechHelper: ChildProcess | null = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 320,
    show: false,             // Hidden until Phase F HUD
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173')
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
  }
}

function spawnSpeechHelper() {
  const helperPath = process.env.KAIROS_SPEECH_HELPER
    ?? path.join(__dirname, '..', '..', '..', 'macos', 'KairosSpeechHelper', '.build', 'release', 'KairosSpeechHelper')
  speechHelper = spawn(helperPath, [], { stdio: ['pipe', 'pipe', 'inherit'] })
  speechHelper.stdout!.on('data', (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      if (!line.trim()) continue
      try {
        const event = JSON.parse(line)
        mainWindow?.webContents.send('speech:event', event)
      } catch { /* ignore malformed */ }
    }
  })
  speechHelper.on('exit', (code) => {
    console.log(`speech helper exited with code ${code}`)
  })
}

function sendToHelper(cmd: object): void {
  speechHelper?.stdin?.write(JSON.stringify(cmd) + '\n')
}

app.whenReady().then(() => {
  createWindow()
  spawnSpeechHelper()

  // Hotkey: Option (Alt) — pressed/released signaled to renderer.
  // Electron's globalShortcut doesn't natively support hold/release for modifiers,
  // so we use Option+Space as a press toggle for v1. Refine to true hold detection
  // via uIOhook or robotjs if needed.
  globalShortcut.register('Alt+Space', () => {
    mainWindow?.webContents.send('hotkey:toggle')
  })

  // IPC from renderer
  ipcMain.handle('speech:speak', (_e, payload: { text: string; voice?: string }) => {
    sendToHelper({ cmd: 'speak', text: payload.text, voice: payload.voice ?? 'Zoe (Premium)' })
  })

  ipcMain.handle('speech:transcribe', (_e, payload: { wavBase64: string }) => {
    sendToHelper({ cmd: 'transcribe', wavBase64: payload.wavBase64 })
  })

  ipcMain.handle('llm:complete', async (_e, _payload: any) => {
    // Will route to Bun daemon's wrap-API in v2 — for now a stub
    return { text: '(LLM not wired yet)' }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  speechHelper?.kill()
})
