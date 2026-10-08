#!/bin/bash
# The rename test's two throwaway installers (2026-09-24): an "old" product without the hook and a
# "new" one with it, each with its own name, identifier and program name (hproxy-migtest.exe), so
# nothing real is touched. Then: node run-test.mjs (same folder). Output in finished-installers/migration-test/.
# The hook under test is src-tauri/windows/installer-hooks.nsh with OLD_PRODUCTNAME pointed at the
# throwaway "old" product. Passed 46 of 46 on 2026-09-24, both ways: as a person runs the new
# installer (/S) and as the app's updater runs it (/S /UPDATE), each time the old install removed,
# the Start menu entry, desktop shortcut and start-with-the-computer moved to the new name, data
# kept; then an update over the new product; then an uninstall takes the AI tool's folder off the
# user's PATH (through the program, --forget-tool-path) and leaves every other entry as it was;
# the user's environment restored from a backup, byte for byte; nothing left. The first run
# (22 of 22) never tried the /UPDATE way, where Tauri's template makes no shortcut and the hook must.
set -e
export MSYS_NO_PATHCONV=1   # Git Bash would rewrite paths inside the JSON below
cd "$(dirname "$0")/../.."
OUT=../finished-installers/migration-test
mkdir -p "$OUT"
sed 's|!define OLD_PRODUCTNAME "hproxy-checker"|!define OLD_PRODUCTNAME "hproxy-migtest-old"|' src-tauri/windows/installer-hooks.nsh > "$OUT/installer-hooks-test.nsh"
OLD='{"productName":"hproxy-migtest-old","mainBinaryName":"hproxy-migtest","identifier":"com.hproxy.migtest","bundle":{"createUpdaterArtifacts":false,"publisher":null,"windows":{"nsis":{"installerHooks":null}}}}'
NEW='{"productName":"hproxy-migtest-new","mainBinaryName":"hproxy-migtest","identifier":"com.hproxy.migtest","bundle":{"createUpdaterArtifacts":false,"windows":{"nsis":{"installerHooks":"../../finished-installers/migration-test/installer-hooks-test.nsh"}}}}'
npx tauri build --bundles nsis --config "$OLD" > "$OUT/build-old.log" 2>&1
cp ../target/release/bundle/nsis/hproxy-migtest-old_*_x64-setup.exe "$OUT/"
npx tauri build --bundles nsis --config "$NEW" > "$OUT/build-new.log" 2>&1
cp ../target/release/bundle/nsis/hproxy-migtest-new_*_x64-setup.exe "$OUT/"
rm -f ../target/release/bundle/nsis/hproxy-migtest-*_x64-setup.exe
ls -la "$OUT"/*.exe
