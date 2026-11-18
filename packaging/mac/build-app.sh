#!/bin/bash
# Builds "Claude Usage Monitor.app" and dist/ClaudeUsageMonitor.dmg. Runs on macOS
# (hdiutil, lipo, iconutil), after: node packaging/prepare.js mac
set -euo pipefail
cd "$(dirname "$0")/../.."
VERSION="${APP_VERSION:-1.6.0}"
NAME="Claude Usage Monitor"
BUILD="build/mac"
APPDIR="$BUILD/$NAME.app"
rm -rf "$BUILD" && mkdir -p "$APPDIR/Contents/MacOS" "$APPDIR/Contents/Resources/node" dist

# The monitor itself, plus one universal (Apple silicon + Intel) node and cloudflared.
cp -R build/stage/mac "$APPDIR/Contents/Resources/app"
mkdir -p "$APPDIR/Contents/Resources/app/tools"
lipo -create build/deps/mac/node-arm64 build/deps/mac/node-x64 -output "$APPDIR/Contents/Resources/node/node"
lipo -create build/deps/mac/cloudflared-arm64 build/deps/mac/cloudflared-x64 -output "$APPDIR/Contents/Resources/app/tools/cloudflared"
chmod 755 "$APPDIR/Contents/Resources/node/node" "$APPDIR/Contents/Resources/app/tools/cloudflared"
for bin in "$APPDIR/Contents/Resources/node/node" "$APPDIR/Contents/Resources/app/tools/cloudflared"; do
  # Each half keeps its maker's signature; if not, sign ad hoc so Apple silicon will run it.
  codesign -v "$bin" 2>/dev/null || codesign --force -s - "$bin"
done

cp packaging/mac/launcher "$APPDIR/Contents/MacOS/launcher"
chmod 755 "$APPDIR/Contents/MacOS/launcher"
sed "s/__VERSION__/$VERSION/g" packaging/mac/Info.plist > "$APPDIR/Contents/Info.plist"

node scripts/make-icons.js --iconset "$BUILD/AppIcon.iconset"
iconutil -c icns "$BUILD/AppIcon.iconset" -o "$APPDIR/Contents/Resources/AppIcon.icns"

# Disk image: the app, a shortcut to Applications, and a short read-me.
STAGE="$BUILD/dmg"
mkdir -p "$STAGE"
cp -R "$APPDIR" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
cat > "$STAGE/Read me.txt" <<'EOF'
Claude Usage Monitor

1. Drag Claude Usage Monitor into Applications.
2. Open it from Applications. The first time, macOS says it cannot check the app
   (it is not from the App Store). Open System Settings, Privacy & Security,
   scroll down, and click Open Anyway next to Claude Usage Monitor.
3. Your dashboard opens in the browser. Under Apps, Pair a phone shows the code
   and QR code for the Android app or the iPhone web app.

The monitor then starts by itself when you log in. To remove it: quit it from
the dashboard (Apps, Stop the monitor), drag the app to the Trash, and delete
~/Library/LaunchAgents/dev.usagemonitor.claude.plist.
EOF
rm -f dist/ClaudeUsageMonitor.dmg
hdiutil create -volname "$NAME" -srcfolder "$STAGE" -ov -format UDZO dist/ClaudeUsageMonitor.dmg
hdiutil verify dist/ClaudeUsageMonitor.dmg
echo "Built dist/ClaudeUsageMonitor.dmg"
