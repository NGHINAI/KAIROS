// Electron main process — KAIROS UI client (Architecture A, renderer-mic mode).
//
// The Bun daemon owns STT/LLM/TTS; the RENDERER now owns mic capture + Silero VAD
// (KAIROS_MIC=renderer). For the renderer's getUserMedia() to work, the main
// process MUST: (1) grant media permission requests, and (2) ensure macOS TCC
// microphone access is held. Without this, getUserMedia resolves to a dead/empty
// stream, VAD sees only silence, and no speech events ever fire ("mic+VAD ready"
// but nothing happens when you talk). That was the bug this block fixes.

import { app, BrowserWindow, globalShortcut, ipcMain, session, systemPreferences } from 'electron'
import path from 'path'

let mainWindow: BrowserWindow | null = null

const DAEMON_PORT = Number(process.env.KAIROS_DAEMON_PORT ?? 9876)

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 520,
    height: 380,
    show: false, // shown on 'ready-to-show' to avoid a white flash
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [`--kairos-daemon-port=${DAEMON_PORT}`],
    },
  })

  // Always reveal the window once content is ready — in every mode, not just dev.
  // Previously `show` was gated on NODE_ENV==='development', so a packaged/`electron .`
  // launch ran an invisible window and looked like it "only booted".
  mainWindow.once('ready-to-show', () => mainWindow?.show())

  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools({ mode: 'detach' }) // see [vad] logs while debugging
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', '..', 'renderer', 'index.html'))
  }
}

async function ensureMicAccess() {
  // macOS TCC: explicitly request microphone access so the OS prompt appears the
  // first time. If the user previously denied it, this returns false and we log
  // guidance (System Settings → Privacy → Microphone → enable KAIROS/Electron).
  if (process.platform === 'darwin') {
    const status = systemPreferences.getMediaAccessStatus('microphone')
    console.log(`[kairos] mic TCC status: ${status}`)
    if (status !== 'granted') {
      try {
        const ok = await systemPreferences.askForMediaAccess('microphone')
        console.log(`[kairos] askForMediaAccess(microphone) → ${ok}`)
        if (!ok) {
          console.error('[kairos] Microphone DENIED. Enable it in System Settings → Privacy & Security → Microphone, then relaunch.')
        }
      } catch (e) {
        console.error(`[kairos] askForMediaAccess failed: ${(e as Error).message}`)
      }
    }
  }
}

app.whenReady().then(async () => {
  await ensureMicAccess()

  // Grant the renderer's getUserMedia (microphone). Electron denies media by
  // default; without these handlers vad-web's getUserMedia() silently fails.
  const ses = session.defaultSession
  // Async request handler: grant 'media' (covers mic/camera getUserMedia).
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media')
  })
  // Sync check handler uses a different permission vocabulary at runtime
  // ('audioCapture') than Electron's TS types expose, so compare as string.
  ses.setPermissionCheckHandler((_wc, permission) => {
    const p = permission as string
    return p === 'media' || p === 'audioCapture'
  })

  createWindow()

  // Option+Space (Alt+Space) toggles listening. NOTE: globalShortcut cannot bind
  // a lone modifier (bare Option), which is why a full accelerator is required.
  // This path needs NO Accessibility permission (unlike the Swift CGEventTap).
  const registered = globalShortcut.register('Alt+Space', () => {
    mainWindow?.webContents.send('hotkey:toggle')
  })
  if (!registered) {
    console.error('[kairos] failed to register Alt+Space (another app may own it). Use the on-screen button.')
  }

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
