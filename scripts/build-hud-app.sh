#!/bin/bash
# build-hud-app.sh — assemble KairosHUD.app (a double-clickable app), no Xcode project needed.
#
# Produces apps/macos/KairosHUD/KairosHUD.app. Double-click it to run the orb; it connects to the
# daemon on :9876 (start the daemon separately for now — e.g. ./scripts/voice-hud.sh — until the
# app boots the daemon itself in a later milestone). LSUIElement=1 → no Dock icon.

set -e
cd "$(dirname "$0")/.."
APPDIR="$(pwd)/apps/macos/KairosHUD"
cd "$APPDIR"

echo "▸ Building release binary…"
swift build -c release

APP="$APPDIR/KairosHUD.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp ".build/release/KairosHUD" "$APP/Contents/MacOS/KairosHUD"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>KairosHUD</string>
  <key>CFBundleDisplayName</key><string>KAIROS</string>
  <key>CFBundleIdentifier</key><string>com.kairos.hud</string>
  <key>CFBundleExecutable</key><string>KairosHUD</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>26.0</string>
  <key>LSUIElement</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>KAIROS listens when you talk to it.</string>
</dict>
</plist>
PLIST

# Ad-hoc sign so it launches locally without Gatekeeper friction.
codesign --force --sign - "$APP" 2>/dev/null || true

echo "✓ Built $APP"
echo "  Double-click it (Finder) to run the orb. Daemon must be running on :9876."
