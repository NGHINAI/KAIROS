#!/bin/bash
# Recent git activity skill — JSON of commits in last 7 days
DIR="${1:-.}"
cd "$DIR" 2>/dev/null || { echo '{"error": "directory not found", "directory": "'$DIR'"}'; exit 1; }

if [ ! -d .git ]; then
  echo '{"error": "not a git repository", "directory": "'$DIR'"}'
  exit 0
fi

COMMITS=$(git log --since="7 days ago" --pretty=format:'%h|%an|%ar|%s' 2>/dev/null | head -20)
COUNT=$(echo "$COMMITS" | grep -c . 2>/dev/null || echo 0)

if [ -z "$COMMITS" ]; then
  echo "{\"directory\": \"$DIR\", \"count\": 0, \"commits\": []}"
  exit 0
fi

# Build JSON array
echo "{"
echo "  \"directory\": \"$DIR\","
echo "  \"count\": $COUNT,"
echo "  \"commits\": ["
echo "$COMMITS" | awk -F'|' '
  NR > 1 { print "    ," }
  { printf "    {\"hash\": \"%s\", \"author\": \"%s\", \"when\": \"%s\", \"message\": \"%s\"}", $1, $2, $3, $4 }
  END { print "" }
'
echo "  ]"
echo "}"
