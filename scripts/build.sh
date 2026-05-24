#!/bin/bash
#
# Build KAIROS daemon (and shim, when it exists in Phase 2+) into single
# binaries via `bun build --compile`. Output goes to bin/.
#
# Usage:
#   bash scripts/build.sh
#
# Or via the npm script:
#   bun run build

set -euo pipefail

# Move to project root regardless of where this script was invoked from
cd "$(dirname "$0")/.."

mkdir -p bin

echo "─── Building KAIROS ───────────────────────────"
echo

# Use the Bun installed at ~/.bun/bin/bun (or whatever's on PATH)
BUN="${BUN:-bun}"
if ! command -v "$BUN" >/dev/null 2>&1; then
  if [ -x "$HOME/.bun/bin/bun" ]; then
    BUN="$HOME/.bun/bin/bun"
  else
    echo "✗ bun not found in PATH or ~/.bun/bin/bun"
    echo "  Install with: curl -fsSL https://bun.sh/install | bash"
    exit 1
  fi
fi

echo "Using $BUN ($("$BUN" --version))"
echo

# ─── Daemon ──────────────────────────────────────────────────
echo "Building daemon..."
"$BUN" build src/daemon/index.ts \
  --compile \
  --outfile bin/kairos-daemon \
  --target=bun

# ─── Shim (Phase 2+) ─────────────────────────────────────────
if [ -f src/shim/index.ts ]; then
  echo "Building shim..."
  "$BUN" build src/shim/index.ts \
    --compile \
    --outfile bin/kairos-mcp-shim \
    --target=bun
fi

# ─── CLI (quick commands from any terminal) ──────────────────────
echo "Building CLI..."
"$BUN" build src/cli/index.ts \
  --compile \
  --outfile bin/kairos \
  --target=bun

echo
echo "─── Build complete ────────────────────────────"
ls -lh bin/
echo
echo "Try it:"
echo "  ./bin/kairos-daemon --sandbox --verbose"
