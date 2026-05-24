#!/bin/bash
# Claude Code statusLine command.
# Shows KAIROS state in the footer of the terminal.

KAIROS_DIR="${KAIROS_SANDBOX_DIR:-$(dirname "$0")/..}"
PORT_FILE="$KAIROS_DIR/runtime/port.txt"

[ ! -f "$PORT_FILE" ] && exit 0
PORT=$(cat "$PORT_FILE")

STATUS=$(curl -s --max-time 0.5 "http://127.0.0.1:$PORT/status-line" 2>/dev/null)
[ -z "$STATUS" ] && exit 0

echo "$STATUS"
