#!/bin/bash
# Claude Code UserPromptSubmit hook.
# Injects the 3 most recent unread KAIROS messages as additionalContext.
# Messages are peeked (not marked read) — Claude's kairos_inbox call marks them.

KAIROS_DIR="${KAIROS_SANDBOX_DIR:-$(dirname "$0")/..}"
PORT_FILE="$KAIROS_DIR/runtime/port.txt"

# If daemon isn't running, nothing to inject
[ ! -f "$PORT_FILE" ] && exit 0
PORT=$(cat "$PORT_FILE")

# Peek at unread messages (don't mark as read)
INBOX=$(curl -s --max-time 2 "http://127.0.0.1:$PORT/inbox/all?peek=true" 2>/dev/null)

# Nothing? Exit clean
[ -z "$INBOX" ] || [ "$INBOX" = "null" ] || [ "$INBOX" = "[]" ] && exit 0

MSG_COUNT=$(echo "$INBOX" | jq 'length' 2>/dev/null)
[ -z "$MSG_COUNT" ] || [ "$MSG_COUNT" = "0" ] && exit 0

# Only take the 3 most recent messages, truncate each to 300 chars max.
# This keeps the injection small enough for Claude Code to handle.
FORMATTED=$(echo "$INBOX" | jq -r '
  [.[] | {kind, body: (.body | .[0:300])}] | reverse | .[0:3] | reverse |
  map("- [\(.kind)] \(.body)") | join("\n\n")
' 2>/dev/null)

[ -z "$FORMATTED" ] && exit 0

jq -n --arg msgs "$FORMATTED" --arg count "$MSG_COUNT" '{
  additionalContext: ("# KAIROS has " + $count + " message(s) for you\n\n" + $msgs + "\n\nTell the user about these KAIROS messages. If they want full details, call kairos_inbox.")
}'
