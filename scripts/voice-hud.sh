#!/bin/bash
# voice-hud.sh — run EVERYTHING together: daemon + Electron (mic/audio) + the native orb HUD.
#
# The orb (apps/macos/KairosHUD) is just another client on the daemon's WebSocket
# (ws://127.0.0.1:9876/v1/voice/events) — it reacts to the same voice + activity events Electron
# gets. Electron stays for now because it owns mic capture + TTS playback; the orb only visualizes.
# (Next milestone: the HUD owns mic+audio and Electron drops out.)
#
# Usage:
#   ./scripts/voice-hud.sh                     # everything (same env flags as voice-electron.sh)
#   KAIROS_STT=groq ./scripts/voice-hud.sh
#
# Ctrl-C (or closing the terminal) tears down all three.

set -e
cd "$(dirname "$0")/.."
REPO=$(pwd)

pkill -f "/KairosHUD" 2>/dev/null || true

echo "▸ Building + launching the orb HUD (apps/macos/KairosHUD)…"
(
  cd "$REPO/apps/macos/KairosHUD"
  swift build -c release
  exec ./.build/release/KairosHUD
) &
HUD_PID=$!

cleanup_hud() {
  kill "$HUD_PID" 2>/dev/null || true
  pkill -f "/KairosHUD" 2>/dev/null || true
}
trap cleanup_hud EXIT INT TERM HUP

# Daemon + Electron (the existing launcher). The HUD auto-reconnects until the daemon is ready,
# so launch order doesn't matter. When Electron exits, voice-electron.sh stops the daemon and our
# trap stops the HUD.
"$REPO/scripts/voice-electron.sh"
