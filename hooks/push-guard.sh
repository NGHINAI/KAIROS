#!/bin/bash
# Claude Code PreToolUse hook — blocks destructive remote operations.
# Inspects every Bash tool call. Allows or blocks based on deny patterns.
# If blocked, writes an approval request for KAIROS to surface.

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // ""')
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // ""')

# Only gate Bash tool calls
[ "$TOOL" != "Bash" ] && exit 0
[ -z "$COMMAND" ] && exit 0

KAIROS_DIR="${KAIROS_SANDBOX_DIR:-$(dirname "$0")/..}"

# Check for one-time approval token
APPROVAL_HASH=$(echo -n "$COMMAND" | shasum -a 256 | cut -d' ' -f1)
TOKEN_FILE="$KAIROS_DIR/state/approved/$APPROVAL_HASH"
if [ -f "$TOKEN_FILE" ]; then
  rm -f "$TOKEN_FILE"  # Single-use: delete after consumption
  exit 0
fi

# Deny patterns — each line is a grep -E regex
DENY_PATTERNS=(
  'git push'
  'git push --force'
  'git push -f'
  'npm publish'
  'yarn publish'
  'pnpm publish'
  'gh pr merge'
  'gh release create'
  'cargo publish'
  'docker push'
  'kubectl apply'
  'terraform apply'
  'aws s3 rm'
  'aws s3 sync'
)

# Also load user-defined patterns if the file exists
USER_PATTERNS="$KAIROS_DIR/state/deny-patterns.txt"
if [ -f "$USER_PATTERNS" ]; then
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    [[ "$line" =~ ^# ]] && continue
    DENY_PATTERNS+=("$line")
  done < "$USER_PATTERNS"
fi

for pattern in "${DENY_PATTERNS[@]}"; do
  if echo "$COMMAND" | grep -qE "$pattern"; then
    # Generate approval ID
    APPROVAL_ID="a_$(head -c 8 /dev/urandom | xxd -p)"
    mkdir -p "$KAIROS_DIR/state/pending-approvals"

    # Write approval request file
    cat > "$KAIROS_DIR/state/pending-approvals/$APPROVAL_ID.json" << APPROVAL_EOF
{
  "id": "$APPROVAL_ID",
  "command": $(echo "$COMMAND" | jq -Rs .),
  "matched_pattern": "$pattern",
  "task_id": "${KAIROS_TASK_ID:-unknown}",
  "command_hash": "$APPROVAL_HASH",
  "timestamp": $(date +%s)000
}
APPROVAL_EOF

    # Exit 2 = deny with reason (Claude Code hook protocol)
    echo "BLOCKED_BY_KAIROS: Command matches protected pattern '$pattern'. Approval request $APPROVAL_ID created. Output STOP_NEEDS_APPROVAL:$APPROVAL_ID and stop." >&2
    exit 2
  fi
done

# No match — allow
exit 0
