#!/bin/bash
#
# Wire the KAIROS sandbox MCP server into the current project's Claude Code
# settings. Creates .claude/settings.local.json in the parent directory
# (project root) so Claude Code sees the KAIROS tools.
#
# Usage: bash scripts/install-sandbox.sh
#
# This is project-scoped — it only affects Claude Code sessions started
# from the parent directory of kairos-sandbox/. No global settings touched.

set -euo pipefail

cd "$(dirname "$0")/.."
SANDBOX_DIR="$(pwd)"
PROJECT_ROOT="$(dirname "$SANDBOX_DIR")"
SETTINGS_DIR="$PROJECT_ROOT/.claude"
SETTINGS_FILE="$SETTINGS_DIR/settings.local.json"

echo "─── KAIROS sandbox installer ──────────────────"
echo
echo "  Sandbox dir:  $SANDBOX_DIR"
echo "  Project root: $PROJECT_ROOT"
echo "  Settings:     $SETTINGS_FILE"
echo

# Ensure .claude dir exists
mkdir -p "$SETTINGS_DIR"

# Build the shim first
if [ ! -f "$SANDBOX_DIR/bin/kairos-mcp-shim" ]; then
  echo "  Building shim first..."
  bash "$SANDBOX_DIR/scripts/build.sh"
  echo
fi

# Write settings.local.json
# Note: Using the compiled binary for the shim (faster cold start)
cat > "$SETTINGS_FILE" << SETTINGS_EOF
{
  "mcpServers": {
    "kairos": {
      "command": "$SANDBOX_DIR/bin/kairos-mcp-shim",
      "args": [],
      "env": {
        "KAIROS_SANDBOX_DIR": "$SANDBOX_DIR"
      }
    }
  }
}
SETTINGS_EOF

echo "  ✓ Wrote $SETTINGS_FILE"
echo
echo "  Next steps:"
echo "    1. Start a NEW Claude Code session from: $PROJECT_ROOT"
echo "    2. Run /mcp to verify KAIROS tools are listed"
echo "    3. Try: 'What is KAIROS doing?' — should call kairos_status"
echo
echo "  To remove:"
echo "    rm $SETTINGS_FILE"
echo
echo "─── Done ──────────────────────────────────────"
