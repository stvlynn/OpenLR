#!/usr/bin/env bash
set -euo pipefail

image=${1:?Pass the generated macOS disk image}
scratch=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/openlr-dmg.XXXXXX")
volume="$scratch/volume"
bundle="$scratch/Applications/OpenLR.app"
attached=false

cleanup() {
  if "$attached"; then
    hdiutil detach "$volume" || return
  fi
  rm -rf -- "$scratch"
}
trap cleanup EXIT
mkdir -p "$volume" "$scratch/Applications"
hdiutil attach -readonly -nobrowse -noautoopen -mountpoint "$volume" "$image"
attached=true
test "$(readlink "$volume/Applications")" = /Applications
ditto "$volume/OpenLR.app" "$bundle"
hdiutil detach "$volume"
attached=false

node scripts/native-installed-cli-smoke.mjs "$bundle/Contents/MacOS/OpenLR" "$bundle/Contents/Resources/cli/openlr.mjs"
launcher="$scratch/cold-document-launch"
xcrun swiftc -parse-as-library scripts/fixtures/cold-document-launch.swift -o "$launcher"
node scripts/native-file-open-smoke.mjs "$bundle/Contents/MacOS/OpenLR" --macos-cold "$launcher"
echo "Disk image detached and copied app verified on $(uname -m)."
