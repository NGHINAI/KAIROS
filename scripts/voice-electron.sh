#!/bin/bash
# voice-electron.sh — launch Arch A: daemon + Electron UI together.
#
# Architecture A: bun (daemon, owns audio + STT + LLM + TTS via Swift sidecar)
#                   ↑ WebSocket on ws://127.0.0.1:9876/v1/voice/events
#                 Electron (UI client — renders events, sends commands)
#
# Press Option (hold) to talk (daemon CGEventTap), or Option+Space in Electron.
#
# All config is via env vars (never source ~/.zshrc — the launcher reads .env):
#   KAIROS_STT       = apple | groq | openrouter        (default: apple)
#   KAIROS_STT_MODEL = override model (e.g. whisper-large-v3-turbo)
#   KAIROS_MODEL     = LLM model (default: openai/gpt-4o-mini via OpenRouter)
#   KAIROS_OR_PROVIDER_SORT = throughput | price | latency (default: throughput)
#   OPENROUTER_API_KEY = required for LLM and (if KAIROS_STT=openrouter) for STT
#   GROQ_API_KEY       = required if KAIROS_STT=groq
#
# Examples:
#   ./scripts/voice-electron.sh                                # Apple STT
#   KAIROS_STT=openrouter ./scripts/voice-electron.sh          # Whisper via OpenRouter ($0.006/min)
#   KAIROS_STT=groq ./scripts/voice-electron.sh                # Whisper via Groq ($0.04/hr)
#   KAIROS_MODEL=anthropic/claude-haiku-4-5 ./scripts/voice-electron.sh

set -e
cd "$(dirname "$0")/.."
REPO=$(pwd)

# Clean any prior runs
pkill -f "scripts/voice-live" 2>/dev/null || true
pkill -f "KairosVoiceHelper" 2>/dev/null || true
pkill -f "kairos.*electron" 2>/dev/null || true
sleep 1

# Source .env so OPENROUTER_API_KEY is set without re-typing
if [ -f "$REPO/.env" ]; then
  set -a; . "$REPO/.env"; set +a
fi

echo "▸ Starting daemon (bun scripts/voice-live.ts) on port 9876..."
bun "$REPO/scripts/voice-live.ts" &
DAEMON_PID=$!
echo "  daemon PID: $DAEMON_PID"

# Wait for daemon WS to be ready
for i in {1..20}; do
  if curl -s --max-time 1 http://127.0.0.1:9876/v1/health >/dev/null 2>&1; then
    echo "  ✓ daemon ready"
    break
  fi
  sleep 0.5
done

echo "▸ Starting Electron UI..."
cd "$REPO/apps/electron"
bun run build:main
NODE_ENV=development bun run dev

# When Electron exits, stop the daemon
kill $DAEMON_PID 2>/dev/null || true
pkill -f "KairosVoiceHelper" 2>/dev/null || true
echo "stopped"
