#!/bin/bash
#
# Inspect KAIROS sandbox state. Pretty-prints the contents of state/state.db
# (when it exists in Phase 1+), recent ticks, recent tasks, etc.
#
# Usage:
#   bash scripts/inspect-state.sh
#
# Or via the npm script:
#   bun run inspect

set -euo pipefail

cd "$(dirname "$0")/.."

DB="state/state.db"

echo "─── KAIROS sandbox state ──────────────────────"
echo

# Phase 0: state.db doesn't exist yet
if [ ! -f "$DB" ]; then
  echo "  state.db: not present (Phase 0 doesn't create it)"
  echo
  echo "  Daemon status:"
  if [ -f runtime/daemon.pid ]; then
    PID=$(cat runtime/daemon.pid)
    if kill -0 "$PID" 2>/dev/null; then
      echo "    Running (PID $PID)"
      [ -f runtime/port.txt ] && echo "    Port: $(cat runtime/port.txt)"
    else
      echo "    Stale pidfile (PID $PID not alive)"
    fi
  else
    echo "    Not running"
  fi
  echo
  exit 0
fi

# Phase 1+: read real state
echo "─── Recent ticks ──────────────────────────────"
sqlite3 -header -column "$DB" "
  SELECT
    datetime(fired_at/1000, 'unixepoch', 'localtime') as time,
    decision,
    substr(reasoning, 1, 60) as reasoning
  FROM ticks
  ORDER BY fired_at DESC LIMIT 10;
" 2>/dev/null || echo "  (no ticks table yet)"

echo
echo "─── Tasks ─────────────────────────────────────"
sqlite3 -header -column "$DB" "
  SELECT
    task_id,
    status,
    priority,
    substr(description, 1, 50) as description
  FROM tasks
  ORDER BY created_at DESC LIMIT 10;
" 2>/dev/null || echo "  (no tasks table yet)"

echo
echo "─── Connected sessions ────────────────────────"
sqlite3 -header -column "$DB" "
  SELECT
    session_id,
    pid,
    substr(cwd, 1, 40) as cwd,
    datetime(started_at/1000, 'unixepoch', 'localtime') as connected_at
  FROM sessions
  WHERE disconnected_at IS NULL;
" 2>/dev/null || echo "  (no sessions table yet)"

echo
